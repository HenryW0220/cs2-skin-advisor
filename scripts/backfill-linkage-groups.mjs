// 给已有的印花/探员补联动分组（印花按赛事胶囊、探员按所属组织）。
//
// 用法（要在云端容器里跑，本机 db 是旧快照）：
//   node scripts/backfill-linkage-groups.mjs            # 演练，只打印不写库
//   node scripts/backfill-linkage-groups.mjs --apply    # 真的写
//   node scripts/backfill-linkage-groups.mjs --revert --apply   # 撤销（只清 derived 的行）
//
// 背景：印花和探员天然没有收藏品（那是皮肤才有的概念），所以同收藏品联动特征对它们恒为 0。
// 2026-08-03 实测按胶囊/组织分组后 25/26 个饰品的联动特征同方向、24h 联动 AUC 中位 0.651
// （scripts/analyze-group-comove.mjs），所以把这个分组补进 item_metadata。
//
// **只动 collection 为空的行**——真实收藏品优先，绝不覆盖 ByMykel 数据集给的官方数据。
// 撤销时也只清 collection_source='derived' 的行，官方数据碰都不碰。
//
// 分组规则跟 lib/item-metadata-groups.ts 保持一致；那边是生产代码（新同步的饰品走那条路），
// 这个脚本只处理存量。两处都改的时候要一起改——这是刻意的重复，因为 node 跑不了 lib 的 .ts。
import Database from "better-sqlite3";

const apply = process.argv.includes("--apply");
const revert = process.argv.includes("--revert");
const db = new Database("data/db.sqlite");

function deriveLinkageGroup(itemName) {
  const parts = itemName.split("|").map((s) => s.trim());
  if (itemName.startsWith("Sticker |")) {
    return parts.length >= 3 ? "capsule:" + parts[parts.length - 1] : null;
  }
  if (parts.length === 2 && !itemName.endsWith(")")) {
    return "agentgroup:" + parts[1];
  }
  return null;
}

if (revert) {
  const rows = db
    .prepare("SELECT item_name, collection FROM item_metadata WHERE collection_source = 'derived'")
    .all();
  console.log(`将清空 ${rows.length} 条推导分组（官方收藏品不受影响）：`);
  for (const r of rows.slice(0, 10)) console.log(`  ${r.item_name}  ←  ${r.collection}`);
  if (rows.length > 10) console.log(`  ...另有 ${rows.length - 10} 条`);
  if (apply) {
    db.prepare(
      "UPDATE item_metadata SET collection = NULL, collection_source = 'official', updated_at = datetime('now') WHERE collection_source = 'derived'"
    ).run();
    console.log("已撤销。");
  } else {
    console.log("（演练，没有写库；加 --apply 才执行）");
  }
  process.exit(0);
}

const candidates = db
  .prepare("SELECT item_name FROM item_metadata WHERE collection IS NULL")
  .all();

const groups = new Map();
let skipped = 0;
for (const { item_name } of candidates) {
  const g = deriveLinkageGroup(item_name);
  if (!g) {
    skipped += 1;
    continue;
  }
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(item_name);
}

const total = [...groups.values()].reduce((s, v) => s + v.length, 0);
console.log(`没有收藏品的饰品 ${candidates.length} 个，能推出分组的 ${total} 个，推不出的 ${skipped} 个`);
console.log("");
console.log("分组明细（只有组内 ≥2 个饰品才可能产生联动信号，单件的补了也没用但无害）：");
for (const [g, items] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${g}  (${items.length} 个)`);
  for (const it of items) console.log(`      ${it}`);
}
const multi = [...groups.values()].filter((v) => v.length >= 2).length;
console.log("");
console.log(`共 ${groups.size} 组，其中 ${multi} 组有 2 个以上饰品（这些才会真正产生联动预警）`);

if (!apply) {
  console.log("");
  console.log("（演练，没有写库；加 --apply 才执行）");
  process.exit(0);
}

const stmt = db.prepare(
  "UPDATE item_metadata SET collection = ?, collection_source = 'derived', updated_at = datetime('now') WHERE item_name = ? AND collection IS NULL"
);
let updated = 0;
db.transaction(() => {
  for (const [g, items] of groups) {
    for (const it of items) updated += stmt.run(g, it).changes;
  }
})();
console.log("");
console.log(`已写入 ${updated} 行。`);
