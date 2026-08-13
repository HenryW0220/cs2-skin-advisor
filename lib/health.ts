import { readFileSync } from "node:fs";
import path from "node:path";
import { getHealthSignal } from "./db/health-signals";
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
