# Keepwork for VS Code

This extension connects VS Code or Cursor to Keepwork and starts the shared Keepwork MCP daemon for local terminal, file, Paracraft and reminder capabilities.

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
