# Win7/Win8 x64 专版构建与发布准备

仅在用户明确选择 Win7、Win8 或 Win8.1 兼容版时读取本流程。`/rust-release win7-win8`（兼容别名 `/rust-release win7`）不进入现代版 `all` 或 `mcp-server` 的构建、CDN 提升和合并步骤。按当次请求区分开发、本地打包、远端构建和发布；实现专版或编写打包流程不代表已要求触发 workflow、推送或发布。需要发布时再依据用户的发布请求和已有授权执行对应写入，不凭本文中的命令自动扩大范围。

能力、安全边界和产品支持范围统一以 [Windows CEF 兼容说明](../../../../apps/aichat-rust/docs/windows-cef.md) 为准。目标为 Windows 7 SP1 x64、Windows 8 x64、Windows 8.1 x64；首版是 C++ Launcher + CEF109 + Win7/Win8 专用 Rust MCP，不包含现代 Tauri EXE，也不提供交互式 PTY。完整验收前只能称兼容预览，不能因 Windows 编译成功或一台旧系统通过就宣布三个系统均已验收。

## 产物与渠道

| 产物 | 入口 / 标识 | 发行范围 |
| --- | --- | --- |
| Win7/Win8 Rust MCP 构建 | `apps/mcp-rust/scripts/build-win7.cjs` | 共享 Rust 源码，Win7/Win8 专用二进制；基础文件、搜索和 `run_terminal` |
| Win7/Win8 Rust MCP 归档 | `apps/mcp-rust/scripts/package-win7-runtime.cjs` | `windows-x64`，`variant: "win7-win8"`，最低系统 Win7 SP1 |
| Win7/Win8 构建入口 | `apps/aichat-rust/scripts/build-win7.cjs` | 编译旧系统 C++ 启动器，并调用专版打包器；固定 legacy CEF109，尝试启动/附着 MCP |
| Win7/Win8 安装包 | `apps/aichat-rust/scripts/package-win7.cjs` | 组装 Launcher + 兼容版 MCP；拒绝现代 Tauri EXE |
| 手动构建工作流 | `.github/workflows/aichat-rust-windows-release.yml`，`edition=win7-win8` | 复用 `aichat-rust-win7.yml`；默认 `modern` 不构建专版，构建成功不等于 VM 验收或发布 |

安装目录为 `%LOCALAPPDATA%\Programs\KeepworkWin7Win8`，安装包名为 `Keepwork_Win7_Win8_<version>_x64-setup.exe`，对外标识固定为 `variant: "win7-win8"`。普通现代版和历史 `KeepworkCompatible` 安装包不作为 Win7/Win8 专版的输入。

本轮默认准备**完整预览包**：构建/打包入口传入 `--cef <signed CEF release-dir>`，把匹配 RSA 信任根的 CEF109 归档内置安装包，安装体积相应增加。无 active 缓存时，启动器先验证并解包内置归档，因此无需先发布 CEF CDN 才能开展内核启动验收。不传 `--cef` 才是薄包：首次无缓存时需要已发布的 legacy 签名 feed。两者都不包含现代 Tauri，也不因内置 CEF 就承诺离线云聊天；不能与历史不内置 CEF 的通用兼容预览混为一种产物。

- 客户端渠道：`https://cdn.keepwork.com/keepwork/aichat-rust-win7-win8`。
- MCP 渠道：`https://cdn.keepwork.com/keepwork/mcp-win7-win8-rs`，不能消费 `mcp-stable-rs` 的普通 Windows 包。
- CEF 渠道：`https://cdn.keepwork.com/keepwork/aichat-cef/v1/legacy/windows-x64/stable.json`，使用现有 RSA 签名清单和完整宿主包。

这些是发行命名空间，不表示已有可下载产物。不得改写现代版 `aichat-rust` / `mcp-stable-rs` feed，也不得用通用兼容客户端 feed 将专版替换为现代 Tauri。客户端、MCP 和 CEF 各自保持版本及身份，不要求产品版本相等。

