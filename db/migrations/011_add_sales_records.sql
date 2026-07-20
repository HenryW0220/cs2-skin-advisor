-- 卖出流水：库存同步发现资产从 Steam 库存消失（卖掉/交易走）时，不再直接删行了事，
-- 而是先落一条卖出记录。sell_price 优先从 C5 卖家订单自动匹配，匹配不到留 NULL
-- 等用户在流水页手动补，月度盈利 = Σ(卖出价-买入价)（两头都已知的记录才计入）。
CREATE TABLE IF NOT EXISTS sales_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,
  name_cn TEXT,
  icon_url TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  buy_price REAL NOT NULL,          -- 卖出时从持仓行带过来；0 = 开箱所得成本未知，不计盈利
  sell_price REAL,                  -- NULL = 待补价
  sell_source TEXT,                 -- 'c5_order'（自动匹配）| 'manual'（用户手填）
  steam_asset_id TEXT,
  sold_at TEXT NOT NULL DEFAULT (datetime('now')),  -- 发现卖出的时间（同步时刻，非成交时刻）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sales_records_sold_at ON sales_records (sold_at);
