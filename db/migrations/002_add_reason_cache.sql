-- LLM 生成的中文理由缓存，避免同一个信号状态重复调用 NVIDIA NIM。
CREATE TABLE IF NOT EXISTS reason_cache (
  cache_key TEXT PRIMARY KEY,
  item_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
