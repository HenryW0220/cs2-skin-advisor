import { daysSince, getSystemHealth } from "@/lib/health";

// 空值绝不能显示成"从来没有过"——那是一句关于整个项目历史的话，而 health_signals
// 是 2026-08-14 才建的表，在那之前的事它一概不知道。**"没有记录"和"从来没发生过"是两回事。**
function formatWhen(iso: string | null, recordingSince?: string | null): string {
  if (!iso) {
    if (!recordingSince) return "无记录（这张表还没有任何数据）";
    const since = new Date(recordingSince).toLocaleString("zh-CN", { hour12: false });
    return `无记录（仅代表 ${since} 开始记录以来没有过，更早的事没有留痕）`;
  }
  const days = daysSince(iso);
  const stamp = new Date(iso).toLocaleString("zh-CN", { hour12: false });
  if (days === null) return stamp;
  if (days < 1) return `${stamp}（${Math.round(days * 24)} 小时前）`;
  return `${stamp}（${Math.floor(days)} 天前）`;
}

function Row({ label, value, alarm }: { label: string; value: string; alarm?: boolean }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 text-xs">
      <span className="text-neutral-500">{label}</span>
      <span className={alarm ? "text-orange-400" : "text-neutral-300"}>{value}</span>
    </div>
  );
}

/**
 * 推送和异地备份这两件事都**静默死过**（推送 2026-08-12 归零、异地备份 08-05 起断了 8 天），
 * 共同点是"坏了不报错、只有主动去查才知道"。这个面板就是那个"主动去查"的位置。
 * 判据写死在这里：推送 0 订阅、异地备份超过 2 天没成功，都算要处理的状态。
 */
export function SystemHealth() {
  const health = getSystemHealth();
  const backupStale = (daysSince(health.offsiteBackup?.pulledAt ?? null) ?? 99) > 2;

  return (
    <div className="space-y-2">
      {/*
        0 订阅时要说清**该做什么**，不能只说"异常"。这里有一个容易误导人的边界：
        2026-08-14 补的两处自愈（页面加载时按 endpoint upsert、pushsubscriptionchange）
        只能救"订阅还在、但端点被浏览器换掉了"，**救不了 0 条**——0 条意味着没有任何设备
        登记过，自愈没有东西可自愈。所以这一行必须明说"需要在设备上手动订阅一次"，
        否则看到的人会以为等一会儿它自己会好。
      */}
      <Row
        label="推送订阅设备"
        value={
          health.pushSubscriptions === 0
            ? "0 台 · 没有任何设备订阅，预警不会送达——需要在设备上手动订阅一次（自愈救不了 0 条）"
            : `${health.pushSubscriptions} 台`
        }
        alarm={health.pushSubscriptions === 0}
      />
      <Row
        label="最近一次推送成功"
        value={formatWhen(health.lastPushSuccessAt, health.recordingSince)}
        alarm={!health.lastPushSuccessAt}
      />
      {/*
        这一行只在**真的有目标设备**时才会被记（lib/api/web-push.ts）。此前零订阅下的空转
        也记成"尝试"，于是同一个时间戳既可能是"发了但失败"也可能是"根本没有可发的对象"，
        而这两种状态要做的事完全不同。
      */}
      <Row label="最近一次推送尝试" value={formatWhen(health.lastPushAttemptAt, health.recordingSince)} />
      {health.lastSubscriptionDropped && (
        <Row
          label="最近一次订阅掉线"
          value={`${formatWhen(health.lastSubscriptionDropped.at)} · 掉线后剩 ${health.lastSubscriptionDropped.remaining} 台`}
        />
      )}
      <Row
        label="异地备份（本机镜像）"
        value={
          health.offsiteBackup
            ? `${health.offsiteBackup.backupDate} · ${formatWhen(health.offsiteBackup.pulledAt)}`
            : (health.offsiteBackupError ?? "未知")
        }
        alarm={backupStale}
      />
      {backupStale && (
        <p className="text-[11px] leading-relaxed text-neutral-500">
          超过 2 天没收到本机心跳。本机计划任务 CS2-CloudBackupPull 每天 21:00 拉一份云端备份，
          失败原因看本机 data/backups/pull-cloud-backup.log；仓库挪过目录的话要重跑
          scripts/fix-backup-task.ps1（管理员）。
        </p>
      )}
      {/*
        整块共享一个隐含的"页面渲染时刻"，而那个时刻本身不显示——读的人无从判断这些数字
        是新的还是卡住的。**这块面板的失效形态恰好是"显示一个看起来正常的数"**：
        2026-08-14 订阅成功那一刻这里还显示 0 台（偏低，刷新就对了），而同样的机制
        偏高时更危险——快照卡住会一直显示陈旧的"1 台"，没人会想到去刷新。
        所以时刻要显示出来，而不是靠"应该挺新的"这种默认假设。
      */}
      <p className="pt-1 text-[11px] text-neutral-600">
        数据截至 {new Date(health.snapshotAt).toLocaleString("zh-CN", { hour12: false })}
        （服务端渲染时刻；订阅状态变化后本页会自动重新拉取）
      </p>
    </div>
  );
}
