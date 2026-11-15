# Android dev.4 runtime diagnosis — 2026-11-15

Final APK remains unchanged: SHA-256 `afb8995888d1a3c5f97065c6b32481d33fd598f1cd544b9a04df97d65856da40`. No native source edits, product rebuild, commit or push occurred in this diagnostic round. All device operations targeted `AiPetOfflineApi35`, emulator-5584, dedicated adb 5039. The root coordinator alone shut down the project iOS review device for the later comparisons; this Android chat never operated iOS or unrelated host apps.

## Current status — final APK target and full smoke passed; cleanup verified

The controlled `-gpu host` comparison selected a genuinely distinct renderer: GLES `host`, Android Emulator OpenGL ES Translator (Apple M5), OpenGL ES 3.0 (4.1 Metal - 90.5), with Vulkan Apple M5 and no recorded fallback warning. Profile remains 3072 MiB / 4 cores, initialized AVD without wipe, unchanged final APK. Unrelated host apps were unchanged during this successful run. Renderer evidence: `build/native-evidence/runs/host-20261115-000732-0fa975/renderer.json`.

Target `early-target-20261115-001339-def87f` passed every scoped check in 128.596 seconds. Actual font readbacks were 1.0 and 2.0; final Stop bounds were `[32,1104,688,1176]` and `[32,1093,688,1176]`, inside measured safe vertical bounds 36–1208. Active→clicked Stop→Ended took 8.134 and 17.603 seconds measured before Start input, below the 25-second gate and 30-second fake lease expiry. Screenshot inspection confirms the 2x Stop is fully above navigation controls.

In-app Stop and revocation both had live window/service assertions before removal and absence afterward. Permission restoration and force-stop/reopen did not resurrect an overlay; each reopened foreground UI also passed a real preview-toggle round trip. Font, overlay app-op and notification permission restored to 1.0, allow and true with exact readbacks and no errors. The corrected full smoke also **passed** on this same retained host instance: `20261115-001746-22e38f/runtime-checks.json`, scope `full`. It covers six locales, persistence, seven poses, preview controls, overlay Home/drag, three Stop paths, running language-switch ownership, revoke/restore and force-stop/reopen, and normal/2x final Stop deliberately at the end. Its crash buffer is empty. This closes the previously outstanding final-APK emulator gates.

The first host target passed normal-font Stop but exposed a harness locator issue at 2x: fast flings skipped the session-status row. Controlled 350-pixel/650-ms drags corrected that locator; this did not change native code or the APK. Hardware GLES is a demonstrated practical resolution for the target on this Mac; the ultimate software-compositor stall cause is not fully isolated, and other hosts still require renderer and runtime verification.

Full-run font and airplane originals restored/read back as `1.0` and `1`, with no errors. Final device readbacks additionally confirmed overlay `allow` and notifications `granted=true`, matching the target originals. The app was force-stopped, then the owned emulator and dedicated adb stopped. `cleanup-verification.json` confirms PID 79005 absent, ports 5039/5584/5585 not connectable and no `lsof` matches. The Android runtime slot is free. Combined evidence is `build/native-evidence/runs/host-acceptance-summary.json`.

