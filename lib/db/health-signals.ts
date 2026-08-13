import { getDb } from "./client";

/**
 * 健康信号只有这三个 key，**别往里加第四个**（见 db/migrations/021 的说明）：
 * 这个项目不需要通用指标表，需要的是"推送到底还活着吗"这一件事有痕迹。
 */
export type IHealthSignalKey =
  | "last_push_success_at"
  | "last_push_attempt_at"
  | "push_subscription_dropped";

export interface IHealthSignal {
  key: IHealthSignalKey;
  value: string;
  updated_at: string;
}

export function setHealthSignal(key: IHealthSignalKey, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO health_signals (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value);
}

export function getHealthSignal(key: IHealthSignalKey): IHealthSignal | null {
  const row = getDb().prepare("SELECT * FROM health_signals WHERE key = ?").get(key);
  return (row as IHealthSignal | undefined) ?? null;
}

/**
 * 订阅掉线时留一条痕迹。订阅行本身会被删掉（端点已经死了，留着只会每轮重试），
 * 删之前把"什么时候掉的、掉的是哪个端点、掉之前还剩几个"记下来——2026-08 那次归零
 * 之所以只能靠翻备份复原，就是因为这一步当时不存在。
 */
export function recordSubscriptionDropped(endpoint: string, remaining: number): void {
  setHealthSignal(
    "push_subscription_dropped",
    JSON.stringify({
      at: new Date().toISOString(),
      endpoint: endpoint.slice(0, 60),
      remaining,
    })
  );
}
