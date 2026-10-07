# Second Brain sidebar

Run **Keepwork: Open Second Brain**, or select the brain icon in the Activity Bar.
The sidebar embeds AIChat in its simple interface; AIChat still owns the second-brain
skills, local workspace selection, knowledge graph, conversations, and provider UI.

Choose **Continue without Keepwork account** to use a local brain and an existing AI
CLI connection. Each AI provider may require its own login. Keepwork login is optional
and enables its models and cloud features. Knowledge remains in the selected local
folder; this entry saves chat history locally. Guest and signed-in histories and brain
preferences are isolated. Logging in does not import guest conversations or upload files.

This is local second-brain storage, not a fully offline application: the hosted AIChat
interface and online AI providers need internet. The first release does not add brain
tools to MCP, distribute brain skills, or bundle a model or website.

## Settings and development

- `keepwork.secondBrain.language`: `auto` (VS Code language), `en`, or `zh-CN`.
- `keepwork.secondBrain.developmentUrl`: empty uses the canonical hosted entry
  `https://keepwork.com/official/apps/tools/AIChat/AIChat.html`. Development accepts
  only a bare loopback HTTP entry without query parameters, credentials, or fragments.
  Example: `http://127.0.0.1:3000/official/apps/tools/AIChat/AIChat.html`.
- Existing `keepwork.mcp` settings control startup, port, and authentication. The
  sidebar attaches to the shared daemon; closing/hiding it does not stop the daemon.

The iframe retains its context when hidden. Theme and language updates use the existing
`aichat.external-tool.v1` channel. AIChat must advertise `second-brain-sidebar` before
the wrapper passes `localMcp: {url, enabled, token}` in `host:config`. Tokens stay in
memory and never appear in the entry URL, webview HTML, logs, settings, or boot replies.
The VS Code API stays private to the wrapper. Only retry, status, ready, and browser
actions are accepted; no generic filesystem/terminal proxy is exposed.

Both the extension and updated AIChat source must be released for the hosted entry to
work. An older hosted page displays an update message instead of receiving credentials.
Use the development URL to validate source changes without publishing AIChat.
The canonical Keepwork page uses a same-origin `srcdoc` child. The marked sidebar
entry supports that single extra frame hop, validating its origin and exact parent
window before sending configuration. Other descendants cannot receive credentials.

## Verification

Run `npm run typecheck --prefix apps/vscode-extension` and
`node --test apps/vscode-extension/scripts/second-brain.test.cjs` from the repository root.
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

点击活动栏的「第二大脑」，或运行「Keepwork: 打开第二大脑」。可以不登录 Keepwork，
使用本地大脑与已连接的 AI CLI；AI 平台可能需要自己的账号。登录 Keepwork 后可使用其
模型与云端功能。技能仍由 AIChat 管理，访客与登录账号的数据隔离，不会自动导入或上传。
界面来自线上 AIChat，因此不承诺完全断网可用。语言设置支持英文、中文和跟随 VS Code。
