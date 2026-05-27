# AGENTS.md

本文件用于帮助未来的 Codex/Agent 快速理解和维护本项目。请在修改代码前先阅读本文件，再结合相关源码确认细节。

## 用户与文件约束

- 所有新增或修改文件必须使用 UTF-8 无 BOM。
- 禁止写入 UTF-16、GBK 或其他非 UTF-8 编码。
- 中文内容直接写中文，不要写成 `\uXXXX` 转义。
- 文件写入必须显式保持 UTF-8。
- 开发前端功能时，优先使用项目已引入的开源组件，尤其是 Ant Design 和 `@ant-design/icons`，避免手搓已有组件库可以覆盖的基础控件。

## 项目定位

这是一个 Windows 桌面端 S3-compatible 对象存储浏览器，产品名为 `OSS Browser`。它使用 Electron 承载桌面能力，主进程负责 S3、文件系统、配置、日志、任务队列等高权限能力，渲染进程负责 React/Ant Design UI，并通过 preload 暴露的 `window.ossApi` 与主进程通信。

核心能力包括：

- 管理对象存储连接配置。
- 测试连接、加载 Bucket、浏览对象和文件夹。
- 上传文件、上传文件夹、保留空文件夹占位对象。
- 下载对象到本地安全目录。
- 删除、复制、移动、重命名对象或文件夹前缀。
- 新建文件夹占位对象、查看对象元数据、生成 1 小时有效的签名 URL。
- 大文件分片上传、Range 下载、multipart copy。
- 任务队列、并发控制、重试、取消、进度和分片状态展示。
- 日志记录、通知、诊断信息导出和敏感信息脱敏。
- 跟随系统/简体中文/英文界面语言切换。

## 技术栈

- Electron 38。
- electron-vite 4。
- Vite 7。
- React 19。
- TypeScript 5，`strict: true`。
- Ant Design 5 和 `@ant-design/icons`。
- Zustand 5 作为渲染进程状态管理。
- AWS SDK v3 S3 client，用于兼容 S3/OSS/MinIO 等对象存储。
- mime-types 用于上传对象 Content-Type 推断。
- dayjs 用于日期格式化。
- Prettier 和 ESLint 负责格式与静态检查。

## 常用命令

在项目根目录运行：

```powershell
npm run dev
npm run clean:build
npm run typecheck
npm run lint
npm run build
npm run package:dir
npm run package
```

说明：

- `npm run dev` 启动 electron-vite 开发模式。
- `npm run clean:build` 清理 `out` 和 `release` 生成目录。
- `npm run typecheck` 执行 `tsc --noEmit`。
- `npm run lint` 执行 ESLint。
- `npm run build` 先 typecheck，再执行 electron-vite build。
- `npm run package:dir` 会清理 `out` 和 `release`，然后生成 Windows 目录包。
- `npm run package` 生成 Windows NSIS 安装包。
- `npm run format` 会对全项目执行 Prettier，使用前确认不会制造无关格式化噪声。

当前没有看到独立测试脚本。修改业务逻辑后至少运行 `npm run typecheck`；涉及打包、preload、Electron 主进程路径或构建配置时运行 `npm run build`。

## 目录结构

