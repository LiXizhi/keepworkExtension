//! Download and stage verified MCP updates without changing the running process.

use super::{
    current_runtime_arch, extract_zip_archive, is_version_newer, mcp_feed_platform, sha256_hex,
    validate_runtime_dir, validate_runtime_dir_any, validate_update_manifest,
    RuntimeStatusSnapshot, RuntimeSupervisor, RuntimeUpdateManifest,
};
use std::fs;
use std::time::Duration;

impl RuntimeSupervisor {
    /// Checks remote MCP manifest, downloads & verifies ZIP if newer, stages it, and returns `(snapshot, newly_staged)`.
    pub async fn check_for_update(&self) -> (RuntimeStatusSnapshot, bool) {
        if !self.config.updates_enabled {
            return (self.snapshot(), false);
        }
        if let Ok(mut st) = self.status.lock() {
            st.update_state = "checking".to_string();
            st.update_error.clear();
        }

        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = e.to_string();
                }
                return (self.snapshot(), false);
            }
        };

        let resp = match client.get(&self.config.feed_url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = format!("检查更新失败（HTTP {}）", r.status().as_u16());
                }
                return (self.snapshot(), false);
            }
            Err(e) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = format!("网络请求失败：{e}");
                }
                return (self.snapshot(), false);
            }
        };

        let remote: RuntimeUpdateManifest = match resp.json().await {
            Ok(m) => m,
            Err(e) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = format!("更新清单格式错误：{e}");
                }
                return (self.snapshot(), false);
            }
        };

        let expected_platform = mcp_feed_platform();
        let expected_arch = current_runtime_arch();
        if let Err(err) = validate_update_manifest(
            &remote,
            self.config.product(),
            expected_platform,
            expected_arch,
        ) {
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = err;
            }
            return (self.snapshot(), false);
        }

        let mut record = Self::load_active_record(&self.config.store_dir);
        record.latest_version = Some(remote.version.clone());
        record.latest_built_at = Some(remote.built_at.clone());
        let _ = self.save_active_record(&record);

        let cur_snap = self.snapshot();
        let installed_ver = if !cur_snap.version.is_empty() {
            cur_snap.version.clone()
        } else {
            self.newest_local_version().unwrap_or_default()
        };
        let installed_commit = cur_snap.commit.clone();

        let is_newer = is_version_newer(&remote.version, &installed_ver)
            || (remote.version == installed_ver
                && !installed_commit.is_empty()
                && remote.commit != installed_commit);

        if !is_newer || record.failed.as_deref() == Some(remote.sha256.as_str()) {
            if let Ok(mut st) = self.status.lock() {
                st.latest_version = remote.version;
                st.latest_built_at = remote.built_at;
                st.update_state = if record.pending.is_some() {
                    "staged".to_string()
                } else {
                    "idle".to_string()
                };
            }
            return (self.snapshot(), false);
        }

        // If already staged with the same sha256, no need to re-download
        if record.pending.as_deref() == Some(remote.sha256.as_str())
            && validate_runtime_dir(
                &self.config.store_dir.join(&remote.sha256),
                self.config.product(),
            )
            .is_ok()
        {
            if let Ok(mut st) = self.status.lock() {
                st.latest_version = remote.version.clone();
                st.latest_built_at = remote.built_at;
                st.pending_version = remote.version;
                st.update_state = "staged".to_string();
                st.update_progress = Some(100);
            }
            return (self.snapshot(), false);
        }

        if let Ok(mut st) = self.status.lock() {
            st.latest_version = remote.version.clone();
            st.latest_built_at = remote.built_at.clone();
            st.update_state = "downloading".to_string();
            st.update_progress = Some(0);
        }

        // Download archive
        let dl_resp = match client.get(&remote.url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = format!("下载更新包失败（HTTP {}）", r.status().as_u16());
                }
                return (self.snapshot(), false);
            }
            Err(e) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = format!("下载失败：{e}");
                }
                return (self.snapshot(), false);
            }
        };

        let archive_bytes = match dl_resp.bytes().await {
            Ok(b) => b,
            Err(e) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = format!("读取更新包流失败：{e}");
                }
                return (self.snapshot(), false);
            }
        };

        if archive_bytes.len() as u64 != remote.size {
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = format!(
                    "更新包大小不匹配（实际 {}，预期 {}）",
                    archive_bytes.len(),
                    remote.size
                );
            }
            return (self.snapshot(), false);
        }

        let actual_sha = sha256_hex(&archive_bytes);
        if !actual_sha.eq_ignore_ascii_case(&remote.sha256) {
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = "更新包 SHA-256 校验失败".to_string();
            }
            return (self.snapshot(), false);
        }

        let _ = fs::create_dir_all(&self.config.store_dir);
        let zip_file = self
            .config
            .store_dir
            .join(format!("download-{}.zip", remote.sha256));
        let staging_dir = self
            .config
            .store_dir
            .join(format!("staging-{}", remote.sha256));
        let final_dir = self.config.store_dir.join(&remote.sha256);

        let _ = fs::remove_dir_all(&staging_dir);
        if let Err(e) = fs::write(&zip_file, &archive_bytes) {
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = format!("写入临时更新包失败：{e}");
            }
            return (self.snapshot(), false);
        }

        let extract_res = extract_zip_archive(&zip_file, &staging_dir);
        let _ = fs::remove_file(&zip_file);
        if let Err(e) = extract_res {
            let _ = fs::remove_dir_all(&staging_dir);
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = e;
            }
            return (self.snapshot(), false);
        }

        let extracted_manifest = match validate_runtime_dir_any(
            &staging_dir,
            &self
                .config
                .products
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        ) {
            Ok(m) => m,
            Err(e) => {
                let _ = fs::remove_dir_all(&staging_dir);
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = e;
                }
                return (self.snapshot(), false);
            }
        };

        if extracted_manifest.commit != remote.commit
            || extracted_manifest.version != remote.version
        {
            let _ = fs::remove_dir_all(&staging_dir);
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = "解压后的 runtime.json 版本或 commit 与清单不一致".to_string();
            }
            return (self.snapshot(), false);
        }

        let _ = fs::remove_dir_all(&final_dir);
        if let Err(e) = fs::rename(&staging_dir, &final_dir) {
            let _ = fs::remove_dir_all(&staging_dir);
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = format!("提交更新目录失败：{e}");
            }
            return (self.snapshot(), false);
        }

        let newly_staged = record.notified.as_deref() != Some(remote.sha256.as_str());
        record.pending = Some(remote.sha256.clone());
        record.notified = Some(remote.sha256.clone());
        let _ = self.save_active_record(&record);

        if let Ok(mut st) = self.status.lock() {
            st.pending_version = remote.version;
            st.update_state = "staged".to_string();
            st.update_progress = Some(100);
            st.update_error.clear();
        }
        (self.snapshot(), newly_staged)
    }
}
