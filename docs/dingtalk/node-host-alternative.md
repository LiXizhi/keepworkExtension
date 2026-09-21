# In-process AIChat host (not implemented)

Status: **not implemented**. This note records an alternative that was considered and not built. The daemon does not download AIChat, does not import `host/inbound.mjs`, and does not run `sendChatMessage` inside Node.

The implemented design is a visible Chrome window: one tab and one AIChat conversation per DingTalk group or 1:1 person, with background tabs kept running. See [architecture.md](architecture.md).

## Why it was considered

A hidden Chrome window freezes JavaScript. A headless browser is still a browser dependency. An in-process host would let the Keepwork Node daemon listen for DingTalk DMs and @me, then call the same chat function the page uses, with no Chrome process.

## Shape that was not built

- Remember the latest real AIChat page URL and Keepwork login in daemon memory. Do not write the login to disk. A frozen or closed source tab would not erase it.
- `keepwork.com/chat` would be fetched only to read `<base href="https://cdn.keepwork.com/maisi/aichat/release/<hash>/">`. The daemon would download that hash’s raw `js/` and `skills/` into `~/.keepwork-mcp/aichat-runtime/<hash>/` and import them. A localhost AIChat tree would be imported from disk. Any other origin would be rejected.
- `host/inbound.mjs` would install an in-memory `location`, storage, and a document stand-in, load the Keepwork SDK with the remembered login, and call `sendChatMessage`. It would not reimplement workspace tools, skill commands, or Keepwork MCP.
- The tool list would be the same `createConversationToolRuntime` list as a Chrome tab, including `run_terminal`, `grep_files`, `mcp_status`, `web_search`, `fetch_url`, and `computer_use`. Local skills would be the copied `skills/` tree plus installed skill records sent by the source tab. MCP calls would use loopback to the same daemon. The daemon command deny-list would stay. Terminal confirms would be treated as allowed for that turn only, because no person could click.
- The reply would be sent back to the same DingTalk chat.

## Why it is not the implementation

The live turn depends on the browser modules (`js/chat_send.js`, workspace tools, skill loading, and `js/local_mcp.js`). Running that graph under a document shim does not give the user a visible session per DingTalk thread, and it does not share Chrome’s stored conversation history. The product path is the dedicated visible Chrome window instead.