```text
.
├─ build/                         Electron Builder 资源，如 icon.ico/icon.png/test-icon.png
├─ out/                           electron-vite 构建输出，生成物
├─ release/                       electron-builder 输出，生成物
├─ src/
│  ├─ main/
│  │  ├─ main.ts                  Electron 主入口、窗口创建、运行时开关、退出清理
│  │  ├─ preload.ts               contextBridge 暴露 window.ossApi
│  │  ├─ ipc/registerIpc.ts       所有 IPC handler、参数校验、错误归一化
│  │  ├─ services/
│  │  │  ├─ s3Service.ts          S3 对象操作与业务编排
│  │  │  ├─ s3ClientFactory.ts    S3Client 创建、client key、删除 Content-MD5 middleware
│  │  │  ├─ s3TransferUtils.ts    分片、Range 写入、并发、临时文件与任务统计工具
│  │  │  ├─ directoryScanner.ts   上传本地目录扫描、空目录和跳过项统计
│  │  │  ├─ taskManager.ts        任务队列、并发、进度、取消、重试
│  │  │  ├─ logger.ts             内存日志、脱敏、事件推送
│  │  │  ├─ error.ts              AppError、PartialOperationError、友好错误映射
│  │  │  ├─ s3Safety.ts           Bucket/Key/Prefix 校验与规范化
│  │  │  └─ pathSafety.ts         下载路径穿越防护、同名文件策略
│  │  └─ store/configStore.ts     配置与凭据存储、safeStorage 加密、脱敏返回
│  ├─ renderer/
│  │  ├─ index.html
│  │  ├─ public/icon.png
│  │  └─ src/
│  │     ├─ App.tsx               渲染入口、启动加载、AntD 主题
│  │     ├─ main.tsx              React 挂载
│  │     ├─ styles.css            全局布局和组件样式
│  │     ├─ layouts/              标题栏、侧栏、主工作区、底部任务面板
│  │     ├─ pages/                Explorer、Search、Tasks
│  │     ├─ components/           对象表、任务表、连接表单、工具栏等
│  │     ├─ stores/               Zustand stores
│  │     ├─ types/                renderer UI 类型
│  │     └─ utils/                格式化和对象 Key 工具
│  └─ shared/
│     ├─ configDefaults.ts        配置默认值，供 main 和 renderer 共用
│     ├─ i18n.ts                  中英文文案、语言偏好解析和运行时翻译
│     ├─ ipc.ts                   IPC channel 常量和 OssApi 接口
│     └─ types.ts                 主进程与渲染进程共享业务类型
├─ electron.vite.config.ts        Electron 主进程/preload/renderer 构建配置
├─ tsconfig.json                  TypeScript 配置和路径别名
├─ eslint.config.js
└─ package.json
```

不要把 `out/`、`release/`、`node_modules/` 当作源码修改。`build/` 是打包资源目录，通常只在更新图标等资源时触碰。

## 路径别名

`tsconfig.json` 和构建配置已定义：

- `@shared/*` -> `src/shared/*`
- `@main/*` -> `src/main/*`
- `@renderer/*` -> `src/renderer/src/*`

主进程可以使用 `@shared` 和 `@main`。preload 使用 `@shared`。渲染进程使用 `@shared` 和 `@renderer`。新增代码优先沿用这些别名。

## 国际化约定

- 用户可见文案、错误、日志和设置项优先放在 `src/shared/i18n.ts`。
- 当前支持 `system`、`zh-CN`、`en-US`；`system` 会按系统语言解析为中文或英文。
- 主进程启动后根据配置调用 `setI18nLanguage()`，渲染进程在配置加载和语言变化时同步 AntD 与 dayjs locale。
- 新增文案时同时补齐中英文 key，组件中使用 `translate()` 或本地 `t()` 包装，不要把新用户可见文案散落在业务逻辑里。

## 主进程架构

### `src/main/main.ts`

职责：

- 读取启动时外观设置并配置 Chromium 运行时。
- 创建无边框 BrowserWindow，窗口最小尺寸为 1100x720，默认最大化显示。
- 开启 `contextIsolation: true`，关闭 `nodeIntegration`，通过 preload 暴露安全 API。
- 限制外部跳转，只允许 `http:`、`https:`、`mailto:`，其他协议会被阻止并写日志。
- 实例化 `Logger`、`ConfigStore`、`S3Service`、`TaskManager`。
- 注册 IPC。
- 启动时清空 active connection，避免应用打开后自动带着上次连接执行 S3 操作。
- 退出时取消/等待任务、销毁 S3 client。

注意：

- `configureChromiumRuntime()` 在窗口创建前执行，硬件加速和 GPU shader cache 开关依赖 `userData/config.json`，保存后需要重启应用才生效；同时会设置 Chromium cache 和 Electron `sessionData` 目录。
- `mainWindow.webContents.setWindowOpenHandler` 和 `will-navigate` 是安全边界，新增外链能力时不要绕开。
- preload 路径是 `../preload/preload.mjs`，构建配置变更后要验证 `npm run build`。

### `src/main/preload.ts`

只做一件事：通过 `contextBridge.exposeInMainWorld('ossApi', api)` 暴露 `OssApi`。渲染进程不应直接访问 Node/Electron API。

新增 IPC API 时，必须同步更新：

