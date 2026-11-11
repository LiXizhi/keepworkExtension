"""Exercise SDK selection and archive validation with isolated HTTP fixtures."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
script = Path(__file__).resolve().parents[2] / "scripts/fetch-cef-sdk.py"
spec = importlib.util.spec_from_file_location("fetch_cef_sdk", script)
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)


def record(version, channel="stable"):
    return {"cef_version": version, "channel": channel, "files": [{"type": "standard", "name": "cef_binary_" + version + "_windows64.tar.bz2", "size": 1, "sha1": "a" * 40}]}


def archive(extra=None, version="109.1.18"):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:bz2") as package:
        body = ('#define CEF_VERSION "' + version + '"\n#define CEF_VERSION_MAJOR 109\n').encode()
        header = tarfile.TarInfo("cef_binary_109.1.18_windows64/include/cef_version.h")
        header.size = len(body)
        package.addfile(header, io.BytesIO(body))
        if extra:
            package.addfile(extra, io.BytesIO(b"x") if extra.isfile() else None)
    return stream.getvalue()


class SdkTests(unittest.TestCase):
    def test_selects_latest_stable_per_compatible_generation(self):
        versions = [record("109.1.9"), record("143.2.1"), record("144.0.1", "beta"), record("109.1.18"), record("143.1.10"), record("108.9.99")]
        index = {"windows64": {"versions": versions}}
        self.assertEqual(sdk.select(index, "legacy", "x64")["cefVersion"], "109.1.18")
        self.assertEqual(sdk.select(index, "modern", "x64")["cefVersion"], "143.2.1")
        with self.assertRaises(ValueError):
            sdk.select({"windows64": {"versions": [record("137.1.1")]}}, "modern", "x64")

    def fetch(self, root, content, mutate=None, lock=None):
        descriptor = record("109.1.18")["files"][0]
        descriptor.update(size=len(content), sha1=hashlib.sha1(content).hexdigest())
        if mutate:
            mutate(descriptor)
        index = {"windows64": {"versions": [{"cef_version": "109.1.18", "channel": "stable", "files": [descriptor]}]}}
        args = [str(script), "--channel", "legacy", "--arch", "x64", "--output", str(root / "output")]
        if lock:
            lock_file = root / "input-lock.json"
            lock_file.write_text(json.dumps(lock))
            args += ["--lock", str(lock_file)]
        requested = []

        def response(url, **kwargs):
            requested.append(url)
            return io.BytesIO(json.dumps(index).encode() if url.endswith("index.json") else content)

        with patch.object(sys, "argv", args), patch.object(sdk.urllib.request, "urlopen", side_effect=response), contextlib.redirect_stdout(io.StringIO()):
            sdk.main()
        return requested

    def test_download_validates_and_records_reusable_sha256_lock(self):
        content = archive()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            requested = self.fetch(root, content)
            self.assertEqual(len(requested), 2)
            lock = json.loads((root / "output/cef-sdk-lock.json").read_text())
            self.assertEqual(lock["sha256"], hashlib.sha256(content).hexdigest())
            self.assertTrue(Path((root / "output/cef-root.txt").read_text().strip()).joinpath("include/cef_version.h").is_file())
            self.assertFalse((root / "output/sdk.tar.bz2").exists())
            other = root / "repeat"; other.mkdir()
            self.assertEqual(len(self.fetch(other, content, lock=lock)), 1, "Lock reuse must avoid mutable index lookup")

    def test_rejects_wrong_digest_and_oversized_response_before_extracting(self):
        for mutate in [lambda d: d.update(sha1="0" * 40), lambda d: d.update(size=d["size"] - 1)]:
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                with self.assertRaises(ValueError):
                    self.fetch(root, archive(), mutate=mutate)
                self.assertFalse((root / "output/cef-root.txt").exists())
                self.assertFalse((root / "output/sdk.tar.bz2").exists())

    def test_rejects_unsafe_tar_paths_and_links(self):
        for name, symlink in [("../outside", False), ("/absolute", False), ("C:/outside", False), ("cef_binary_109.1.18_windows64/link", True)]:
            entry = tarfile.TarInfo(name)
            if symlink:
                entry.type = tarfile.SYMTYPE; entry.linkname = "../../outside"
            else:
                entry.size = 1
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                with self.assertRaises(ValueError):
                    self.fetch(root, archive(entry))
                self.assertFalse((root / "outside").exists())
                self.assertFalse((root / "output/cef-root.txt").exists())

    def test_locked_sha256_and_architecture_must_match(self):
        content = archive()
        lock = {"name": "cef_binary_109.1.18_windows64.tar.bz2", "channel": "legacy", "arch": "x64", "cefVersion": "109.1.18", "size": len(content), "sha1": hashlib.sha1(content).hexdigest(), "sha256": "0" * 64}
        for modified in [lock, {**lock, "arch": "arm64"}, {**lock, "channel": "modern"},
                         {**lock, "cefVersion": "143.1.2", "name": "cef_binary_143.1.2_windows64.tar.bz2"},
                         {**lock, "name": "cef_binary_109.1.19_windows64.tar.bz2"}]:
            with tempfile.TemporaryDirectory() as temp:
                with self.assertRaises(ValueError):
                    self.fetch(Path(temp), content, lock=modified)

    def test_extracted_sdk_header_must_match_verified_download_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaisesRegex(ValueError, "version differs"):
                self.fetch(root, archive(version="109.1.17"))
            self.assertFalse((root / "output/cef-root.txt").exists())


if __name__ == "__main__":
    unittest.main()
