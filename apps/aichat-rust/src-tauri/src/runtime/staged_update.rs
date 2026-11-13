//! Download and stage verified updates. Activation remains an explicit operation.

use super::{
    current_runtime_arch, extract_zip_archive, is_version_newer, mcp_feed_platform, sha256_hex,
    validate_staged_runtime, validate_update_manifest, validate_update_url, RuntimeStatusSnapshot,
    RuntimeSupervisor, RuntimeUpdateManifest,
};
use futures_util::StreamExt;
use std::fs;
use std::time::Duration;

async fn bounded_body(response: reqwest::Response, limit: u64) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|size| size > limit) {
        return Err("更新响应超出大小限制".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取更新响应失败：{error}"))?;
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err("更新响应超出大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

impl RuntimeSupervisor {
    pub async fn check_for_update(&self) -> (RuntimeStatusSnapshot, bool) {
        if !self.config.updates_enabled {
            return (self.snapshot(), false);
        }
        let _checking = self.update_operation.lock().await;
        if let Ok(mut status) = self.status.lock() {
            status.update_state = "checking".into();
            status.update_error.clear();
        }
        match self.stage_update().await {
            Ok(newly_staged) => (self.snapshot(), newly_staged),
            Err(error) => {
                if let Ok(mut status) = self.status.lock() {
                    status.update_state = "error".into();
                    status.update_error = error;
                }
                (self.snapshot(), false)
            }
        }
    }

    async fn stage_update(&self) -> Result<bool, String> {
        validate_update_url(&self.config.feed_url)?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
            .get(&self.config.feed_url)
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .send()
            .await
            .map_err(|error| format!("更新清单暂不可用：{error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "更新清单暂不可用（HTTP {}）",
                response.status().as_u16()
            ));
        }
        let remote: RuntimeUpdateManifest =
            serde_json::from_slice(&bounded_body(response, 65_536).await?)
                .map_err(|error| format!("更新清单格式错误：{error}"))?;
        validate_update_manifest(
            &remote,
            self.config.product(),
            mcp_feed_platform(),
            current_runtime_arch(),
        )?;

        // Only compare within the selected engine. Never downgrade an attached
        // newer service or substitute Node for a missing native capability.
        let current = self.snapshot();
        let same_engine = current
            .engine
            .eq_ignore_ascii_case(if self.configured_rust_mcp() {
                "rust"
            } else {
                "node"
            });
        let current_version = if same_engine {
            current.version.as_str()
        } else {
            ""
        };
        let installed = self
            .newest_local_version()
            .filter(|version| is_version_newer(version, current_version))
            .unwrap_or(current_version.to_string());
        let installed = if installed.is_empty() {
            self.newest_local_version().unwrap_or_default()
        } else {
            installed
        };
        let newer = installed.is_empty()
            || is_version_newer(&remote.version, &installed)
            || (remote.version == installed
                && same_engine
                && !current.commit.is_empty()
                && remote.commit != current.commit);

        {
            let _commit = self.lifecycle.lock().await;
            let mut record = Self::load_active_record(&self.config.store_dir);
            record.latest_version = Some(remote.version.clone());
            record.latest_built_at = Some(remote.built_at.clone());
            record.latest_source = Some(self.config.update_source());
            self.save_active_record(&record)?;
            if let Ok(mut status) = self.status.lock() {
                status.latest_version = remote.version.clone();
                status.latest_built_at = remote.built_at.clone();
            }
            if record.failed.as_deref() == Some(remote.sha256.as_str()) {
                return Err("该更新此前启动失败，已保留可用版本；等待后续更新".into());
            }
            // A same-version pending cache still needs validation. Comparing
            // version strings first must not hide a corrupted native payload.
            if record.pending.as_deref() == Some(remote.sha256.as_str()) {
                self.cached_runtime(&remote.sha256)
                    .and_then(|_| {
                        validate_staged_runtime(
                            &self.config.store_dir.join(&remote.sha256),
                            &remote,
                        )
                    })
                    .map_err(|error| format!("待更新运行时校验失败，已保留可用版本：{error}"))?;
                if let Ok(mut status) = self.status.lock() {
                    status.pending_version = remote.version;
                    status.update_state = "staged".into();
                    status.update_progress = Some(100);
                }
                return Ok(false);
            }
            if !newer {
                if let Ok(mut status) = self.status.lock() {
                    status.update_state = if record.pending.is_some() {
                        "staged"
                    } else {
                        "idle"
                    }
                    .into();
                }
                return Ok(false);
            }
        }

        if let Ok(mut status) = self.status.lock() {
            status.update_state = "downloading".into();
            status.update_progress = Some(0);
        }
        let response = client
            .get(&remote.url)
            .send()
            .await
            .map_err(|error| format!("下载失败：{error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "下载更新包失败（HTTP {}）",
                response.status().as_u16()
            ));
        }
        let bytes = bounded_body(response, remote.size).await?;
        if bytes.len() as u64 != remote.size {
            return Err("更新包大小与清单不一致".into());
        }
        if !sha256_hex(&bytes).eq_ignore_ascii_case(&remote.sha256) {
            return Err("更新包 SHA-256 校验失败".into());
        }

        fs::create_dir_all(&self.config.store_dir).map_err(|error| error.to_string())?;
        // A unique private staging directory cannot overlap a running binary or
        // a previous check. No downloaded file is executed during validation.
        let staging = self
            .config
            .store_dir
            .join(format!("staging-{}", uuid::Uuid::new_v4()));
        let archive = staging.with_extension("zip");
        fs::write(&archive, &bytes).map_err(|error| error.to_string())?;
        let validated = extract_zip_archive(&archive, &staging)
            .and_then(|()| validate_staged_runtime(&staging, &remote));
        let _ = fs::remove_file(&archive);
        let runtime = match validated {
            Ok(runtime) => runtime,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
        };
        if remote.engine.as_deref() == Some("rust") {
            let receipt = fs::read(staging.join(&runtime.entry))
                .map_err(|_| "Could not read verified native binary".to_string())
                .and_then(|binary| {
                    let mut receipt =
                        serde_json::to_value(&remote).map_err(|error| error.to_string())?;
                    receipt["binarySha256"] = serde_json::json!(sha256_hex(&binary));
                    crate::files::atomic_json_write(
                        &staging.join(".update-manifest.json"),
                        &receipt,
                    )
                });
            if let Err(error) = receipt {
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
        }

        let _commit = self.lifecycle.lock().await;
        let mut record = Self::load_active_record(&self.config.store_dir);
        let destination = self.config.store_dir.join(&remote.sha256);
        if destination.exists() {
            // Never remove or overwrite resources which a daemon may still use.
            let result = validate_staged_runtime(&destination, &remote);
            let _ = fs::remove_dir_all(&staging);
            result?;
        } else if let Err(error) = fs::rename(&staging, &destination) {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("提交更新目录失败：{error}"));
        }
        let newly_staged = record.notified.as_deref() != Some(remote.sha256.as_str());
        record.pending = Some(remote.sha256.clone());
        record.notified = Some(remote.sha256);
        self.save_active_record(&record)?;
        if let Ok(mut status) = self.status.lock() {
            status.pending_version = remote.version;
            status.update_state = "staged".into();
            status.update_progress = Some(100);
            status.update_error.clear();
        }
        Ok(newly_staged)
    }
}
