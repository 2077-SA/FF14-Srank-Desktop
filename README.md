# FF14 Srank Desktop

## v4.1.1 自动更新版（Windows）

桌面版 v4.1.1 工程采用独立 Electron 外壳，自动更新功能通过 GitHub Releases 提供。

- Windows 安装版：启动后延迟检查正式版更新；也可从「帮助 → 检查更新」手动检查。
- 安装版：下载前询问，下载完成后再次询问是否重启安装；使用 GitHub Release 的 latest.yml / SHA-512 元数据校验更新包。
- Portable 版：检查新版本并打开 Releases 下载页，由用户手动替换正在运行的单文件 EXE。
- 本地数据：继续保存在 Electron userData 独立目录，程序更新不会主动删除本地 S 怪数据、CD、服务器设置和缓存。
- 发布流程：GitHub Actions 执行语法检查、自动化测试、Windows 安装版与 Portable 构建，并发布 EXE、latest.yml 和 blockmap。

**构建准备：** 请将 `FF14_Srank_Desktop_v4.1.1_工程源码.zip` 上传到仓库根目录，然后运行 Actions 中的 **Build and publish FF14 Srank Desktop release** 工作流。工作流目前按 v4.1.1 构建；不要覆盖原有 v4.0.0 源码包或仓库里的其他网页文件。

---

# Bear Tracker 免登录 S 怪 CD 同步桥（v1.3.3）

本地只读同步正式 S 怪（`DatabaseHunt.Rank === 5`）到 FF14 Srank 工具箱。无需 Bear Tracker 账号，不使用 Socket.IO，不调用上游写接口，不读取 A 怪、B 怪、FATE。

## 最简单启动方式

请回到解压包最外层，**只双击 `01_双击启动FF14工具箱_自动启动桥接.cmd`**。启动器会检查 Node.js 20+、后台启动本服务、等待 `127.0.0.1:8787/health` 可用，再自动打开 `FF14_Srank_v3.3.8.html`。不需要 `npm install`，也不需要再单独打开桥接程序。

如果电脑没有 Node.js 20+，启动器会打开 Node.js 官方下载页。安装完成后，再双击同一个文件即可。

工具箱保持以本地 HTML 文件方式打开，避免改变原来的浏览器本地数据位置。服务会在后台运行，日志写入本目录 `logs/bridge.log` 和 `logs/bridge-error.log`。

## 工具箱内设置

1. 右下角的统一工具浮窗选择「Bear S怪CD」。
2. 选择要同步的数据中心。
3. 首次使用时，核对中文 S 怪名称与 Bear Tracker 英文 `HuntName` 的映射。
4. 点击「立即同步 S 怪 CD」。之后可在后台按配置的间隔自动刷新。

## 默认参数

- 本地服务：`http://127.0.0.1:8787`
- 默认数据中心：`陆行鸟`
- 自动刷新：15 分钟
- 查询并发：3
- 请求起始间隔：350ms

可在 `config.json` 中修改高级参数。首次没有 `config.json` 时使用内置默认值；数据中心和别名可直接在工具箱面板保存。

## 本机接口

- `GET /health`：服务状态与同步进度
- `GET /resources`：仅保留 Rank=5 的资源字典
- `GET /settings`：数据中心和名称映射
- `POST /settings/aliases`：保存并校验 S 怪映射
- `POST /settings/data-centers`：修改扫描数据中心
- `POST /sync/now`：启动后台扫描
- `GET /hunts?rank=s`：读取已缓存 S 怪击杀时间
- `GET /events/recent`：最近新发现的击杀锚点

## 性能与数据安全

Node 服务先启动本地 HTTP 接口，再于后台执行远端请求；浏览器不会承担批量扫描工作。扫描过滤仅保留 Rank=5，并限速、限制并发。工具箱自动保存采用字段增量采集与 IndexedDB 优先存储，避免每次输入都扫描整页并同步序列化全部草稿。

不会把账号密码、Cookie、Token 写入文件；免登录模式没有账号登录步骤。只新增 Bear 返回且确认晚于本地记录的击杀时间，不改动旧击杀历史、天气、强制 CD、校准数据或用户其他设置。
