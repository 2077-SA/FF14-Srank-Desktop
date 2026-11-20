# v4.2.8 桥接、API、CD 与选择逻辑审计

## 1. 进程与端口

- 桌面版本 4.2.8，桥接版本 1.4.8。
- 桌面桥接固定监听 127.0.0.1:8790，旧 8788 进程不会被当成新版服务。
- Electron 启动时探测 `/health`，要求 `ok=true`、`mode=anonymous-srank`、`bridgeVersion=1.4.8`；不匹配就显示版本不符，不复用。
- Renderer 同样校验预期桥接版本，连接错误时禁止同步与快照应用。
- 新旧缓存目录分离，升级将旧缓存复制，不删除旧目录。

## 2. 四大区 / 服务器选择

四个固定大区及世界：
- 豆豆柴 5：水晶塔、银泪湖、太阳海岸、伊修加德、红茶川。
- 陆行鸟 8：红玉海、神意之地、拉诺西亚、幻影群岛、萌芽池、宇宙和音、沃仙曦染、晨曦王座。
- 莫古力 8：白银乡、白金幻象、神拳痕、潮风亭、旅人栈桥、拂晓之间、龙巢神殿、梦羽宝境。
- 猫小胖 7：紫水栈桥、延夏、静语庄园、摩杜纳、海猫茶屋、柔风海湾、琥珀原。

同步面板：新增大区自动勾选该区所有世界；逐台取消保留自定义选项；取消大区后其选择整体删除。后端 normalizeWorldSelections 会再过滤每个世界是否属于其大区，并拒绝每个选中大区没有任何服务器的配置。

服务器总览：四大区独立开关，按四套设备筛选配置清除不符合世界；允许全部取消，不隐式回填默认值。可见设备的服务器条数限制只控制显示，不控制同步范围。

## 3. Bear API 读链路

1. `TrackerRest.bootstrap()` 访问 Bear 根页面，读取匿名 CSRF / Cookie，只存内存。
2. `syncSession()` 读取资源并严格保留 `DatabaseHunt.Rank===5`。
3. 四大区独立批次 POST `/api/lastDeathTimers`，请求 JSON `{ QueryDeathTimers: worlds, RankType: 'sRank' }`。
4. 豆豆柴先读公开 Live；没有有效 S 怪记录时回退 Bear 批量接口。其他大区缺失世界做限速单世界复核。
5. 不对每只怪逐世界多路展开，验证抽查仍有每区上限和延迟。
6. 429 进入全局冷却；只读网络瞬断 / 指定 5xx 有限重试；上游写路径不自动重发。

接口解析的空数据与异常数据不同：有效空 timers 数组是 `empty`；raw>0 但所有记录都被校验拒绝是 `error`；部分接受但有拒绝 / 隔离为 `partial`；HTTP / JSON / 连接故障为 `error`。这些情况均不清空旧缓存，不更新最近成功时间。

## 4. CD 时间窗

- 只接受 Rank=5 的正式 S 怪资源定义。
- 正常模式读取 `RespawnTimer`，维护模式读取 `MaintTimer`；记录缺省 `isMaint` 按 Bear 公开客户端规则为正常，显式 null / 非布尔值拒绝。
- 维护窗口必须与维护标记同一时间锚点匹配；资源更新时间超过 6 小时、未来时间、无效或不合理窗口、跨 DC / world、冲突等级都不能显示预计 CD。
- `gateTs = lastDeathTime + lowerHours * 3600`；`forceTs = lastDeathTime + upperHours * 3600`。单位统一为 Unix seconds，renderer 进入毫秒计算前乘 1000。
- 同锚点改变维护 / 正常窗口时更新 CD 元数据，不新增击杀行；旧锚点不覆盖新锚点；跨大区使用独立缓存。

## 5. 写入、缓存与监控投影

- Store 按 DC 分区保存；每条记录按世界唯一归属二次校验；unknown / cross-DC 写入拒绝。
- identical snapshot 记为 unchanged，不做无意义磁盘重写；有效时间窗变化视为 substantive change。
- 同步确认后 renderer 重新拉取 `/hunts?rank=s`；数据按 DC + world + S key 合并进本地历史。重复快照仍刷新 monitor host binding；手动记录不被批量删除。
- 新旧监控室和计算器共享经校验的 Bear 时间元数据；未核验锚点不回退为通用时长。

## 6. 防止「进度完成但没同步」

- 分母是一台服务器一个目标：豆豆柴5、陆行鸟8、莫古力8、猫小胖7（仅选中世界累加）。
- 完成目标数不等于数据有效数或磁盘变更数；面板同时显示 raw、parsed、accepted、written/unchanged、rejected、quarantined。
- 空数组必须说明真实接口为空；解析器全拒绝必须显示错误；HTTP失败必须显示状态与响应信息；不会用进度100%掩盖。
- 每服务器诊断包含请求端点、Rank、请求服务器、HTTP、Content-Type、payload keys、短响应样本和 fallback 状态；不写出 Cookie / CSRF / Token。
- 如果面板显示的桌面 / 桥接版本不是 4.2.8 / 1.4.8、端口不是8790，应停止将该轮结果作为新版数据验收，并检查安装版本和旧进程。

## 7. 自动化验证

- Desktop Node tests: 44/44.
- Bridge Node tests: 56/56.
- Syntax checks + embedded monitor JSON / inline JS: pass.
- DC selection tests cover add/remove four DCs, all-empty overview, device preference cleanup, and selected-world mapping.
- Bridge tests cover Bear bootstrap / request body, rank and world filters, empty vs parser rejection, bounded fallback, retries / 429, store isolation, CD windows and monitor metadata.

## 8. 尚未验证

本运行环境未能连接 Bear Tracker 当前线上 API，网页页面由 JavaScript 客户端渲染，故没有当前实时 Bear 结果逐世界对照；也未完成 Windows Actions 构建与 EXE 实机验证。自动化模拟证明请求结构和内部数据路径，不代表当前 Bear 线上一定已返回有效 timers。首次新版本启动必须检查当前桌面/桥接版本，并观察 raw / parsed / accepted 明细；若仍为零，以响应样本继续定位，而不应宣称修复已通过线上验收。
