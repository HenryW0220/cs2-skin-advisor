// 给 C1/C2 预测模型的"全市场"候选池补真正的随机样本（REPORT-C1-C2.md 问题一：
// 之前的 full 池只是 131 个用户自己关注的跟踪饰品，不是全市场随机样本，数字偏乐观）。
//
// 用法：node scripts/backfill-candidate-pool.mjs [目标样本数，默认500]
//
// 方法：从 ByMykel/CSGO-API 的全量武器皮肤目录（约2.1万个 market_hash_name）里，
// 排除已跟踪饰品（持仓+观察池，它们已有完整历史），按品质分层比例抽样凑够目标数量
// （按真实市场品质构成比例抽，不是每档等量抽——目的是让抽出来的样本分布接近真实
// 全市场，不是人为拉平稀有度分布），写进 market_candidate_pool 留档保证可复现。
//
// 数据获取：只用 K 线接口（/open/cs2/item/v1/kline），单次调用直接拿回90天完整小时线，
// 不用碰批量价格接口——实测批量价格接口限流很紧（连续2次请求就404 4005，需要等
// 差不多60秒才恢复），而 K 线接口连续请求（250ms间隔，跟 lib/kline-backfill.ts 现有
// 逻辑一致）没有触发限流。这是一次性回填，不接入每小时同步，不影响生产采集器。
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}

const BASE_URL = process.env.STEAMDT_API_BASE_URL;
const APP_KEY = process.env.STEAMDT_APP_KEY;
const TARGET_SIZE = Number(process.argv[2] ?? 500);
const REQUEST_DELAY_MS = 250;
const FALLBACK_PLATFORM = "C5";

const db = new Database(new URL("../data/db.sqlite", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
// 独立脚本不走 lib/db/client.ts 的启动期迁移，自己确保表存在（跟 015 迁移的 DDL 保持一致）。
db.exec(`CREATE TABLE IF NOT EXISTS market_candidate_pool (
  item_name TEXT PRIMARY KEY,
  rarity TEXT,
  sampled_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCatalog() {
  const zhBase = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/zh-CN";
  const [grouped, ungrouped] = await Promise.all([
    fetch(`${zhBase}/skins.json`).then((r) => r.json()),
    fetch(`${zhBase}/skins_not_grouped.json`).then((r) => r.json()),
  ]);
  const groupedById = new Map(grouped.map((s) => [s.id, s]));
  const byName = new Map();
  for (const entry of ungrouped) {
    if (!entry.market_hash_name) continue;
    const rarity = groupedById.get(entry.skin_id)?.rarity?.id ?? "unknown";
    byName.set(entry.market_hash_name, rarity);
  }
  return byName;
}

function stratifiedSample(universeByName, need) {
  const byTier = new Map();
  for (const [name, rarity] of universeByName) {
    if (!byTier.has(rarity)) byTier.set(rarity, []);
    byTier.get(rarity).push(name);
  }
  const totalUniverse = universeByName.size;
  const picked = [];
  for (const [rarity, names] of byTier) {
    const share = names.length / totalUniverse;
    const quota = Math.max(1, Math.round(need * share));
    const shuffled = [...names].sort(() => Math.random() - 0.5);
    for (const name of shuffled.slice(0, quota)) picked.push({ item_name: name, rarity });
  }
  return picked.sort(() => Math.random() - 0.5).slice(0, need);
}

async function backfillOne(itemName) {
  const res = await fetch(new URL("/open/cs2/item/v1/kline", BASE_URL), {
    method: "POST",
    headers: { Authorization: `Bearer ${APP_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ marketHashName: itemName, type: 1, platform: FALLBACK_PLATFORM }),
  });
  const json = await res.json();
  if (!res.ok || !json.success || !json.data) {
    return { count: 0, error: json.errorMsg ?? `HTTP ${res.status}` };
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO price_snapshots (item_name, platform, price, volume, captured_at)
     VALUES (?, ?, ?, NULL, ?)`
  );
  const insertMany = db.transaction((points) => {
    let count = 0;
    for (const [timestampSec, , , , close] of points) {
      insert.run(itemName, FALLBACK_PLATFORM, close, new Date(Number(timestampSec) * 1000).toISOString());
      count += 1;
    }
    return count;
  });
  return { count: insertMany(json.data) };
}

async function main() {
  const existingPool = db.prepare("SELECT item_name FROM market_candidate_pool").all().map((r) => r.item_name);
  const need = TARGET_SIZE - existingPool.length;
  if (need <= 0) {
    console.log(`候选池已有 ${existingPool.length} 个，达到目标 ${TARGET_SIZE}，不需要再抽样。`);
    return;
  }

  console.log("拉取 ByMykel 全市场目录...");
  const catalog = await fetchCatalog();
  console.log(`全市场唯一饰品: ${catalog.size}`);

  const excluded = new Set([
    ...db.prepare("SELECT DISTINCT item_name FROM inventory").all().map((r) => r.item_name),
    ...db.prepare("SELECT item_name FROM watchlist").all().map((r) => r.item_name),
    ...existingPool,
  ]);
  const universe = new Map([...catalog].filter(([name]) => !excluded.has(name)));
  console.log(`排除已跟踪/已抽样后可选: ${universe.size}，本次要补 ${need} 个`);

  const sample = stratifiedSample(universe, need);
  console.log(`本次抽样 ${sample.length} 个，开始回填90天K线（每个间隔 ${REQUEST_DELAY_MS}ms）...`);

  const insertPool = db.prepare(
    "INSERT INTO market_candidate_pool (item_name, rarity) VALUES (?, ?) ON CONFLICT(item_name) DO NOTHING"
  );

  let ok = 0;
  let failed = 0;
  let totalSnapshots = 0;
  for (let i = 0; i < sample.length; i++) {
    const { item_name, rarity } = sample[i];
    insertPool.run(item_name, rarity);
    const result = await backfillOne(item_name);
    if (result.error) {
      failed += 1;
      console.log(`[${i + 1}/${sample.length}] ${item_name}: 失败 - ${result.error}`);
    } else {
      ok += 1;
      totalSnapshots += result.count;
      if ((i + 1) % 20 === 0) console.log(`[${i + 1}/${sample.length}] 进度：成功 ${ok}，失败 ${failed}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\n=== 完成 ===`);
  console.log(`成功 ${ok}，失败 ${failed}，写入快照 ${totalSnapshots} 条`);
  console.log(`候选池总规模: ${existingPool.length + ok}（目标 ${TARGET_SIZE}）`);
}

main()
  .catch((err) => {
    console.error("回填脚本崩了:", err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
