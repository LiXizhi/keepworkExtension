"""Offline integrity and rollback tests for the pinned Microsoft redistributable."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
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

    def test_windows_signature_failure_retains_diagnostics_and_never_stages_payload(self):
        diagnostic = json.dumps({"status": "UnknownError", "statusMessage": "Unable to build the certificate chain",
                                 "signerSubject": "CN=Microsoft Corporation", "signerIssuer": "Microsoft Code Signing PCA"})
        result = subprocess.CompletedProcess(["powershell"], 1, diagnostic, "CERT_E_CHAINING 0x800b010a")
        with tempfile.TemporaryDirectory() as temporary:
            payload, cache = self.fixture(Path(temporary)); cache.mkdir()
            windows = SimpleNamespace(name="nt", environ={"SystemRoot": str(Path(temporary) / "Windows")})
            with patch.object(module, "os", windows), patch.object(module, "download", return_value=cache / "sdk.cab"), \
                    patch.object(module, "extract", return_value=b"DLL"), \
                    patch.object(module.subprocess, "run", return_value=result), patch.object(module, "audit") as audit:
                with self.assertRaises(RuntimeError) as failure:
                    module.prepare(payload, cache)
            message = str(failure.exception)
            for detail in ["exit 1", "UnknownError", "Unable to build the certificate chain", "Microsoft Code Signing PCA", "CERT_E_CHAINING"]:
                self.assertIn(detail, message)
            audit.assert_not_called()
            self.assertEqual((payload / "d3dcompiler_47.dll").read_bytes(), b"original CEF SDK DLL")
            self.assertFalse((payload / "d3dcompiler-redist-lock.json").exists())
            self.assertFalse((payload / "D3DCOMPILER-REDIST-NOTICE.txt").exists())

    def test_windows_signature_failure_bounds_both_captured_output_streams(self):
        result = subprocess.CompletedProcess(["powershell"], 3,
                                             "S" * 4096 + "STDOUT_AFTER_LIMIT",
                                             "E" * 4096 + "STDERR_AFTER_LIMIT")
        windows = SimpleNamespace(name="nt", environ={"SystemRoot": "test-system-root"})
        with patch.object(module, "os", windows), patch.object(module.subprocess, "run", return_value=result):
            with self.assertRaises(RuntimeError) as failure:
                module.verify_authenticode(Path("candidate.dll"))
        message = str(failure.exception)
        self.assertIn("exit 3", message)
        self.assertIn("S" * 4096, message)
        self.assertIn("E" * 4096, message)
        self.assertNotIn("STDOUT_AFTER_LIMIT", message)
        self.assertNotIn("STDERR_AFTER_LIMIT", message)
        self.assertLessEqual(len(message), 2 * 4096 + 256)

    def test_windows_signature_success_uses_the_literal_file_environment(self):
        result = subprocess.CompletedProcess(["powershell"], 0,
                                             json.dumps({"status": "Valid", "signerSubject": "CN=Microsoft Corporation"}), "")
        windows = SimpleNamespace(name="nt", environ={"SystemRoot": "test-system-root", "INHERITED_MARKER": "preserved"})
        candidate = Path("directory with spaces") / "literal '$()' candidate.dll"
        with patch.object(module, "os", windows), patch.object(module.subprocess, "run", return_value=result) as process:
            self.assertTrue(module.verify_authenticode(candidate))
        args, options = process.call_args
        self.assertEqual(options["env"]["KEEPWORK_D3D_VERIFY_FILE"], str(candidate))
        self.assertEqual(options["env"]["INHERITED_MARKER"], "preserved")
        self.assertNotIn(str(candidate), args[0][-1])
        self.assertNotIn("KEEPWORK_D3D_VERIFY_FILE", windows.environ)

    def test_non_windows_signature_verification_is_explicitly_unverified(self):
        with patch.object(module, "os", SimpleNamespace(name="posix")), patch.object(module.subprocess, "run") as process:
            self.assertIs(module.verify_authenticode(Path("not-read-on-this-host.dll")), False)
        process.assert_not_called()

    def test_windows_signature_timeout_never_stages_payload_or_writes_success_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            payload, cache = self.fixture(Path(temporary)); cache.mkdir()
            windows = SimpleNamespace(name="nt", environ={"SystemRoot": str(Path(temporary) / "Windows")})
            with patch.object(module, "os", windows), patch.object(module, "download", return_value=cache / "sdk.cab"), \
                    patch.object(module, "extract", return_value=b"DLL"), \
                    patch.object(module.subprocess, "run", side_effect=subprocess.TimeoutExpired("powershell", 60)), \
                    patch.object(module, "audit") as audit:
                with self.assertRaises(subprocess.TimeoutExpired):
                    module.prepare(payload, cache)
            audit.assert_not_called()
            self.assertEqual((payload / "d3dcompiler_47.dll").read_bytes(), b"original CEF SDK DLL")
            self.assertFalse((payload / "d3dcompiler-redist-lock.json").exists())
            self.assertFalse((payload / "D3DCOMPILER-REDIST-NOTICE.txt").exists())

    @unittest.skipUnless(sys.platform == "win32", "Runs the real PowerShell gate against simulated signature objects on Windows")
    def test_powershell_gate_requires_valid_status_and_the_actual_microsoft_publisher(self):
        # Exercise the production command's real PowerShell decisions. The
        # supplied certificate objects are fixtures, not native trust evidence.
        with patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")) as process:
            module.verify_authenticode(Path("signature-gate-fixture.dll"))
        invocation = list(process.call_args.args[0])
        command = invocation[-1]
        scenarios = [
            ("Valid", "CN=Microsoft Corporation, O=Microsoft Corporation", True),
            ("Valid", "O=Microsoft Corporation, CN=Microsoft Corporation", True),
            ("UnknownError", "CN=Microsoft Corporation", False),
            ("HashMismatch", "CN=Microsoft Corporation", False),
            ("Valid", "CN=Other Publisher, O=Microsoft Corporation", False),
            ("Valid", "CN=Microsoft Corporation Impostor, O=Microsoft Corporation", False),
            ("Valid", None, False),
        ]
        for status, subject, accepted in scenarios:
            with self.subTest(status=status, subject=subject):
                certificate = "$null" if subject is None else "@{Subject='" + subject + "';Issuer='fixture issuer';Thumbprint='fixture thumbprint'}"
                signature = "@{Status='" + status + "';StatusMessage='fixture status';SignerCertificate=" + certificate + ";TimeStamperCertificate=$null}"
                fixture = "function Get-AuthenticodeSignature { param([string]$LiteralPath); return " + signature + " }; "
                result = subprocess.run(invocation[:-1] + [fixture + command], capture_output=True,
                                        text=True, encoding="utf-8", errors="replace", timeout=20,
                                        env={**os.environ, "KEEPWORK_D3D_VERIFY_FILE": "signature-gate-fixture.dll"})
                self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)
                diagnostic = json.loads(result.stdout.strip().lstrip("\ufeff"))
                self.assertEqual(diagnostic["status"], status)
                self.assertEqual(diagnostic["signerSubject"], subject)

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
