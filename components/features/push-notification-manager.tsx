"use client";

import { useEffect, useState } from "react";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export function PushNotificationManager() {
  const [isSupported, setIsSupported] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if ("serviceWorker" in navigator && "PushManager" in window) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 一次性特性检测，不是响应外部状态变化
      setIsSupported(true);
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((registration) => registration.pushManager.getSubscription())
        .then((sub) => setSubscription(sub));
    }
  }, []);

  async function subscribe() {
    setBusy(true);
    setMessage(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setSubscription(sub);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe() {
    if (!subscription) return;
    setBusy(true);
    setMessage(null);
    try {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
      setSubscription(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setMessage(`已发送（成功 ${json.data.sent}，失败 ${json.data.failed}）`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!isSupported) {
    return <p className="text-sm text-neutral-500">当前浏览器不支持 Web Push 通知。</p>;
  }

  return (
    <div className="space-y-3">
      {subscription ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-emerald-400">已订阅推送通知</span>
          <button
            type="button"
            onClick={sendTest}
            disabled={busy}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            发送测试通知
          </button>
          <button
            type="button"
            onClick={unsubscribe}
            disabled={busy}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            取消订阅
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-neutral-400">未订阅——嫌疑分预警、联动预警不会推到这台设备</span>
          <button
            type="button"
            onClick={subscribe}
            disabled={busy}
            className="rounded border border-orange-700 bg-orange-500/10 px-3 py-1.5 text-xs text-orange-400 hover:bg-orange-500/20 disabled:opacity-50"
          >
            开启推送
          </button>
        </div>
      )}
      {message && <p className="text-xs text-neutral-500">{message}</p>}
    </div>
  );
}