Reproduce with the tracked hardware-renderer launcher and attached smoke workflow in [README](../README.md#runtime-verification-on-this-mac); historical debug launcher commands below are retained only as diagnostic history.

All sections below are historical failed/partial attempts, superseded by the current status above. Their pending language describes the state at that time.

## Historical minimal early-session target failed at UI gate

A fresh root-authorized ten-minute lower-load window was used for exactly one minimized attempt. Original 3072 MiB / 4 cores / GPU auto and initialized AVD data were unchanged; no APK rebuild or wipe occurred. Run `early-target-20261114-233405-10c782` launched dev.4 successfully (`TotalTime: 1405 ms`, `WaitTime: 1407 ms`) but the actual-UI gate found a **System UI ANR dialog**. `completed-checks.json` is empty: neither font check nor any overlay operation was reached. The proposed order/minimization test therefore did not overcome the startup environment failure; it neither passes nor disproves the app's layout/Stop behavior.

The 23:33:12 System UI startup ANR again shows its main thread waiting in `BpSurfaceComposer::getGpuContextPriority` / `SurfaceControl.getGPUContextPriority`, matching the earlier system-startup trace. This differs from the later app-focus ANR recorded in the previous partial run. The ultimate compositor/platform cause remains unresolved, and two authorized paused workloads were insufficient to guarantee startup stability.

Original settings were restored and read back exactly: font `1.0→1.0`, overlay app-op `allow→allow`, notifications `true→true`; no restoration errors. The owned emulator and dedicated adb were explicitly shut down, and root was notified the slot was free for iOS/avatar restoration. No second attempt or profile change was made. The unchanged APK hash remains the one above. New evidence includes `outcome.json`, `system-app-anr.txt`, `fresh-launch.txt`, `latest-ui.xml`, timings and restoration JSON in that run directory.

Outstanding checks remain normal/2x final Stop bounds and actual Active→clicked Stop→Ended within 25 seconds, strengthened live-before in-app Stop/revoke assertions, and stable actual foreground after reopen. Prior split-run results below remain partial; no full-suite success exists.

## Earlier partial acceptance under authorized lower host load

The original 3072 MiB / 4 cores / GPU auto profile became usable after root paused the two authorized avatar processes and stopped only the project iOS review simulator. Package/Activity/UI probes were 0.037/0.999/2.531 seconds and the actual language picker was visible without system ANRs. This supports host contention as a contributing factor; it does not isolate one workload or prove the ultimate scheduler/compositor cause.

Final-APK run `20261114-225408-3ddb01` passed six locale selections/persistence, French process-restart persistence, seven pose controls, preview switches, 2x language-picker reachability, permission fallback, Settings intent, Home/drag, pet-tap removal, running language-switch service/window identity, notification Stop, and absence assertions after in-app Stop and revocation. It then failed on a 30-second permission-restore command timeout. A bounded readback confirmed the write had become `allow`. The in-app Stop/revoke branches have since gained explicit pre-Stop live-window/service assertions; those stronger assertions have not yet run.

The targeted continuation `remaining-20261114-230110` observed no automatic overlay after permission restoration, explicitly showed a live overlay, force-stopped it and observed no window/service after reopen. The reopened UI later displayed an app ANR, so this is **not** a stable-reopen acceptance pass. ANR at 23:01:52 reports a 5098 ms focus-event wait; its sampled main thread is in MessageQueue.nativePollOnce/ART condition waiting, with no actionable app-method blocking stack. It differs from the earlier System UI SurfaceComposer stack. A single isolated recovery, `layout-20261114-230604`, ended with launcher UI rather than the application. No further attempt followed.

**Still pending:** normal/2x final Stop full visibility and actual click/session-ended before lease expiry, plus stable reopened UI after the late ANR. No full-suite success is claimed. Structured partial status is `build/native-evidence/runs/split-acceptance-status.json`, with all three run directories and identical APK hash. Each run restored/read back original font settings; the full run also restored airplane mode. AVD and dedicated adb were explicitly shut down. Root owns restoration of its iOS device and paused avatar apps; this Android chat did not signal those host processes.

The harness now persists and validates every Activity reopen result, instead of silently discarding `am start -W` status. Syntax checks and the three bounded-readiness tests pass; this harness-only tightening does not change the APK or turn earlier partial runs into passes.

## Minimal target used in the latest attempt (historical invocation)

The following procedure was used only after root released the fresh exclusive paused-load window. It is not authorization for another attempt. The original 3072 MiB / 4 cores / GPU auto profile and unchanged final APK remain the baseline. The distinct hypothesis is order/minimization: run the previously blocked font/Stop checks early in a fresh initialized session, before locale/overlay/revocation churn. This is not a claim that the late-session ANR cause is known.

From this app directory, after root authorization:

```sh
python3 .toolchains/diagnostics/start-owned.py
# Only after its bounded boot check passes:
python3 scripts/targeted-runtime-checks.py --budget-seconds 300
```

The target itself never starts a device or adb server. It verifies ownership, APK hash, actual resumed foreground Activity and visible application UI with no ANR dialog. It reads the existing selected language without changing it. It then runs normal/2x final Stop FIRST: read back and persist requested/actual font scale, visible Active state, exact Stop bounds above measured system bars, real click, and Ended observed within 25 seconds measured BEFORE Start input is issued. It subsequently checks explicit window+service presence before in-app Stop and revocation, absence afterward, and actual visible foreground UI after permission restoration and force-stop/reopen without resurrection. Original font, overlay app-op and notification permission are restored and read back in finally; the owned package is stopped. Emulator/adb lifecycle cleanup remains with the diagnostic owner.

The main target has a fixed 300-second deadline; individual cleanup commands have five-second limits. Combined with the 180-second boot budget this leaves time within a ten-minute host-pause guard for explicit device cleanup. Each run has separate artifact, timing, partial-check and restoration records. No success file is written unless every scoped assertion and restoration passes. Offline replay rejected the captured launcher XML and accepted the captured healthy app XML without any device access. Native execution subsequently failed at the initial System UI ANR gate as recorded above; no scoped checks passed.

## Red loop and harness correction

A debug-only captured-launch replay returned red in 0.001 seconds for `Status: timeout`, `WaitTime: 58332`. At the actual readiness-loop seam, the original uncaught `subprocess.TimeoutExpired` reproduced two failing regression tests. `scripts/emulator_runtime.py` now catches only command timeout, records it, and consumes the fixed original deadline rather than extending it. Three regression tests passed. Boot completion, package service, window service, Activity launch and UI automation are distinct checks. A successful XML dump alone does **not** imply a usable application UI; the explicit language-picker/no-system-dialog check remained red.

Harness changes also provide per-run evidence directories, local/installed APK SHA-256 matching, skip reinstall when the hash already matches, measured visible system-bar frames, a fixed-profile assertion, exact final Stop clicking with session-ended observation before fake lease expiry, original font/airplane-setting restoration plus readback in `finally`, and `--attach` for the already running owned instance. These improve evidence quality; they do not constitute device acceptance.

## Measured comparisons

All attempts reused initialized owned AVD data without factory wipe. The boot deadline was 180 seconds. Reused initialization advances over time, so improved later timing alone cannot establish resource changes as causal.

| Run directory under `build/native-evidence/runs` | Android profile / host condition | Boot probes (timeouts), median command | Subsequent observations |
| --- | --- | --- | --- |
| `20261114-215446-5328a5` | 3072 MiB, 4 cores, GPU auto; project iOS review device running | 106 (2), 0.476 s; failed at 180.067 s | Boot never ready; no acceptance attempted |
| `health-20261114-215914` | Requested 2048 MiB, emulator raised it to 2560 MiB; other conditions unchanged | 90 (0), 0.2495 s; ready | Activity 15.518 s, UI dump 4.674 s; Quickstep then System UI ANR dialogs blocked acceptance |
| `health-20261114-220711` | Restored 3072 MiB / 4 cores / auto; root stopped only project iOS review device | 48 (0), 0.1005 s; ready | Package 0.118 s, Activity 4.197 s, UI dump 3.509 s; System UI ANR obscured language picker |
| `health-20261114-221209` | Same 3072 MiB / 4 cores / host condition; only GPU option changed to swiftshader | 43 (0), 0.098 s; ready | Package 0.105 s, Activity 3.193 s, UI dump 4.255 s; same System UI ANR and absent language picker |

The original auto-selected backend was Vulkan Lavapipe plus GLES SwANGLE/ANGLE using SwiftShader. The explicit `swiftshader` option actually changed Vulkan to SwiftShader while GLES remained SwANGLE; this observed difference, rather than the CLI option label alone, defines the comparison.

## Strongest diagnostic evidence

`health-20261114-220711/dropbox-anr.txt` contains the 22:07:56 System UI startup ANR. Its main thread is waiting in Binder → `BpSurfaceComposer::getGpuContextPriority` → `SurfaceControl.getGPUContextPriority` → `SystemUIApplication.onCreate`. SurfaceFlinger used about 85% CPU over the recorded interval; guest memory pressure avg10 was zero. This motivated the graphics-backend hypothesis rather than an arbitrary resource retry.

The 22:12:47 System UI startup ANR under explicit SwiftShader has the same main-thread wait. Guest memory pressure avg10 was 0.02 and CPU pressure avg10 21.99. Changing Vulkan backend did not eliminate the symptom. These traces implicate waiting on the graphics/compositor service but do **not** identify its ultimate cause. High host contention remains plausible; it is not proven solely by swap use or process CPU readings. The reduced-memory guest still had approximately 1.6 GB available before shutdown, so guest RAM exhaustion was not established.

Two attached acceptance failures from the reduced-memory experiment and one from restored original configuration have their own evidence, including `latest-ui.xml` and successful original settings readback. A single Quickstep dialog was explicitly closed during the reduced-memory diagnosis, but the subsequent System UI dialog was treated as failure; recurring system ANRs were not hidden or accepted. No full runtime report was emitted from these red runs.

## Historical handoff before the authorized lower-load run

Automatic resource-profile experiments stopped after the SwiftShader comparison. The owned emulator and dedicated adb were shut down. Final guest setting readback was font scale `1.0` and airplane mode `1`, matching the captured originals; per-run restoration JSONs contain no errors. Root may restore its project iOS review device. No unrelated workload was stopped.

Final-APK acceptance remains outstanding: normal/2x last Stop visibility and real click/session-ended, three overlay Stop paths, revoke/restore/no resurrection, force-stop/reopen, running language-switch service/window invariants, and final locale/pose UI. Earlier pre-inset partial passes are not substituted for current-APK evidence. The next runtime action requires root coordination about host workload or a separately justified environment change; no further blind boot loop is queued.

## Superseded diagnostic handoff (historical)

The debug launcher has been reset to the original **3072 MiB / 4 cores / GPU auto** profile. The SwiftShader option exists only in the historical experiment evidence; it is not the next-run default. APK hash remains unchanged. No device retry is authorized until root releases it after the user's workload decision.

Confirmed conclusions: (1) the harness's premature abort on one probe timeout was a real defect and is fixed/tested; (2) recurring guest System UI startup ANRs block the app, with the main thread waiting on SurfaceComposer's GPU-context-priority Binder call; (3) the Vulkan backend comparison did not resolve this symptom. Not confirmed: the ultimate compositor stall cause, whether unrelated host workloads are causal, whether lowering guest RAM improves reliability, or whether the final app's outstanding runtime checks pass.

After root authorizes the next run, from the Android app directory: run `python3 .toolchains/diagnostics/start-owned.py` (initialized owned AVD, no wipe, fixed 180-second boot budget), then each `python3 .toolchains/diagnostics/runtime-health.py --stage package`, `--stage activity`, and `--stage ui`. Before acceptance, inspect the generated UI hierarchy for the actual `language_picker` and absence of system ANR dialogs; an XML dump by itself is insufficient. Only if that gate passes, use `python3 scripts/smoke-emulator.py --attach` for the full final-APK suite. It preserves the diagnostic instance and restores original tested settings; explicit owned-emulator and dedicated-adb shutdown remains required afterward. Capture host workload state for the comparison without modifying any other variable.
