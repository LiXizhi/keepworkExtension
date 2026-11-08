"""Prepare a one-time update for the installed electron-updater, using the released launcher."""
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import urllib.request
import zipfile

VERSION = "0.1.10"
PRODUCT = "KeepWork 第二大脑"
APP_ID = "com.keepwork.aichat-desktop"
DESKTOP = Path(__file__).resolve().parents[1]


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def main():
    target = sys.argv[1]
    platform, arch = target.split("-")
    directory = Path(sys.argv[2]).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    stage = directory / "stage"
    stage.mkdir()
    url = f"https://cdn.keepwork.com/keepwork/aichat-desktop/{target}/"
    meta = json.loads(fetch(url + "latest-client.json"))
    native = "windows" if platform == "win32" else "macos"
    name = f"Keepwork-Launcher-{native}-{arch}.zip"
    if meta["url"] != url + name or meta["fileName"] != name:
        raise ValueError("Unexpected launcher URL")
    archive = stage / name
    data = fetch(url + name)
    pins = {
        # Verified public launcher digests, independent of the mutable download descriptor.
        "win32-x64": "ae97ece5993b4d02a8f31821d991fd89d67bba9b5dfff968abe791ae893df0ad",
        "darwin-x64": "81d94d5918ee64e52cb820b0426c8ed0d51831454a624f889f403b36e9ccdd4b",
        "darwin-arm64": "87c0d5126761b0f901b08d33a64dbae32ffe97e6851ba9a9e864e08a4bd14e51",
    }
    if hashlib.sha256(data).hexdigest() != pins[target] or meta["sha256"] != pins[target]:
        raise ValueError("Released launcher identity changed")
    archive.write_bytes(data)
    stem = f"KeepWork-Launcher-Migration-{VERSION}-{arch}"
    if platform == "win32":
        app = stage / "app"
        (app / "resources").mkdir(parents=True)
        with zipfile.ZipFile(archive) as z:
            (app / (PRODUCT + ".exe")).write_bytes(z.read("Keepwork.exe"))
        # Use the same NSIS app identity, install mode and shortcut names as 0.1.8.
        project = stage / "installer"
        project.mkdir()
        (project / "package.json").write_text(json.dumps(dict(name="aichat-desktop", productName=PRODUCT,
            version=VERSION, description="Keepwork Desktop launcher migration", author="Keepwork")))
        config = dict(electronVersion="44.1.1",appId=APP_ID, productName=PRODUCT, directories=dict(output=str(directory)),
            artifactName=stem+".exe", win=dict(target="nsis",icon=str(DESKTOP/"assets/keepwork.png")),
            nsis=dict(oneClick=False,perMachine=False,allowElevation=False,createDesktopShortcut=True,
                      deleteAppDataOnUninstall=False),publish=dict(provider="generic",url=url))
        cfg = project / "migration.json"
        cfg.write_text(json.dumps(config))
        subprocess.run(["node", str(DESKTOP/"node_modules/electron-builder/cli.js"), "--win",
                        "nsis", "--x64", "--prepackaged", str(app), "--projectDir", str(project),
                        "--config", str(cfg), "--publish", "never"], check=True)
    else:
        subprocess.run(["ditto", "-x", "-k", archive, stage], check=True)
        bundle = stage / (PRODUCT + ".app")
        (stage / "Keepwork.app").rename(bundle)
        info = bundle / "Contents/Info.plist"
        plist = plistlib.loads(info.read_bytes())
        plist.update(CFBundleIdentifier=APP_ID, CFBundleVersion=VERSION, CFBundleShortVersionString=VERSION)
        info.write_bytes(plistlib.dumps(plist))
        subprocess.run(["codesign", "--force", "--sign", "-", bundle], check=True)
        subprocess.run(["codesign", "--verify", "--strict", bundle], check=True)
        package = directory / (stem + ".zip")
        subprocess.run(["ditto", "-c", "-k", "--keepParent", bundle, package], check=True)
        sha = base64.b64encode(hashlib.sha512(package.read_bytes()).digest()).decode()
        (directory/"latest-mac.yml").write_text(json.dumps(dict(version=VERSION,
            files=[dict(url=package.name,sha512=sha,size=package.stat().st_size)],path=package.name,sha512=sha)))
    print(f"Prepared {target} migration {VERSION}")


if __name__ == "__main__":
    main()
