# FF14 Srank Desktop v4.0.0

这是把 FF14 Srank v3.3.8 核心工具箱迁移到 Windows 桌面外壳的第一阶段工程。它不是把 HTML 简单改名为 EXE：Electron 主进程负责窗口、菜单、数据迁移与文件对话框；Bear S 怪同步服务在独立 Utility Process 中运行；原工具箱继续作为隔离的 renderer 页面显示。

## 本版本目标

- 保留 v3.3.8 原有计算器、监控室、OCR、排车、ET、工具箱菜单和统一浮窗。
- Bear Tracker 保持匿名只读 S 怪同步：只查询 Rank=5；不登录、不向 Bear Tracker 写入、不处理 A/B/B+/FATE。
- Bear 查询运行在单独后台进程；启动主窗口不等待 Bear 的远端网络请求。
- 桥接使用独立端口 `127.0.0.1:8788`，避免与旧一键包的 `8787` 冲突。
- 桌面数据、映射、同步缓存、日志和备份统一保存在 Electron userData 目录。
- 主窗口使用自定义 `app://bundle` 安全协议；renderer 禁用 Node 集成，启用 context isolation、sandbox 和 webSecurity。
- 通过原版工具箱的 `ff14-toolbox-local-backup` JSON v1 迁移历史数据，不直接读写 Edge/Chrome 浏览器配置文件。

## 目录

```text
FF14_Srank_Desktop_v4.0.0/
├─ app/index.html                 原 v3.3.8 完整工具箱页面
├─ bridge/                        免登录 S 怪本地同步服务完整源码
├─ main.js                        Electron 主进程和 Utility Process 管理
├─ preload.js                     最小 IPC 安全桥
├─ desktop-runtime.js              桌面数据迁移 / 导出 / 本地桥接地址
├─ desktop-helpers.js              配置、路径和备份校验
├─ tests/                          桌面辅助逻辑测试
├─ 01_一键生成Windows安装包.cmd   安装构建依赖、检查、测试、生成安装程序+单文件 EXE
├─ 02_生成EXE加资源文件夹.cmd     生成 EXE + resources 的文件夹分发版
└─ 03_打开数据文件夹.cmd          打开桌面版持久化数据目录
```

## 一次性构建 Windows EXE

构建电脑需要 Windows 10/11 x64、Node.js 22.12 或更高版本，以及首次安装依赖时可访问 npm/Electron 下载站点的网络。

1. 完整解压本工程文件夹，不要只取 `app/index.html`。
2. 双击 `01_一键生成Windows安装包.cmd`。
3. 脚本会执行 `npm install`、源码语法检查、桌面 + Bear 桥接自动化测试，然后调用 electron-builder。
4. 构建产物在 `release`：
   - `FF14-Srank-Desktop-4.0.0-x64.exe`：NSIS 安装程序。
   - `FF14-Srank-Desktop-4.0.0-Portable-x64.exe`：单文件免安装程序。
5. 安装后或运行 Portable 后，日常使用只需打开 **FF14 Srank Desktop.exe**。不需要另外启动 CMD、Node 服务、浏览器或 Tampermonkey。

### EXE + resources 文件夹分发版

如果更喜欢“一个主 EXE + 一个 resources 文件夹”的结构，双击 `02_生成EXE加资源文件夹.cmd`。输出在 `release/win-unpacked/`：

```text
release/win-unpacked/
├─ FF14 Srank Desktop.exe      ← 双击唯一主程序
├─ resources/                  ← 程序资源，必须保留
└─ 其他 Electron 运行库文件    ← 必须与 EXE 放在一起
```

不要单独移动 EXE，也不要删除 resources 或其他运行库文件。

## 第一次迁移旧版数据

桌面版不会擅自读取 Edge/Chrome 的浏览器数据库。请通过原 v3.3.8 浏览器版的正式备份格式迁移：

