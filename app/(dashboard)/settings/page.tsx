import { InstallPrompt } from "@/components/features/install-prompt";
import { PushNotificationManager } from "@/components/features/push-notification-manager";
import { SyncItemCatalogButton } from "@/components/features/sync-item-catalog-button";
import { SystemHealth } from "@/components/features/system-health";

// 这一页要在请求时读环境变量拿 VAPID 公钥；没有 searchParams 的页面会被生产构建
// 静态预渲染（踩坑 11），那样读到的是构建机器上的值——CI 上构建就是空的。
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-lg font-semibold text-neutral-100">设置</h1>
      <section className="space-y-3 rounded border border-neutral-800 p-4">
        <h2 className="text-sm font-medium text-neutral-200">推送通知</h2>
        <p className="text-xs text-neutral-500">
          嫌疑分预警、同收藏品联动预警会在触发时推到已订阅的设备。手机上先“添加到主屏幕”装成
          App，通知才稳定。
        </p>
        <PushNotificationManager vapidPublicKey={process.env.VAPID_PUBLIC_KEY ?? ""} />
        <InstallPrompt />
      </section>
      <section className="space-y-3 rounded border border-neutral-800 p-4">
        <h2 className="text-sm font-medium text-neutral-200">运行状态</h2>
        <p className="text-xs text-neutral-500">
          推送和异地备份都静默死过（推送 2026-08-12 归零、异地备份 08-05 起断了 8 天），
          坏了不会有任何提示。这里是唯一能一眼看出来的地方。
        </p>
        <SystemHealth />
      </section>
      <section className="space-y-3 rounded border border-neutral-800 p-4">
        <h2 className="text-sm font-medium text-neutral-200">饰品目录</h2>
        <p className="text-xs text-neutral-500">
          “加入观察池”的联想搜索查的是本地目录（全量皮肤+探员的中英文名和图标）。
          新箱子/新探员发布后点一次刷新即可，平时不用管。
        </p>
        <SyncItemCatalogButton />
      </section>
    </div>
  );
}
