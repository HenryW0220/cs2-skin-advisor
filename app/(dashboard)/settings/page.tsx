import { InstallPrompt } from "@/components/features/install-prompt";
import { PushNotificationManager } from "@/components/features/push-notification-manager";

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
        <PushNotificationManager />
        <InstallPrompt />
      </section>
    </div>
  );
}
