# Validation — 2026-10-04

Verified locally on Windows x64:

- Title-bar height regression: the previous `height:100%` shell collapsed through
  AIChat's auto-height `#app`. The Electron smoke regression failed before the fix
  (shell bottom 114 instead of 900), then passed at 1360×900 and 1000×700 with the
  viewport-based height. Actual local AIChat homepage and resize verified visually
  in `.test-runtime/layout-fixed.png`; sidebar/composer now reach the bottom.

- Follow-up title-bar/local-development change: 12 desktop tests pass, including real
  loopback source serving and occupied-port fallback. Electron integration passes;
  actual AIChat source loaded at `http://127.0.0.1:3002/official/apps/tools/AIChat/AIChat.html`
  with the one-row title/menu bar and no native menu row. Screenshot checked under
  `.test-runtime/titlebar-local.png`. These follow-up changes are in source/dist;
  the earlier installer has not been rebuilt for this follow-up.

- Product rename to **KeepWork 第二大脑**, using the unchanged Keepwork K icon from
  `keepwork-nuxt/public/pwa/icon.png`; packaged manifest and icon bytes verified.
- Repository and app-folder VS Code Start/Build tasks and F5 launch configurations parse
  successfully. Desktop type checks, 11 tests and source/packaged Electron integration
  passed again after the rename. VS Code F5 UI and macOS launch remain manually unverified.

- Desktop TypeScript check and production source bundle.
- 11 desktop filesystem, IPC boundary, update/rollback and release-contract tests.
- Real Electron 44.1.1 native PTY creation, input, resize and exit using the pinned
  node-pty Node-API prebuilds; no Visual Studio rebuild required.
- Electron integration using actual AIChat adapters: MCP disabled, native folder selection,
  text read/write, ungranted/traversal rejection, preload absent in subframes, terminal
  input/resize, persistent grants after reload, and hide rather than exit on window close.
- The same native integration against the packaged Windows application.
- Bundled Windows MCP NodeRuntime startup/health and native PTY smoke test.
- 10 existing NodeRuntime release tests, including fixed CDN URL compatibility.
- Shared TypeScript/application-boundary checks and VS Code compile without a version bump.
- npm package content dry-run and both new workflow YAML files parsed successfully.
- Unsigned Windows NSIS installer produced under `release/`; no publication performed.

AIChat verification:

- All 25 focused desktop/helper/file-action contract tests passed.
- Existing browser folder-picker regression passed in headless Edge using a temporary
  loopback server; that server was stopped afterward.
- All 244 unit tests passed under Node 24.19.0.
- The full default profile was **not clean**: 9 integration failures and 1 catalog contract
  failure remain. Failures concern Windows symlink/Git temporary-directory permissions,
  chronicles service expectations, old chat-mode/chunk-size assertions, extracted-function
  fixtures missing chat-lifecycle helpers, and the LanguageLearner catalog expectation.
  See AIChat `.test-runtime/desktop-regression-node24.log`; these were not repaired as part
  of the desktop feature.
- Isolated historical-adapter proof: with network denied, current desktop tests fail when
  using `keepwork_fs.js` from HEAD, and pass with the new adapter. This is source isolation,
  not verification of a complete historical checkout. Logs live in AIChat
  `.test-runtime/desktop-proof/`.
- Changed JavaScript syntax and whitespace checks passed.

Still requiring release infrastructure or other platforms:

- Signed Windows installation/update and Mac signing, notarization, installation and update
  tests. Mac build/test jobs are defined but have not run from this Windows session.
- A real installed N→N+1 shell update and Mac runtime activation.
- Live Keepwork login/media permissions/cloud synchronization and full embedded-tool visual QA.
- npm/VS Code/CDN publication with configured credentials. No secrets were created or stored.
- Publication of the accompanying AIChat browser-source changes through its human-controlled
  release pipeline. Until then, the live website does not contain the new desktop adapter;
  use the documented development URL to exercise local AIChat sources.