## 固定源码和准备构建

记录本次源码完整提交、桌面版本、MCP 独立版本，以及本次工作区是否包含未提交修改。桌面四个版本文件和 MCP 两个版本文件仍按主 Skill 同步；源码有修改的本地构建不能冒充对应提交的正式发布包。

构建发生在现代 Windows 开发机或 Windows runner，使用脚本要求的 Rust 工具链、MSVC/Windows SDK、CMake、NSIS、Node 和 Python。Win7/Win8 最终用户无需安装这些构建工具。使用新的输出目录保存每次构建及日志，保留真实工具链和依赖锁定信息，不能把普通 `x86_64-pc-windows-msvc` 产物改名当作 Win7/Win8 包。

MCP 的固定工具链和真实目标以 `apps/mcp-rust/win7-toolchain.json` 为准。它使用 `x86_64-win7-windows-msvc` 和 `-Z build-std=std,panic_abort`；路径、脚本和 Rust target 中保留的 `win7` 表示最低 OS 技术目标，涵盖本专版的 Win7 SP1/Win8/Win8.1 范围，对外身份不能回退为旧 `win7` variant。需预先安装对应 nightly 的 `rust-src`；构建脚本本身不安装工具链。在已配置 MSVC 的现代 Windows PowerShell 中执行：

```powershell
$win7Config = Get-Content apps/mcp-rust/win7-toolchain.json -Raw | ConvertFrom-Json
rustup toolchain install $win7Config.toolchain --profile minimal --component rust-src
if ($LASTEXITCODE -ne 0) { throw 'Win7 Rust toolchain installation failed' }
node apps/mcp-rust/scripts/build-win7.cjs
if ($LASTEXITCODE -ne 0) { throw 'Win7 MCP build failed' }
```

不使用 `rustup target add` 假设已有此目标的预编译标准库，也不通过 `RUSTFLAGS --cfg` 冒充 Win7 target。实际编译或 PE 导入检查失败就保留日志，不退回普通 Windows 二进制。

CEF SDK 使用 `fetch-cef-sdk.py` 的 `legacy` / `x64` 选择或经过校验的锁文件，保持 CEF109 与匹配宿主、沙箱库、资源及 locale 成套。正式信任根必须由发布方准备；临时预览密钥只可用于隔离验证。私钥不进入产物、源码或日志。现有 CEF 构建、清单签名和验证命令见产品说明，不在这里复制另一份。

legacy 宿主完成 CMake build 和 ctest 后、全 PE 审计及签名/生成包摘要前，使用 `apps/aichat-rust/scripts/prepare-win7-cef.py` 按其来源锁准备微软 Windows 8.1 SDK 官方 redist `D3DCompiler_47.dll`：

```powershell
python apps/aichat-rust/scripts/prepare-win7-cef.py --payload .tmp/win7-win8/cef-host/payload/Release --cache .tmp/win7-win8/d3dcompiler-cache
if ($LASTEXITCODE -ne 0) { throw 'Legacy D3D compiler preparation failed' }
```

准备脚本分别锁定官方 CAB 和解出 DLL 的 SHA-256，仅替换 legacy payload 中的对应依赖；不直接使用构建机系统目录或新版 SDK 的同名 DLL，不修改原始 PE 头。payload 内的 `d3dcompiler-redist-lock.json` 和 `D3DCOMPILER-REDIST-NOTICE.txt` 随 CEF SDK 锁文件一起保留；Windows 准备步骤还要求 Authenticode 有效且签名发布者为 Microsoft。

