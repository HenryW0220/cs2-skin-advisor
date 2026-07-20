import Link from "next/link";
import { AnomalyReviewActions } from "@/components/features/anomaly-review-actions";

// 这个页面没有 searchParams，生产构建时会被静态预渲染成构建时刻的死数据——
// 强制按请求渲染，待审核列表才是实时的。
export const dynamic = "force-dynamic";
import { SyncItemMetadataButton } from "@/components/features/sync-item-metadata-button";
import { STEAM_ICON_BASE_URL } from "@/lib/api/steam";
import { listAnomalyEvents } from "@/lib/db/anomaly-events";
import { listInventory } from "@/lib/db/inventory";
import { listItemMetadata } from "@/lib/db/item-metadata";
import type { IAnomalyEvent, IAnomalyMetric, IItemMetadata } from "@/lib/types";

const METRIC_LABEL: Record<IAnomalyMetric, string> = {
  price_zscore: "价格波动异常",
  volume_ratio: "成交量放大",
  manipulation_score: "操盘嫌疑",
  collection_linkage: "联动预警",
  washout_signal: "疑似洗盘",
};

// 联动预警用紫色跟收藏品体系呼应，嫌疑分用红色示警，统计异常保持橙色，
// 洗盘信号用蓝色区分——它是提示性的领先信号，不是"已确认异动"，颜色上不该和红/橙抢眼
const METRIC_STYLE: Record<IAnomalyMetric, string> = {
  price_zscore: "bg-orange-500/15 text-orange-400",
  volume_ratio: "bg-orange-500/15 text-orange-400",
  manipulation_score: "bg-red-500/15 text-red-400",
  collection_linkage: "bg-purple-500/15 text-purple-300",
  washout_signal: "bg-blue-500/15 text-blue-300",
};

function formatMetricValue(metric: IAnomalyMetric, value: number): string {
  switch (metric) {
    case "price_zscore":
      return `z-score ${value.toFixed(2)}`;
    case "volume_ratio":
      return `${value.toFixed(1)}x 于历史均值`;
    case "manipulation_score":
      return `嫌疑分 ${value.toFixed(0)}`;
    case "collection_linkage":
      return `上级信号强度 ${value.toFixed(1)}`;
    case "washout_signal":
      return `回撤 ${(value * 100).toFixed(1)}%`;
  }
}

interface ICollectionCluster {
  collection: string;
  items: { itemName: string; rarity: string | null; rarityRank: number | null; count: number }[];
}

// 用户的经验规律：拉盘不是单个饰品的事——同收藏品的上级被拉时，下级（炼金材料）
// 会跟涨。所以把待审核异常按收藏品分组，同一收藏品里 ≥2 个饰品同时报异常，
// 联动嫌疑远比单个饰品的孤立异常大，优先审。
function findCollectionClusters(
  pending: IAnomalyEvent[],
  metaByName: Map<string, IItemMetadata>
): ICollectionCluster[] {
  const byCollection = new Map<string, Map<string, number>>();
  for (const event of pending) {
    const collection = metaByName.get(event.item_name)?.collection;
    if (!collection) continue;
    const items = byCollection.get(collection) ?? new Map<string, number>();
    items.set(event.item_name, (items.get(event.item_name) ?? 0) + 1);
    byCollection.set(collection, items);
  }

  return [...byCollection.entries()]
    .filter(([, items]) => items.size >= 2)
    .map(([collection, items]) => ({
      collection,
      items: [...items.entries()]
        .map(([itemName, count]) => ({
          itemName,
          rarity: metaByName.get(itemName)?.rarity ?? null,
          rarityRank: metaByName.get(itemName)?.rarity_rank ?? null,
          count,
        }))
        .sort((a, b) => (b.rarityRank ?? 0) - (a.rarityRank ?? 0)),
    }))
    .sort((a, b) => b.items.length - a.items.length);
}

// 每小时同步后自动跑的统计异常检测（价格 z-score + 成交量倍数）落在这里等审核。
// 只扫持仓，跟 K 线回填、操盘标记的范围一致。确认/忽略的结果分别喂给
// manipulation_tags 当正/负样本——这个页面是"自动检测"和"人工标注"的连接点。
const PAGE_LIMIT = 50;

