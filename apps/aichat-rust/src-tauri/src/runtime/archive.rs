//! Confined ZIP extraction, fixture packaging, and archive digests.

use crate::files::{inside, validate_relative_path};
use flate2::write::DeflateEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

/// Pure-Rust ZIP extractor with path traversal confinement.
///
/// Zip64 and data descriptors are handled in-process without shell tools.
pub fn extract_zip_archive(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Failed to create destination directory: {e}"))?;
    let bytes = fs::read(zip_path).map_err(|e| format!("Failed to read zip archive: {e}"))?;
    extract_zip_central_directory(&bytes, dest_dir)
}

/// Central-directory pass for Zip64 archives and entries carrying data
/// descriptors, using the archive central directory.
fn extract_zip_central_directory(bytes: &[u8], dest_dir: &Path) -> Result<(), String> {
    let canonical_root = dunce::canonicalize(dest_dir).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("Failed to read ZIP central directory: {e}"))?;
    let mut extracted_any = false;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Failed to read ZIP entry {index}: {e}"))?;
        if entry
            .unix_mode()
            .map(|mode| mode & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            return Err("ZIP symbolic links are not supported".into());
        }
        let Some(enclosed) = entry.enclosed_name() else {
            return Err("ZIP entry escapes destination directory".to_string());
        };
        let clean_rel = validate_relative_path(&enclosed.to_string_lossy())?;
        if clean_rel.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest_dir.join(&clean_rel);
        if !inside(dest_dir, &out_path) {
            return Err("ZIP entry escapes destination directory".to_string());
        }
        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create directory: {e}"))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {e}"))?;
            let parent = dunce::canonicalize(parent).map_err(|e| e.to_string())?;
            if !parent.starts_with(&canonical_root) {
                return Err("ZIP entry parent escapes destination directory".into());
            }
        }
        if fs::symlink_metadata(&out_path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("ZIP output cannot replace a symbolic link".into());
        }
        let mut decompressed = Vec::new();
        entry
            .read_to_end(&mut decompressed)
            .map_err(|e| format!("ZIP entry decompression failed: {e}"))?;
        fs::write(&out_path, &decompressed)
            .map_err(|e| format!("Failed to write extracted file: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = out_path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|name| name == "node" || name == "keepwork-mcp" || name.ends_with(".sh"))
                .unwrap_or(false);
            let mut mode = entry
                .unix_mode()
                .unwrap_or(if executable { 0o755 } else { 0o644 })
                & 0o777;
            // DOS ZIPs can report synthesized non-executable Unix modes.
            if executable {
                mode |= 0o111;
            }
            fs::set_permissions(&out_path, fs::Permissions::from_mode(mode))
                .map_err(|e| format!("Failed to restore ZIP permissions: {e}"))?;
        }
        extracted_any = true;
    }
    if !extracted_any {
        return Err("ZIP archive contained no files".to_string());
    }
    Ok(())
}

pub fn extract_zip_bytes(bytes: &[u8], dest_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    extract_zip_central_directory(bytes, dest_dir)
}
/// Pure-Rust helper to build a valid ZIP archive from a directory (used in tests and smoke suites).
pub fn create_zip_from_dir(src_dir: &Path, zip_file: &Path) -> Result<(), String> {
    let mut entries = Vec::new();
    collect_files_recursive(src_dir, src_dir, &mut entries)?;

    let mut out = Vec::new();
    let mut central_dir = Vec::new();

    for (rel_slash, full_path) in entries {
        let raw_data = fs::read(&full_path).map_err(|e| e.to_string())?;
        let crc = crc32_ieee(&raw_data);
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&raw_data).map_err(|e| e.to_string())?;
        let comp_data = encoder.finish().map_err(|e| e.to_string())?;

        let local_offset = out.len() as u32;
        let name_bytes = rel_slash.as_bytes();

        // Local file header
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&8u16.to_le_bytes()); // method = deflate
        out.extend_from_slice(&0u16.to_le_bytes()); // mod time
        out.extend_from_slice(&0u16.to_le_bytes()); // mod date
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(comp_data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(raw_data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(&comp_data);

        // Central directory header
        central_dir.extend_from_slice(b"PK\x01\x02");
        central_dir.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central_dir.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // flags
        central_dir.extend_from_slice(&8u16.to_le_bytes()); // method = deflate
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // mod time
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // mod date
        central_dir.extend_from_slice(&crc.to_le_bytes());
        central_dir.extend_from_slice(&(comp_data.len() as u32).to_le_bytes());
        central_dir.extend_from_slice(&(raw_data.len() as u32).to_le_bytes());
        central_dir.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // extra
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // comment
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // disk
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // int attrs
        central_dir.extend_from_slice(&0u32.to_le_bytes()); // ext attrs
        central_dir.extend_from_slice(&local_offset.to_le_bytes());
        central_dir.extend_from_slice(name_bytes);
    }

    let cd_offset = out.len() as u32;
    let cd_size = central_dir.len() as u32;
    let count = out.windows(4).filter(|w| *w == b"PK\x03\x04").count() as u16;
    out.extend_from_slice(&central_dir);

    // End of central directory
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());

    if let Some(parent) = zip_file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(zip_file, out).map_err(|e| e.to_string())
}

fn collect_files_recursive(
    base: &Path,
    current: &Path,
    out: &mut Vec<(String, PathBuf)>,
) -> Result<(), String> {
    let rd = fs::read_dir(current).map_err(|e| e.to_string())?;
    for item in rd {
        let item = item.map_err(|e| e.to_string())?;
        let p = item.path();
        let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            collect_files_recursive(base, &p, out)?;
        } else if meta.is_file() {
            let rel = p
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push((rel, p));
        }
    }
    Ok(())
}

fn crc32_ieee(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        crc ^= b as u32;
        for _ in 0..8 {
            if (crc & 1) != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
