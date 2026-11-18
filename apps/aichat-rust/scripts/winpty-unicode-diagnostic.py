#!/usr/bin/env python3
"""Private Windows WinPTY byte probe; diagnostic only, never acceptance."""
import argparse
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

LIMIT = 65536
PINNED = {
    "winpty.dll": (640000, "936f611c2129600d35ab7aad45546a837f4f3a9ca7f673e5d66b48c313b9cd75"),
    "winpty-agent.exe": (727552, "9add1a61155ec47cf6f347faf776b746eebbde1dc9360d81b8a909da34650642"),
}
INIT = "$utf8 = [System.Activator]::CreateInstance([System.Text.UTF8Encoding]); [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; if ($PSDefaultParameterValues) { $PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'; $PSDefaultParameterValues['Select-String:Encoding'] = 'UTF8' }"
EXPECTED = "中文😀".encode("utf-8")
ANSI = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def quote(value):
    """Same CreateProcess quoting as terminal/winpty.rs; no shell quoting."""
    result, slashes = '"', 0
    for char in value:
        if char == "\\":
            slashes += 1
            continue
        result += "\\" * (slashes * 2 + 1 if char == '"' else slashes) + char
        slashes = 0
    return result + "\\" * (slashes * 2) + '"'


def write_report(directory, report):
    # Reports are separate from the downloaded, verified runtime/payload.
    temporary = directory / "report.pending.json"
    temporary.write_text(json.dumps(report, ensure_ascii=True, indent=2), encoding="utf-8")
    os.replace(temporary, directory / "report.json")


def script_text():
    # The source value is exactly the smoke expression. A .NET file write
    # records its UTF-16 units and UTF-8 bytes independently of console output.
    return """$value = [string][char]0x4e2d + [char]0x6587 + [char]0xd83d + [char]0xde00;
$units = ''; foreach ($unit in $value.ToCharArray()) { $units += ([int]$unit).ToString('X4') + ',' };
$detail = 'length=' + $value.Length + ';utf16=' + $units + ';scalar=' + ([char]::ConvertToUtf32($value, 2)).ToString('X') + ';utf8=' + ([BitConverter]::ToString($utf8.GetBytes($value))).Replace('-', '');
[IO.File]::WriteAllText($env:KEEPWORK_WINPTY_UNICODE_SIDECAR, $detail, $utf8);
$p = 'KW_UNICODE_'; [Console]::Out.WriteLine($p + 'CONSOLE_BEGIN'); [Console]::Out.WriteLine($value); [Console]::Out.WriteLine($p + 'CONSOLE_END');
[Console]::Out.WriteLine($p + 'WRITE_OUTPUT_BEGIN'); Write-Output $value; [Console]::Out.WriteLine($p + 'WRITE_OUTPUT_END')\r""".replace("\n", " ")


