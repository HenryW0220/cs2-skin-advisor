-- 模拟盘（paper trading）：对观察池饰品，规则引擎买入信号达到阈值时模拟开仓，
-- 之后按持仓模式评估、出卖出信号（且过了 T+7 锁定期）时模拟平仓。
-- 目的是用真实时间线上的前瞻记录验证规则引擎有没有用——回测有各种偏差
-- （C1/C2 已经验证过离线评估的坑），这里的每条记录都是"决策当时"落的，没有未来数据泄漏。
CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,
  platform TEXT NOT NULL,           -- 开仓时的参考平台，之后估值/平仓都用同一平台的价格
  buy_price REAL NOT NULL,          -- 开仓参考价（当时的在售价，模拟"按卖价直接买入"）
  buy_score INTEGER NOT NULL,       -- 开仓时规则引擎 score
  buy_reasons TEXT NOT NULL,        -- 开仓时触发的信号，JSON 数组字符串
  opened_at TEXT NOT NULL,          -- 用开仓依据的那条快照的时间，不是写库时间
  status TEXT NOT NULL DEFAULT 'open',  -- open | closed
  sell_price REAL,                  -- 平仓参考价（扣手续费前）
  sell_net_price REAL,              -- 扣手续费后的净到手价
  sell_score INTEGER,               -- 平仓时规则引擎 score
  sell_reasons TEXT,                -- 平仓时触发的信号，JSON 数组字符串
  close_reason TEXT,                -- 'sell_signal'（规则引擎给了 SELL）| 'timeout'（超过最长持有天数强制平仓）
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades (status);
CREATE INDEX IF NOT EXISTS idx_paper_trades_item ON paper_trades (item_name);
