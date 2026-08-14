import { readFileSync } from "node:fs";
import path from "node:path";
import { getEarliestHealthSignalAt, getHealthSignal } from "./db/health-signals";
import { listPushSubscriptions } from "./db/push-subscriptions";

export interface IOffsiteBackupStatus {
  pulledAt: string;
  backupDate: string;
  sizeBytes: number;
  host: string;
}

export interface ISystemHealth {
  pushSubscriptions: number;
  lastPushSuccessAt: string | null;
  lastPushAttemptAt: string | null;
  /** health_signals 最早的一条记录时间。空值只说明"这张表建表以来没记到过"，不是历史结论 */
  recordingSince: string | null;
  /** 这份快照的取值时刻——每个字段都要能说清"数据截至什么时候" */
  snapshotAt: string;
  lastSubscriptionDropped: { at: string; endpoint: string; remaining: number } | null;
  offsiteBackup: IOffsiteBackupStatus | null;
  offsiteBackupError: string | null;
}

// 本机的异地备份脚本（scripts/pull-cloud-backup.ps1）成功后把这个文件 scp 到云端的
// data/ 目录，data 是 bind mount，容器直接读得到。**本机的死活云端看不见**，只能本机
// 主动上报——2026-08-05~08-13 异地备份断了 8 天没人发现，缺的就是这条上报。
const HEARTBEAT_FILE = "offsite-backup-heartbeat.json";

function readOffsiteBackup(): { data: IOffsiteBackupStatus | null; error: string | null } {
  const file = path.join(process.cwd(), "data", HEARTBEAT_FILE);
  try {
    // 心跳文件是 PowerShell 写的，历史上出现过 UTF-8 BOM 把 JSON.parse 打挂的情况，
    // 写入侧已经改成无 BOM，这里再剥一层是防御——读不到不该让整页 500。
    const raw = readFileSync(file, "utf8").replace(/^﻿/, "");
    return { data: JSON.parse(raw) as IOffsiteBackupStatus, error: null };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { data: null, error: "还没有收到过本机的异地备份心跳" };
    }
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** /settings 用的健康状态。只有推送和异地备份两件事，别往里堆指标。 */
export function getSystemHealth(): ISystemHealth {
  const dropped = getHealthSignal("push_subscription_dropped");
  const offsite = readOffsiteBackup();

  return {
    pushSubscriptions: listPushSubscriptions().length,
    lastPushSuccessAt: getHealthSignal("last_push_success_at")?.value ?? null,
    lastPushAttemptAt: getHealthSignal("last_push_attempt_at")?.value ?? null,
    // **"没有记录"和"从来没成功过"是两回事。** health_signals 是 2026-08-14 才建的表，
    // 在那之前发生过什么它一概不知道；空值只说明"这张表没记到过"，不是历史结论。
    // 没有这个字段的话，面板上的"从来没有过"会被读成一个关于整个项目历史的判断。
    recordingSince: getEarliestHealthSignalAt(),
    // 这份快照是什么时候取的。**一个数字单独出现时没有"正常"可言**——面板整块共享一个
    // 隐含的"页面渲染时刻"，而那个时刻本身不显示，读的人无从判断数字是新的还是卡住的。
    // 2026-08-14 就撞到过：订阅成功那一刻推送卡片显示 1 台、运行状态仍显示 0 台。
    // 那次是偏低（刷新就对了），但同一个失效形态**偏高时更危险**：快照卡住会一直显示
    // 陈旧的"1 台"，数字看起来正常，没人会想到去刷新。
    snapshotAt: new Date().toISOString(),
    lastSubscriptionDropped: dropped
      ? (JSON.parse(dropped.value) as { at: string; endpoint: string; remaining: number })
      : null,
    offsiteBackup: offsite.data,
    offsiteBackupError: offsite.error,
  };
}

/** 距今多少天，用来判"是不是已经陈旧到该报警了"。取不到时间返回 null。 */
export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? ms / (24 * 60 * 60 * 1000) : null;
}
