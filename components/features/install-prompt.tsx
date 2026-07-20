"use client";

import { useEffect, useState } from "react";

// Android/桌面 Chrome 会自动弹安装横幅（满足 manifest+HTTPS 条件即可），不需要额外代码。
// iOS Safari 没有这个自动横幅，"添加到主屏幕"入口藏在分享菜单里，用户很难自己发现，
// 所以只对 iOS 且还没装成 PWA（standalone 模式）的情况显示这段引导文案。
export function InstallPrompt() {
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    // 设备类型/安装状态只有浏览器 API 能查，SSR 阶段拿不到，只能挂载后测一次。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 一次性特性检测，不是响应外部状态变化
    setIsIOS(/iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as unknown as { MSStream?: unknown }).MSStream);
    setIsStandalone(window.matchMedia("(display-mode: standalone)").matches);
  }, []);

  if (!isIOS || isStandalone) return null;

  return (
    <p className="text-xs text-neutral-500">
      iPhone/iPad：点浏览器分享按钮 ⎋，选“添加到主屏幕” ➕，才能收到 Web Push 通知（iOS 要求先装成主屏幕图标）。
    </p>
  );
}
