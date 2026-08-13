self.addEventListener("push", function (event) {
  if (!event.data) return;
  const data = event.data.json();
  const options = {
    body: data.body,
    icon: "/icon-192",
    badge: "/icon-192",
    data: { url: data.url || "/positions" },
  };
  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || "/positions"));
});

// 端点轮换时浏览器会发这个事件——这正是 2026-08 那次订阅归零的机制：
// FCM/Apple 会周期性换端点，服务端对旧端点收到 410 就把订阅删了（对的，不然每轮都在
// 对死端点重试），但**没有任何人把新端点建回来**，于是订阅数只减不增，8-12 归零。
// 这个事件存在的唯一目的就是补上"建回来"这一半。
//
// 注意 newSubscription 在部分实现上是空的，所以要自己重新 subscribe 一次；
// applicationServerKey 从旧订阅里取，拿不到就只能等页面加载时那条兜底路径（见
// components/features/push-notification-manager.tsx 的 syncSubscription）。
self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil(
    (async () => {
      const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
      const subscription =
        event.newSubscription ??
        (applicationServerKey
          ? await self.registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey,
            })
          : null);
      if (!subscription) return;

      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });
    })()
  );
});
