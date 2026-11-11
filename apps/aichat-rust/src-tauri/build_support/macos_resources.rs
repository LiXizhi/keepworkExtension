//! Keep Tauri's development resource copy from overwriting a running Mach-O inode.
//! Only the two fixed Rust MCP executable paths participate in this transaction.

use std::fs::{self, Metadata};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const EXECUTABLES: [&str; 2] = ["arm64/bin/keepwork-mcp", "x64/bin/keepwork-mcp"];

#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity(u64, u64);

#[cfg(unix)]
fn identity(metadata: &Metadata) -> io::Result<Identity> {
    use std::os::unix::fs::MetadataExt;
    Ok(Identity(metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn identity(_: &Metadata) -> io::Result<Identity> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "macOS resource isolation requires a Unix build host to verify file identities",
    ))
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

// Check every existing component without following links. Besides the executable,
// its parent directories must not redirect a rename outside the supplied tree.
fn inspect(path: &Path) -> io::Result<Option<Metadata>> {
    if !path.is_absolute() {
        return Err(invalid(format!(
            "Resource path must be absolute: {}",
            path.display()
        )));
    }
    let mut prefix = PathBuf::new();
    let mut missing = false;
    let mut result = None;
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err(invalid(format!(
                "Resource path must be normalized: {}",
                path.display()
            )));
        }
        prefix.push(component.as_os_str());
        if missing {
            continue;
        }
        match fs::symlink_metadata(&prefix) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(invalid(format!(
                        "Resource path contains a symlink: {}",
                        prefix.display()
                    )));
                }
                if prefix != path && !metadata.is_dir() {
                    return Err(invalid(format!(
                        "Resource parent is not a directory: {}",
                        prefix.display()
                    )));
                }
                result = Some(metadata);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing = true;
                result = None;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(result)
}

fn executable(path: &Path) -> io::Result<Option<Identity>> {
    match inspect(path)? {
        Some(metadata) if metadata.is_file() => identity(&metadata).map(Some),
        Some(_) => Err(invalid(format!(
            "Resource executable is not a file: {}",
            path.display()
        ))),
        None => Ok(None),
    }
}

fn overlap(first: &Path, second: &Path) -> bool {
    first.starts_with(second) || second.starts_with(first)
}

