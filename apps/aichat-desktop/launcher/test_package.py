"""Contract tests for the portable app packager. Run: python apps/aichat-desktop/launcher/test_package.py"""
import hashlib
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("launcher_package", Path(__file__).with_name("package.py"))
packager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packager)

TAILWIND_URL = "https://cdn.keepwork.com/keepwork/cdn/tailwindcss@3.4.16.js"


def page(sdk_build="0123456789ab", tailwind=True):
    lines = ["<html><head>"]
    if sdk_build:
        lines.append(f"<script>const sdkCdnUrl = '{packager.SDK_URL}{sdk_build}';</script>")
    if tailwind:
        lines.append('<script src="' + TAILWIND_URL + '"></script>')
    lines.append("</head></html>")
    return "\n".join(lines)


class StartupScripts(unittest.TestCase):
    def test_follows_the_sdk_build_the_page_names(self):
        sdk, tailwind = packager.startup_scripts(page("f" * 12))
        self.assertEqual(sdk, (packager.SDK_URL + "f" * 12, "f" * 12))
        self.assertEqual(tailwind, packager.TAILWIND)

    def test_rejects_a_page_without_the_bundled_sdk(self):
        with self.assertRaisesRegex(ValueError, "bundled SDK build"):
            packager.startup_scripts(page(sdk_build=None))

    def test_rejects_a_page_naming_two_sdk_builds(self):
        with self.assertRaisesRegex(ValueError, "Expected one bundled SDK build"):
            packager.startup_scripts(page() + page("a" * 12))

    def test_rejects_a_page_that_dropped_tailwind(self):
        with self.assertRaisesRegex(ValueError, "tailwindcss"):
            packager.startup_scripts(page(tailwind=False))


class _Response:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        pass

    def read(self, _size):
        return self.body


class _Archive:
    def __init__(self):
        self.members = {}

    def data(self, dest, payload, mode=0):
        self.members[dest] = payload


class ScriptIntegrity(unittest.TestCase):
    def setUp(self):
        self.body = b"sdk bytes"
        original = packager.urllib.request.urlopen
        packager.urllib.request.urlopen = lambda url, timeout: _Response(self.body)
        self.addCleanup(setattr, packager.urllib.request, "urlopen", original)

    def test_bundles_the_build_the_page_pinned(self):
        archive = _Archive()
        build = hashlib.sha256(self.body).hexdigest()[:12]
        packager.add_script(archive, "sdk.js", (packager.SDK_URL + build, build))
        self.assertEqual(archive.members, {"web-libs/sdk.js": self.body})

    def test_rejects_a_different_build_under_the_same_build_id(self):
        with self.assertRaisesRegex(ValueError, "Unexpected digest"):
            packager.add_script(_Archive(), "sdk.js", (packager.SDK_URL + "0" * 12, "0" * 12))


if __name__ == "__main__":
    unittest.main()
