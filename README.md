# FF14 Srank Desktop

当前工程版本：**v4.2.2**（多路线读取与数据一致性优化；Windows 构建和线上复核待验证）。

## v4.2.2 多路线读取与数据一致性

- 四大区任务独立隔离，最多 2 个大区并行读取；每区缓存、状态、重试、下一次检查时间互不共享。
- 主线路：Bear Tracker `/api/lastDeathTimers` 批量读取正式 S 怪。
- 定向补充 / 复核线路：对本地锚点冲突、临近进闸窗口，或批量结果缺失但本地已有活动 CD 锚点的少量目标，调用 Bear `/api/huntInfo`。
- 每个大区最多复核 5 个目标，逐条限速；不是把全部服务器 × 全部 S 怪展开成高频请求。
- 两路时间差不超过 120 秒才标记为交叉确认；发生冲突的数据写入该大区独立隔离日志，不参与 CD 更新。
- 未完成复核的数据标记为单源校验。注意：`lastDeathTimers` 与 `huntInfo` 都是 Bear Tracker 的接口，不是两个独立第三方数据提供方；豆豆柴仍使用公开 Live 来源，尚未完成外部独立来源验证。
- 共享 429 冷却机制；触发限流后，其他大区任务也会等待，避免并行任务继续给上游加压。
- 同步控制中心显示并行读取大区、交叉确认、单源校验与冲突隔离数量。

## 保留功能

- 四大区严格隔离，避免跨区 CD 污染。
- 独立同步控制中心、暂停 / 恢复、真实进度、首次使用建议。
- 新版 / 旧版监控室和计算器共用同步锚点。
- 本地缓存每 30 秒投影；自动保存每 15 秒静默执行。
- 排车 / OCR 合并为默认折叠菜单。
- Bear 保持匿名只读，不登录、不向上游写入。

## 测试

- 桌面端：14/14 通过。
- 桥接端：25/25 通过。
- JavaScript 语法检查通过。
- Windows EXE、线上 Bear 交叉核验和长时间压力测试尚待 GitHub Actions / Windows 实机完成。

## 发布

将 `FF14_Srank_Desktop_v4.2.2_工程源码.zip` 上传至仓库根目录，打开 GitHub Actions，运行 **Build and publish FF14 Srank Desktop release**。Windows 安装版和 Portable 版构建成功后会发布到 [GitHub Releases](https://github.com/2077-SA/FF14-Srank-Desktop/releases)。