PE 审计只允许这个固定 SHA-256 的微软 redist 保留原始 `OSVersion=6.3` 元数据；其 subsystem 为 6.0，架构、原有 subsystem 阈值与导入 API 检查仍执行，其他文件不适用此例外。该特定 SDK redist 的旧系统支持和 app-local 分发依据见 [DirectX 作者说明](https://walbourn.github.io/hlsl-fxc-and-d3dcompile/)，不等于任意 CEF109 SDK 附带 DLL 都支持旧系统。现代 payload 不经此替换；静态通过仅证明本次检查通过，不能填入 CEF/UI 或三 OS native 验收结果。

完整包应先按产品说明构建 legacy CEF 宿主，再使用与专版 Launcher 相同的 RSA 信任根打包签名。以下命令假定宿主输出位于 `.tmp/win7-win8/cef-host/payload/Release`：

```powershell
node apps/aichat-rust/scripts/cef-release.cjs package .tmp/win7-win8/cef-host/payload/Release .tmp/win7-win8/cef-release C:/release-keys/legacy-private.pem
if ($LASTEXITCODE -ne 0) { throw 'Legacy CEF packaging failed' }
```

`--cef` 接受该 release 目录，包含 `legacy/windows-x64/stable.json` 签名清单及其 `objects/<sha256>.zip`，不是未签名宿主目录或单个 DLL。传入的预览 CEF 包不会自动发布到现有 CDN。

## 本地构建与打包顺序

从仓库根目录依次执行以下入口，使用各脚本的实际参数传入本次独立输出目录和产物：

1. `apps/mcp-rust/scripts/build-win7.cjs` 构建 Win7/Win8 Rust MCP。检查真实目标、构建身份及退出状态；没有生成该目标二进制时停止 MCP 打包，不以现代包顶替。
2. `apps/mcp-rust/scripts/package-win7-runtime.cjs` 生成带 Win7/Win8 标识和最低系统要求的独立归档，记录版本、完整提交、大小及 SHA-256。
3. `apps/aichat-rust/scripts/build-win7.cjs` 读取已打包的兼容版 MCP，编译原生启动器并调用 `package-win7.cjs`。提供发布方准备的 RSA 私钥，启动器固定对应公钥、Win7/Win8 模式和旧系统入口；不先构建 Tauri。
4. 内部 `apps/aichat-rust/scripts/package-win7.cjs` 组装独立安装包，并为独立 MCP feed 和客户端更新清单签名。输入包含核对过的启动器、兼容版 MCP、相应资源与许可；完整包通过 `--cef` 加入同信任根签名的 legacy CEF 归档，薄包省略此参数。不能混入现代桌面 EXE、普通 MCP 或任意 `libcef.dll`。
5. 准备发布计划并核对计划列出的所有源文件、目标身份、摘要和专版渠道。计划生成不是上传；没有独立 MCP 包或缺少任一目标系统的验收回执时，不报告专版全链路已完成。

独立 MCP 归档命令如下，`--out` 必须使用尚不存在的本次输出目录。若设置了 `CARGO_TARGET_DIR`，`--binary` 改为该目录下实际生成的文件：

```powershell
node apps/mcp-rust/scripts/package-win7-runtime.cjs --binary "apps/mcp-rust/target/$($win7Config.target)/release/keepwork-mcp.exe" --out .tmp/win7-win8/mcp-package
if ($LASTEXITCODE -ne 0) { throw 'Win7 MCP packaging failed' }
```

输出的 `windows-x64.zip` 和 `windows-x64.json` 记录 win7-win8 variant、最低系统及编译身份。此时 JSON 是未签名的打包元数据；下一步专版打包器才使用私钥生成启动器接受的签名 feed。不能直接把原始 JSON 上传为最终 feed。

接着构建并打包完整专版，使用另一全新输出目录；`--key` 是发布方提供的 RSA 私钥路径，脚本从中导出启动器公钥，不是 CEF 公钥路径：

```powershell
node apps/aichat-rust/scripts/build-win7.cjs --mcp .tmp/win7-win8/mcp-package --out .tmp/win7-win8/client-package --key C:/release-keys/legacy-private.pem --cef .tmp/win7-win8/cef-release
if ($LASTEXITCODE -ne 0) { throw 'Win7 client packaging failed' }
```

用户明确选择薄包时，从上述命令省略 `--cef` 和它的目录参数，并使用另一全新输出目录；不以省略 CEF 构建来默认生成首次无法启动的预览包。

上述构建的安装包及已签名 feed 位于 `.tmp/win7-win8/client-package/release`，`installer-payload/resources/win7-mcp` 是供 native smoke 使用的解包后 MCP runtime。独立 MCP 归档/清单地址分别为 `mcp-win7-win8-rs/<mcp_version>/windows-x64.zip` 和 `mcp-win7-win8-rs/windows-x64.json`；客户端归档在 `aichat-rust-win7-win8/<desktop_version>/Keepwork_Win7_Win8_<desktop_version>_x64-setup.exe`，签名客户端 feed 在 `aichat-rust-win7-win8/windows-x64/latest-client.json`。本地构建、签名和生成计划均不上传，也不提升 feed。CEF 清单必须由该启动器信任的公钥验证；若沿用已有正式 CEF 通道，应使用其匹配信任根，不能把临时预览公钥当作现有 CEF 通道的信任根。

操作系统代码签名应在生成受影响归档和摘要之前完成；签名改变字节后重新生成对应摘要和清单。保留构建日志、安装包描述、MCP manifest、CEF SDK 锁文件和产物校验表，不能修改既有测试报告或填入没有执行的 passed。

## 可选远端构建

用户要求远端构建时，通过唯一桌面主入口显式选择 Win7/Win8，指定已存在的明确 ref：

```bash
gh workflow run aichat-rust-windows-release.yml --ref <source-ref> -f edition=win7-win8
```

记录精确 run ID 和 `headSha`。`aichat-rust-win7.yml` 仅有 `workflow_call`，不直接 dispatch；普通无参数调用保持 `modern`，不得顺带增加 Win7/Win8 构建。现代 Windows runner 的实际构建与 source/fixture 结果独立于 Win7/Win8/Win8.1 VM 回执。

专版预览工作流先构建并打包签名 CEF109，再把该 release 目录传给桌面构建的 `--cef`，默认保留可在未发布 CEF CDN 时验证内核启动的完整包。预览临时密钥与内置 CEF 必须匹配；不能据此修改现有正式 CEF feed。

沿用主 Skill 的本机代理规则读取 GitHub：GitHub 下载走 `http://127.0.0.1:7890`，`gh` 子进程不携带七牛凭据；每次下载到新目录，保存原始 artifacts 和身份校验结果。专版使用 `download-artifacts.cjs --product win7-win8`，记录同样的代理下载回执；不能使用 `--product desktop|mcp` 的现代版匹配规则或改名混入现代 artifacts。

工作流成功只表示其实际步骤成功；下载并核对真实安装包和 MCP 归档后，再进入 VM 验收。不要把传给校验器的 `6.1.7601` 参数写成 Win7 运行环境。

## 专版更新验证

在用户明确要求检查或执行相应更新的测试机上使用启动器入口：

```powershell
.\Keepwork.exe --update-mcp
.\Keepwork.exe --update-client
.\Keepwork.exe --update-cef
```

`--update-mcp` 验签、下载并暂存 Win7/Win8 包；已有 daemon 不停止，待下一次服务启动健康检查成功才激活。pending 候选启动失败时，将其从 `pending.json` 隔离到 `failed.json`；若存在与失败候选不同的旧 `active.json`，重新验证其签名与缓存后尝试启动。此 MCP 回退不重放任务，也不保证旧版本必能启动；没有可用 active 或仍然失败时，记录问题并保留云聊天。

`--update-client` 验签并下载专版安装器，交由用户完成升级，不宣称原子安装回滚。`--update-cef` 沿用 legacy 缓存更新，失败保留已验证缓存，不自动启动旧 CEF。三者均不称为后台定时热更新。测试不能结束其他产品或未知进程来强行制造服务重启。

内置 CEF 仅解决无 active 缓存时的首次内核获取；`--update-cef` 仍读取独立签名 CDN feed，不把安装包内置归档当作线上更新服务。

## Win7/Win8/Win8.1 VM 验收

同一套专版分别在下列系统的独立实机或 VM 执行验收，逐份记录 OS build、补丁/根证书、架构、安装包/MCP/CEF 版本与 SHA-256：

| 系统 | 基线 | 必须保留的结果 |
| --- | --- | --- |
| Windows 7 SP1 x64 | `6.1.7601`，workstation，SP1 或更高 | 该系统的 MCP native smoke、安装/CEF/登录/更新回执 |
| Windows 8 x64 | `6.2.9200`，workstation | 该系统的 MCP native smoke、安装/CEF/登录/更新回执 |
| Windows 8.1 x64 | `6.3.9600`，workstation | 该系统的 MCP native smoke、安装/CEF/登录/更新回执 |

可将 `apps/aichat-rust/scripts/win7-native-smoke.ps1` 与待测 runtime 一起复制到目标机，以系统自带 PowerShell 执行基础 MCP smoke；它兼容 PowerShell 2，不依赖 Node。以下示例使用安装后的 runtime，并为本次结果选择新的目录：

```powershell
powershell.exe -NoProfile -File C:/validation/win7-native-smoke.ps1 -RuntimeDirectory "$env:LOCALAPPDATA\Programs\KeepworkWin7Win8\resources\win7-mcp" -OutputDirectory C:/validation/mcp-smoke
```

脚本在随机且非 `8089` 的隔离端口运行 `requireAuth=false` / `true` 两组，核对包身份、基础工具及 PTY unsupported，保留真实 OS 和 `scope: "mcp-native-basic-smoke"` 的回执。`nativeLegacyVerified` 只有在实际 WMI 识别到上述旧系统的 x64 workstation 且两组通过时才为真，它只覆盖报告中的 `system.osFamily`；现代 Windows 跑过仍不能标为旧系统已验收。保留三个系统的独立报告，不能编辑一个 JSON 将结果推广到其他系统。该 smoke 不启动或验证 CEF/UI，`cefUiVerified` 仍为 false，不能代替下表完整验收。

每个目标系统至少覆盖：

| 场景 | 必须观察的结果 |
| --- | --- |
| 非管理员安装、中文/空格路径、再次启动 | 安装到 `KeepworkWin7Win8`，启动器和 CEF 子进程可加载；不运行现代 Tauri；不产生第二个 daemon |
| 完整包与薄包首次启动 | 无 active 缓存时，完整包在 CEF CDN 不可用条件下仍可验证、解包并创建本地 CEF 窗口；薄包按需下载且失败保留明确错误，不运行未验证内核；云聊天另需网络 |
| 首次 HTTPS 下载与登录 | 证书校验开启，legacy 清单验签和包摘要正确；聊天页可用并在重启后保持登录；OAuth 是否通过按实际账号回执记录 |
| 本机 MCP 正常 | `/health` 显示真实 Rust 二进制身份及 Win7/Win8 标记；网页可经 loopback 连接；基础文件、目录、搜索、`grep_files` 和经确认的 `run_terminal` 可用 |
| 系统常用目录与 PowerShell 2 | Win7 默认 PowerShell 2 环境可发现实际存在的 Desktop/Documents/Downloads/Pictures/Music/Videos；重定向和本地化路径正确，位置查询不创建目录，单位置失败不影响 Home/盘符及其他浏览；不要求用户升级 PowerShell |
| PTY 不可用 | `/health` 和能力通知不含 `terminalApi`；直接请求 `/terminal/*` 得到有界 unsupported；daemon 与普通聊天/文件请求继续工作 |
| MCP 缺失、崩溃或端口被占用 | 云聊天窗口仍打开，网页显示本地功能不可用；不结束未知进程或其他产品拥有的 daemon，不另启第二个监听 |
| Origin、认证和路径 | 非允许 Origin、错误认证、路径穿越/符号链接逃逸按既有契约拒绝；相对工作区和允许的绝对路径保留历史语义 |
| 缓存与更新失败 | 中断、错误签名/摘要、错误架构、普通 Windows 包或现代 CEF 不激活；保留已验证缓存及用户数据，不重放结果不明的写操作 |
| MCP pending 启动失败 | 隔离失败候选至 `failed.json`，仅在先前另一份 active 重新验签及缓存校验通过后尝试启动；既有外部 daemon 不受影响，不重放任务；CEF 缓存保留与客户端安装不据此宣称自动回滚 |
| 网页与服务新旧组合 | 缺少/未知可选能力、旧网页+新服务、新网页+旧服务、重连或降级均不阻塞普通操作；不能把版本不等当作整机故障 |
| 卸载和现代版共存 | 不删除现代版目录，不结束非本安装归属进程；浏览器 profile、已授权工作区和已有数据按说明保留 |

CEF109 网页 JS/Web API、系统 TLS/根证书以及原生 DLL 依赖必须在三个目标旧系统上分别验证。编译、PE 检查、模拟旧版本的 fixture 和现代 Windows smoke 均不可替代。若只有 fixture 形式的新旧合同测试，写明未覆盖真实历史发行包。

## 发布、回滚与结果报告

本轮开发和流程写入不执行发布。后续用户明确要求 Win7/Win8 发布时，先确认上述产物、正式信任根和三个目标系统的独立 VM 回执完整，再按专版计划逐项操作：不可变对象先上传并下载核验，最后提升对应专版 feed，保留旧对象及已验证缓存。不得调用现代版全平台发布器来发布专版，不得为了通过验收把现代版的 `deferred` 门禁套用为“三个旧系统均已验收”。

在已要求下载构建产物的流程中，从主工作流对应的精确 run 下载专版 artifact `aichat-rust-win7-win8-x64`，然后本地预检。以下是后续操作示例，本轮文档和实现工作不执行这些命令：

```bash
node .github/skills/rust-release/scripts/download-artifacts.cjs \
  --product win7-win8 --run-id <win7_win8_run_id> --commit <full_source_commit> \
  --output .tmp/rust-release/win7-win8-<win7_win8_run_id>
node .github/skills/rust-release/scripts/publish-win7.cjs \
  --artifacts .tmp/rust-release/win7-win8-<win7_win8_run_id> \
  --version <desktop_version> --mcp-version <mcp_version> --commit <full_source_commit> \
  --public-key <trusted-public.pem>
```

`publish-win7.cjs` 默认只校验下载回执、身份、签名和字节并生成发布计划，不上传、不提升 feed。它读取的是下载根目录，不是随意拼出的安装包目录。预检可以先没有 `--acceptance`，但结果必须保留未验收状态，不能据计划成功宣布已可正式发布。

实际写入必须使用同一下载根目录和固定源码身份，补齐三系统验收文件，再显式选择发布：

```bash
node .github/skills/rust-release/scripts/publish-win7.cjs \
  --artifacts .tmp/rust-release/win7-win8-<win7_win8_run_id> \
  --version <desktop_version> --mcp-version <mcp_version> --commit <full_source_commit> \
  --public-key <trusted-public.pem> --acceptance <3OS-acceptance.json> --publish true
```

正式发布要求客户端编译身份 `sourceDirty: false`，版本、完整提交、MCP provenance 和下载回执一致；三个旧系统各自具有真实 MCP native report，以及对应 CEF/UI/更新验收。`nativeLegacyVerified` 只是单份 MCP 报告的范围标记，不能替代完整验收文件。缺项时保留预检计划和待验收状态，不伪造报告、不绕过门禁、不自动降成现代版的 deferred 发布。

发布器另核对产物中的 `build-scope.json`：必须记录 `signing: "production"` 且 `productionTrustRoot: true`；缺失或为 preview 时，即使源码干净、三系统验收齐全也禁止写 CDN。应使用正式信任根重新构建，不能编辑预览范围记录或把临时密钥产物改标为 production。

`--acceptance` 的最小结构如下，**这是待验收结构示意，不是可发布回执**。`null` 表示尚未填写结论；操作者必须在对应系统实际完成 CEF/UI 和安装升级验收后填写真实布尔结果，并引用当次非空证据文件。不能批量把占位值改成 `true` 或创建空日志充数。

```json
{
  "schemaVersion": 1,
  "variant": "win7-win8",
  "version": "<desktop_version>",
  "mcpVersion": "<mcp_version>",
  "commit": "<full_source_commit>",
  "installerSha256": "<installer_sha256>",
  "systems": [
    {
      "osFamily": "windows7-sp1",
      "mcpReport": "windows7-sp1/mcp/report.json",
      "cefUi": { "passed": null, "evidence": "windows7-sp1/cef-ui.log" },
      "installerUpgrade": { "passed": null, "evidence": "windows7-sp1/installer-upgrade.log" }
    },
    {
      "osFamily": "windows8",
      "mcpReport": "windows8/mcp/report.json",
      "cefUi": { "passed": null, "evidence": "windows8/cef-ui.log" },
      "installerUpgrade": { "passed": null, "evidence": "windows8/installer-upgrade.log" }
    },
    {
      "osFamily": "windows8.1",
      "mcpReport": "windows8.1/mcp/report.json",
      "cefUi": { "passed": null, "evidence": "windows8.1/cef-ui.log" },
      "installerUpgrade": { "passed": null, "evidence": "windows8.1/installer-upgrade.log" }
    }
  ]
}
```

三个 `osFamily` 必须各出现一次。所有证据路径相对于该验收 JSON 所在目录，必须是真实、非空、未链接且限制在该目录内的文件，不能使用绝对路径或 `..`。每份 MCP 原始报告必须属于相应 OS，`nativeLegacyVerified` 为真且 auth 开/关两组都通过；其实际二进制 SHA-256、版本、commit、sourceHash 必须匹配本次 MCP 包。`installerSha256` 匹配本次已签名客户端清单中的安装包摘要。

`cefUi` 和 `installerUpgrade` 是操作者另行执行并记录的 CEF/UI、安装升级验收，不由 MCP PowerShell smoke 推导。发布器检查结构、身份和证据文件，但不能代替操作者进行 GUI 验证；只有三个系统各自真实通过后才可提供可发布回执。没有验收文件时仍可运行默认预检，返回的 pending / productionReady 状态必须原样报告。

`--public-key` 必须是发布方确认的真实受信公钥，不能因预览 artifact 自带 `release-public.pem` 就把它当作生产信任根。预览临时密钥签出的 CEF109 包可供匹配启动器的隔离验收，不能提升现有正式 legacy CEF feed；正式发布时应以匹配既有 CEF 信任根的产物重新核对签名和全部摘要，不能只换公钥文件掩盖不匹配。

七牛凭据和本机上传网络隔离沿用主 Skill：凭据只进入发布进程环境，GitHub 使用本机代理，CDN 上传直连；缺少发布授权时保留可审查计划并报告边界，不手写或伪造线上清单。客户端、MCP 和 CEF 三类更新分别核对渠道与身份，禁止自动跨到现代版；写入结果不确定时先读取远端对象/清单确认，不盲目重试。

最终分别列出源码/fixture 检查、Windows 构建、Win7/Win8/Win8.1 VM 实测和 CDN 发布状态。附实际版本、提交、产物位置/摘要及未验证功能；仅完成本地构建时写“已构建兼容预览”，仅编写流程时写“流程已准备”，不要报告已发布或已正式支持。
