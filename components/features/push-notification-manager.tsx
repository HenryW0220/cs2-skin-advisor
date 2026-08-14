"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// iOS 上必须先"添加到主屏幕"、以 PWA 方式打开才能订阅推送，普通 Safari 标签页里
// pushManager.subscribe 会直接失败。这个判断只用来**提示**，不阻止用户点。
function isIosWithoutStandalone(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS 13 起 Safari 默认报的是 Macintosh 的 UA，`/iPad/` 匹配不到——**而它照样受
  // "普通标签页不允许订阅推送"这条限制**，于是最需要这条提示的设备恰好看不到它。
  // 用"报 Mac 但有多点触控"把 iPad 认出来（桌面 Mac 的 maxTouchPoints 是 0）。
  const ua = navigator.userAgent;
  const isIpadOsAsMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const isIos = /iPad|iPhone|iPod/.test(ua) || isIpadOsAsMac;
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as { standalone?: boolean }).standalone === true;
  return isIos && !standalone;
}

/**
 * @param vapidPublicKey VAPID 公钥，由 /settings 页在**请求时**从环境变量读出来传进来。
 *   不在这里直接读 process.env.NEXT_PUBLIC_*：那种写法是构建期内联的，
 *   而镜像在 GitHub Actions 上构建（那里没有密钥），会被冻结成空字符串。
 */
export function PushNotificationManager({ vapidPublicKey }: { vapidPublicKey: string }) {
  const [isSupported, setIsSupported] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [needsPwaHint, setNeedsPwaHint] = useState(false);
  // 订阅状态一变就让服务端组件重新取一次数（运行状态面板是服务端渲染的）。
  // 不加这一下的话，订阅成功后同屏的"推送订阅设备"还停在旧值——2026-08-14 实测：
  // 推送卡片已显示"服务端已登记 1 台"，运行状态仍是 0 台，刷新后才一致。
  // **那次是偏低、刷新就对了；但同一个机制偏高时更危险**（快照卡住会一直显示陈旧的台数，
  // 数字看着正常，没人会想到刷新），所以这里主动失效，不依赖用户重新加载页面。
  const router = useRouter();

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 一次性特性检测，不是响应外部状态变化
    setIsSupported(true);
    setNeedsPwaHint(isIosWithoutStandalone());

    // 页面加载时把浏览器**当前**的订阅补登记一次（按 endpoint upsert，不会新增行）。
    // 这是自愈的另一半：端点轮换后服务端那条会被 410 清掉，而浏览器这边订阅还在，
    // 于是界面显示"已订阅"、服务端却一条都没有——2026-08-12 归零后正是这个状态，
    // 靠人去数据库里查才发现。现在只要打开一次页面就自动纠正。
    (async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        const sub = await registration.pushManager.getSubscription();
        setSubscription(sub);
        if (sub) setServerTotal(await upsertSubscription(sub));
      } catch (err) {
        // 这里以前是静默的：register 失败（比如 Basic Auth 把 /sw.js 拦成 401）什么都不会显示，
        // 用户只看到"未订阅"，完全不知道是哪一步断的。
        setMessage(`Service Worker 注册或订阅同步失败：${errorText(err)}`);
      }
    })();
  }, []);

  async function upsertSubscription(sub: PushSubscription): Promise<number | null> {
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json.data?.total ?? null;
  }

  async function subscribe() {
    setBusy(true);
    setMessage(null);
    try {
      // 公钥空的时候 subscribe 会抛一句跟原因毫无关系的浏览器报错，先自己说清楚
      if (!vapidPublicKey) {
        throw new Error("服务端没有配置 VAPID_PUBLIC_KEY，无法订阅");
      }
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      setServerTotal(await upsertSubscription(sub));
      setSubscription(sub);
      setMessage(null);
      router.refresh(); // 让服务端渲染的运行状态面板跟着更新，别停在订阅前的快照
    } catch (err) {
      setMessage(
        needsPwaHint
          ? `订阅失败：${errorText(err)}。iOS 必须先把本站「添加到主屏幕」，再从主屏幕图标打开才能订阅。`
          : `订阅失败：${errorText(err)}`
      );
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
      setServerTotal(null);
      router.refresh();
    } catch (err) {
      setMessage(errorText(err));
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
      // sent=0 且 failed=0 看着像成功，其实是"服务端一条订阅都没有"——这正是静默死亡的样子
      setMessage(
        json.data.sent === 0 && json.data.failed === 0
          ? "服务端没有任何订阅记录，这条测试推送没有发给任何设备"
          : `已发送（成功 ${json.data.sent}，失败 ${json.data.failed}）`
      );
      router.refresh(); // 推送成功会写 last_push_success_at，面板要跟着更新
    } catch (err) {
      setMessage(errorText(err));
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
          <span className="text-sm text-emerald-400">
            已订阅推送通知
            {serverTotal !== null && `（服务端已登记 ${serverTotal} 台设备）`}
          </span>
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
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-neutral-400">
              未订阅——嫌疑分预警、联动预警不会推到这台设备
            </span>
            <button
              type="button"
              onClick={subscribe}
              disabled={busy}
              className="rounded border border-orange-700 bg-orange-500/10 px-3 py-1.5 text-xs text-orange-400 hover:bg-orange-500/20 disabled:opacity-50"
            >
              开启推送
            </button>
          </div>
          {needsPwaHint && (
            <p className="text-xs text-orange-400/80">
              iOS 提示：必须先用 Safari 的「分享 → 添加到主屏幕」，再从主屏幕图标打开本站，
              否则订阅会失败（普通标签页里 iOS 不允许订阅推送）。
            </p>
          )}
        </div>
      )}
      {message && <p className="text-xs text-neutral-400">{message}</p>}
    </div>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
