"""Prepare the unchanged Microsoft app-local D3D compiler for CEF 109.

Build-host utility only. Installed users do not need Python or PowerShell.
The SDK download and extracted DLL are both pinned; no PE headers are patched.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request


SOURCE = {
    "product": "Microsoft Windows 8.1 SDK D3D x64 redistributable",
    "url": "https://download.microsoft.com/download/B/0/C/B0C80BA3-8AD6-4958-810B-6882485230B5/standalonesdk/Installers/61d57a7a82309cd161a854a6f4619e52.cab",
    "size": 1776364,
    "sha256": "f736e161547095bb8d98c636b85fdfeb4070fefeee3c3745db3ce88f6eb1d9de",
    "member": "fil3585cb2ea5db13cc0838f8d06b5c9679",
    "installedPath": "Windows Kits/8.1/Redist/D3D/x64/d3dcompiler_47.dll",
    "dllSize": 4173928,
    "dllSha256": "e994847e01a6f1e4cbdc5a864616ac262f67ee4f14db194984661a8d927ab7f4",
    "license": "Microsoft Windows SDK redistributable; distribute application-local with desktop applications",
    "redistributionReference": "https://learn.microsoft.com/en-us/windows/desktop/directx-sdk--august-2009-",
    "platformSupportReference": "https://walbourn.github.io/hlsl-fxc-and-d3dcompile/",
}
ROOT = Path(__file__).resolve().parents[3]
NOTICE = """Microsoft D3DCompiler 47 redistributable
Copyright Microsoft Corporation. All rights reserved.

This unchanged x64 DLL comes from the Microsoft Windows 8.1 SDK Redist/D3D
directory. It is deployed application-local alongside this desktop application,
under the Windows SDK redistributable terms. It is not installed in System32.
The original Microsoft Authenticode signature is preserved.

Redistribution instructions:
https://learn.microsoft.com/en-us/windows/desktop/directx-sdk--august-2009-
Vendor platform support (Windows Vista, Windows 7, Windows 8.x):
https://walbourn.github.io/hlsl-fxc-and-d3dcompile/

