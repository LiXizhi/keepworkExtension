"""Verify the built download installs a persistent, discoverable per-user app on a clean runner."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile


def verify(archive, *, launch=False):
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        if sys.platform == "win32":
            with zipfile.ZipFile(archive) as z:
                z.extractall(root)
            source = root / "Keepwork.exe"
            installed = Path(os.environ["LOCALAPPDATA"]) / "Programs/Keepwork Desktop/Keepwork.exe"
        else:
            subprocess.run(["ditto","-x","-k",archive,root],check=True)
            source = root / "Keepwork.app/Contents/MacOS/Keepwork"
            installed = Path.home() / "Applications/Keepwork.app/Contents/MacOS/Keepwork"
        for _ in range(2):
            subprocess.run([source,"--install-only"],check=True,timeout=90)
            assert source.read_bytes() == installed.read_bytes(), "Installed launcher identity differs"
        if sys.platform == "win32":
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,r"Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepworkDesktopLauncher") as key:
                assert Path(winreg.QueryValueEx(key, "InstallLocation")[0]) == installed.parent
            assert (installed.parent/"Uninstall.exe").is_file()
            link = subprocess.check_output(["powershell","-NoProfile","-Command",
                "(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Keepwork Desktop.lnk')).TargetPath"],text=True).strip()
            assert Path(link) == installed
        else:
            subprocess.run(["codesign","--verify","--deep","--strict",installed.parents[2]],check=True)
    assert not source.exists() and installed.exists()
    print("Verified installation after deleting the download:",installed, flush=True)
    if launch:
        subprocess.run([installed],check=True,timeout=1000)
    return installed


if __name__ == "__main__":
    verify(Path(sys.argv[1]).resolve(), launch="--launch" in sys.argv)