1. `src/shared/ipc.ts` 的 `IPC_CHANNELS`。
2. `src/shared/ipc.ts` 的 `OssApi` 接口。
3. `src/main/preload.ts` 的 `api` 实现。
4. `src/main/ipc/registerIpc.ts` 的 handler。
5. 渲染进程调用点、store 或组件。

### `src/main/ipc/registerIpc.ts`

这是主进程所有业务入口的集中注册点。重要约定：

- 使用本文件内的 `handle()` 包装 `ipcMain.handle`，统一捕获异常、`normalizeError()`、写日志后再抛给渲染进程。
- 所有来自渲染进程的参数都要先校验，不要相信 UI 侧校验。
- Bucket、Key、Prefix 必须使用 `s3Safety.ts` 中的函数。
- 下载路径必须走 `pathSafety.ts`。
- S3 类读取接口通常先 `refreshActiveConnection()`。
- 任务类接口通常先 `refreshActiveTaskConnection()`，拿到完整连接和最新传输设置。
- 切换连接、保存设置后要同步 `TaskManager` 并发数。
- `APP_GET_DIAGNOSTICS` 返回前必须脱敏配置、清理任务错误详情，不要把凭据或签名 URL 放进诊断结果。

不要在 renderer 中绕过这些校验，也不要把未校验的对象直接传给 `S3Service`。

## 配置与凭据

`src/main/store/configStore.ts` 管理配置：

- 配置文件位于 `app.getPath('userData')/config.json`。
- 配置默认值集中在 `src/shared/configDefaults.ts`，供主进程和渲染进程共用。
- 传输默认值：任务并发 3、单对象分片并发 4、分片 8 MiB、重试 2、下载同名策略 `ask`，实际会映射为安全自动重命名。
- 安全默认值：本地保存凭据、删除前确认；日志和诊断导出始终强制脱敏。
- 外观默认值：语言跟随系统、不禁用硬件加速、不禁用 GPU shader disk cache；`compactMode` 默认关闭。
- 凭据保存时使用 Electron `safeStorage`；如果不可用，则使用 `base64:` 作为兼容降级。
- `get()` 返回给渲染进程前会脱敏：`secretAccessKey` 和 `sessionToken` 置空，使用 `hasSecretAccessKey` 告知 UI 是否已有本地密钥。
- 编辑连接时，Secret 留空表示继续使用本地已保存密钥。

严禁把真实 `secretAccessKey`、`sessionToken` 或完整签名 URL 暴露给渲染日志、普通 UI 文案或错误详情。

## S3 服务约定

`src/main/services/s3Service.ts` 是对象存储业务核心，底层 client 创建、目录扫描和传输工具已拆到同目录独立模块。

客户端行为：

- endpoint 如果没有协议，会根据连接的 `ssl` 自动加 `https://` 或 `http://`。
- `region` 默认为 `us-east-1`。
- `forcePathStyle` 直接来自连接设置。
- 使用 AWS SDK v3 `S3Client`。
- request handler 使用 `NodeHttpHandler`，连接超时 10 秒，请求/socket 超时 120 秒。
- HTTP/HTTPS agent 开启 keepAlive，最大 socket 数 128。
- 切换连接时基于连接关键字段生成 client key，不同则销毁旧 client。
- 删除对象和批量删除会安装 Content-MD5 middleware，提高 S3-compatible 服务兼容性。
- 上传普通文件会尽量用 `mime-types` 推断 Content-Type。

对象/目录约定：

- 文件夹以 trailing slash 的 S3 Key 表示。
- `normalizeS3Prefix()` 输出为空字符串或以 `/` 结尾的 prefix。
- 普通文件对象 Key 不能以 `/` 结尾。
- `assertS3Key(..., { allowTrailingSlash: true })` 只用于文件夹、prefix 或允许目录语义的对象操作。
- Key 不允许以 `/` 开头、不允许 `//`、不允许控制字符、不允许独立 `.` 或 `..` 段，UTF-8 字节长度不能超过 1024。
- 上传本地目录时，符号链接会跳过，非普通文件会跳过。

传输行为：

