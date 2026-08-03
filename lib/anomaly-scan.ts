import { addAnomalyEvent, hasRecentAnomalyEvent } from "./db/anomaly-events";
import { listItemMetadata } from "./db/item-metadata";
import { getPriceHistory, getRecentPriceHistory } from "./db/snapshots";
import { sendPushNotification } from "./api/web-push";
import { displayGroupName, isDerivedGroup } from "./item-metadata-groups";
import { detectPriceZScoreAnomaly, scanPriceZScoreAnomalies } from "./signals/anomaly";
import { computeManipulationScore } from "./signals/manipulation-score";
import { computeMomentumChaseSignal } from "./signals/momentum-chase";
import { resampleHourly } from "./signals/resample";
import { computeWashoutSignal } from "./signals/washout";
import { pickReferencePlatform } from "./signal-summary";
import { getTrackedItemNames } from "./tracked-items";

export interface IAnomalyScanSummary {
  itemsScanned: number;
  eventsCreated: number;
}

// 每次价格同步后跑一遍：价格 z-score 统计异常 + 操盘嫌疑分预警 + 同收藏品联动预警，
// 命中就落 pending 的 anomaly_events，等用户去 /anomalies 审核。
// 扫描范围见 lib/tracked-items.ts：持仓只算 buy_price>0 的部分（开箱所得的审不过来），
// 加观察池（观察池就是数据面扩容入口，见 PLAN.md A3）。
//
// 这里**刻意没有成交量异动检测**。原来有一条（168 期基线、3 倍阈值），2026-08-03 查明
// 它跟规则引擎那条是同一个根因：喂进去的是在售挂单数量（存量）不是成交量（流量），
// 存量在小时尺度上不会翻倍。证据是 anomaly_events 表里 metric='volume_ratio' 的
// 历史记录**一条都没有**，而同期 price_zscore 有 2043 条。理由详见 lib/db/snapshots.ts
// 里 volume 那一列的注释。

// 低价饰品的价格本身就是一分两分地跳（0.02 -> 0.03 就是 50%），这种"异常"是价格精度
// 太粗糙的机械结果，不是操盘——没人会去操盘一个几块钱的东西。挡在检测之前，而不是
// 事后筛掉：这类饰品占了实测候选事件里很大一部分噪音。
//
// 阈值 5 是 2026-07-31 用已人工审核的 485 条 price_zscore 事件回算出来的，不是拍脑袋：
// 按触发价分档的确认操盘率是 <¥5 → **0%（121 条无一命中）**、¥5-20 → 56%、¥20-100 → 99%、
// ¥100+ → 95%，¥5 以下这一档干净得没有任何保留价值。原值 1 定得太低，放进来的全是噪音。
// 注意**不要**改成按 z-score 强度筛：同一批数据显示 z 6-7 的确认率 68%、8-10 是 76%，
// 几乎无差别，而 z≥15 反而只有 31%（极端 z 多是数据毛刺），按强度砍会误伤大量真操盘。
const MIN_PRICE_FOR_ANOMALY_SCAN = 5;

// 嫌疑分/联动是"状态"型预警（分数会持续高位好几天），不像 z-score 是"事件"型——
// 同一饰品在窗口期内只提醒一次，不然每小时扫描一次就刷屏了。
const ALERT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const MANIPULATION_ALERT_MIN_SCORE = 60;

