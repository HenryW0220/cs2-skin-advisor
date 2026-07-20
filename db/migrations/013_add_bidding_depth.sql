-- SteamDT 批量/单品价格接口其实一直在返回求购价/求购数（biddingPrice/biddingCount），
-- 之前同步代码只用了在售价/在售数（sellPrice/sellCount），求购这一侧的挂单深度数据被
-- 白白丢掉了——这正是 REPORT-B2.md 里指出卡住"吸货期"、"出货期"指纹的挂单深度数据，
-- 不用新调研数据源，把已经在拉的字段存下来即可。C5 直连价格接口没有求购数据，这两列
-- 对应 platform='C5' 的快照会是 NULL。
ALTER TABLE price_snapshots ADD COLUMN bidding_price REAL;
ALTER TABLE price_snapshots ADD COLUMN bidding_count INTEGER;
