# Second brain(keepwork)

**Your digital brain powered by LLM wiki and tools.**

Second brain(keepwork) brings a personal AI workspace into VS Code and Cursor, with your second brain as the core context for AI assistance. Use LLM wiki to organize knowledge, connect AI models and agents, and work with HTML tools for students, teachers and everyday life.

The embedded AIChat workspace brings knowledge, learning and practical tasks together. Local terminal, file, Paracraft and reminder capabilities connect that workspace to your computer through the shared Keepwork MCP daemon. The broader AIChat ecosystem extends to browsers, tablets and other applications, helping you build and use a digital brain across your daily activities.

The extension retains its Marketplace ID, `Xizhi.keepwork`, and existing `keepwork.*` commands and settings for compatibility.

The extension is one application in the `keepworkExtension` repository. Shared runtime code lives in the repository-level `src/core` and `src/mcp` directories. The Windows web companion is built separately from `apps/local-helper` and is never included in the VSIX.

## Development

From the repository root:

```bash
npm ci
npm ci --prefix apps/vscode-extension
npm run compile:only --prefix apps/vscode-extension
```

Run `npm run package --prefix apps/vscode-extension` from the repository root for an intentional version bump and VSIX build. The artifact is written to `apps/vscode-extension/`.

For F5 debugging, open `apps/vscode-extension` as the VS Code workspace so its application-local `.vscode` launch and task settings are used.

## Local MCP

The daemon binds to `127.0.0.1:8089` by default. It can be started through the extension or from the repository root with `npm start --prefix apps/vscode-extension`. Its default workspace is `~/.keepwork-mcp/workspace`.

See the [repository README](https://github.com/LiXizhi/keepworkExtension#readme) for the complete API, security boundaries and KP Local Helper documentation.

## Second Brain / 第二大脑

Use **Second brain(keepwork): Open Second Brain** for AIChat's interface in the right Secondary Side Bar.
Work with local knowledge using an existing AI CLI, with optional Keepwork login.
See [setup, development and verification](docs/second-brain.md). The hosted UI needs
internet; second-brain skills remain in AIChat.
