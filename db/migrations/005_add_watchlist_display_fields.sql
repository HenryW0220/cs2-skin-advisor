-- 加观察池的展示字段，跟 inventory 表的 name_cn/icon_url 同样的用法。
-- 观察池里的饰品大概率不在用户自己的 Steam 库存里，没法从库存导入时顺带拿到，
-- 改成添加时调 Steam 市场搜索接口（lib/api/steam.ts 的 lookupSteamMarketItem）查一次。
ALTER TABLE watchlist ADD COLUMN name_cn TEXT;
ALTER TABLE watchlist ADD COLUMN icon_url TEXT;
