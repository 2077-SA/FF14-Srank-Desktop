# v4.2.5 Bear 批量同步诊断规则

## 关键兼容

参考 Bear Timer 公开客户端 MagicBucket：
https://github.com/Laficia/MagicBucket/blob/main/src/SrankFlag/SrankFlag/BearBulkClient.cs

批量记录必需字段为 `huntName`、`worldName`、`lastDeathTime`。
- `isMaint: true`：维护状态，采用资源定义 `MaintTimer`。
- `isMaint: false`：正常状态，采用 `RespawnTimer`。
- `isMaint` 字段缺省：与公开客户端一致，按 false 处理。
- 显式 null / unknown / 不支持类型：拒绝，不猜测。

## 状态判定

- raw=0：接口无记录（empty），不得显示为数据已同步。
- raw>0、parsed=0：校验异常（error），不保存、不清空旧缓存、不刷新成功时间。
- parsed>0、accepted>0：按可信有效条目保存；存在拒绝或隔离则 partial。
- distinct>accepted：差额列入冲突隔离，不参与 CD。

## 世界明细字段

- rawRecords：Bear 原始返回条数。
- parsedRecords：字段、Rank、世界和时间校验通过数。
- distinctRecords：同世界 / S 怪去重后记录数。
- records：经过冲突规则后接受的记录数。
- rejectedRecords：格式 / 词库 / 时间校验拒绝数。
- duplicateRecords：重复条目数。
- isolatedRecords：因来源冲突被隔离数。

## 测试

桌面 26/26、桥接 36/36。ZIP 解压后的最终源码复跑语法和所有测试通过。测试使用模拟 Bear 响应，不代表已经抓到用户当次在线原始响应。
