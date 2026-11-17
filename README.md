# OSS Browser

面向 Windows x64 的 S3-compatible 对象存储桌面浏览器，使用 Tauri 2、Rust 和 React 构建。

提供中文和英文界面，以默认浏览页、页内对象搜索和底部任务面板组织日常操作。

## 下载

[最新 Release](https://github.com/AthenaKnovesp/OSS-Browser/releases/latest) · [全部版本](https://github.com/AthenaKnovesp/OSS-Browser/releases)

| Windows x64  | 下载地址                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 安装版       | [下载安装 EXE](https://github.com/AthenaKnovesp/OSS-Browser/releases/latest/download/OSS-Browser-windows-x64-setup.exe)    |
| 免安装版     | [下载便携 ZIP](https://github.com/AthenaKnovesp/OSS-Browser/releases/latest/download/OSS-Browser-windows-x64-portable.zip) |
| SHA-256 校验 | [SHA256SUMS.txt](https://github.com/AthenaKnovesp/OSS-Browser/releases/latest/download/SHA256SUMS.txt)                     |

免安装版解压后运行 `OSS Browser.exe`。运行需要系统已有 WebView2；安装器不会自动下载安装运行时。当前二进制未进行代码签名。

## 功能

- 管理多个连接，支持自定义 endpoint、region、path-style 和默认 Bucket。
- 分页浏览 Bucket 和对象，查看元数据，生成有效期为 1 小时的签名 URL。
- 上传文件和目录、下载、新建文件夹、删除、复制、移动及重命名。
- 支持空目录、中文与特殊字符 Key，以及大文件分片上传、Range 下载和分片复制。
- 底部任务面板展示进度、分片、耗时和错误，支持取消、失败重试及详情查看。
- 提供同名目标处理、并发目标占用保护和复制后源对象身份检查。
- 支持日志查看、诊断信息、窗口单实例和界面语言切换。

## 运行

当前仅支持 **Windows x64**，运行依赖系统已有的 **Microsoft Edge WebView2 Runtime**。

- **安装版**：运行 Release 中的 `OSS-Browser-windows-x64-setup.exe`，按向导安装到当前用户。
- **免安装版**：运行目录包中的 `OSS Browser.exe`；若使用 ZIP 分发，先解压后运行。

安装器不附带、下载或安装 WebView2。缺少 WebView2 的机器需要先自行准备运行时。

免安装仅表示无需安装应用；配置和日志仍保存在当前 Windows 用户的应用数据目录，不保存在 EXE 旁。

发布文件由维护者上传至 GitHub Releases，源码仓库不包含 EXE、ZIP、依赖目录或编译缓存。

## 开发环境

- Windows x64。
- Node.js 24 和 npm。
- Rust stable，使用 MSVC 工具链；项目声明的最低版本为 1.94.1。
- Visual Studio C++ Build Tools 与 Windows SDK。
- 系统已安装 WebView2 Runtime。

前端使用 React 19、Ant Design 6、Zustand 5、TypeScript 6 和 Vite 8；后端使用 Tauri 2、Tokio 和 AWS SDK for Rust。具体依赖以 `package-lock.json` 和 `src-tauri/Cargo.lock` 为准，请保留两个锁文件。

### 安装依赖并启动

在项目根目录执行：

```powershell
npm ci
npm run dev
```

首次启动会编译 Rust 后端。`dev` 同时启动 Vite 和原生 Tauri 窗口。

`npm run dev:frontend` 仅启动 Vite；真实 S3、文件和系统操作依赖 Tauri 后端，不能把普通浏览器页面当作完整应用使用。

### 检查与测试

```powershell
npm run lint
npm run typecheck
npm run test
npm run check:rust
npm run test:rust
npm run verify
```

`verify` 依次执行 ESLint、TypeScript、前端测试、Rustfmt、Clippy、Rust 测试和发布构建。前端测试覆盖通信契约、状态竞争、刷新、路径显示和语言更新；Rust 测试覆盖配置、路径安全、任务调度及模拟 S3 协议行为。

依赖审计：

```powershell
npm run audit
cargo install cargo-audit --locked
npm run audit:rust
```

npm 审计以 high/critical 为失败阈值，其他告警仍需检查。Rust 审计按 Windows x64 实际依赖区分阻断漏洞和其他平台条目。

### 构建与打包

打包前关闭从构建输出目录启动的程序，避免 EXE 被占用。

| 命令                  | 结果                                                      |
| --------------------- | --------------------------------------------------------- |
| `npm run build`       | 类型检查并生成 `src-tauri/target/release/oss-browser.exe` |
| `npm run package:dir` | 完整验证后生成 `release/win-unpacked/OSS Browser.exe`     |
| `npm run package`     | 完整验证后生成 `release/OSS Browser_0.1.0_x64-setup.exe`  |
| `npm run clean:build` | 删除 `dist` 和 `release`，保留 Rust 编译缓存              |

目录包生成前会清空 `release/win-unpacked`。需要 ZIP 免安装版时，在生成目录包后执行：

```powershell
Compress-Archive -LiteralPath 'release/win-unpacked/OSS Browser.exe' `
  -DestinationPath 'release/OSS Browser_0.1.0_x64-portable.zip' -Force
```

版本号由根目录 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 维护，发布时应同步更新。

## 项目结构

```text
build/                    应用图标资源
scripts/                  打包和 Rust 依赖审计脚本
src/
  renderer/               React 界面、组件、状态和 Tauri 通信适配
  shared/                 共享类型、命令、设置默认值和中英文词条
src-tauri/
  capabilities/           主窗口所需的最小权限
  src/                    Rust 命令、S3、任务、配置和安全校验
  Cargo.toml              Rust 依赖声明
  Cargo.lock              Rust 依赖锁文件
  tauri.conf.json         窗口安全策略和打包配置
tests/                    前端与通信契约回归测试
AGENTS.md                 项目开发约定和安全不变量
```

`build` 是源码资源目录，应提交到 Git。`dist`、`release`、`node_modules`、`src-tauri/target` 和 `src-tauri/gen` 是生成目录，已加入 Git 忽略规则。

## 配置与安全边界

- 配置使用 Tauri 应用配置目录下的 `tauri-v2/config.json`，Windows 默认位置为 `%APPDATA%\com.ossbrowser.desktop\tauri-v2\config.json`。
- 不读取、迁移或覆盖旧 Electron 配置；活动连接只保留在当前会话。
- 持久化凭据使用 Windows 当前用户范围的 DPAPI 加密；不可用时仅保存在内存，不降级为明文保存。
- 配置采用串行保存、原子替换和有效备份恢复；损坏配置不会被默认值静默覆盖。
- 下载在受控临时目录中流式写入，校验后提交目标文件；失败或取消时清理临时文件。
- 日志和诊断会脱敏凭据、签名 URL 等信息，但提交问题报告前仍应检查内容，不要公开连接配置、凭据或真实业务数据。
- 前端通过 `window.ossApi` 调用 Rust，未开放通用文件系统或 shell 权限。

## 传输与兼容性

- 默认任务并发为 3，分片并发为 4，分片大小为 8 MiB，任务重试次数为 2。
- 任务并发范围为 1–8，分片并发范围为 1–16。
- 100 MiB 起使用分片上传或 Range 下载；分片大小限制为 5 MiB–5 GiB，最多 10000 个分片；复制从 5 GiB 起使用 multipart copy。
- 删除请求每批最多 1000 个 Key，保留 Content-MD5；支持 disabled、CRC32 和 SHA256 校验设置。
- 批量上传先校验整个批次再入队。复制成功后才尝试删除源对象；无法安全删除时保留源对象并报告部分成功。

不同 S3-compatible 服务对校验和、条件删除和分片复制的支持存在差异。模拟协议测试和本地测试不能证明所有厂商兼容性，请先在隔离 Bucket 验证操作行为。

## 许可证

本项目采用 [MIT License](LICENSE)，版权归 AthenaKnovesp 所有。使用、修改和分发时请保留版权及许可证声明。第三方依赖遵循各自的许可证。
