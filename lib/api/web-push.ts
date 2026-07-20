import webpush from "web-push";
import { listPushSubscriptions, removePushSubscription } from "../db/push-subscriptions";

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const CONTACT_EMAIL = process.env.VAPID_CONTACT_EMAIL ?? "";

let configured = false;
function ensureConfigured(): boolean {
  if (!PUBLIC_KEY || !PRIVATE_KEY || !CONTACT_EMAIL) return false;
  if (!configured) {
    webpush.setVapidDetails(`mailto:${CONTACT_EMAIL}`, PUBLIC_KEY, PRIVATE_KEY);
    configured = true;
  }
  return true;
}

export interface IPushNotificationPayload {
  title: string;
  body: string;
  url?: string; // 点击通知跳转的路径，默认跳首页
}

interface IPushResult {
  data: { sent: number; failed: number } | null;
  error?: string;
}

/**
 * 给所有已订阅设备推送一条通知。单用户但可能装了多台设备，逐个发不聚合失败。
 * 订阅过期（404/410，用户卸载了 PWA 或清了浏览器数据）时顺手清掉这条订阅记录，
 * 不然每次扫描都会对着一个死 endpoint 重试。
 */
export async function sendPushNotification(payload: IPushNotificationPayload): Promise<IPushResult> {
  if (!ensureConfigured()) {
    return { data: null, error: "VAPID 密钥未配置（NEXT_PUBLIC_VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_CONTACT_EMAIL）" };
  }

  const subscriptions = listPushSubscriptions();
  let sent = 0;
  let failed = 0;

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload)
      );
      sent += 1;
    } catch (err) {
      failed += 1;
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        removePushSubscription(sub.endpoint);
      }
    }
  }

  return { data: { sent, failed } };
}
