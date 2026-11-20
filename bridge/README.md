# FF14 Srank Desktop · Bear 桥接核心 v1.4.8

桌面版由 Electron 自动启动本地桥接进程，监听 `127.0.0.1:8790`。桌面端只接受 `/health` 明确报告 `bridgeVersion=1.4.8` 的服务；旧端口 / 旧进程不能被当成当前版本复用。

## 四大区与子服务器

- 豆豆柴：水晶塔、银泪湖、太阳海岸、伊修加德、红茶川（5）
- 陆行鸟：红玉海、神意之地、拉诺西亚、幻影群岛、萌芽池、宇宙和音、沃仙曦染、晨曦王座（8）
- 莫古力：白银乡、白金幻象、神拳痕、潮风亭、旅人栈桥、拂晓之间、龙巢神殿、梦羽宝境（8）
- 猫小胖：紫水栈桥、延夏、静语庄园、摩杜纳、海猫茶屋、柔风海湾、琥珀原（7）

同步选择大区后默认全选其子服务器；仍可逐台取消。取消整个大区会从后端订阅和同步计划移除其全部服务器。服务端对世界归属再做一次 1:1 检查。

## API 与处理管线

1. GET `https://tracker.beartoolkit.com/` 初始化匿名 Cookie / CSRF（只保存在内存）。
2. POST `/api/syncSession` 取得资源词库，桥接仅保留 `DatabaseHunt.Rank=5` 的正式 S 怪。
3. 每个所选大区执行 POST `/api/lastDeathTimers`，JSON 为 `{ "QueryDeathTimers": [本区所选世界], "RankType": "sRank" }`，Referer `/srank`。
4. 豆豆柴优先用公开 Live 快照，未得到有效 S 怪记录时回退 Bear 批量接口；其他大区先批量读取，批量缺失的世界按单服务器有限复核。不会将所有怪物拆成高频的 world × hunt 请求。
5. 批次结果按 Rank、世界、时间戳、维护状态和资源窗口校验；跨区、未知世界、重复、过期及冲突记录按诊断类别处理。
6. 写入四个独立大区缓存，renderer 适配器再将相同记录投影到首页、两版监控室和计算器。

参考公开客户端批量 API：<https://github.com/Laficia/MagicBucket/blob/main/src/SrankFlag/SrankFlag/BearBulkClient.cs>。参考代码说明请求结构，不代表当前环境已完成 Bear 线上实测。

## CD 计算与防污染

- 正常模式使用每只怪资源定义 `RespawnTimer`，维护模式使用 `MaintTimer`。
- 进闸 / 强制时间分别为击杀锚点 + 对应窗口下限 / 上限。
- Bear 资源词库超过 6 小时、维护状态不明确、未来锚点、时间窗异常或冲突来源时，不生成可展示 CD。
- 同锚点只更新维护 / 正常窗口元数据时，更新同一条记录，不新增重复行。
- 空响应 / 失败 / 校验异常不清空旧缓存，不刷新最近成功时间。

## 同步状态含义

- `completed / totalTargets`：真实已处理服务器请求数 / 所选服务器数，不代表发现了击杀记录。
- `rawRecords / parsedRecords / distinctRecords / recordsFound`：原始、解析、去重、可信接受记录数。
- `rejectedRecords / quarantinedRecords / unchangedRecords / staleRecords`：拒绝、隔离、未变化、过期锚点数量。
- `empty` 仅代表接口确实返回空数组；`error` 包含结构异常、全部解析拒绝、HTTP 失败等；`partial` 代表部分有效并有拒绝 / 隔离 / 备用路径失败。
- 逐服务器明细包含 API、Rank、请求世界、HTTP、Content-Type、响应顶层字段 / 摘要样本和 raw / parsed / rejected 等数量；不展示会话 Cookie / CSRF。

## 本地 API

- `GET /health`：桥接版本、资源版本、同步状态、四大区逐服明细。
- `GET /resources`：S 怪资源和服务器映射。
- `GET /settings`、`POST /settings/data-centers`：读取 / 保存大区及服务器选择。
- `POST /sync/now`：立即同步当前订阅大区。
- `POST /sync/pause`、`POST /sync/resume`：暂停 / 恢复。
- `GET /hunts?rank=s`：读取本地已接受的正式 S 怪缓存。

## 稳定性与安全

- Bear 只读请求临时网络失败 / 指定 5xx 有限重试；429 不重试，使用全局冷却。
- 不调用 Bear 上游写入接口，不读取用户浏览器 Cookie、账号凭据或 Token。
- 四大区缓存、同步元数据、重试时间、冲突隔离文件分区存储。
- 桌面升级时将旧 `bear-bridge-data` 复制到 `bear-bridge-data-v2`，原目录保留，旧缓存不会被直接删除。

## 测试边界

桌面端自动化测试 44/44、桥接端 56/56 通过，语法检查通过。当前执行环境无法完成 Bear Tracker 实时逐服务器验收，也不能代表 Windows EXE 实机已验证。首次 Windows 构建运行后，请检查同步面板显示的 **桌面 v4.2.8 / 桥接 v1.4.8 / 端口 8790**。若版本不符，应视为桥接冲突，不得继续把其数据当成当前构建结果。