- 小于 100 MiB 倾向单请求上传/下载；大对象使用 multipart 上传或 Range 下载。
- 最小 part size 5 MiB，最大 5 GiB，自动保证 part 数不超过 10000。
- 上传校验算法由连接 `checksumAlgorithm` 控制：`disabled`、`CRC32`、`SHA256`。
- 如果服务要求 SHA256 且当前不是 SHA256，会记录告警并用 SHA256 重试。
- copy 超过 5 GiB 走 multipart copy。
- 批量删除按 1000 个 Key 分批。
- copy/move/rename 的目标存在策略包括 `overwrite`、`skip`、`autoRename`；UI 默认传 `autoRename`。
- `generateObjectUrl()` 生成 1 小时有效的签名 GET URL，日志和诊断中不得泄露完整 URL。

新增 S3 行为时优先放在 `S3Service`，不要把 AWS SDK 调用散落到 IPC 或 renderer。

## 任务队列

`src/main/services/taskManager.ts` 管理上传、下载、删除、复制、移动、重命名任务。

重要约定：

- 每个任务是 `TaskItem`，类型和状态定义在 `src/shared/types.ts`。
- 并发数由设置控制，`TaskManager` 会 clamp 到 1-16。
- 大对象上传、Range 下载和 multipart copy 的单对象分片并发也由设置控制，并 clamp 到 1-16。
- 任务进度推送节流为 250ms。
- renderer 侧 `taskStore` 再以 100ms 批量合并高频更新。
- 终态包括：`success`、`failed`、`partial_success`、`canceled`、`stopped`。
- 只有 `failed` 状态允许 retry。
- cancel 会 abort 当前任务，并从等待队列移除。
- shutdown 会取消等待和运行中的任务，最多等待 3 秒。
- `withConnection()` 会为每个任务创建 scoped `S3Service`，任务结束后销毁连接，避免并发任务共享同一个可变 active client。

新增任务类型时需要同步更新：

- `TaskType` 和相关请求类型。
- `IPC_CHANNELS` 和 `OssApi`。
- preload。
- `registerIpc.ts`。
- `TaskManager` enqueue/run 逻辑。
- renderer 的 `TaskTable` 过滤和展示文案。

## 日志与错误

`src/main/services/logger.ts`：

- 日志仅保存在当前进程内存中，不写入本地磁盘。
- `logger.list()` 返回当前进程内存日志，诊断信息只截取最近日志。
- `Logger.operation()` 会根据 operation status 映射 `info/warn/error/success`。
- `Logger` 通过事件推送日志给 renderer，renderer 侧只保留有限条数用于展示。
- 日志必须脱敏：签名 URL、`X-Amz-*`、`Authorization`、access/secret/session token 等都不能原样写入。

`src/main/services/error.ts`：

- 主进程业务错误优先抛 `AppError`。
- 部分成功使用 `PartialOperationError`。
- 其他错误统一走 `normalizeError()` 映射为用户友好中文消息，同时把原始错误名和 message 放入 detail。
- renderer 通常只展示 `error.message`。

新增日志时不要包含凭据、完整签名 URL、Authorization header、真实 session token。

## 下载路径安全

`src/main/services/pathSafety.ts` 是本地文件写入安全边界：

- `resolveDownloadTarget()` 会要求默认下载目录存在且可写。
- 如果 UI 提供 `savePath`，仍会被限制在默认下载目录内。
- `assertPathInside()` 防止路径穿越。
- 同名策略：
  - `overwrite`：直接覆盖。
  - `skip`：存在则跳过。
  - `autoRename`：自动生成 `name (1).ext`，最多尝试 9999。

新增任何本地写入能力时，都应先确认目标路径是否需要类似边界，不要直接信任 renderer 传入的绝对路径。

## 渲染进程架构

`src/renderer/src/App.tsx`：

- 启动时检查 `window.ossApi`，缺失则显示 preload 错误页。
- 首次加载并行执行 `getConfig()`、`loadLogs()`、`loadTasks()`。
- 订阅 `onLogAdded` 和 `onTaskUpdated`。
- 上传、删除、复制、移动、重命名成功或部分成功后，会按当前连接和 Bucket 刷新对象列表。
- 注册全局 `error` 和 `unhandledrejection`，把 renderer 异常写入日志 store。
- 使用 Ant Design `ConfigProvider` 定义主题 token，并按语言切换 AntD/dayjs locale；当前是浅色、偏工作台的密集 UI。

Zustand stores：

