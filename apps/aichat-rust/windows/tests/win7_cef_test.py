"""Offline integrity and rollback tests for the pinned Microsoft redistributable."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
script = Path(__file__).resolve().parents[2] / "scripts/prepare-win7-cef.py"
spec = importlib.util.spec_from_file_location("prepare_win7_cef", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Response(io.BytesIO):
    def __init__(self, data, url):
        super().__init__(data)
        self.url = url

    def geturl(self):
        return self.url


class RedistTests(unittest.TestCase):
    def fixture(self, root):
        payload = root / "payload"; payload.mkdir()
        (payload / "cef-host.json").write_text(json.dumps({"cefMajor": 109, "arch": "x64", "sandbox": "cef_sandbox"}))
        (payload / "d3dcompiler_47.dll").write_bytes(b"original CEF SDK DLL")
        return payload, root / "cache"

    def source(self):
        return {**module.SOURCE, "size": 3, "sha256": hashlib.sha256(b"CAB").hexdigest(),
                "dllSize": 3, "dllSha256": hashlib.sha256(b"DLL").hexdigest()}

    def test_source_is_official_and_exactly_pinned_with_license_and_support_evidence(self):
        self.assertTrue(module.SOURCE["url"].startswith("https://download.microsoft.com/"))
        self.assertEqual(module.SOURCE["sha256"], "f736e161547095bb8d98c636b85fdfeb4070fefeee3c3745db3ce88f6eb1d9de")
        self.assertEqual(module.SOURCE["dllSha256"], "e994847e01a6f1e4cbdc5a864616ac262f67ee4f14db194984661a8d927ab7f4")
        self.assertIn("Redist/D3D/x64", module.SOURCE["installedPath"])
        self.assertIn("learn.microsoft.com", module.SOURCE["redistributionReference"])
        self.assertIn("walbourn.github.io", module.SOURCE["platformSupportReference"])

    def test_download_is_bounded_and_rejects_wrong_bytes_before_cache_publish(self):
        for data in [b"bad", b"CABx", b"CA"]:
            with self.subTest(data=data), tempfile.TemporaryDirectory() as temporary:
                cache = Path(temporary) / "cache"
                with patch.object(module, "SOURCE", self.source()), patch.object(module.urllib.request, "urlopen", return_value=Response(data, module.SOURCE["url"])):
                    with self.assertRaisesRegex(ValueError, "integrity mismatch"):
                        module.download(cache)
                self.assertEqual(list(cache.iterdir()), [])

    def test_download_reuses_only_verified_cached_archive_and_refuses_corruption(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / "cache"
            with patch.object(module, "SOURCE", self.source()), patch.object(module.urllib.request, "urlopen", return_value=Response(b"CAB", module.SOURCE["url"])) as network:
                archive = module.download(cache)
                self.assertEqual(archive.read_bytes(), b"CAB")
                self.assertEqual(module.download(cache), archive)
                self.assertEqual(network.call_count, 1)
                archive.write_bytes(b"bad")
                with self.assertRaisesRegex(ValueError, "Cached SDK archive integrity"):
                    module.download(cache)
                self.assertEqual(network.call_count, 1)

    def test_rejects_non_microsoft_and_non_https_redirects(self):
        for url in ["https://example.com/sdk.cab", "http://download.microsoft.com/sdk.cab", "https://download.microsoft.com.evil.example/sdk.cab"]:
            with self.subTest(url=url), tempfile.TemporaryDirectory() as temporary:
                with patch.object(module, "SOURCE", self.source()), patch.object(module.urllib.request, "urlopen", return_value=Response(b"CAB", url)):
                    with self.assertRaisesRegex(ValueError, "official Microsoft HTTPS"):
                        module.download(Path(temporary) / "cache")

    def test_corrupt_extracted_member_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / module.SOURCE["member"]).write_bytes(b"tampered DLL")
            with patch.object(module.subprocess, "run"), patch.object(module.shutil, "which", return_value="bsdtar"):
                with self.assertRaisesRegex(ValueError, "DLL integrity mismatch"):
                    module.extract(directory / "sdk.cab", directory)

    def test_prepares_unchanged_dll_and_records_static_scope_and_license(self):
        with tempfile.TemporaryDirectory() as temporary:
            payload, cache = self.fixture(Path(temporary)); cache.mkdir()
            with patch.object(module, "SOURCE", self.source()), patch.object(module, "download", return_value=cache / "sdk.cab"), patch.object(module, "extract", return_value=b"DLL"), patch.object(module, "verify_authenticode", return_value=False), patch.object(module, "audit") as audit:
                lock = module.prepare(payload, cache)
            self.assertEqual((payload / "d3dcompiler_47.dll").read_bytes(), b"DLL")
            audit.assert_called_once_with(payload)
            self.assertTrue(lock["staticPeAuditPassed"])
            self.assertFalse(lock["nativeWin7Verified"])
            self.assertFalse(lock["nativeWin8Verified"])
            self.assertFalse(lock["nativeWin81Verified"])
            self.assertFalse(lock["authenticodeVerifiedOnThisBuildHost"])
            self.assertEqual(json.loads((payload / "d3dcompiler-redist-lock.json").read_text()), lock)
            self.assertIn("Microsoft", (payload / "D3DCOMPILER-REDIST-NOTICE.txt").read_text())

    def test_shared_pe_failure_restores_original_and_does_not_write_success_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            payload, cache = self.fixture(Path(temporary)); cache.mkdir()
            with patch.object(module, "download", return_value=cache / "sdk.cab"), patch.object(module, "extract", return_value=b"DLL"), patch.object(module, "verify_authenticode", return_value=False), patch.object(module, "audit", side_effect=RuntimeError("another DLL is incompatible")):
                with self.assertRaisesRegex(RuntimeError, "another DLL"):
                    module.prepare(payload, cache)
            self.assertEqual((payload / "d3dcompiler_47.dll").read_bytes(), b"original CEF SDK DLL")
            self.assertFalse((payload / "d3dcompiler-redist-lock.json").exists())

    def test_signature_failure_does_not_modify_payload(self):
        with tempfile.TemporaryDirectory() as temporary:
            payload, cache = self.fixture(Path(temporary)); cache.mkdir()
            with patch.object(module, "download", return_value=cache / "sdk.cab"), patch.object(module, "extract", return_value=b"DLL"), patch.object(module, "verify_authenticode", side_effect=RuntimeError("invalid signature")), patch.object(module, "audit") as audit:
                with self.assertRaisesRegex(RuntimeError, "invalid signature"):
                    module.prepare(payload, cache)
            audit.assert_not_called()
            self.assertEqual((payload / "d3dcompiler_47.dll").read_bytes(), b"original CEF SDK DLL")

    def test_rejects_other_hosts_before_network(self):
        for host in [{"cefMajor": 143, "arch": "x64", "sandbox": "cef_sandbox"}, {"cefMajor": 109, "arch": "x86", "sandbox": "cef_sandbox"}, {"cefMajor": 109, "arch": "x64", "sandbox": "disabled"}]:
            with self.subTest(host=host), tempfile.TemporaryDirectory() as temporary:
                payload, cache = self.fixture(Path(temporary))
                (payload / "cef-host.json").write_text(json.dumps(host))
                with patch.object(module, "download") as network:
                    with self.assertRaisesRegex(ValueError, "only for the sandboxed"):
                        module.prepare(payload, cache)
                network.assert_not_called()

    @unittest.skipIf(sys.platform == "win32", "Requires local symlink privileges")
    def test_rejects_symlinked_dll_or_metadata_without_network(self):
        for name in ["d3dcompiler_47.dll", "d3dcompiler-redist-lock.json", "D3DCOMPILER-REDIST-NOTICE.txt"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); payload, cache = self.fixture(root)
                outside = root / "outside"; outside.write_bytes(b"do not modify")
                (payload / name).unlink(missing_ok=True)
                (payload / name).symlink_to(outside)
                with patch.object(module, "download") as network:
                    with self.assertRaises(ValueError):
                        module.prepare(payload, cache)
                network.assert_not_called()
                self.assertEqual(outside.read_bytes(), b"do not modify")


if __name__ == "__main__":
    unittest.main()
