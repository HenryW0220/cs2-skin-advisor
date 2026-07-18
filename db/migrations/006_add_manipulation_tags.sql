-- 用户凭外部消息标记"这个饰品在某段时间被人操盘"，给规则引擎/LLM 引用，
-- 也是将来训练操盘检测模型的正样本标签——必须精确到时间窗口，不能只标"这个品有庄"，
-- 不然整条历史（含正常波动时段）都会被当成正样本，稀释掉真正的操盘特征。
CREATE TABLE IF NOT EXISTS manipulation_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,
  start_date TEXT NOT NULL,        -- 操盘开始日期，ISO 8601 日期，记不清具体哪天就填大概日期
  end_date TEXT,                   -- 操盘结束日期，还在进行中/还没确认结束就留空
  confidence TEXT NOT NULL DEFAULT 'medium', -- 'high' | 'medium' | 'low'，消息可靠程度
  note TEXT,                       -- 消息来源/依据，几个月后回看还能懂是听谁说的、为什么信
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_manipulation_tags_item_name ON manipulation_tags (item_name);
