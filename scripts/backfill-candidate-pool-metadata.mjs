// 给 market_candidate_pool 里的全市场随机样本补 item_metadata（收藏品/箱子/品质），
// 让 coMove 规则基准能在完整候选池上公平对比——之前只有原来131个真实跟踪饰品有
// metadata，363个随机样本没有，coMove 候选数被锁死在115个，跟模型评估的候选池
// 大小不对等（见 REPORT-C1-C2.md 2026-07-21 复核记录）。
//
// 用法：node scripts/backfill-candidate-pool-metadata.mjs
// 不需要额外网络请求之外的调用——collection/crate/rarity 数据跟抽样时用的是
// 同一份 ByMykel 目录，这里重新拉一次是为了拿到 backfill-candidate-pool.mjs
// 当时没保留的 collection/crate 字段（那边只存了 rarity 到 market_candidate_pool）。
import Database from "better-sqlite3";

const RARITY_RANK = [
  ["rarity_common", 1],
  ["rarity_uncommon", 2],
  ["rarity_rare", 3],
  ["rarity_mythical", 4],
  ["rarity_legendary", 5],
  ["rarity_ancient", 6],
  ["rarity_contraband", 7],
];

function rarityRankOf(rarityId) {
  if (!rarityId) return null;
  const hit = RARITY_RANK.find(([prefix]) => rarityId.startsWith(prefix));
  return hit ? hit[1] : null;
}

const db = new Database(new URL("../data/db.sqlite", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

async function main() {
  const poolItems = db.prepare("SELECT item_name FROM market_candidate_pool").all().map((r) => r.item_name);
  console.log(`候选池 ${poolItems.length} 个饰品，开始拉取结构数据...`);

  const zhBase = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/zh-CN";
  const [grouped, ungrouped] = await Promise.all([
    fetch(`${zhBase}/skins.json`).then((r) => r.json()),
    fetch(`${zhBase}/skins_not_grouped.json`).then((r) => r.json()),
  ]);
  const groupedById = new Map(grouped.map((s) => [s.id, s]));
  const byName = new Map();
  for (const entry of ungrouped) {
    if (!entry.market_hash_name) continue;
    const group = groupedById.get(entry.skin_id);
    byName.set(entry.market_hash_name, {
      collection: group?.collections?.[0]?.name ?? null,
      crate: group?.crates?.[0]?.name ?? null,
      rarity: group?.rarity?.name ?? null,
      rarityRank: rarityRankOf(group?.rarity?.id),
    });
  }

  const upsert = db.prepare(
    `INSERT INTO item_metadata (item_name, collection, crate, rarity, rarity_rank)
     VALUES (@item_name, @collection, @crate, @rarity, @rarity_rank)
     ON CONFLICT(item_name) DO UPDATE SET
       collection = excluded.collection,
       crate = excluded.crate,
       rarity = excluded.rarity,
       rarity_rank = excluded.rarity_rank,
       updated_at = datetime('now')`
  );

  let matched = 0;
  let unmatched = 0;
  const insertMany = db.transaction((items) => {
    for (const itemName of items) {
      const info = byName.get(itemName);
      if (info) matched += 1;
      else unmatched += 1;
      upsert.run({
        item_name: itemName,
        collection: info?.collection ?? null,
        crate: info?.crate ?? null,
        rarity: info?.rarity ?? null,
        rarity_rank: info?.rarityRank ?? null,
      });
    }
  });
  insertMany(poolItems);

  console.log(`完成：匹配到结构数据 ${matched} 个，未匹配（印花/探员等非武器皮肤,理论上抽样池里不应该有）${unmatched} 个`);
}

main()
  .catch((err) => {
    console.error("补 metadata 脚本崩了:", err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