- `appStore.ts`：全局 UI 状态，活动页面、设置弹窗、编辑连接、搜索词、配置。
- `connectionStore.ts`：Bucket 列表，使用 requestId 避免旧请求覆盖新状态。
- `objectStore.ts`：当前 Bucket/Prefix、对象列表、选中对象、分页、预取、加载全部；有 requestId 和 cancel 机制。
- `taskStore.ts`：任务列表，批量合并高频任务更新。
- `logStore.ts`：日志列表，最多保留 2000 条 renderer 内存日志，批量追加。

页面与布局：

- `layouts/ActivityBar.tsx`：主功能入口，切换浏览、搜索、任务和设置。
- `layouts/TitleBar.tsx`：自定义无边框窗口标题栏、日志通知、窗口按钮。
- `layouts/Sidebar.tsx`：包装 `BucketTree`。
- `layouts/MainLayout.tsx`：整体 Shell、左侧连接树、主工作区、底部可拖拽任务面板、设置 modal。
- `layouts/DetailPanel.tsx`：对象详情侧栏。
- `pages/ExplorerPage.tsx`：核心对象浏览、上传、下载、复制、移动、重命名、删除、详情。
- `pages/TasksPage.tsx`：任务列表。
- `pages/SearchPage.tsx`：对象搜索页，支持当前目录、本 Bucket、指定 Prefix 和基础筛选。
- 设置入口在 `layouts/MainLayout.tsx` 的 modal 中承载，不再有独立 Settings 页面。

组件约定：

- 表格优先使用 AntD `Table`，大列表使用 `virtual` 和固定 `scroll` 尺寸。
- 文本溢出优先使用 `OverflowTooltip` 和 CSS ellipsis。
- 图标优先使用 `@ant-design/icons`。
- 表格列、回调、过滤结果使用 `useMemo`、`useCallback`、`memo` 减少重渲染。
- 高频 UI 更新不要直接每次 set 全量状态，参考 task/log store 的批量策略。
- CSS 集中在 `styles.css`，以 CSS 变量控制基础色、字体、间距、圆角。
- 新增用户可见文案应接入 `@shared/i18n`，避免只改一种语言。

## 前端设计与实现约定

- 这是桌面工作台应用，不是营销页面。界面应保持克制、紧凑、可扫描、适合长时间操作。
- 优先使用 Ant Design 现成组件：Button、Dropdown、Modal、Form、Input、InputNumber、Select、Switch、Tabs、Tree、Table、Progress、Tag、Popover、DatePicker、Empty、Typography、Space、Flex。
- 不要为基础控件手写替代品，除非 AntD 无法覆盖。
- 已有视觉语言是浅色、白色面板、细边框、蓝色主色、少量青色和黄色语义色。
- 不要引入大面积渐变、装饰性图形、营销式 hero、复杂卡片嵌套。
- 窗口顶部区域使用 `-webkit-app-region: drag`，可点击控件必须设置 `-webkit-app-region: no-drag`。
- 桌面窗口最小宽度 1100，高度 720；仍要避免文本溢出和控件互相遮挡。
- 表格、底部面板、对象列表要维持稳定高度，避免加载、hover、选中、空状态导致布局跳动。
- 当前文案中英文混合，新增文案优先跟随相邻模块风格；涉及用户安全、错误、确认弹窗时优先中文。

## IPC 扩展流程

新增一条能力时按下面顺序做：

1. 如果需要新请求/响应类型，先改 `src/shared/types.ts`。
2. 如果新增用户可见文案或错误信息，同步补齐 `src/shared/i18n.ts` 的中英文 key。
3. 在 `src/shared/ipc.ts` 增加 `IPC_CHANNELS` 常量。
4. 在 `src/shared/ipc.ts` 扩展 `OssApi`。
5. 在 `src/main/preload.ts` 增加 `window.ossApi` 方法。
6. 在 `src/main/ipc/registerIpc.ts` 增加 `handle()`，并对所有参数做主进程校验。
7. 如果是 S3/文件系统能力，把核心逻辑放入 `services`，IPC 只做编排和参数校验。
8. 在 renderer 的 store/component/page 中调用新 API。
9. 更新任务表、日志或刷新对象列表等联动逻辑。
10. 运行 `npm run typecheck`，必要时运行 `npm run build`。

IPC 参数必须是可序列化数据。不要传函数、类实例、Node stream、Buffer 大对象或 Electron 对象到 renderer。

