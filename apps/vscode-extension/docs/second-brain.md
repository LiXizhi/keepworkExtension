# Second Brain sidebar

In **Second brain(keepwork)**, run **Second brain(keepwork): Open Second Brain**, or select **Second Brain** in the right Secondary Side Bar.
The default location is beside Chat/Codex/Claude Code (VS Code 1.106+); existing
user-moved locations remain respected.
The sidebar embeds AIChat in its simple interface; AIChat still owns the second-brain
skills, local workspace selection, knowledge graph, conversations, and provider UI.

Setup opens AIChat's existing seven-step onboarding guide, including its responsive
narrow-window layout. There is no extension-specific provider/folder setup form.
Use the shared guide and workspace/provider controls to configure a local brain. Each AI provider may require its own login. Keepwork login is optional
and enables its models and cloud features. Knowledge remains in the selected local
folder; this entry saves chat history locally. Guest and signed-in histories and brain
preferences are isolated. Logging in does not import guest conversations or upload files.

This is local second-brain storage, not a fully offline application: the hosted AIChat
interface and online AI providers need internet. The first release does not add brain
tools to MCP, distribute brain skills, or bundle a model or website.

## Copilot without CLI or Keepwork login

AIChat recognizes the verified VS Code host and defaults to **VS Code Copilot (Auto)**.
Open the model picker to list the Copilot models available in this editor and choose
one. The first picker or send action can open VS Code's native GitHub Copilot consent
dialog. Sign in to Copilot in the editor if needed; no Copilot CLI installation or
Keepwork account is required for this connection. Model access and quotas still
follow the editor's Copilot account.

Chat streams through the private webview bridge and `vscode.lm`. AIChat retains its
own context, tools and confirmations; this does not invoke the Copilot Chat agent.
Text and tool calls are supported; unsupported multimodal input fails explicitly.
Stop, reload and disposal cancel outstanding inference. Model/provider failures do
not fall back to Keepwork. The model picker refreshes the available catalog each time.
Guest conversations stay local. Keepwork cloud features require a Keepwork account.
The seven-step guide is optional for ordinary chat and allows local setup as a guest.

`brainModels.ts` serves only the embedded view via the existing versioned channel;
it has no HTTP endpoint. Model credentials remain in VS Code. The older CLI custom
model bridge and the Copilot CLI platform retain their separate behavior.

Validation: `node --test apps/vscode-extension/scripts/brain-models.test.cjs
apps/vscode-extension/scripts/second-brain.test.cjs` (one shell line). AIChat has
`tests/unit/vscode_lm.test.mjs` and `tests/e2e/vscode_copilot.test.mjs`. These tests use
mock editor models and do not establish live Copilot sign-in/inference availability.

## Settings and development

Open the repository root or `apps/vscode-extension` in VS Code, then choose
**Terminal → Run Task → keepwork VS code extension:Run**. The task compiles the extension
without changing its version and opens an Extension Development Host. Select the
**Second Brain** tab there to view AIChat. Run the task again after source changes to rebuild.
The task uses VS Code's `code` CLI launcher, which must be on PATH (the Windows
installer adds it; on macOS run **Shell Command: Install 'code' command in PATH**).
The chat frame fills the webview without padding or a permanent wrapper toolbar,
using AIChat's simple interface as in the desktop app. Recovery controls appear only
on connection/protocol errors.

- `keepwork.secondBrain.language`: `auto` (VS Code language), `en`, or `zh-CN`.
- Development Hosts (including the Run task and F5) serve the sibling
  `apps/official/apps/tools/AIChat` checkout on loopback, trying port 3001 upward.
  Set `AICHAT_SOURCE_DIR` before starting VS Code to select another checkout. No
  AIChat build runs; the source server closes with the extension. Missing source
  or a local page that fails to respond falls back to `https://keepwork.com/chat`.
- Normal installed runs use `https://keepwork.com/chat`, the same hosted app as
  AIChat desktop, without Keepwork document-viewer navigation.
- `keepwork.secondBrain.developmentUrl`: optional explicit loopback entry, preferred
  over automatic source serving. Unreachable entries fall back to `/chat`. Accepts
  only a bare loopback HTTP entry without query parameters, credentials, or fragments.
  Example: `http://127.0.0.1:3000/official/apps/tools/AIChat/AIChat.html`.
