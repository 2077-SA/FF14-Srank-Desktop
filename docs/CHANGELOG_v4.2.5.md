# FF14 Srank Desktop v4.2.5 更新笔记

## 修复原因

v4.2.4 的批量计时解析要求每一条 `/api/lastDeathTimers` 记录显式包含 `isMaint`。参考公开 Bear Timer 客户端 MagicBucket 的 `BearBulkClient.Parse`：它只在 `isMaint` 为 JSON true 时判为维护；字段缺省时按正常模式。缺省字段被当成未知并拒绝，可能导致服务器所有查询任务结束却没有一条有效记录。

参考实现：
https://github.com/Laficia/MagicBucket/blob/main/src/SrankFlag/SrankFlag/BearBulkClient.cs

## 修复内容

1. 批量响应缺省 `isMaint` 时兼容为 `false`；显式 null、未知字符串和不支持的值依然拒绝。
2. 原始 `timers` 有记录但全部解析失败，整区标记「校验异常」，不更新成功时间、不清空旧缓存。
3. **全批次解析失败时仍保留每世界诊断**：原始有数据的世界显示 raw / parsed / rejected 计数和错误原因；本轮确实没有记录的世界单独标记 empty。
4. 只有原始数组确实为空，才标记「接口无记录」。
5. 服务器明细分别显示 raw / parsed / distinct / accepted / rejected / duplicate / isolated。
6. 144/144 进度文案改为「已处理查询目标」，明确是任务完成数而不是发现记录数。
7. 维持 Bear CD 的正常 `RespawnTimer` 与维护 `MaintTimer` 口径；不能通过解析的时间窗仍不能进入监控室或计算器。

## 测试

- 桌面端：26/26。
- 桥接端：36/36。
- ZIP 解压复测：语法检查、两端测试和 SHA-256 均通过。

## 验证边界

本次修复依据公开 MagicBucket 对 Bear 批量接口的字段约定，并使用模拟 Bear 响应做回归。当前未取得用户 v4.2.4 同步当时的原始 HTTP 响应，因此不宣称已经线上抓包验证；v4.2.5 的 raw / parsed 分层诊断会帮助确认首次实机响应。Windows EXE 仍需 GitHub Actions 构建。
