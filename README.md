# FF14 Srank Desktop

当前工程版本：**v4.2.5**（修复 Bear 批量计时解析导致全服 0 条记录，并增加逐世界诊断）。

## v4.2.5 修复

- **批量计时缺省字段兼容**：参考 Bear Timer 公开客户端 MagicBucket 对 `/api/lastDeathTimers` 的解析规则：记录缺少 `isMaint` 时按正常状态 `false` 处理；明确存在但值为 null / 非法字符串仍拒绝。
- **避免 144/144 误报成功**：144/144 只代表查询目标被处理，不代表发现 144 条击杀。原始记录有数据但解析后为 0 时，大区标记「校验异常」并保留旧缓存；仅当原始 `timers` 数组确实为空时才标记「接口无记录」。
- **逐服务器诊断**：服务器明细分别显示原始记录、字段解析、去重后、有效接受、字段拒绝、重复和冲突隔离数量。
- **进度语义修正**：界面使用「已处理查询目标」，不再把查询任务完成等同于 CD 数据同步成功。
- **保持 CD 安全规则**：正常状态依 S 怪定义中的 `RespawnTimer`，维护状态依 `MaintTimer`；明确非法的维护标记、缺失资源、过期词库、未来击杀时间和冲突来源仍拒绝计算。不会因本次缺省字段兼容而跳过 CD 校验。
- Bear 429 使用全局冷却；只读临时网络错误 / 5xx 有限重试；不自动重发上游写入。

## 测试

- 桌面端：**26/26 通过**。
- 桥接端：**36/36 通过**。
- ZIP 解压后的最终源码再次执行 `npm run check`、`npm test` 均通过；SHA-256 校验通过。
- 新增回归覆盖：缺省 `isMaint` 正常模式解析、显式 null / unknown 拒绝、全量解析失败不能报成功、真实空数组标记无记录、每服务器分层统计。
- 测试采用公开 MagicBucket 字段约定和模拟响应；尚未取得用户 v4.2.4 失败当次的 Bear 原始 HTTP 响应，也未完成 Windows EXE 实测或线上逐服务器对照。

## 发布

将 `FF14_Srank_Desktop_v4.2.5_工程源码.zip` 上传至仓库根目录，运行 GitHub Actions 的 **Build and publish FF14 Srank Desktop release**，构建 Windows 安装版和 Portable 版并发布到 [GitHub Releases](https://github.com/2077-SA/FF14-Srank-Desktop/releases)。
