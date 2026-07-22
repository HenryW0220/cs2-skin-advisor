"use client";

import { useEffect } from "react";

// 装 PWA 需要浏览器先看到已注册的 Service Worker，注册逻辑之前只写在
// PushNotificationManager 里（仅 /settings 页渲染），导致只访问过其他页面的用户
// 浏览器里从没注册过 SW，地址栏永远不会出现安装按钮。这里放进根 layout，
// 保证任意页面进站都会注册一次（重复调用是幂等的，不会重复安装）。
export function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    }
  }, []);

  return null;
}
