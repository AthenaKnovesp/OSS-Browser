# OSS Browser

面向 Windows x64 的 S3-compatible 对象存储桌面浏览器，使用 Tauri 2、Rust 和 React 构建。

支持中文和英文界面，可浏览 Bucket 与对象，并在底部任务面板查看传输进度。

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
- 支持空目录、中文与特殊字符 Key，以及大文件分片传输。
- 底部任务面板展示进度、分片、耗时和错误，支持取消、失败重试及详情查看。
- 同名目标支持覆盖、跳过或自动重命名。
- 支持日志查看、诊断信息、窗口单实例和界面语言切换。

## 运行

当前仅支持 **Windows x64**，运行依赖系统已有的 **Microsoft Edge WebView2 Runtime**。

- **安装版**：运行 Release 中的 `OSS-Browser-windows-x64-setup.exe`，按向导安装到当前用户。
- **免安装版**：运行目录包中的 `OSS Browser.exe`；若使用 ZIP 分发，先解压后运行。

缺少 WebView2 的机器需要先自行安装运行时。

免安装版的配置和日志保存在当前 Windows 用户的应用数据目录，移动 EXE 不会一并迁移这些数据。

## 使用

1. 新建连接，填写 endpoint、region、Access Key ID 和 Secret Access Key；根据存储服务要求选择 path-style。
2. 连接后选择 Bucket，浏览目录或通过搜索框查找对象。
3. 使用工具栏或右键菜单上传、下载及管理对象。
4. 在底部任务面板查看进度、取消任务、重试失败任务或打开任务详情。

可在设置中调整语言、下载目录、并发数、分片大小和重试次数。

不同 S3-compatible 服务的兼容性可能存在差异，首次使用时建议先通过测试 Bucket 验证上传、下载、复制和删除。提交问题报告前请移除凭据、签名 URL 和业务敏感信息。

## 开发环境

- Windows x64。
- Node.js 24 和 npm。
- Rust stable，使用 MSVC 工具链；项目声明的最低版本为 1.94.1。
- Visual Studio C++ Build Tools 与 Windows SDK。
- 系统已安装 WebView2 Runtime。

前端使用 React 19、Ant Design 6、Zustand 5、TypeScript 6 和 Vite 8；后端使用 Tauri 2、Tokio 和 AWS SDK for Rust。

### 安装依赖并启动

在项目根目录执行：

```powershell
npm ci
npm run dev
```

首次启动会编译 Rust 后端。`dev` 同时启动 Vite 和原生 Tauri 窗口。

开发和调试完整应用请使用 `npm run dev`，单独启动 Vite 无法执行真实存储操作。

### 检查与测试

```powershell
npm run lint
npm run typecheck
npm run test
npm run check:rust
npm run test:rust
npm run verify
```

`verify` 一次执行上述检查、测试和发布构建。

依赖审计：

```powershell
npm run audit
cargo install cargo-audit --locked
npm run audit:rust
```

### 构建与打包

打包前关闭从构建输出目录启动的程序，避免 EXE 被占用。

| 命令                  | 结果                                                      |
| --------------------- | --------------------------------------------------------- |
| `npm run build`       | 类型检查并生成 `src-tauri/target/release/oss-browser.exe` |
| `npm run package:dir` | 完整验证后生成 `release/win-unpacked/OSS Browser.exe`     |
| `npm run package`     | 完整验证后在 `release/` 生成 NSIS 安装 EXE                |
| `npm run clean:build` | 删除 `dist` 和 `release`，保留 Rust 编译缓存              |

需要 ZIP 免安装版时，在生成目录包后执行：

```powershell
Compress-Archive -LiteralPath 'release/win-unpacked/OSS Browser.exe','LICENSE' `
  -DestinationPath 'release/OSS-Browser-windows-x64-portable.zip' -Force
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
  capabilities/           Tauri 窗口权限配置
  src/                    Rust 命令、S3、任务、配置和安全校验
  Cargo.toml              Rust 依赖声明
  Cargo.lock              Rust 依赖锁文件
  tauri.conf.json         窗口安全策略和打包配置
tests/                    前端与通信契约回归测试
AGENTS.md                 项目开发约定
```

## 许可证

本项目采用 [MIT License](LICENSE)，版权归 AthenaKnovesp 所有。使用、修改和分发时请保留版权及许可证声明。第三方依赖遵循各自的许可证。