export default async function AnomaliesPage() {
  const allPending = listAnomalyEvents("pending");
  const events = allPending.slice(0, PAGE_LIMIT);
  const pendingCountByItem = new Map<string, number>();
  for (const event of allPending) {
    pendingCountByItem.set(event.item_name, (pendingCountByItem.get(event.item_name) ?? 0) + 1);
  }
  const displayInfoByName = new Map(
    listInventory().map((item) => [item.item_name, { nameCn: item.name_cn, iconUrl: item.icon_url }])
  );
  const metaByName = new Map(listItemMetadata().map((meta) => [meta.item_name, meta]));
  const clusters = findCollectionClusters(allPending, metaByName);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
        <h1 className="text-lg font-semibold text-neutral-200">异常波动待审核</h1>
        <p className="mt-1 text-sm text-neutral-500">
          每小时同步价格后自动检测，命中统计异常的饰品会出现在这里。确认是操盘会自动生成对应的
          <Link href="/positions" className="mx-1 text-blue-400 hover:underline">
            操盘标记
          </Link>
          ；“外部事件”（版本更新、炼金开放、大赛等引发的真实行情）请写明具体事件——它长得跟操盘一样但成因不同，是训练时最有价值的对照数据；“正常波动”是普通对照数据。三种结论都会被记下来。
        </p>
        {allPending.length > PAGE_LIMIT && (
          <p className="mt-1 text-xs text-neutral-600">
            共 {allPending.length} 条待审核，按异常程度排序显示最可疑的 {PAGE_LIMIT} 条
          </p>
        )}
        </div>
        <SyncItemMetadataButton />
      </div>

      {clusters.length > 0 && (
        <div className="rounded-lg border border-purple-900/60 bg-purple-500/5 p-4">
          <h2 className="text-sm font-medium text-purple-300">
            同系列联动嫌疑（同收藏品多个饰品同时异常，上级拉盘带动下级炼金需求的典型形态）
          </h2>
          <div className="mt-2 space-y-2">
            {clusters.map((cluster) => (
              <div key={cluster.collection} className="text-xs text-neutral-400">
                <span className="font-medium text-neutral-200">{cluster.collection}</span>
                <span className="mx-2 text-neutral-600">·</span>
                {cluster.items.map((item, i) => {
                  const display = displayInfoByName.get(item.itemName);
                  return (
                    <span key={item.itemName}>
                      {i > 0 && <span className="text-neutral-600"> + </span>}
                      <Link
                        href={`/item/${encodeURIComponent(item.itemName)}`}
                        className="text-blue-400 hover:underline"
                      >
                        {display?.nameCn ?? item.itemName}
                      </Link>
                      {item.rarity && <span className="text-neutral-500">（{item.rarity}）</span>}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {events.map((event) => {
          const display = displayInfoByName.get(event.item_name);
          const displayName = display?.nameCn ?? event.item_name;
          const meta = metaByName.get(event.item_name);
          return (
            <div
              key={event.id}
              className="flex items-center gap-4 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3"
            >
              {display?.iconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- 外部 Steam CDN 图片，没配 next/image 的 remotePatterns
                <img
                  src={`${STEAM_ICON_BASE_URL}/${display.iconUrl}`}
                  alt={displayName}
                  width={40}
                  height={40}
                  className="size-10 shrink-0 rounded bg-neutral-800 object-contain"
                />
              ) : (
                <div className="size-10 shrink-0 rounded bg-neutral-800" />
              )}

              <div className="min-w-0 flex-1">
                <Link
                  href={`/item/${encodeURIComponent(event.item_name)}`}
                  className="font-medium text-neutral-100 hover:text-blue-400 hover:underline"
                >
                  {displayName}
                </Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-neutral-500">
                  <span className={`rounded px-1.5 py-0.5 ${METRIC_STYLE[event.metric]}`}>
                    {METRIC_LABEL[event.metric]}
                  </span>
                  <span>{formatMetricValue(event.metric, event.value)}</span>
                  <span>¥{event.price.toFixed(2)}</span>
                  <span>{new Date(event.detected_at).toLocaleString("zh-CN")}</span>
                  <span className="text-neutral-600">{event.platform}</span>
                  {meta?.collection && (
                    <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-purple-300">
                      {meta.collection}
                      {meta.rarity ? ` · ${meta.rarity}` : ""}
                    </span>
                  )}
                </div>
                {event.context && (
                  <div className="mt-0.5 text-xs text-neutral-500">{event.context}</div>
                )}
              </div>

              <AnomalyReviewActions
                eventId={event.id}
                pendingCountForItem={pendingCountByItem.get(event.item_name) ?? 1}
              />
            </div>
          );
        })}

        {events.length === 0 && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-5 py-10 text-center text-sm text-neutral-500">
            暂时没有待审核的异常波动，同步价格后如果检测到会自动出现在这里
          </div>
        )}
      </div>
    </div>
  );
}
