# AGENTS.md

## 项目与开发原则

OSS Browser 是 Windows x64 的 S3-compatible 桌面浏览器：Tauri 2 + Rust 后端，React 19 + Ant Design 6 + Zustand 5 + TypeScript strict 前端。Node/npm 仅用于开发构建。

- 所有新增或修改文本使用 UTF-8 无 BOM，写入时显式指定编码；中文直接写中文。
- 修改前检查调用方、测试和实际行为；不确定的产品选择先说明并询问。
- 保留已有未提交改动。只做当前任务需要的修改，不顺手重构。
- 优先删除无引用代码、重复状态和无意义的包装；不保留旧实现或预留兼容层。
- 不以精简为由删除现有功能、安全边界、防丢失处理、无障碍支持或必要的并发控制。
- 多步任务先说明步骤及验证方式，完成后说明结果和未验证范围。

## 构建与验证

Windows 开发使用 Node 24、Rust stable MSVC（最低 1.94.1）、Visual Studio C++ Build Tools 和系统 WebView2。TypeScript 固定使用最新 6.x，保留 ESLint 与通信契约测试依赖的编译器 API；暂不采用 TypeScript 7 或双版本兼容包。

```powershell
npm install
npm run dev             # Tauri + Vite
npm run typecheck
npm run lint
npm run test            # Vitest：桥接、契约、刷新、打包
npm run check:rust      # rustfmt + Clippy，警告视为错误
npm run test:rust
npm run verify          # 上述检查和测试，再构建发布程序
npm run build           # 类型检查并构建发布程序
npm run package:dir     # 验证后生成 release/win-unpacked/OSS Browser.exe
npm run package         # 验证后生成 release 下的 NSIS 安装包
npm run audit           # 官方 npm registry，high/critical 为 0
npm run audit:rust      # RustSec 审计，按 Windows x64 实际依赖区分告警
npm run clean:build     # 清理 dist/release，保留 Rust 编译缓存
```

- 安装器固定 `webviewInstallMode.type = skip`；不附带、不下载、不安装 WebView2，也不设置触发安装的最低版本检查。
- 目录包生成前清空 `release/win-unpacked`，其中只包含本次 Tauri exe，避免混入旧运行时。
- 只格式化本次修改的文件。不要对整个项目运行 format。
- 业务变更运行类型检查和相关测试；Rust、通信、构建变更运行 verify；打包变更运行 package。
- 发布前另运行 audit 和 audit:rust。Rust 审计需要开发工具 `cargo install cargo-audit --locked`；Windows 依赖中的漏洞阻断，维护/unsound 告警和其他平台条目保持可见。
- SDK 升级已移除旧 lru 与 pin-utils；本次 Windows Rust 审计无告警，其他平台条目仍保持可见。npm 的 minimatch 中危告警仍来自开发工具链，需按实际调用条件评估，不强制跨主版本覆盖上游依赖；不得静默忽略新增公告。
- 前端变更在桌面窗口检查启动、连接表单、对象表、搜索、右键菜单、任务面板拖动、通知及语言切换。
- 外部 S3 集成测试默认忽略；仅对隔离的 loopback 服务运行，测试凭据为 test/test：

```powershell
$env:OSS_BROWSER_TEST_S3_ENDPOINT = "http://127.0.0.1:5077"
cargo test --manifest-path src-tauri/Cargo.toml external_s3_compatible_full_operation_chain -- --ignored
```

不得未经明确确认对真实 Bucket 执行破坏性操作；模拟协议测试不能证明所有厂商兼容性。
SeaweedFS 4.54 实测覆盖小文件、101 MiB 往返、特殊字符 Key、同名文件/目录合并和下载提交。该服务对新建空目录的 CopyObject 有兼容限制，目录合并测试预置目标空目录占位；不要据此宣称所有厂商的空目录复制均已验证。

## 代码入口

