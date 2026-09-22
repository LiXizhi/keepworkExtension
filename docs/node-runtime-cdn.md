# NodeRuntime CDN 下载约定

供 Electron 宿主、安装器及其他客户端获取当前 Keepwork MCP NodeRuntime。
首次 CI 发布成功后，以下固定地址提供最新构建。后续发布覆盖同名文件；
地址不包含版本号、时间戳或 hash。每次发布共 6 个文件。

## 平台与下载地址

| 系统与架构 | 独立 package 清单 JSON | Runtime ZIP |
| --- | --- | --- |
| macOS Apple Silicon（arm64） | [macos-arm64.json](https://cdn.keepwork.com/keepwork/mcp-runtime/macos-arm64.json) | [macos-arm64.zip](https://cdn.keepwork.com/keepwork/mcp-runtime/macos-arm64.zip) |
| macOS Intel（x64） | [macos-x64.json](https://cdn.keepwork.com/keepwork/mcp-runtime/macos-x64.json) | [macos-x64.zip](https://cdn.keepwork.com/keepwork/mcp-runtime/macos-x64.zip) |
| Windows x64 | [windows-x64.json](https://cdn.keepwork.com/keepwork/mcp-runtime/windows-x64.json) | [windows-x64.zip](https://cdn.keepwork.com/keepwork/mcp-runtime/windows-x64.zip) |

Node.js/Electron 的 `process.platform === 'darwin'` 映射到 `macos`，
`process.platform === 'win32'` 映射到 `windows`；架构使用 `process.arch`。
目前只提供上述三种组合，不提供 Linux 或 Windows arm64 原生包。

每个 `<platform>-<arch>.json` 就是对应 ZIP 的独立 package 描述文件，
不需要先请求总清单，也不是 ZIP 内 `app/package.json` 的 npm 依赖清单。

## JSON 字段

以下为 `macos-arm64.json` 的结构示例（hash、commit、时间和大小以实际文件为准）：

```json
{
  "schemaVersion": 1,
  "product": "keepwork-mcp-node-runtime",
  "version": "0.1.0",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "nodeVersion": "22.23.2",
  "platform": "macos",
  "arch": "arm64",
  "builtAt": "2026-09-22T02:00:00.000Z",
  "url": "https://cdn.keepwork.com/keepwork/mcp-runtime/macos-arm64.zip",
  "fileName": "macos-arm64.zip",
  "size": 55000000,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 清单格式版本，当前为 `1` |
| `product` | 固定为 `keepwork-mcp-node-runtime` |
| `version` | `apps/mcp-runtime/package.json` 中的应用版本 |
| `commit` | 构建源码的完整 Git commit SHA（40 位十六进制） |
| `nodeVersion` | ZIP 内 Node.js 的版本 |
| `platform` / `arch` | 目标系统与架构 |
| `builtAt` | 该平台包生成时的 UTC ISO 8601 时间 |
| `url` / `fileName` | 固定 ZIP 地址与文件名 |
| `size` | ZIP 原始文件的字节数 |
| `sha256` | ZIP 原始文件的 SHA-256，小写 64 位十六进制 |

同一应用版本也可能产生新构建。客户端以 `sha256` 判断 ZIP 是否变化，
用 `commit` 追溯源码，用 `builtAt` 展示构建时间，不应只比较 `version`。

## 客户端获取流程

1. 根据系统和架构下载对应 JSON，验证 `schemaVersion`、`product` 和目标平台。
2. 如果已安装包记录的 `sha256` 与清单一致，可跳过下载。
3. 从 JSON 的 `url` 下载 ZIP 到临时文件，校验字节数和 SHA-256。
4. 校验通过后解压到新目录，保留 macOS 文件执行权限和符号链接。
5. 读取解压目录中的 `runtime.json`，按其中的入口、参数和环境变量启动服务。
6. 健康检查通过后，再将该包及其 JSON 记录为当前安装版本。

ZIP 与 JSON 是分别覆盖的，发布过程中可能暂时不匹配。若校验失败，丢弃
本次临时 ZIP，稍后重新获取 JSON 和 ZIP；采用有限次数重试，持续失败时保留
当前可运行版本并报告更新失败。不能运行未经匹配校验的 ZIP。

macOS arm64 手动下载示例：

```bash
curl --fail --location --output macos-arm64.json \
  https://cdn.keepwork.com/keepwork/mcp-runtime/macos-arm64.json
curl --fail --location --output macos-arm64.zip \
  https://cdn.keepwork.com/keepwork/mcp-runtime/macos-arm64.zip
shasum -a 256 macos-arm64.zip
```

将计算结果与 JSON 的 `sha256` 比较，并核对文件字节数等于 `size`，然后解压：

```bash
unzip macos-arm64.zip -d keepwork-runtime
```

## ZIP 内容与启动依据

```text
runtime.json
LICENSE-node.txt
bin/node                 # macOS
node.exe                 # Windows
app/
  cli.cjs
  package.json
  node_modules/
```

每个包仅包含对应系统的 Node 可执行文件。`runtime.json` 提供 `entry`、`args`、
`env` 和 `health` 等启动配置。使用包内 Node 启动 `app/cli.cjs`，应用其环境变量
和参数；健康接口为 `http://127.0.0.1:8089/health`。服务已有兼容实例时应附着，
避免重复启动。

实现依据：

- [CI 工作流](../.github/workflows/mcp-node-runtime.yml)：三个原生平台构建、解压运行验证及发布任务。
- [ZIP 与 JSON 生成](../apps/mcp-runtime/scripts/package-runtime.cjs)：固定文件名、构建时间、大小和 SHA-256。
- [发布脚本](../apps/mcp-runtime/scripts/release.cjs)：仅覆盖这 6 个对象，刷新并校验 CDN 内容。
- [发布测试](../apps/mcp-runtime/scripts/release.test.cjs)：验证固定地址、两次覆盖、hash 校验与 ZIP 文件权限。
