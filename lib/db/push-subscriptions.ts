import { getDb } from "./client";
import type { IPushSubscription } from "../types";

export function listPushSubscriptions(): IPushSubscription[] {
  return getDb().prepare("SELECT * FROM push_subscriptions").all() as IPushSubscription[];
}

export function addPushSubscription(sub: {
  endpoint: string;
  p256dh: string;
  auth: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (@endpoint, @p256dh, @auth)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
    )
    .run(sub);
}

export function removePushSubscription(endpoint: string): void {
  getDb().prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}