- `src-tauri/src/main.rs`：窗口、单实例、导航限制、运行时开关和退出。
- `commands.rs`：dispatch、参数解析、活动连接校验、对话框和诊断；业务放在 service 中。
- `config.rs`：配置、DPAPI、串行保存、原子替换和备份；`model.rs`：Serde DTO。
- `s3.rs`：S3、目录上传、分片传输和复制；`tasks.rs`：调度、重试、取消和目标占用。
- `safety.rs`：Key/Prefix 和本地路径校验；`logger.rs`、`error.rs`、`i18n.rs`：日志、错误、翻译。
- `src/shared`：业务类型、OssApi/命令名、前端设置默认值和中英文 JSON 词条。
- `src/renderer/src/desktop.ts`：Tauri 通信桥接；`main.tsx` 先初始化桥接再挂载 React。
- `layouts/MainLayout.tsx`：标题栏、BucketTree、工作区、任务面板及设置弹窗；对象详情由 ExplorerPage 的弹窗承载。
- `pages`、`components`、`stores`：现有页面、AntD 控件和 Zustand 状态；`styles.css` 集中管理样式。
- `scripts/package.mjs`：复制发布程序和安装包；`tests` 与 Rust tests 检查契约、业务及回归行为。

路径别名：`@shared/*` → `src/shared/*`，`@renderer/*` → `src/renderer/src/*`。
`dist`、`release`、`src-tauri/target`、`src-tauri/gen` 是生成目录，不修改为源码或提交。
`build` 是图标资源目录，不能整体忽略。项目不再维护 Electron 主进程、preload 或旧构建输出。

## 通信与界面

- 前端通过 `window.ossApi` 调用 `dispatch({ channel, args })`；不直接访问 Node、文件系统或 AWS SDK。
- 新能力同步修改共享类型/OssApi、desktop 映射、Rust DTO/dispatch、业务与调用点；保持字段 camelCase 和参数顺序。
- Rust 必须校验输入和活动连接 ID，拒绝过期连接请求；不要以 UI 校验替代可信边界校验。
- 桥接先完成底层事件注册，再挂载 React；注册失败或卸载时清理监听，保留同步取消订阅接口。
- 任务、日志、最大化事件分别为 task:updated、log:added、window:maximized-changed；AppError 在前端恢复为 Error。
- capabilities 只开放主窗口所需监听和拖动权限，不开放通用 fs、shell 或远端访问。
- 应用内禁止外部导航；仅允许 http/https/mailto 由系统打开。
- 复用现有 AntD 组件、图标、store 和样式，保持紧凑桌面布局，不做无关视觉改动。
- AntD 6 使用 orientation、Drawer.size、mask.closable、Space.Compact 等当前 API；消息和确认弹窗使用 App.useApp()，启动副作用也必须处于 App 上下文内。不要恢复静态消息服务或弃用的组合控件。
- Vite 8 使用 rolldownOptions.output.codeSplitting；显式保留原构建目标和分包意图。TypeScript 路径映射直接使用相对路径，不恢复 baseUrl 或添加 ignoreDeprecations。
- CSP 由 Tauri 配置；AntD 动态样式及静态提示需要页面 nonce。标题栏用 data-tauri-drag-region，交互控件不能成为拖动区域。
- 保留虚拟表格稳定尺寸、requestId 防旧请求覆盖、分页与任务完成后的合并刷新；高频事件在前端批量合并。
- 仅保留默认浏览页、页内对象搜索和底部任务面板，不维护独立搜索页、任务页或页面切换状态。活动连接保存后清空 Bucket、对象及选择，失效旧读取并重新加载；远程操作提交前校验捕获的连接 ID 与 updatedAt。
- 日志快照期间缓冲事件并按 ID 合并；清空使旧快照失效。对象首屏与后续分页使用同一排序规则。
- 本地化单元格的更新条件必须包含语言变化；不要只比较对象字段，否则切换语言后会保留旧文案。
- TaskTable 的类型、状态、信息和操作列随翻译更新，不使用仅比较任务字段的单元格缓存；回归覆盖成功/失败任务及操作按钮提示。
- 文案放入 locales/zh-CN.json 和 en-US.json；Rust/TS 共用词条。前端按配置解析语言，不维护全局翻译状态。

## 配置、日志与文件安全

