"""Create the portable app ZIP or a native dependency ZIP. Run after compiling the selected inputs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import urllib.request
import zipfile

APPS = Path(__file__).resolve().parents[2]
DESKTOP = APPS / "aichat-desktop"
MCP = APPS / "mcp-runtime"
MODEL = APPS / "local-model-runtime"
TARGETS = ("windows-x64", "macos-x64", "macos-arm64")


# These are the two scripts the official page needs before rendering its UI.
# The SDK build id is the leading hex digits of that build's sha256 (the CDN cache
# key), so take it from the page instead of pinning a build that the page may replace.
SDK_URL = "https://cdn.keepwork.com/sdk/keepworkSDK.iife.js?v="
SDK_BUILD = re.compile(re.escape(SDK_URL) + r"([0-9a-f]{12,64})")
TAILWIND = ("https://cdn.keepwork.com/keepwork/cdn/tailwindcss@3.4.16.js",
            "a099dd026585d44fe6602bdc66680e407700f935ca92cd0c9443c6ebb96be45e")


def startup_scripts(page):
    """Resolve the two startup scripts to the exact builds the page loads."""
    builds = sorted(set(SDK_BUILD.findall(page)))
    if len(builds) != 1:
        raise ValueError("Expected one bundled SDK build in AIChat.html, found " + (", ".join(builds) or "none"))
    sdk = (SDK_URL + builds[0], builds[0])
    for url, _ in (sdk, TAILWIND):
        if url not in page:
            raise ValueError("Review the packaged web startup dependency: " + url)
    return sdk, TAILWIND


def add_script(archive, name, source):
    url, integrity = source
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(16 * 1024 * 1024)
    digest = hashlib.sha256(data).hexdigest()
    if not digest.startswith(integrity):
        raise ValueError("Unexpected digest for " + url + ": " + digest)
    archive.data("web-libs/" + name, data)


def read(path):
    return json.loads(path.read_bytes())


def dependency_contract():
    # Use dependency/lock content rather than the first-party product version.
    inputs = [TAILWIND[1]]
    for root in (DESKTOP, MCP, MODEL, APPS / "pet-companion"):
        pkg = read(root / "package.json")
        lock = read(root / "package-lock.json")["packages"]
        inputs.append([pkg.get("dependencies"), pkg.get("devDependencies", {}).get("electron"),
                       {k: v for k, v in lock.items() if k and not v.get("dev")}])
    inputs.append(["node-22.23.2", [(f.relative_to(MODEL).as_posix(), read(f)) for f in sorted((MODEL / "models").rglob("checksums.json"))]])
    return hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()


class Archive:
    def __init__(self, archive):
        self.archive = archive
        self.names = set()

    def file(self, source, dest):
        if source.is_symlink():
            self.data(dest, os.readlink(source).encode(), stat.S_IFLNK | 0o777)
        elif source.is_dir():
            for child in sorted(source.iterdir()):
                self.file(child, dest + "/" + child.name)
        else:
            mode = stat.S_IFREG | (source.stat().st_mode & 0o777)
            with source.open("rb") as stream, self.archive.open(self.info(dest, mode), "w") as output:
                shutil.copyfileobj(stream, output)

    def info(self, dest, mode):
        if dest in self.names:
            raise ValueError("Duplicate package member " + dest)
        self.names.add(dest)
        info = zipfile.ZipInfo(dest)
        info.create_system = 3
        info.external_attr = mode << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        return info

    def data(self, dest, data, mode=stat.S_IFREG | 0o644):
        self.archive.writestr(self.info(dest, mode), data)

    def metadata(self, dest, data):
        self.data(dest, json.dumps(data, sort_keys=True).encode())


def application(a, web, version):
    for f in sorted((DESKTOP / "dist").iterdir()):
        if f.is_file() and f.suffix in {".js", ".cjs", ".css", ".html", ".png"}:
            a.file(f, "desktop/dist/" + f.name)
    package = read(DESKTOP / "package.json")
    a.metadata("desktop/package.json", {**{k: package[k] for k in ("name", "productName", "main")}, "version": version})
    for f in ("cli.cjs", "skills", "pet-companion"):
        a.file(MCP / "dist" / f, "mcp/app/" + f)
    for f in ("dist/src", "configs", "schemas", "keys/model-signing-public.pem", "tests/fixtures"):
        a.file(MODEL / f, "model/app/" + f)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=DESKTOP, text=True).strip()
    for service, root, product, entry, args in [
        ("mcp", MCP, "keepwork-mcp-node-runtime", "app/cli.cjs", ["--port", "8089"]),
        ("model", MODEL, "keepwork-local-model-node-runtime", "app/dist/src/cli.js", ["serve", "--port", "18089"])]:
        package = read(root / "package.json")
        a.metadata(service + "/app/package.json", {k: package[k] for k in ("name", "type", "version", "dependencies") if k in package})
        for target in TARGETS:
            platform, arch = target.split("-")
            a.metadata(f"{service}/runtime-{target}.json", dict(schemaVersion=1, product=product,
                       version=package["version"], platform=platform, arch=arch, entry=entry, args=args,
                       commit=commit, env={"LOCAL_MODEL_ROOT": "app"} if service == "model" else {}))
    # Take only tracked public app resources, never developer credentials or build output.
    page = (web / "AIChat.html").read_text(encoding="utf-8")
    sdk, tailwind = startup_scripts(page)
    add_script(a, "sdk.js", sdk)
    a.metadata("web-libs/assets.json", {sdk[0]: "sdk.js", tailwind[0]: "tailwind.js"})
    roots = ["AIChat.html", "AIChat_skins.json", "base-manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.md",
             "preview_broker.html", "preview_host.html", "preview_service_worker.js", "preview_debug_bridge.js",
             "audio", "css", "js", "packages", "profiles", "runtime", "skills", "skins", "tools"]
    tracked = subprocess.check_output(["git", "ls-files", "-z", "--", *roots], cwd=web).decode().split("\0")
    if "AIChat.html" not in tracked:
        raise ValueError("Expected tracked AIChat sources")
    for name in sorted(filter(None, tracked)):
        source = web / name
        if source.is_symlink():
            raise ValueError("Unexpected link in web sources: " + name)
        a.file(source, "web/" + name)


def platform_runtime(a, target):
    add_script(a, "tailwind.js", TAILWIND)
    mcp = MCP / "staging" / target
    model = MODEL / "runtime-staging" / target
    for service, root in (("mcp", mcp), ("model", model)):
        meta = read(root / "runtime.json")
        if target != meta["platform"] + "-" + meta["arch"] or meta["nodeVersion"] != "22.23.2":
            raise ValueError("Incompatible staged runtime " + str(root))
        for name in ("node.exe" if target.startswith("windows") else "bin/node", "LICENSE-node.txt", "app/node_modules"):
            a.file(root / name, service + "/" + name)
    a.file(model / "app/models", "model/app/models")
    a.file(mcp / "app/pet-companion/electron", "mcp/app/pet-companion/electron")
    with tempfile.TemporaryDirectory() as tmp:
        for f in ("package.json", "package-lock.json"):
            shutil.copyfile(DESKTOP / f, Path(tmp) / f)
        npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
        subprocess.run([npm, "ci", "--legacy-peer-deps", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=tmp, check=True)
        deps = Path(tmp) / "node_modules"
        if target.startswith("macos"):
            (deps / "node-pty/prebuilds" / target.replace("macos", "darwin") / "spawn-helper").chmod(0o755)
        a.file(deps, "desktop/node_modules")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("app", *TARGETS))
    parser.add_argument("--web", type=Path)
    parser.add_argument("--version")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.out) as tmp:
        file = Path(tmp) / "package.zip"
        with zipfile.ZipFile(file, "w") as archive:
            if args.kind == "app":
                if not args.web or not args.version:
                    parser.error("app needs --web DIR and --version X.Y.Z")
                application(Archive(archive), args.web.resolve(), args.version)
            else:
                platform_runtime(Archive(archive), args.kind)
        with file.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        meta = {"sha256": digest, "size": file.stat().st_size, "contract": dependency_contract()}
        if args.kind == "app":
            meta["version"] = args.version
        file.replace(args.out / (digest + ".zip"))
        (args.out / (args.kind + ".json")).write_text(json.dumps(meta), encoding="utf8")
        print(args.kind, meta)


if __name__ == "__main__":
    main()