fn resolve_missing(path: &Path) -> io::Result<PathBuf> {
    // Canonicalize the existing prefix to also catch aliases caused by a
    // case-insensitive volume. The path was already checked for symlinks.
    let mut existing = path;
    let mut missing = Vec::new();
    while !existing.try_exists()? {
        missing.push(
            existing
                .file_name()
                .ok_or_else(|| invalid("Invalid resource path"))?,
        );
        existing = existing
            .parent()
            .ok_or_else(|| invalid("Invalid resource parent"))?;
    }
    let mut resolved = fs::canonicalize(existing)?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

struct Candidate {
    source: PathBuf,
    source_id: Identity,
    target: PathBuf,
    target_id: Option<Identity>,
}

struct Saved {
    target: PathBuf,
    backup: PathBuf,
    identity: Identity,
}

pub struct ResourceCopyGuard {
    saved: Vec<Saved>,
    backup_dir: Option<PathBuf>,
    finished: bool,
}

impl ResourceCopyGuard {
    pub fn prepare(source: &Path, target: &Path, backup_parent: &Path) -> io::Result<Self> {
        // Validate every relevant file before the first rename. A bad x64 path
        // must not leave the arm64 executable isolated halfway through setup.
        let mut candidates = Vec::new();
        for relative in EXECUTABLES {
            let source_path = source.join(relative);
            if let Some(source_id) = executable(&source_path)? {
                let target_path = target.join(relative);
                candidates.push(Candidate {
                    source: source_path,
                    source_id,
                    target_id: executable(&target_path)?,
                    target: target_path,
                });
            }
        }
        let mut guard = Self {
            saved: Vec::new(),
            backup_dir: None,
            finished: false,
        };
        if candidates.is_empty() {
            return Ok(guard);
        }
        let resolved_source = resolve_missing(source)?;
        let resolved_target = resolve_missing(target)?;
        if overlap(&resolved_source, &resolved_target) {
            return Err(invalid("Resource source and target directories overlap"));
        }
        for candidate in &candidates {
            if candidates
                .iter()
                .any(|source| candidate.target_id == Some(source.source_id))
            {
                return Err(invalid(
                    "Resource source and target files alias the same inode",
                ));
            }
        }
        if candidates
            .iter()
            .all(|candidate| candidate.target_id.is_none())
        {
            return Ok(guard);
        }
        let parent = inspect(backup_parent)?
            .ok_or_else(|| invalid("Resource backup parent does not exist"))?;
        let resolved_backup = resolve_missing(backup_parent)?;
        if !parent.is_dir()
            || overlap(&resolved_backup, &resolved_source)
            || overlap(&resolved_backup, &resolved_target)
        {
            return Err(invalid(
                "Resource backup directory must be separate from source and target",
            ));
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        for attempt in 0..100 {
            let directory = backup_parent.join(format!(
                "macos-mcp-copy-{}-{nonce}-{attempt}",
                std::process::id()
            ));
            match fs::create_dir(&directory) {
                Ok(()) => {
                    guard.backup_dir = Some(directory);
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        let directory = guard.backup_dir.clone().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::AlreadyExists,
                "Cannot allocate resource backup directory",
            )
        })?;
        let isolate = (|| {
            for (index, candidate) in candidates.into_iter().enumerate() {
                let Some(target_id) = candidate.target_id else {
                    continue;
                };
                if executable(&candidate.source)? != Some(candidate.source_id)
                    || executable(&candidate.target)? != Some(target_id)
                {
                    return Err(invalid(
                        "Resource executable changed during copy preparation",
                    ));
                }
                let backup = directory.join(index.to_string());
                fs::rename(&candidate.target, &backup)?;
                guard.saved.push(Saved {
                    target: candidate.target,
                    backup,
                    identity: target_id,
                });
            }
            Ok(())
        })();
        if let Err(error) = isolate {
            if let Err(recovery) = guard.rollback() {
                return Err(io::Error::other(format!(
                    "{error}; resource recovery failed: {recovery}"
                )));
            }
            return Err(error);
        }
        Ok(guard)
    }

    #[cfg(test)]
    pub fn backup_dir(&self) -> Option<&Path> {
        self.backup_dir.as_deref()
    }

    pub fn commit(&mut self) -> io::Result<()> {
        if self.finished {
            return Ok(());
        }
        for saved in &self.saved {
            match executable(&saved.target)? {
                Some(current) if current != saved.identity => (),
                _ => return Err(invalid("Tauri did not create a new resource executable")),
            }
        }
        // The new resources are valid. Cleanup failure must never roll a
        // successful copy back after some of its old backups were deleted.
        self.finished = true;
        if let Some(directory) = &self.backup_dir {
            fs::remove_dir_all(directory)?;
        }
        self.saved.clear();
        self.backup_dir = None;
        Ok(())
    }

    pub fn rollback(&mut self) -> io::Result<()> {
        if self.finished {
            return Ok(());
        }
        let mut failures = Vec::new();
        for index in (0..self.saved.len()).rev() {
            let saved = &self.saved[index];
            let restore = (|| {
                executable(&saved.target)?;
                if executable(&saved.backup)? != Some(saved.identity) {
                    return Err(invalid("Resource backup identity changed"));
                }
                // Unix rename replaces an incomplete copy atomically and
                // restores the original inode, including any open daemon image.
                fs::rename(&saved.backup, &saved.target)
            })();
            match restore {
                Ok(()) => {
                    self.saved.remove(index);
                }
                Err(error) => failures.push(format!("{}: {error}", saved.target.display())),
            }
        }
        if self.saved.is_empty() {
            if let Some(directory) = &self.backup_dir {
                if let Err(error) = fs::remove_dir(directory) {
                    failures.push(format!("{}: {error}", directory.display()));
                } else {
                    self.backup_dir = None;
                }
            }
        }
        if failures.is_empty() {
            self.finished = true;
            Ok(())
        } else {
            Err(io::Error::other(failures.join("; ")))
        }
    }
}

impl Drop for ResourceCopyGuard {
    fn drop(&mut self) {
        if !self.finished {
            if let Err(error) = self.rollback() {
                eprintln!("Cannot restore development MCP resources: {error}");
            }
        }
    }
}