- 新配置仅使用 app_config_dir/tauri-v2/config.json，不读取或覆盖旧应用数据。
- DPAPI 使用当前 Windows 用户范围；不可用时凭据仅留内存，不降级明文/Base64 持久化。
- 返回前端前移除 secret/session token，用 hasSecretAccessKey 告知是否已有密钥；编辑时留空继续使用已有密钥。
- 配置保存串行执行、同步临时文件后原子替换并保留有效备份；损坏配置不能被默认值静默覆盖。
- 备份必须通过同一配置解析流程；关闭凭据保存或删除连接时，先清理备份中的对应数据，失败不能报告保存成功。
- 活动连接只在会话中保存；连接校验不改保存时间，仅保存配置时更新 updatedAt，客户端缓存直接比较连接值。
- 默认任务并发 3、分片并发 4、分片 8 MiB、重试 2；同名 ask 映射为安全自动重命名。
- 下载目录必须存在且可写；savePath 仍限于该目录。解析真实父目录，阻止路径穿越、junction/symlink 逃逸、设备名和 ADS。
- 下载写入受控 .oss-browser-partials 临时文件；验证范围和长度后提交，失败/取消清理。自动重命名最多 9999 个后缀。
- Windows 下载通过 Win32 原子移动提交，按覆盖策略控制 REPLACE_EXISTING，不依赖硬链接；不允许覆盖时目标已出现必须失败并保留原文件。
- 日志内存最多 5000 条、前端 2000 条、本地两份各 5 MiB；日志及诊断脱敏凭据、Authorization、签名 URL 和 URL 用户信息。

## S3 与任务不变量

- endpoint 缺协议时按 ssl 补齐，region 默认 us-east-1；保留 path-style、默认 Bucket、MIME 和 1 小时签名 URL。
- 已有源 Key/Prefix 原样校验，不改变空格、反斜杠、重复斜杠或点段；新目标严格规范化，UTF-8 最多 1024 字节。
- 文件夹以 trailing slash Key 表示；新 Prefix 为空或以 / 结尾。
- 完成目标规范化后再检查长度、文件尾斜杠和目录重叠；同 Bucket 的目录源、目标禁止相等或互为祖先。互不重叠的同名目录合并，只自动改名文件，已有占位对象跳过；移动时可条件删除空源占位对象。
- 小于 100 MiB 单请求，大对象 multipart/Range；part 为 5 MiB–5 GiB、最多 10000 个，copy 自 5 GiB 起分片。
- 支持 disabled/CRC32/SHA256，服务要求 SHA256 时告警重试；删除保留 Content-MD5，每批最多 1000 个 Key，前缀操作分页处理。
- copy/move/rename 支持 overwrite/skip/autoRename；同次 HEAD 捕获的 VersionId/ETag 绑定复制及删除。复制失败不删源，目标已建但源未删报告 partial_success。
- VersionId 为字符串 null 时仍是可变版本，删除必须带捕获的 ETag；无可靠身份时保留源对象。AWS SDK 仅启用 http-1x、default-https-client、rt-tokio，不启用未用的 SigV4a 和 legacy TLS。
- 目录上传跳过符号链接/非普通文件，保留空目录；文件内容流式传输，不经 IPC 传递大数据。
- 批量上传先完成全批次路径/Key 校验，再在同一队列锁内提交，最后统一调度；校验失败不得产生任务，保留占用目标的跳过规则。
- 每任务使用不可变连接快照；任务并发 1–8、分片并发 1–16、每个 scoped client 最多 16 个请求。
- 保留 SDK 请求 future 的堆分配，避免 Windows 调试构建嵌套异步操作栈溢出；连接超时 10 秒、请求尝试/读超时 120 秒、交互读取总超时 30 秒。
- 进度节流 250ms，前端任务合并 100ms；只有 failed 可手动重试，copy/move/rename 不自动重试整个操作。
- 并发写入先预留本地/远程最终目标，按连接/Bucket/Key 或重叠 Prefix 检测冲突；自动重命名后也必须先占用目标再写入。
- cancel 中止并移出等待队列；运行结束前不释放占用，也不被 clear 移除。退出取消任务，最多等 3 秒；multipart abort 使用独立有界清理。
