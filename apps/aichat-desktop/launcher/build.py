"""Build the small native launcher for the current platform with a pinned production key."""
import base64
import os
import platform
from pathlib import Path
import plistlib
import subprocess
import zipfile
import sys


def main():
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    key = os.environ["KP_DESKTOP_LAUNCHER_PUBLIC_KEY"]
    if len(base64.b64decode(key, validate=True)) != 32:
        raise ValueError("Expected raw Ed25519 public key (base64)")
    mac = sys.platform == "darwin"
    if not mac and sys.platform != "win32":
        raise ValueError("Build launchers on macOS or Windows")
    osname = "macos" if mac else "windows"
    arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
    bundle = out / "Keepwork.app"
    exe = bundle / "Contents/MacOS/Keepwork" if mac else out / "Keepwork.exe"
    exe.parent.mkdir(parents=True, exist_ok=True)
    flags = "-s -w -X main.publicKey=" + key
    if not mac:
        flags += " -H windowsgui"
    subprocess.run(["go", "build", "-trimpath", "-ldflags", flags, "-o", str(exe), "."],
                   check=True, cwd=Path(__file__).resolve().parent)
    archive = out / f"Keepwork-Launcher-{osname}-{arch}.zip"
    if mac:
        info = dict(CFBundleExecutable="Keepwork", CFBundleIdentifier="com.keepwork.desktop.launcher",
                    CFBundleName="Keepwork", CFBundlePackageType="APPL", CFBundleVersion="1",
                    CFBundleShortVersionString="1.0", LSUIElement=True)
        (bundle / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
        subprocess.run(["codesign", "--force", "--options", "runtime", "--sign",
                        os.environ.get("KP_LAUNCHER_MAC_IDENTITY", "-"), str(bundle)], check=True)
        subprocess.run(["ditto", "-c", "-k", "--keepParent", str(bundle), str(archive)], check=True)
        if profile := os.environ.get("KP_LAUNCHER_NOTARY_PROFILE"):
            subprocess.run(["xcrun", "notarytool", "submit", archive, "--keychain-profile", profile, "--wait"], check=True)
            subprocess.run(["xcrun", "stapler", "staple", bundle], check=True)
            archive.unlink()
            subprocess.run(["ditto", "-c", "-k", "--keepParent", bundle, archive], check=True)
    else:
        if thumbprint := os.environ.get("KP_LAUNCHER_WINDOWS_CERT_SHA1"):
            subprocess.run(["signtool", "sign", "/sha1", thumbprint, "/fd", "sha256", "/tr",
                            "http://timestamp.digicert.com", "/td", "sha256", str(exe)], check=True)
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(exe, exe.name)
    print(archive, archive.stat().st_size)


if __name__ == "__main__":
    main()