export async function scanForAnomalies(): Promise<IAnomalyScanSummary> {
  const itemNames = getTrackedItemNames();
  const cooldownSince = new Date(Date.now() - ALERT_COOLDOWN_MS).toISOString();
  let eventsCreated = 0;
  // D3：只推"状态型"高优先级信号（嫌疑分、联动），z-score/成交量/洗盘这类事件型或
  // 提示型信号太密，推了会被当骚扰关掉通知——冷却窗口（3天/条）已经把频率压住了。
  const pushNotifications: { title: string; body: string; url: string }[] = [];

  // 本轮触发了异动的饰品（z-score 或嫌疑分），给联动预警当输入
  const triggered = new Map<string, { label: string; value: number }>();
  // 各饰品最新快照，联动预警给下级饰品落事件时要用它的时间点和价格
  const latestByItem = new Map<string, { platform: string; captured_at: string; price: number }>();

  for (const itemName of itemNames) {
    const platform = pickReferencePlatform(itemName);
    if (!platform) continue;

    const history = getRecentPriceHistory(itemName, platform);
    if (history.length === 0) continue;

    const latest = history[history.length - 1];
    latestByItem.set(itemName, { platform, captured_at: latest.captured_at, price: latest.price });
    if (latest.price < MIN_PRICE_FOR_ANOMALY_SCAN) continue;
    // 下面这批信号函数把数组下标当"小时"用，喂之前统一按小时重采样，见 resampleHourly 注释。
    const hourly = resampleHourly(history);
    const prices = hourly.map((h) => h.price);

    const priceResult = detectPriceZScoreAnomaly(prices);
    if (priceResult?.isAnomaly && Number.isFinite(priceResult.zScore)) {
      const created = addAnomalyEvent({
        item_name: itemName,
        platform,
        metric: "price_zscore",
        detected_at: latest.captured_at,
        value: priceResult.zScore,
        price: latest.price,
      });
      if (created) {
        eventsCreated += 1;
        triggered.set(itemName, { label: `z-score ${priceResult.zScore.toFixed(1)}`, value: priceResult.zScore });
      }
    }

    // 操盘嫌疑分预警（B4）：波动形态跟已确认操盘期高度相似时主动提醒
    const manipulation = computeManipulationScore(prices);
    if (
      manipulation &&
      manipulation.score >= MANIPULATION_ALERT_MIN_SCORE &&
      !hasRecentAnomalyEvent(itemName, "manipulation_score", cooldownSince)
    ) {
      const created = addAnomalyEvent({
        item_name: itemName,
        platform,
        metric: "manipulation_score",
        detected_at: latest.captured_at,
        value: manipulation.score,
        price: latest.price,
        context: `24h波动率 ${(manipulation.volatility24h * 100).toFixed(2)}%、24h涨跌 ${(manipulation.move24h * 100).toFixed(1)}%、偏离周线均值 ${(manipulation.maDeviation * 100).toFixed(1)}%`,
      });
      if (created) {
        eventsCreated += 1;
        triggered.set(itemName, { label: `嫌疑分 ${manipulation.score}`, value: manipulation.score });
        pushNotifications.push({
          title: `操盘嫌疑分预警：${itemName}`,
          body: `嫌疑分 ${manipulation.score}，24h涨跌 ${(manipulation.move24h * 100).toFixed(1)}%`,
          url: `/item/${encodeURIComponent(itemName)}`,
        });
      }
    }

    // 洗盘/砸盘信号（B2 报告验证过的指纹）：提示性质，不进联动预警的 triggered 集合——
    // 这只是"疑似洗盘"，不是确认异动，不该拿去触发下级饰品的联动预警。
    const washout = computeWashoutSignal(prices);
    if (washout?.isWashout && !hasRecentAnomalyEvent(itemName, "washout_signal", cooldownSince)) {
      const created = addAnomalyEvent({
        item_name: itemName,
        platform,
        metric: "washout_signal",
        detected_at: latest.captured_at,
        // 待审核列表按 ABS(value) DESC 跟其他指标混排（价格 z-score 6~35、嫌疑分 60~100），
        // 存成 0~1 的小数会永远沉底、50 条分页里根本看不到——存成百分比数值（15~），
        // 量级才跟其他指标可比。
        value: washout.drawdown * 100,
        price: latest.price,
        context: `近48小时回撤 ${(washout.drawdown * 100).toFixed(1)}%、波动率 ${(washout.volatility * 100).toFixed(2)}%，形态上和 REPORT-manipulation-playbook-stages.md 里验证过的洗盘案例相似（深回撤后可能接急拉），也可能只是正常下跌，仅供参考`,
      });
      if (created) eventsCreated += 1;
    }

    // 追涨风险信号（REPORT-t7-actionable-labels.md 验证过的最稳结论）：同样提示性质，不进联动预警的
    // triggered 集合——涨了不代表操盘确认，只是"现在追可能站在高位"的风险提示。
    const momentumChase = computeMomentumChaseSignal(prices);
    if (
      momentumChase?.isChasing &&
      !hasRecentAnomalyEvent(itemName, "momentum_chase", cooldownSince)
    ) {
      const created = addAnomalyEvent({
        item_name: itemName,
        platform,
        metric: "momentum_chase",
        detected_at: latest.captured_at,
        value: momentumChase.return24h * 100, // 同 washout_signal，存百分比数值方便跟其他指标混排
        price: latest.price,
        context: `近24小时涨幅 ${(momentumChase.return24h * 100).toFixed(1)}%，REPORT-t7-actionable-labels.md 统计过历史上这个量级的涨幅未来7天平均收益 -10.74%（70.8% 概率为负），现在追高风险偏大，但也可能是主拉升刚开始，仅供参考`,
      });
      if (created) eventsCreated += 1;
    }
  }

  // 联动预警（B3）：同收藏品上级异动 → 下级（炼金料）可能跟涨。
  // 用户的经验规律："上级被拉时，下级因为可以炼金成上级而跟涨"，这里把它变成可执行信号。
  const metaByName = new Map(listItemMetadata().map((m) => [m.item_name, m]));
  for (const [triggerName, trigger] of triggered) {
    const triggerMeta = metaByName.get(triggerName);
    if (!triggerMeta?.collection || triggerMeta.rarity_rank === null) continue;

    for (const itemName of itemNames) {
      if (itemName === triggerName || triggered.has(itemName)) continue;
      const meta = metaByName.get(itemName);
      if (
        meta?.collection !== triggerMeta.collection ||
        meta.rarity_rank === null ||
        meta.rarity_rank >= triggerMeta.rarity_rank
      ) {
        continue;
      }
      const latest = latestByItem.get(itemName);
      if (!latest || hasRecentAnomalyEvent(itemName, "collection_linkage", cooldownSince)) continue;

      const created = addAnomalyEvent({
        item_name: itemName,
        platform: latest.platform,
        metric: "collection_linkage",
        detected_at: latest.captured_at,
        value: trigger.value,
        price: latest.price,
        context: `同收藏品「${triggerMeta.collection}」的上级 ${triggerName}（${triggerMeta.rarity ?? ""}）异动（${trigger.label}），本品是下级炼金料，可能跟涨`,
      });
      if (created) {
        eventsCreated += 1;
        pushNotifications.push({
          title: `联动预警：${itemName}`,
          body: `同收藏品上级 ${triggerName} 异动（${trigger.label}），本品可能跟涨`,
          url: `/item/${encodeURIComponent(itemName)}`,
        });
      }
    }
  }

  // 同组联动（2026-08-03）：同赛事胶囊的印花、同组织的探员是**平级**同涨同跌关系，
  // 没有上面那种"上级拉升→下级炼金料跟涨"的层级链条，所以单独一段、不套用 rarity_rank 排序
  // （这两类饰品本来也没有 rarity_rank）。分组来源见 lib/item-metadata-groups.ts，
  // 依据是实测：按胶囊/组织分组后 25/26 个饰品的联动特征同方向、24h 联动 AUC 中位 0.651。
  //
  // **观察期内只入库、不推送**（项目所有者定的口径）：这批预警的可靠性还没验证过，
  // 印花/探员同涨同跌比皮肤密集，直接开推送有把通知变成骚扰、被整个关掉的风险。
  // 判断依据要用数据不用感觉——观察期结束时统计 group_linkage 的触发次数、其中多少
  // 真正值得看、密集程度，再决定要不要接进 pushNotifications。
  for (const [triggerName, trigger] of triggered) {
    const triggerMeta = metaByName.get(triggerName);
    if (!triggerMeta?.collection || !isDerivedGroup(triggerMeta.collection)) continue;

    for (const itemName of itemNames) {
      if (itemName === triggerName || triggered.has(itemName)) continue;
      if (metaByName.get(itemName)?.collection !== triggerMeta.collection) continue;

      const latest = latestByItem.get(itemName);
      if (!latest || hasRecentAnomalyEvent(itemName, "group_linkage", cooldownSince)) continue;

      const created = addAnomalyEvent({
        item_name: itemName,
        platform: latest.platform,
        metric: "group_linkage",
        detected_at: latest.captured_at,
        value: trigger.value,
        price: latest.price,
        context: `同组「${displayGroupName(triggerMeta.collection)}」的 ${triggerName} 异动（${trigger.label}），同一批发行的饰品常同涨同跌，本品可能跟随`,
      });
      if (created) eventsCreated += 1;
    }
  }

  for (const notification of pushNotifications) {
    await sendPushNotification(notification);
  }

  return { itemsScanned: itemNames.length, eventsCreated };
}

