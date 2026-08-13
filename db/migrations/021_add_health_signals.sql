-- 健康信号（2026-08-13）。**只放三样东西，不要长成通用指标表**——这个项目不需要第二套监控。
--
-- 背景：Web Push 从 2026-07-24 的 4 个订阅一路掉到 08-12 归零，全程没有任何痕迹。
-- 掉线本身是对的（端点 404/410 时 lib/api/web-push.ts 会删掉那条订阅，不然每轮都对着
-- 死端点重试），错在**删完什么都不剩**：表是空的，看不出曾经有过订阅，也看不出最后一次
-- 成功推送是什么时候。这次能把归零日子定到 08-11~08-12 之间，靠的是逐日翻数据库备份。
--
-- 所以这张表只回答三个问题：最近一次推送成功是什么时候、最近一次尝试是什么时候、
-- 掉过哪些线。key 固定是下面这三个，新增第四个之前先想清楚它是不是真的属于这里。
CREATE TABLE IF NOT EXISTS health_signals (
  key TEXT PRIMARY KEY,             -- 'last_push_success_at' | 'last_push_attempt_at' | 'push_subscription_dropped'
  value TEXT NOT NULL,              -- 时间戳或 JSON，含义由 key 决定
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