1. 在 Edge/Chrome 打开旧版 v3.3.8 HTML。
2. 进入「智能工具中心」→「数据安全中心」→「立即导出备份」，保存 JSON。
3. 打开 FF14 Srank Desktop。
4. 从窗口顶部菜单「文件」→「导入旧版工具箱备份 JSON…」选择刚才的 JSON。
5. 桌面版会先对当前桌面数据创建回滚备份，再合并恢复相同键；原来备份未包含的数据不会被清空。

为避免把浏览器权限状态移植到另一运行环境，迁移过程会跳过密码、Cookie、Token、CSRF、会话、邀请码、权限标记、开发者模式和 master verified 标记。业务击杀记录、常规设置和工具箱数据会迁移。

桌面版后续备份从「文件」→「导出桌面版数据备份 JSON…」执行。

## 数据与日志位置

通过菜单「文件」→「打开数据文件夹」进入。实际目录由 Electron userData 决定，最稳妥的打开方式是桌面软件菜单「文件 → 打开数据文件夹」。默认通常位于 Windows 用户的 Roaming 应用数据目录。目录包含：

```text
%APPDATA%\\FF14 Srank Desktop\\（具体位置可从“文件 → 打开数据文件夹”进入）
├─ bridge-config.json             数据中心及 S 怪名称映射配置（本地桥接端口 8788）
├─ bear-bridge-data/               Bear 匿名查询缓存与状态
├─ logs/                           Bear 后台运行日志
└─ backups/                        迁移前自动备份与导出记录
```

桌面浏览器存储（localStorage / IndexedDB）由 Electron 持久化在同一 userData 配置目录中。

## Bear S 怪 CD 同步方式

- 仅处理 `DatabaseHunt` 中 `Rank=5` 的正式 S 怪。
- 匿名查询 `syncSession` + `huntInfo`；不使用 Bear 登录账号。
- 中文怪名通过本地 S 怪词库与 `aliases` 映射到 Bear 英文 HuntName。未确认的名字不会导入中文历史记录。
- 服务器按选择的数据中心展开。
- 后台默认每 15 分钟刷新；工具箱面板可手动立即同步。
- Bear 远端响应缺失或权限受限时显示暂无数据，不伪造击杀时间。
- 这是单向读取（Bear Tracker → 工具箱）；匿名模式不具备向 Bear 上报权限。

## 性能与边界说明

本阶段已经把 Bear 网络请求和本地 HTTP/SSE 服务隔离在 Electron Utility Process，主 UI 不再执行大批量远端请求；文件读写、导入对话框和主窗口由 Electron 主进程管理。OCR 识别仍由工具箱现有 Worker 运行；首次使用 OCR 仍需访问原页面指定的 Tesseract CDN/语言资源。Electron 封装不会自动让旧版所有同步 DOM 逻辑变成多线程，后续如果真实运行还存在 UI 卡顿，应继续把 OCR 解析、历史统计和大型数据转换拆进 Worker/Utility Process，而不是盲目改写业务逻辑。

## 重要安全说明

- Bear 模式为匿名只读，不要求 Bear 密码，也不保存 Bear 凭据。
- 本地桥接仅监听 `127.0.0.1`，不绑定局域网网卡；CORS 只允许 `app://bundle`。
- Electron renderer 的 Node 集成关闭，使用隔离 preload；不要自行给远程网页开启 Node 集成。
- 不要将 `bridge-config.json`、缓存、Cookie jar（本模式不应产生登录 Cookie）或日志上传到公开位置。
- 未签名的 EXE 可能触发 Windows SmartScreen 提示。正式对外发布应使用组织代码签名证书。

## 当前验证状态

本工程包含自动化测试；构建机上运行 `npm run check` 与 `npm test`。本次 ChatGPT 工作环境没有预装 Electron，也无法访问 npm registry 完成 Electron runtime 下载，因此没有在此处生成或声称已生成 Windows EXE。请在 Windows 电脑运行上面的构建脚本实际生成 EXE。真实 Bear 线上匿名接口结果仍取决于 Bear 当前服务状态与返回数据。