## 构建与打包注意点

`electron.vite.config.ts` 有三个构建目标：

- `main`：入口 `src/main/main.ts`，别名 `@shared`、`@main`。
- `preload`：入口 `src/main/preload.ts`，别名 `@shared`。
- `renderer`：root 为 `src/renderer`，入口由 `index.html` 引入，别名 `@shared`、`@renderer`。

renderer 手动分包：

- `antd`: `antd` 和 `@ant-design/icons`
- `state`: `zustand` 和 `dayjs`

`package.json` 的 electron-builder 配置：

- `appId`: `com.ossbrowser.desktop`
- `productName`: `OSS Browser`
- 输出目录：`release`
- 打包资源目录：`build`
- Windows 目标：NSIS。
- `files` 只包含 `out/**/*`、`package.json`、`build/icon.ico`，并排除源码、map、docs、release、markdown 等。

修改 preload、入口路径、资源路径、builder files 规则后必须运行 `npm run build`，涉及安装包时再运行 `npm run package:dir` 或 `npm run package`。

## TypeScript 与格式

- 项目启用 `strict: true`。
- `allowJs: false`，不要新增 `.js` 源码文件，配置文件除外。
- JSX 使用 `react-jsx`。
- `moduleResolution: Bundler`。
- Prettier 配置：
  - 单引号。
  - 分号。
  - printWidth 100。
  - trailingComma none。
- ESLint 当前关闭了 `no-unused-vars` 和 `no-undef`，不要因此留下明显死代码。

## Codex 忽略

- 根目录 `.codexignore` 用于让 Codex/Git 工作流忽略依赖、构建产物、本地缓存和可能包含敏感信息的临时文件。
- 不要把 `build/` 整体加入 `.codexignore`，其中 `icon.ico` 等是打包资源。
- 新增生成目录、临时导出或本地实验文件时，同步评估是否需要加入 `.codexignore`；不要忽略源码、配置模板、锁文件或文档。

## 高风险修改清单

以下修改需要格外谨慎：

- 修改凭据保存、脱敏、`ConfigStore.redact()`、`Logger.sanitizeLogText()`。
- 修改外链打开、导航拦截、preload 或 `contextBridge`。
- 修改下载路径、覆盖策略、临时文件命名、Range 下载写入。
- 修改 `s3Safety.ts` 的 Key/Prefix 规则，可能影响文件夹语义和兼容性。
- 修改 multipart 上传、copy、abort、重试策略。
- 修改任务终态、retry/cancel/shutdown 行为。
- 修改对象列表分页、预取、加载全部和 requestId 竞争控制。
- 修改 AntD Table 虚拟滚动尺寸、底部面板 resize、窗口最小尺寸。

这些区域变更后，至少做 typecheck，并手动验证相关 UI 和异常路径。

## 建议验证路径

仅文档或样式小改：

```powershell
npm run typecheck
```

主进程、IPC、preload、共享类型、构建配置改动：

```powershell
npm run typecheck
npm run build
```

渲染 UI 改动：

```powershell
npm run typecheck
npm run dev
```

然后在 Electron 窗口里至少检查：

- 应用能启动，无 preload error。
- 新建/编辑连接弹窗正常。
- 左侧连接树、Bucket 树、对象表布局不溢出。
- 对象表搜索、选择、右键菜单、加载更多状态正常。
- 底部任务表和可拖拽高度正常。
- 日志通知弹窗正常。

涉及真实对象存储操作时，需要用户提供或本地已有可用 S3-compatible 连接。不要在没有确认的情况下对真实 Bucket 执行破坏性操作。

## 开发原则

- 主进程负责可信边界和高权限能力；渲染进程只负责 UI 和用户交互。
- 所有跨进程契约放在 `src/shared`，不要复制粘贴重复类型。
- 参数校验放在主进程，UI 校验只能作为体验优化。
- 文件系统写入要有路径边界。
- 对象存储 Key/Prefix 操作必须使用现有工具函数。
- 日志和错误面向用户要清晰，但不能泄露秘密。
- 优先复用现有 store、service、component 和 CSS 变量。
- 对大列表和高频进度更新保持性能敏感，避免无节制 setState。
- 修改范围保持聚焦，不要顺手重构无关模块。
