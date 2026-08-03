// 一次性分析脚本：验证"印花按赛事胶囊、探员按所属组织"分组能不能像收藏品一样产生联动信号。
// 用法：node scripts/analyze-group-comove.mjs（要在云端容器里跑，本机 db 是旧快照）
//
// 动机（2026-08-03）：给 analyze-manipulation-features.mjs 补按饰品检验时发现，
// coMove 长期被判"没区分度"是个统计假象——67 个有操盘标记的饰品里 34 个（23 张印花 +
// 10 个探员 + 1 个皮肤）的 item_metadata.collection 是空的，对它们 coMove 恒为 0，
// AUC 机械地等于 0.5，把整体命中率稀释到看起来像抛硬币。剔除这些退化样本后，
// 剩下 32 个可检验饰品是 32/32 同方向（coMove24h 中位 AUC 0.749）。
//
// 印花和探员没有"收藏品"是数据正确而非缺失（那是皮肤才有的概念），但它们有天然等价物：
// 印花属于同一个赛事胶囊、探员属于同一个组织。这个脚本就是验证这个等价物成不成立。
// **只读，不写库、不碰 item_metadata**——要不要把这个分组落进生产数据是另一个决定，
// 因为 lib/anomaly-scan.ts 的同收藏品联动预警读的就是那一列，改了会直接影响线上预警。
import Database from "better-sqlite3";
const db = new Database("data/db.sqlite", { readonly: true });
const HOUR_MS = 36e5, DAY_MS = 24 * HOUR_MS;

function groupOf(name) {
  const parts = name.split("|").map(s => s.trim());
  if (name.startsWith("Sticker |")) return parts.length >= 3 ? "capsule:" + parts[parts.length - 1] : null;
  if (parts.length === 2 && !/\)$/.test(name)) return "agentgroup:" + parts[1];
  return null;
}

const tagsByItem = new Map();
for (const t of db.prepare("SELECT * FROM manipulation_tags").all()) {
  const s = new Date(`${t.start_date}T00:00:00Z`).getTime();
  const e = t.end_date ? new Date(`${t.end_date}T00:00:00Z`).getTime() + DAY_MS : s + 3 * DAY_MS;
  if (!tagsByItem.has(t.item_name)) tagsByItem.set(t.item_name, []);
  tagsByItem.get(t.item_name).push([s, e]);
}
const all = db.prepare("SELECT DISTINCT item_name FROM price_snapshots").all().map(r => r.item_name);
const PRIO = ["C5", "BUFF", "YOUPIN"];
function platformOf(item) {
  const rows = db.prepare("SELECT platform, COUNT(*) n FROM price_snapshots WHERE item_name=? AND price>0 GROUP BY platform ORDER BY n DESC").all(item);
  for (const p of PRIO) { const h = rows.find(r => r.platform === p); if (h && h.n >= 200) return p; }
  return rows[0]?.n >= 200 ? rows[0].platform : null;
}
const retByItem = new Map(), r24ByItem = new Map(), platOf = new Map();
for (const it of all) {
  const p = platformOf(it); if (!p) continue; platOf.set(it, p);
  const rows = db.prepare("SELECT captured_at, price FROM price_snapshots WHERE item_name=? AND platform=? AND price>0 ORDER BY captured_at").all(it, p);
  const m = new Map();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i-1].price <= 0) continue;
    m.set(Math.floor(Date.parse(rows[i].captured_at)/HOUR_MS)*HOUR_MS, (rows[i].price - rows[i-1].price)/rows[i-1].price);
  }
  retByItem.set(it, m);
  const r24 = new Map();
  for (const h of m.keys()) { let acc = 1; for (let k=0;k<24;k++){ const r=m.get(h-k*HOUR_MS); if(r!==undefined) acc*=1+r; } r24.set(h, acc-1); }
  r24ByItem.set(it, r24);
}
const groups = new Map();
for (const it of all) { const g = groupOf(it); if (!g) continue; if(!groups.has(g)) groups.set(g, []); groups.get(g).push(it); }

function auc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  const a = [...neg.map(v=>[v,0]), ...pos.map(v=>[v,1])].sort((x,y)=>x[0]-y[0]);
  let rs=0,i=0;
  while(i<a.length){ let j=i; while(j<a.length&&a[j][0]===a[i][0]) j++; const r=(i+j+1)/2; for(let k=i;k<j;k++) if(a[k][1]===1) rs+=r; i=j; }
  return (rs - pos.length*(pos.length+1)/2)/(pos.length*neg.length);
}
const median = a => { const s=[...a].sort((x,y)=>x-y); return s.length? s[Math.floor(s.length/2)] : NaN; };

const tagged = [...tagsByItem.keys()].filter(t => groupOf(t));
console.log(`按名字能推出分组的有标记饰品：${tagged.length} 个`);
const aucs = [], aucs24 = [];
for (const it of tagged) {
  const g = groupOf(it);
  const sibs = (groups.get(g) ?? []).filter(o => o !== it && retByItem.has(o));
  if (!sibs.length) continue;
  const p = platOf.get(it); if (!p) continue;
  const rows = db.prepare("SELECT captured_at FROM price_snapshots WHERE item_name=? AND platform=? AND price>0 ORDER BY captured_at").all(it, p);
  const pos=[],neg=[],pos24=[],neg24=[];
  for (const row of rows) {
    const ts = Date.parse(row.captured_at), h = Math.floor(ts/HOUR_MS)*HOUR_MS;
    let cm=0, cm24=0;
    for (const s of sibs) { const r=retByItem.get(s)?.get(h); if(r!==undefined&&Math.abs(r)>0.01) cm++; const q=r24ByItem.get(s)?.get(h); if(q!==undefined&&Math.abs(q)>0.03) cm24++; }
    const isManip = (tagsByItem.get(it)??[]).some(([s,e]) => ts>=s && ts<e);
    (isManip?pos:neg).push(cm); (isManip?pos24:neg24).push(cm24);
  }
  if (pos.length<24||neg.length<24) continue;
  if (new Set([...pos,...neg]).size>1) aucs.push([it, sibs.length, auc(pos,neg)]);
  if (new Set([...pos24,...neg24]).size>1) aucs24.push([it, sibs.length, auc(pos24,neg24)]);
}
for (const [label, arr] of [["同胶囊/同组织 1小时联动", aucs], ["同胶囊/同组织 24小时联动", aucs24]]) {
  const vals = arr.map(a=>a[2]);
  console.log(`${label}：可检验 ${vals.length} 个，AUC>0.5 的 ${vals.filter(v=>v>0.5).length} 个，中位 AUC ${median(vals).toFixed(3)}`);
}
console.log("明细（饰品 / 同组伙伴数 / 24h联动AUC）：");
for (const [it, n, a] of aucs24.sort((x,y)=>y[2]-x[2]).slice(0,15)) console.log(`  ${a.toFixed(3)}  伙伴${n}  ${it}`);