def worker(args):
    started = time.monotonic()
    elapsed = lambda: round((time.monotonic() - started) * 1000, 3)
    output = Path(args.output_directory).resolve()
    runtime = Path(args.runtime_directory).resolve()
    report = {"diagnosticOnly": True, "acceptance": False, "probeCollected": False,
              "backend": "original pinned WinPTY 0.4.3", "times": {},
              "signatureVerification": "External signed-artifact provenance is required; this probe separately verifies fixed vendor hashes and expected runtime metadata."}
    instance = config = spawn_config = reader = writer = agent_lock = None
    read_thread = write_thread = None
    capture, capture_lock = bytearray(), threading.Lock()
    capture_status = {"totalBytes": 0, "eof": False}
    api = kernel = None
    fixture = Path(tempfile.mkdtemp(prefix="kw-winpty-unicode-"))
    report["fixture"] = str(fixture)
    profile = fixture / "isolated-profile"
    overrides = {"USERPROFILE": str(profile), "APPDATA": str(profile / "AppData/Roaming"),
                 "LOCALAPPDATA": str(profile / "AppData/Local"), "TEMP": str(profile / "Temp"), "TMP": str(profile / "Temp")}
    for directory in overrides.values():
        Path(directory).mkdir(parents=True, exist_ok=True)
    # This is a private worker process. Its parent and real profile are untouched;
    # the WinPTY agent also inherits only these isolated profile locations.
    os.environ.update(overrides)
    report["childEnvironmentOverrides"] = overrides
    (output / "pending.json").write_text(json.dumps(report, ensure_ascii=True, indent=2), encoding="utf-8")
    try:
        metadata = json.loads((runtime / "runtime.json").read_text(encoding="utf-8-sig"))
        if (metadata.get("version") != args.expected_version or metadata.get("commit") != args.expected_commit
                or metadata.get("variant") != "win7-win8" or metadata.get("buildTarget") != "x86_64-win7-windows-msvc"):
            raise ValueError("Original runtime identity does not match the explicit diagnostic inputs")
        report["runtime"] = {key: metadata.get(key) for key in ("version", "commit", "sourceHash", "buildTarget")}
        report["vendor"] = {}
        for name, (size, digest) in PINNED.items():
            file = runtime / "bin" / name
            data = file.read_bytes()
            actual = hashlib.sha256(data).hexdigest()
            if len(data) != size or actual != digest:
                raise ValueError("Pinned WinPTY integrity mismatch: " + name)
            report["vendor"][name] = {"size": len(data), "sha256": actual}

        # Fail if this fixed original-MCP80 initializer drifts from the checked
        # out production initializer, rather than silently comparing scripts.
        source = Path(__file__).resolve().parents[3] / "apps/mcp-rust/crates/keepwork-mcp/src/terminal/pty.rs"
        found = re.search(r'^const POWERSHELL_UTF8_INIT: &str = ("[^\n]+");$', source.read_text(encoding="utf-8"), re.M)
        if not found or json.loads(found.group(1)) != INIT:
            raise ValueError("Diagnostic original runtime initializer differs from the production source")
        report["initSha256"] = hashlib.sha256(INIT.encode()).hexdigest()
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        ptr, uint = ctypes.c_void_p, ctypes.c_uint32
        kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, uint, uint, ptr, uint, uint, ptr]
        kernel.CreateFileW.restype = ptr
        kernel.CloseHandle.argtypes, kernel.CloseHandle.restype = [ptr], ctypes.c_int
        kernel.ReadFile.argtypes = [ptr, ptr, uint, ctypes.POINTER(uint), ptr]
        kernel.ReadFile.restype = ctypes.c_int
        kernel.WriteFile.argtypes = [ptr, ptr, uint, ctypes.POINTER(uint), ptr]
        kernel.WriteFile.restype = ctypes.c_int
        kernel.GetSystemDirectoryW.argtypes = [ctypes.c_wchar_p, uint]
        kernel.GetSystemDirectoryW.restype = uint
        kernel.GetModuleFileNameW.argtypes = [ptr, ctypes.c_wchar_p, uint]
        kernel.GetModuleFileNameW.restype = uint
        invalid = ptr(-1).value

        # Keep the verified adjacent agent nonreplaceable through winpty_open,
        # matching the production read-only FILE_SHARE_READ handle.
        agent_lock = kernel.CreateFileW(str(runtime / "bin/winpty-agent.exe"), 0x80000000, 1, None, 3, 0, None)
        if agent_lock == invalid:
            raise ctypes.WinError(ctypes.get_last_error())
        if hashlib.sha256((runtime / "bin/winpty-agent.exe").read_bytes()).hexdigest() != PINNED["winpty-agent.exe"][1]:
            raise ValueError("Pinned WinPTY agent changed before its read-only handle was acquired")
        dll = runtime / "bin/winpty.dll"
        api = ctypes.CDLL(str(dll), winmode=8, use_last_error=True)
        module_path = ctypes.create_unicode_buffer(32768)
        length = kernel.GetModuleFileNameW(api._handle, module_path, len(module_path))
        if not length or length >= len(module_path) or not os.path.samefile(module_path.value, dll):
            raise ValueError("Loaded WinPTY DLL path differs from the verified absolute path")
        report["loadedDll"] = module_path.value

        def bind(name, result, arguments):
            fn = getattr(api, name)
            fn.restype, fn.argtypes = result, arguments
            return fn

        error_pointer = ctypes.POINTER(ptr)
        config_new = bind("winpty_config_new", ptr, [ctypes.c_uint64, error_pointer])
        config_free = bind("winpty_config_free", None, [ptr])
        size = bind("winpty_config_set_initial_size", None, [ptr, ctypes.c_int, ctypes.c_int])
        timeout = bind("winpty_config_set_agent_timeout", None, [ptr, uint])
        opened = bind("winpty_open", ptr, [ptr, error_pointer])
        conin = bind("winpty_conin_name", ctypes.c_wchar_p, [ptr])
        conout = bind("winpty_conout_name", ctypes.c_wchar_p, [ptr])
        spawn_new = bind("winpty_spawn_config_new", ptr, [ctypes.c_uint64, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_wchar_p, ptr, error_pointer])
        spawn_free = bind("winpty_spawn_config_free", None, [ptr])
        spawned = bind("winpty_spawn", ctypes.c_int, [ptr, ptr, error_pointer, error_pointer, ctypes.POINTER(uint), error_pointer])
        resized = bind("winpty_set_size", ctypes.c_int, [ptr, ctypes.c_int, ctypes.c_int, error_pointer])
        bind("winpty_free", None, [ptr])
        error_message = bind("winpty_error_msg", ctypes.c_wchar_p, [ptr])
        error_free = bind("winpty_error_free", None, [ptr])

        def checked(value, error, label):
            if not value:
                detail = error_message(error) if error.value else label
                if error.value:
                    error_free(error)
                raise RuntimeError(label + ": " + str(detail))
            return value

        error = ptr()
        config = checked(config_new(0, ctypes.byref(error)), error, "winpty_config_new")
        size(config, 80, 24)
        timeout(config, 5000)
        report["config"] = {"flags": 0, "cols": 80, "rows": 24, "agentTimeoutMs": 5000, "spawnFlags": 3}
        instance = checked(opened(config, ctypes.byref(error)), error, "winpty_open")
        config_free(config)
        config = None
        report["times"]["openedMs"] = elapsed()
        reader = kernel.CreateFileW(conout(instance), 0x80000000, 0, None, 3, 0, None)
        writer = kernel.CreateFileW(conin(instance), 0x40000000, 0, None, 3, 0, None)
        if reader == invalid or writer == invalid:
            raise ctypes.WinError(ctypes.get_last_error())

        raw_file = output / "winpty.raw"
        chunks_file = output / "chunks.jsonl"
        def read_output():
            try:
                with raw_file.open("xb") as raw, chunks_file.open("x", encoding="utf-8") as chunks:
                    buffer, count = ctypes.create_string_buffer(4096), uint()
                    while True:
                        ok = kernel.ReadFile(reader, buffer, len(buffer), ctypes.byref(count), None)
                        if not ok:
                            code = ctypes.get_last_error()
                            capture_status.update({"readError": code, "eof": code in (109, 232)})
                            break
                        if not count.value:
                            capture_status["eof"] = True
                            break
                        data = buffer.raw[:count.value]
                        with capture_lock:
                            keep = data[:max(0, LIMIT - len(capture))]
                            capture.extend(keep)
                            capture_status["totalBytes"] += len(data)
                        raw.write(keep)
                        raw.flush()
                        chunks.write(json.dumps({"elapsedMs": elapsed(), "bytes": len(data)}) + "\n")
                        chunks.flush()
            except Exception as failure:
                capture_status["error"] = str(failure)
        read_thread = threading.Thread(target=read_output, daemon=True)
        read_thread.start()

        system = ctypes.create_unicode_buffer(32768)
        length = kernel.GetSystemDirectoryW(system, len(system))
        if not length or length >= len(system):
            raise ctypes.WinError(ctypes.get_last_error())
        shell = str(Path(system.value) / "WindowsPowerShell/v1.0/powershell.exe")
        arguments = ["-NoLogo", "-NoProfile", "-NoExit", "-EncodedCommand", base64.b64encode(INIT.encode("utf-16-le")).decode("ascii")]
        command = " ".join(quote(item) for item in [shell] + arguments)
        cwd = fixture / "cwd"
        cwd.mkdir()
        sidecar = fixture / "unicode-sidecar.txt"
        environment = {key: value for key, value in os.environ.items()
                       if key.upper() not in {"TERM", "KEEPWORK_WINPTY_UNICODE_SIDECAR", *overrides}}
        environment.update(overrides)
        environment.update({"TERM": "xterm-256color", "KEEPWORK_WINPTY_UNICODE_SIDECAR": str(sidecar)})
        block = ("\0".join(key + "=" + value for key, value in sorted(environment.items(), key=lambda item: item[0].upper())) + "\0\0").encode("utf-16-le")
        environment_buffer = ctypes.create_string_buffer(block, len(block))
        report.update({"shell": shell, "arguments": arguments, "childEnvironmentOverrides": overrides,
                       "commandSha256": hashlib.sha256(command.encode("utf-16-le")).hexdigest()})
        spawn_config = checked(spawn_new(3, shell, command, str(cwd), environment_buffer, ctypes.byref(error)), error, "winpty_spawn_config_new")
        checked(spawned(instance, spawn_config, None, None, None, ctypes.byref(error)), error, "winpty_spawn")
        spawn_free(spawn_config)
        spawn_config = None
        report["times"]["spawnedMs"] = elapsed()
        deadline = started + 11
        prompt = False
        while time.monotonic() < deadline:
            with capture_lock:
                prompt = b"PS " in ANSI.sub(b"", bytes(capture))
            if prompt:
                break
            time.sleep(0.02)
        if not prompt:
            raise TimeoutError("Original default PowerShell did not produce its initial prompt")
        report["times"]["promptMs"] = elapsed()
        # The original smoke resized to 101x31 before its Unicode command.
        checked(resized(instance, 101, 31, ctypes.byref(error)), error, "winpty_set_size")
        report["resize"] = {"cols": 101, "rows": 31, "completedMs": elapsed()}
        text = script_text()
        data = text.encode("utf-8")
        report["input"] = {"script": text, "sha256": hashlib.sha256(data).hexdigest(), "writeStartedMs": elapsed()}
        def write_input():
            try:
                count, offset = uint(), 0
                while offset < len(data):
                    part = ctypes.create_string_buffer(data[offset:])
                    if not kernel.WriteFile(writer, part, len(data) - offset, ctypes.byref(count), None) or not count.value:
                        raise ctypes.WinError(ctypes.get_last_error())
                    offset += count.value
                report["input"].update({"bytesWritten": offset, "writeCompletedMs": elapsed()})
            except Exception as failure:
                report["input"]["error"] = str(failure)
        write_thread = threading.Thread(target=write_input, daemon=True)
        write_thread.start()
        complete = False
        while time.monotonic() < deadline:
            with capture_lock:
                complete = b"KW_UNICODE_WRITE_OUTPUT_END" in ANSI.sub(b"", bytes(capture))
            if complete:
                report["times"]["endMarkerMs"] = elapsed()
                break
            time.sleep(0.02)
        if sidecar.exists():
            sidecar_text = sidecar.read_text(encoding="utf-8")
            (output / "unicode-sidecar.txt").write_text(sidecar_text, encoding="utf-8")
            report["sidecar"] = sidecar_text
            report["sourceValueVerified"] = sidecar_text == "length=4;utf16=4E2D,6587,D83D,DE00,;scalar=1F600;utf8=E4B8ADE69687F09F9880"
        report["probeCollected"] = complete and report.get("sourceValueVerified", False)
    except Exception as failure:
        report["error"] = str(failure)
    finally:
        report["times"]["cleanupStartedMs"] = elapsed()
        # These are exclusively our own instance and handles. No process list,
        # AttachConsole, CtrlEvent broadcast, or arbitrary PID kill is used.
        try:
            if api and spawn_config:
                api.winpty_spawn_config_free(spawn_config)
            if api and config:
                api.winpty_config_free(config)
            if api and instance:
                api.winpty_free(instance)
                report["instanceFreed"] = True
        except Exception as failure:
            report["cleanupError"] = str(failure)
        if kernel:
            if writer and writer != ctypes.c_void_p(-1).value:
                kernel.CloseHandle(writer)
            if write_thread:
                write_thread.join(0.2)
            if read_thread:
                read_thread.join(1)
                report["readerCompleted"] = not read_thread.is_alive()
            for handle in (reader, agent_lock):
                if handle and handle != ctypes.c_void_p(-1).value:
                    kernel.CloseHandle(handle)
        with capture_lock:
            raw = bytes(capture)
            report.update(capture_status)
        report.update({"elapsedMs": elapsed(), "capturedBytes": len(raw), "truncated": report.get("totalBytes", 0) > len(raw),
                       "rawBase64": base64.b64encode(raw).decode("ascii"),
                       "rawContainsExpectedUtf8": EXPECTED in raw,
                       "rawReplacementSequences": raw.count(b"\xef\xbf\xbd")})
        try:
            report["rawUtf8Text"] = raw.decode("utf-8", errors="strict")
            report["rawUtf8Valid"] = True
        except UnicodeDecodeError as failure:
            report["rawUtf8Valid"] = False
            report["rawUtf8Error"] = {"start": failure.start, "end": failure.end, "reason": failure.reason}
        try:
            shutil.rmtree(fixture)
            report["fixtureRemoved"] = True
        except OSError as failure:
            report["fixtureRemoved"] = False
            report["fixtureCleanupError"] = str(failure)
        report["cleanupCompleted"] = bool(report.get("instanceFreed") and report.get("readerCompleted")
                                          and report.get("eof") and report.get("fixtureRemoved")
                                          and not report.get("cleanupError"))
        write_report(output, report)
    return 0 if report["probeCollected"] and report["cleanupCompleted"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-directory", required=True)
    parser.add_argument("--output-directory", required=True)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("This raw probe requires native Windows")
    if not re.fullmatch(r"[0-9a-f]{40}", args.expected_commit) or not re.fullmatch(r"\d+\.\d+\.\d+", args.expected_version):
        parser.error("Expected explicit full original commit and stable version")
    output = Path(args.output_directory).resolve()
    runtime = Path(args.runtime_directory).resolve()
    if output == runtime or runtime in output.parents or output in runtime.parents:
        parser.error("Diagnostic output must be separate from the original runtime")
    output.mkdir(parents=True, exist_ok=True)
    if args.worker:
        return worker(args)
    if (output / "report.json").exists() or (output / "winpty.raw").exists():
        parser.error("Use a fresh diagnostic output directory")
    started = time.monotonic()
    process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--worker"])
    watchdog = False
    try:
        code = process.wait(timeout=14)
    except subprocess.TimeoutExpired:
        watchdog = True
        process.kill()  # Only the Python worker we just created; never a discovered PID.
        try:
            code = process.wait(timeout=max(0.001, 15 - (time.monotonic() - started)))
        except subprocess.TimeoutExpired:
            code = None
    report_file = output / "report.json"
    pending = output / "pending.json"
    report = json.loads(report_file.read_text()) if report_file.exists() else (
        json.loads(pending.read_text()) if pending.exists() else {"diagnosticOnly": True, "acceptance": False, "probeCollected": False})
    if not report_file.exists():
        report.update({"resultMissing": True, "cleanup": "Unknown after owned-worker watchdog; native control pipe closes with the worker."})
        if (output / "winpty.raw").exists():
            report["pendingRawBase64"] = base64.b64encode((output / "winpty.raw").read_bytes()).decode("ascii")
        if (output / "unicode-sidecar.txt").exists():
            report["pendingSidecar"] = (output / "unicode-sidecar.txt").read_text(encoding="utf-8")
    report["worker"] = {"exitCode": code, "watchdogTerminated": watchdog, "elapsedMs": round((time.monotonic() - started) * 1000, 3)}
    write_report(output, report)
    print(json.dumps({"diagnosticOnly": True, "acceptance": False, "report": str(report_file),
                      "probeCollected": report["probeCollected"], "worker": report["worker"]}))
    return 1 if watchdog or code else 0


if __name__ == "__main__":
    sys.exit(main())
