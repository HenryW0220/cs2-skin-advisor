-- D3：Web Push 订阅记录。本机单用户但一个人可能同时装在电脑+手机多个设备上，
-- 所以按 endpoint（每个设备/浏览器的订阅唯一标识）存多行，而不是只存一份。
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
