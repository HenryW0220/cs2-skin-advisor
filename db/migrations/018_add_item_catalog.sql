-- 全量饰品目录：market_hash_name ↔ 中文名/图标 的本地映射，给"加入观察池"的
-- 联想搜索用。之前联想直接实时调 Steam 市场搜索接口，云服务器的数据中心 IP
-- 被 Steam 429 限流是常态，而且 Steam 每页只给 10 条、按热度排序，磨损变体多的
-- 饰品家族里目标磨损经常掉出前几条根本搜不到。改成本地表查询后这两个问题都消失。
-- 数据来源是 ByMykel/CSGO-API 开源数据集（lib/api/cs-item-db.ts），手动触发同步，
-- 只在新箱子/新探员发布后需要重新同步一次。
CREATE TABLE IF NOT EXISTS item_catalog (
  market_hash_name TEXT PRIMARY KEY,  -- 英文全名，价格接口和入库用的 key
  name_cn TEXT NOT NULL,              -- 中文全名（含磨损后缀），联想搜索的主要匹配对象
  icon_url TEXT,                      -- Steam CDN 图标路径（不含域名前缀，同 watchlist.icon_url 口径）
  item_type TEXT NOT NULL,            -- skin / agent，将来加印花等品类时扩展
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
