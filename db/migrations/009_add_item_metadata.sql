-- 饰品的结构资料：属于哪个收藏品/箱子、什么品质等级。
-- 用途是"同系列联动"分析——用户的经验规律：一个饰品被拉盘时，同收藏品的
-- 上下级会跟涨（下级因为可以炼金成上级，需求被带起来）。要识别这种联动，
-- 系统必须知道哪些饰品同属一个收藏品、品质谁高谁低。
-- 数据来源是 ByMykel/CSGO-API 开源数据集（lib/api/cs-item-db.ts），手动触发同步。
CREATE TABLE IF NOT EXISTS item_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL UNIQUE,   -- market_hash_name
  collection TEXT,                  -- 收藏品中文名，如"野火收藏品"；印花等非皮肤物品是 NULL
  crate TEXT,                       -- 所属箱子中文名
  rarity TEXT,                      -- 品质中文名，如"隐秘级"
  rarity_rank INTEGER,              -- 品质数值等级，越大越高：1消费 2工业 3军规 4受限 5保密 6隐秘 7违禁
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_item_metadata_collection ON item_metadata (collection);
