"""Fetch a CEF SDK for building, not for end-user installation. No CDN writes."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import urllib.parse
import urllib.request

BASE = "https://cef-builds.spotifycdn.com/"
PLATFORMS = {"x64": "windows64", "x86": "windows32", "arm64": "windowsarm64"}


def select(index, channel, arch):
    candidates = []
    for version in index[PLATFORMS[arch]]["versions"]:
        cef = version["cef_version"]
        numbers = tuple(map(int, re.match(r"^(\d+)\.(\d+)\.(\d+)", cef).groups()))
        if version.get("channel", "stable") != "stable":
            continue
        if (channel == "legacy" and numbers[0] != 109) or (channel == "modern" and numbers[0] < 138):
            continue
        for file in version["files"]:
            if file["type"] == "standard":
                candidates.append((numbers, {"cefVersion": cef, "channel": channel, "arch": arch,
                                             "name": file["name"], "size": file["size"], "sha1": file["sha1"]}))
    if not candidates:
        raise ValueError("No matching stable CEF SDK")
    return max(candidates, key=lambda item: item[0])[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--channel", required=True, choices=["legacy", "modern"])
    parser.add_argument("--arch", default="x64", choices=list(PLATFORMS))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--lock", type=Path, help="Reuse a previously recorded SDK version and SHA-256")
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Use a new SDK output directory")
    if args.lock:
        descriptor = json.loads(args.lock.read_text())
        if descriptor["channel"] != args.channel or descriptor["arch"] != args.arch:
            raise ValueError("SDK lock target mismatch")
    else:
        with urllib.request.urlopen(BASE + "index.json", timeout=60) as response:
            raw = response.read(32 * 1024 * 1024 + 1)
        if len(raw) > 32 * 1024 * 1024:
            raise ValueError("CEF index too large")
        descriptor = select(json.loads(raw), args.channel, args.arch)
    name = descriptor["name"]
    cef_version = descriptor["cefVersion"]
    match = re.fullmatch(r"(\d+)\.\d+\.\d+[A-Za-z0-9.+_-]*", cef_version)
    if not match or (args.channel == "legacy" and int(match[1]) != 109) or (args.channel == "modern" and int(match[1]) < 138):
        raise ValueError("CEF SDK version does not match channel")
    if name != f"cef_binary_{cef_version}_{PLATFORMS[args.arch]}.tar.bz2":
        raise ValueError("CEF SDK filename/version mismatch")
    if not re.fullmatch(r"cef_binary_[A-Za-z0-9.+_-]+_" + PLATFORMS[args.arch] + r"\.tar\.bz2", name):
        raise ValueError("Unexpected SDK archive name")
    if not 0 < descriptor["size"] <= 2 * 1024 ** 3 or not re.fullmatch(r"[a-f0-9]{40}", descriptor["sha1"]):
        raise ValueError("Invalid SDK download metadata")
    args.output.mkdir(parents=True)
    archive = args.output / "sdk.tar.bz2"
    sha1, sha256, count = hashlib.sha1(), hashlib.sha256(), 0
    try:
        with urllib.request.urlopen(BASE + urllib.parse.quote(name), timeout=60) as response, archive.open("wb") as target:
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > descriptor["size"]:
                    raise ValueError("Oversized SDK download")
                sha1.update(chunk)
                sha256.update(chunk)
                target.write(chunk)
        if count != descriptor["size"] or sha1.hexdigest() != descriptor["sha1"]:
            raise ValueError("CEF SDK integrity mismatch")
        digest = sha256.hexdigest()
        if args.lock and descriptor.get("sha256") != digest:
            raise ValueError("CEF SDK differs from locked SHA-256")
        with tarfile.open(archive) as package:
            total = 0
            members = package.getmembers()
            if len(members) > 50000:
                raise ValueError("Too many SDK entries")
            for member in members:
                item = PurePosixPath(member.name)
                if item.is_absolute() or ".." in item.parts or "\\" in member.name or ":" in member.name or not (member.isfile() or member.isdir()):
                    raise ValueError("Unsafe SDK archive member")
                total += member.size
                if total > 8 * 1024 ** 3:
                    raise ValueError("Oversized SDK extraction")
            package.extractall(args.output, filter="data")
        archive.unlink()
        roots = [p for p in args.output.iterdir() if p.is_dir() and (p / "include/cef_version.h").is_file()]
        if len(roots) != 1:
            raise ValueError("Expected exactly one CEF SDK")
        version_header = (roots[0] / "include/cef_version.h").read_text(encoding="utf-8")
        declared = re.search(r'#define CEF_VERSION "([^\"]+)"', version_header)
        if not declared or declared[1] != cef_version:
            raise ValueError("Extracted SDK version differs from download metadata")
        descriptor["sha256"] = digest
        (args.output / "cef-sdk-lock.json").write_text(json.dumps(descriptor, indent=2) + "\n")
        (args.output / "cef-root.txt").write_text(str(roots[0].resolve()) + "\n")
        print(roots[0].resolve())
    finally:
        archive.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