- Existing `keepwork.mcp` settings control startup, port, and authentication. The
  sidebar attaches to the shared daemon; closing/hiding it does not stop the daemon.

The iframe retains its context when hidden. Theme and language updates use the existing
`aichat.external-tool.v1` channel. AIChat must advertise `second-brain-sidebar` before
the wrapper passes `localMcp: {url, enabled, token}` in `host:config`. Tokens stay in
memory and never appear in the entry URL, webview HTML, logs, settings, or boot replies.
The VS Code API stays private to the wrapper. In local windows, `nativeHost` also
advertises the shared AIChat native file adapter. Folder selection uses VS Code's
`window.showOpenDialog`. File reads/writes, listing, search and deletion use
`src/core/nativeFiles.cjs`, shared with Electron desktop, without the MCP daemon.
Only explicitly selected native folders acquire persistent grants, stored in
extension global storage. Browser-restored paths must be selected again once to
grant access. Binary payloads use JSON arrays. Reveal opens the OS file manager;
open-file uses VS Code's editor. Remote windows keep their existing provider.

The versioned native request/result messages allow only roots, folder selection,
revocation and confined file operations. Source/origin checks and per-view sessions
reject stale replies; cancellation does not grant a folder. No generic Node or
terminal proxy is exposed. Desktop PTY, automatic MyBrain preparation and Git
installation remain separate optional capabilities.

Both the extension and updated AIChat source must be released for the hosted entry to
work. An older hosted page displays an update message instead of receiving credentials.
Use the development URL to validate source changes without publishing AIChat.
The `/chat` endpoint serves AIChat directly. The compatibility adapter still
validates origin and exact parent window for a single same-origin child frame;
other descendants cannot receive credentials.

## Verification

Run `npm run typecheck --prefix apps/vscode-extension` and
`node --test apps/vscode-extension/scripts/second-brain.test.cjs` from the repository root.
Native file regressions: `node --test apps/vscode-extension/scripts/brain-native.test.cjs`
and `node --test apps/aichat-desktop/tests/files.test.cjs`. With Edge installed,
`node --test apps/vscode-extension/scripts/brain-native.browser.cjs` tests the real
iframe transport and AIChat folder/file provider against temporary native files,
with MCP disabled and a stub for VS Code's folder dialog. It requires the sibling
AIChat checkout (or `AICHAT_SOURCE_DIR`). A real interactive OS dialog still needs
an Extension Development Host check.
Run `node --test apps/vscode-extension/scripts/brain-development.test.cjs` for local
source/fallback checks. With Edge installed, run
`node --test apps/vscode-extension/scripts/second-brain-layout.browser.cjs` for
narrow/wide edge-to-edge layout, recovery controls and local timeout fallback.
AIChat's `tests/e2e/second_brain_sidebar.test.mjs` covers the actual iframe, authenticated
loopback fixtures, local folders, guest setup, draft retention, language changes, and reload.
Use a VS Code Extension Development Host for real webview verification. Real provider and
Keepwork login require user-controlled authentication; fixture results do not establish
that those accounts work.

On 2026-10-08, extension type/shared-layout checks and all 15 extension tests passed.
An isolated real VS Code development host verified local source loading, daemon/CLI
connection, explicit folder selection, hide/show retention, Retry restoration, and
Chinese/light configuration. The live canonical URL loaded the older published UI
but could not complete the new handshake. The canonical frame adapter is covered by
AIChat's browser fixture; real hosted authentication remains a release check after
both source updates are published. No publication or real model inference was performed.

## 中文

点击右侧辅助侧栏的「第二大脑」，或运行「Second brain(keepwork): 打开第二大脑」。可以不登录 Keepwork，
使用本地大脑与已连接的 AI CLI；AI 平台可能需要自己的账号。登录 Keepwork 后可使用其
模型与云端功能。技能仍由 AIChat 管理，访客与登录账号的数据隔离，不会自动导入或上传。
界面来自线上 AIChat，因此不承诺完全断网可用。语言设置支持英文、中文和跟随 VS Code。
