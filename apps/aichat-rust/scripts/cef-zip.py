"""Create deterministic CEF release ZIPs. This runs on build machines only."""
import os
from pathlib import Path
import stat
import sys
import zipfile

source, output = map(Path, sys.argv[1:])
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
    for root, dirs, files in os.walk(source, followlinks=False):
        dirs.sort()
        for name in [*dirs, *files]:
            if (Path(root) / name).is_symlink():
                raise ValueError("Runtime cannot contain symlinks")
        for name in sorted(files):
            file = Path(root) / name
            entry = zipfile.ZipInfo(file.relative_to(source).as_posix(), (2024, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            with archive.open(entry, "w", force_zip64=True) as target, file.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    target.write(chunk)