The adjacent d3dcompiler-redist-lock.json records the official Microsoft source
and both archive and DLL SHA-256 hashes. Native Windows acceptance is separate
from static PE inspection.
"""


def checked_bytes(data, size, digest, name):
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(name + " integrity mismatch")
    return data


def download(cache):
    cache.mkdir(parents=True, exist_ok=True)
    if cache.is_symlink():
        raise ValueError("Cache must not be a symlink")
    archive = cache / "d3dcompiler-sdk81-x64.cab"
    if archive.exists() or archive.is_symlink():
        if not archive.is_file() or archive.is_symlink():
            raise ValueError("Unsafe cached SDK archive")
        if archive.stat().st_size != SOURCE["size"]:
            raise ValueError("Cached SDK archive integrity mismatch")
        checked_bytes(archive.read_bytes(), SOURCE["size"], SOURCE["sha256"], "Cached SDK archive")
        return archive
    with urllib.request.urlopen(SOURCE["url"], timeout=60) as response:
        final_url = urllib.parse.urlparse(response.geturl())
        if final_url.scheme != "https" or final_url.hostname != "download.microsoft.com":
            raise ValueError("SDK download must remain on the official Microsoft HTTPS source")
        data = response.read(SOURCE["size"] + 1)
    checked_bytes(data, SOURCE["size"], SOURCE["sha256"], "Microsoft SDK archive")
    with tempfile.NamedTemporaryFile(dir=cache, suffix=".partial", delete=False) as target:
        temporary = Path(target.name)
        target.write(data)
    try:
        os.replace(temporary, archive)
    finally:
        temporary.unlink(missing_ok=True)
    return archive


def extract(archive, directory):
    if os.name == "nt":
        # Use the build host's CAB extractor, never run the downloaded package.
        executable = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/expand.exe"
        subprocess.run([str(executable), "-F:" + SOURCE["member"], str(archive), str(directory)],
                       check=True, capture_output=True, timeout=30)
    else:
        executable = shutil.which("bsdtar") or shutil.which("tar")
        if not executable:
            raise RuntimeError("Use Windows expand.exe or a CAB-capable bsdtar on the build host")
        subprocess.run([executable, "-xf", str(archive), "-C", str(directory), SOURCE["member"]],
                       check=True, capture_output=True, timeout=30)
    member = directory / SOURCE["member"]
    if not member.is_file() or member.is_symlink():
        raise ValueError("SDK archive did not contain the expected regular DLL member")
    if member.stat().st_size != SOURCE["dllSize"]:
        raise ValueError("Microsoft D3D compiler DLL integrity mismatch")
    return checked_bytes(member.read_bytes(), SOURCE["dllSize"], SOURCE["dllSha256"], "Microsoft D3D compiler DLL")


def verify_authenticode(file):
    if os.name != "nt":
        return False
    command = (
        "$s = Get-AuthenticodeSignature -LiteralPath $env:KEEPWORK_D3D_VERIFY_FILE; "
        "if ($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate -or "
        "$s.SignerCertificate.Subject -notmatch '(^|, )CN=Microsoft Corporation(,|$)') "
        "{ throw 'Microsoft D3DCompiler Authenticode validation failed' }"
    )
    environment = {**os.environ, "KEEPWORK_D3D_VERIFY_FILE": str(file)}
    executable = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    subprocess.run([str(executable), "-NoProfile", "-NonInteractive", "-Command", command],
                   env=environment, check=True, capture_output=True, timeout=60)
    return True


def audit(payload):
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node is required on the build host for the shared Windows 7 PE audit")
    subprocess.run([node, str(ROOT / "scripts/lib/windows7-pe.cjs"), str(payload)],
                   check=True, capture_output=True, timeout=60)


def prepare(payload, cache):
    if payload.is_symlink() or not payload.is_dir():
        raise ValueError("Use a regular CEF payload directory")
    host = json.loads((payload / "cef-host.json").read_text(encoding="utf-8"))
    if host.get("cefMajor") != 109 or host.get("arch") != "x64" or host.get("sandbox") != "cef_sandbox":
        raise ValueError("This pinned redistributable is only for the sandboxed CEF 109 x64 legacy host")
    dll = payload / "d3dcompiler_47.dll"
    if not dll.is_file() or dll.is_symlink():
        raise ValueError("Expected a regular d3dcompiler_47.dll in the CEF payload")
    collisions = [item for item in payload.iterdir() if item.name.lower() == dll.name and item.name != dll.name]
    if collisions:
        raise ValueError("Ambiguous D3D compiler filename")
    for name in ["d3dcompiler-redist-lock.json", "D3DCOMPILER-REDIST-NOTICE.txt"]:
        if (payload / name).is_symlink():
            raise ValueError("Redistributable metadata must not be a symlink")
    archive = download(cache)
    with tempfile.TemporaryDirectory(prefix="d3dcompiler-", dir=cache) as temporary:
        directory = Path(temporary)
        data = extract(archive, directory)
        signature_file = directory / "d3dcompiler_47.dll"
        signature_file.write_bytes(data)
        signature_verified = verify_authenticode(signature_file)
    original = dll.read_bytes()
    try:
        dll.write_bytes(data)
        audit(payload)
    except Exception:
        dll.write_bytes(original)
        raise
    lock = {"schemaVersion": 1, **SOURCE, "arch": "x64", "osVersion": [6, 3], "subsystemVersion": [6, 0],
            "authenticodeVerifiedOnThisBuildHost": signature_verified, "staticPeAuditPassed": True,
            "nativeWin7Verified": False, "nativeWin8Verified": False, "nativeWin81Verified": False}
    (payload / "D3DCOMPILER-REDIST-NOTICE.txt").write_text(NOTICE, encoding="utf-8")
    (payload / "d3dcompiler-redist-lock.json").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
    return lock


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    lock = prepare(args.payload, args.cache)
    print(json.dumps({"payload": str(args.payload.resolve()), "dllSha256": lock["dllSha256"],
                      "staticPeAuditPassed": True, "nativeLegacyVerified": False}))


if __name__ == "__main__":
    main()
