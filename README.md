# FF14 Srank Desktop

当前工程版本：**v4.2.0**（Bear 同步链路专项优化；Windows 云端构建待运行验证）。

## v4.2.0 本次重点

- 新增独立「同步数据」控制中心：四大区可多选，默认陆行鸟；显示真实同步阶段进度、子服务器结果、请求队列、最近同步时间与错误，并支持手动同步、暂停和恢复。
- 支持豆豆柴、陆行鸟、莫古力、猫小胖及内置的 28 个子服务器；保留上游资源新增服务器的动态合并。
- 同步结果共享给新版 / 旧版监控室及计算器。计算器会根据当前服务器 / S 怪锚点实时显示 CD 阶段、剩余冷却、进闸与强制时间；手动填入锚点仍由玩家点击确认。
- 本地同步缓存每 30 秒刷新投影；远端 Bear 请求仍按 S 怪 CD 窗口调度，不会每 30 秒重复请求站点。
- 自动保存改为有变更时每 15 秒静默保存，不再占用右下角；排车与 OCR 合并为默认折叠的左侧菜单组。
- Bear Tracker 保持匿名只读，仅处理正式 Rank=5 S 怪，不登录、不向上游写入；失败时保留现有本地数据。

## 下载

正式安装版和 Portable 便携版构建并发布后，可从 [GitHub Releases](https://github.com/2077-SA/FF14-Srank-Desktop/releases) 下载。**源码与自动化测试已准备；Windows EXE 尚未在 GitHub Actions 构建并经实际启动验证。**

## 发布 v4.2.0

1. 将 `FF14_Srank_Desktop_v4.2.0_工程源码.zip` 上传到本仓库根目录。
2. 打开 GitHub **Actions**。
3. 运行 **Build and publish FF14 Srank Desktop release**。
4. 工作流先执行依赖安装、语法检查和自动化测试，再生成 Windows NSIS 安装版及 Portable EXE，最后创建 GitHub Release 并上传 updater 元数据。

## 数据安全

本地用户数据保存在 Electron `userData`，与安装目录分离。升级不会主动清空 CD、击杀历史、设置、映射或同步缓存。Bear 远端失败时保留原缓存。首次迁移旧版浏览器工具箱数据，请使用正式 JSON 备份 / 导入流程。