// 一次性回溯扫描：对每个持仓饰品回填出来的完整历史逐点算价格 z-score（不止最新一点），
// 直接从刚回填的 90 天密集数据里挖出候选异常窗口，不用干等未来再发生一次。
// 只扫价格——成交量的真实数据现在还太少（K 线回填没有成交量，只能慢慢靠每小时同步攒），
// 回溯扫成交量意义不大，见 scanForAnomalies 里的说明。
export function scanHistoricalPriceAnomalies(): IAnomalyScanSummary {
  const itemNames = getTrackedItemNames();
  let eventsCreated = 0;

  for (const itemName of itemNames) {
    const platform = pickReferencePlatform(itemName);
    if (!platform) continue;

    const history = getPriceHistory(itemName, platform);
    if (history.length === 0) continue;

    const hourly = resampleHourly(history);
    const prices = hourly.map((h) => h.price);
    const results = scanPriceZScoreAnomalies(prices);

    for (const result of results) {
      if (!result.isAnomaly || !Number.isFinite(result.zScore)) continue;
      const snapshot = hourly[result.priceIndex];
      if (snapshot.price < MIN_PRICE_FOR_ANOMALY_SCAN) continue;
      const created = addAnomalyEvent({
        item_name: itemName,
        platform,
        metric: "price_zscore",
        detected_at: snapshot.captured_at,
        value: result.zScore,
        price: snapshot.price,
      });
      if (created) eventsCreated += 1;
    }
  }

  return { itemsScanned: itemNames.length, eventsCreated };
}
