-- 持仓
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,        -- market_hash_name，作为跨表关联价格快照的 key
  platform TEXT NOT NULL,         -- 'steam' | 'c5'
  buy_price REAL NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  buy_date TEXT NOT NULL,         -- ISO 8601 日期
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_item_name ON inventory (item_name);

-- 价格快照（K线/报价时间序列，供 lib/signals 计算 MA/RSI）
CREATE TABLE IF NOT EXISTS price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,
  platform TEXT NOT NULL,         -- 'steamdt' | 'c5'
  price REAL NOT NULL,
  volume INTEGER,                 -- 当天/当时成交量，平台未提供时为 NULL
  captured_at TEXT NOT NULL,      -- 数据对应的时间点（ISO 8601），不是写入时间
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_name, platform, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_item_time
  ON price_snapshots (item_name, captured_at);

-- 观察池（未持仓但关注的饰品）
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL UNIQUE,
  target_buy_price REAL,
  target_sell_price REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
