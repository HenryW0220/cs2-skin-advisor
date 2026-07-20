// B2 操盘剧本验证脚本：对已确认的操盘窗口（含窗口前 2 周、后 5 天）做无监督分段 + 分段特征画像，
// 再拿聚类结果对照用户给出的六阶段剧本（低位横盘→吸货→会员进场→洗盘→主拉→出货）。
// 用法：node scripts/analyze-playbook-stages.mjs
//
// 防循环论证的关键设计：分段用变点检测（对 log 价格做分段线性拟合 + BIC 判停），
// 聚类只看形态特征（涨速/波动/回撤），全程不使用剧本先验；剧本名字只在人工解读时对号入座。
// 结论写进 REPORT-B2.md，喂 C 阶段（吸货期指纹=买点特征）和 D1（出货期指纹=逃顶信号）。
import Database from "better-sqlite3";

const db = new Database("data/db.sqlite", { readonly: true });

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PRE_WINDOW_DAYS = 14; // 剧本的吸货/横盘发生在拉盘确认之前，所以往前多取两周
const POST_WINDOW_DAYS = 5; // 出货可能拖到窗口标记结束之后
const MIN_SEG_HOURS = 24; // 小于一天的段落多半是噪声（最小报价单位、单笔挂单）
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];

// ---------- 1. 窗口合并成 episode ----------
// 同一饰品的多个窗口经常首尾相接（批量标注按异常事件生成），间隔 ≤3 天视为同一次做盘。

function loadEpisodes() {
  const tags = db
    .prepare("SELECT item_name, start_date, end_date FROM manipulation_tags ORDER BY item_name, start_date")
    .all();
  const episodes = [];
  for (const t of tags) {
    const start = new Date(`${t.start_date}T00:00:00Z`).getTime();
    // end_date 为空按 +3 天算，与 analyze-manipulation-features.mjs 保持同一口径
    const end = t.end_date ? new Date(`${t.end_date}T00:00:00Z`).getTime() + DAY_MS : start + 3 * DAY_MS;
    const last = episodes[episodes.length - 1];
    if (last && last.item === t.item_name && start - last.end <= 3 * DAY_MS) {
      last.end = Math.max(last.end, end);
      last.tagCount++;
    } else {
      episodes.push({ item: t.item_name, start, end, tagCount: 1 });
    }
  }
  return episodes;
}

// ---------- 2. 小时级价格序列 ----------

function referencePlatform(itemName) {
  const rows = db
    .prepare(
      `SELECT platform, COUNT(*) n FROM price_snapshots
       WHERE item_name = ? AND price > 0 GROUP BY platform ORDER BY n DESC`
    )
    .all(itemName);
  for (const p of PLATFORM_PRIORITY) {
    const hit = rows.find((r) => r.platform === p);
    if (hit && hit.n >= 200) return p;
  }
  return rows[0]?.n >= 200 ? rows[0].platform : null;
}

// 按小时对齐取每小时最后一个价，缺口不插值（缺口跨段不影响线性拟合，插值反而制造假平稳）
function hourlySeries(itemName, platform, fromTs, toTs) {
  const rows = db
    .prepare(
      `SELECT captured_at, price, volume FROM price_snapshots
       WHERE item_name = ? AND platform = ? AND price > 0 ORDER BY captured_at ASC`
    )
    .all(itemName, platform);
  const byHour = new Map();
  for (const r of rows) {
    const ts = new Date(r.captured_at).getTime();
    if (ts < fromTs || ts >= toTs) continue;
    byHour.set(Math.floor(ts / HOUR_MS), { price: r.price, volume: r.volume });
  }
  return [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([h, v]) => ({ hour: h, logPrice: Math.log(v.price), price: v.price, volume: v.volume }));
}

// ---------- 3. 变点检测：分段线性 + BIC ----------

function linearFitSSE(pts, from, to) {
  // 对 [from, to) 的 (hour, logPrice) 做最小二乘，返回 SSE 和斜率
  const n = to - from;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = from; i < to; i++) {
    const x = pts[i].hour - pts[from].hour;
    const y = pts[i].logPrice;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  let sse = 0;
  for (let i = from; i < to; i++) {
    const x = pts[i].hour - pts[from].hour;
    const resid = pts[i].logPrice - (slope * x + intercept);
    sse += resid * resid;
  }
  return { sse, slope };
}

// 二分式分段：只要"一分为二后 BIC 下降"就继续切。参数量 k=每段 2（斜率+截距）+ 变点位置 1。
function segment(pts, from, to, out) {
  const n = to - from;
  const whole = linearFitSSE(pts, from, to);
  let best = null;
  const minPts = MIN_SEG_HOURS;
  for (let cut = from + minPts; cut <= to - minPts; cut++) {
    // 变点必须落在真实时间上连续的位置：跨大缺口（>12h）处禁切，避免把数据断档当成形态突变
    if (pts[cut].hour - pts[cut - 1].hour > 12) continue;
    const a = linearFitSSE(pts, from, cut);
    const b = linearFitSSE(pts, cut, to);
    if (!best || a.sse + b.sse < best.sse) best = { cut, sse: a.sse + b.sse };
  }
  if (best) {
    const eps = 1e-12; // SSE 可能为 0（价格长期不动），避免 log(0)
    const bicWhole = n * Math.log(whole.sse / n + eps) + 2 * Math.log(n);
    const bicSplit = n * Math.log(best.sse / n + eps) + 5 * Math.log(n);
    if (bicSplit < bicWhole) {
      segment(pts, from, best.cut, out);
      segment(pts, best.cut, to, out);
      return;
    }
  }
  out.push({ from, to });
}

// ---------- 4. 分段特征 ----------

function maxDrawdown(pts, from, to) {
  let peak = -Infinity;
  let mdd = 0;
  for (let i = from; i < to; i++) {
    peak = Math.max(peak, pts[i].price);
    mdd = Math.max(mdd, (peak - pts[i].price) / peak);
  }
  return mdd;
}

function segmentFeatures(pts, seg, ep, analysisStart, analysisEnd) {
  const { from, to } = seg;
  const durH = pts[to - 1].hour - pts[from].hour + 1;
  const fit = linearFitSSE(pts, from, to);
  const slopePctPerDay = (Math.exp(fit.slope * 24) - 1) * 100;
  const rets = [];
  for (let i = from + 1; i < to; i++) {
    if (pts[i].hour - pts[i - 1].hour <= 3) rets.push(pts[i].logPrice - pts[i - 1].logPrice);
  }
  const volPct =
    rets.length >= 12
      ? Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length) * 100
      : NaN;
  const startTs = pts[from].hour * HOUR_MS;
  const endTs = pts[to - 1].hour * HOUR_MS;
  // 段落相对操盘窗口的位置：pre=全在窗口开始前，in=与窗口重叠，post=全在窗口结束后
  const phase = endTs < ep.start ? "pre" : startTs >= ep.end ? "post" : "in";
  const vols = [];
  for (let i = from; i < to; i++) if (pts[i].volume > 0) vols.push(pts[i].volume);
  let volumeTrend = NaN;
  if (vols.length >= 12) {
    const third = Math.floor(vols.length / 3);
    const head = vols.slice(0, third).reduce((s, v) => s + v, 0) / third;
    const tail = vols.slice(-third).reduce((s, v) => s + v, 0) / third;
    if (head > 0) volumeTrend = (tail / head - 1) * 100;
  }
  return {
    item: ep.item,
    durH,
    slopePctPerDay,
    volPct,
    mddPct: maxDrawdown(pts, from, to) * 100,
    relPos: (startTs - analysisStart) / (analysisEnd - analysisStart),
    phase,
    volumeTrend,
    priceStart: pts[from].price,
    priceEnd: pts[to - 1].price,
  };
}

// ---------- 5. 聚类（k-means，特征标准化，分位数确定性初始化保证可复现） ----------

function kmeans(rows, dims, k) {
  const stats = dims.map((d) => {
    const vals = rows.map((r) => r[d]).filter((v) => Number.isFinite(v));
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) || 1;
    return { mean, std };
  });
  const X = rows.map((r) => dims.map((d, j) => ((Number.isFinite(r[d]) ? r[d] : stats[j].mean) - stats[j].mean) / stats[j].std));
  // 初始化：按第一维（涨速）排序取分位点，避免随机种子导致每次结果不同
  const order = X.map((_, i) => i).sort((a, b) => X[a][0] - X[b][0]);
  let centers = Array.from({ length: k }, (_, c) => X[order[Math.floor(((c + 0.5) / k) * X.length)]].slice());
  let assign = new Array(X.length).fill(0);
  for (let iter = 0; iter < 100; iter++) {
    let changed = false;
    for (let i = 0; i < X.length; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = X[i].reduce((s, v, j) => s + (v - centers[c][j]) ** 2, 0);
        if (d < bd) { bd = d; bi = c; }
      }
      if (assign[i] !== bi) { assign[i] = bi; changed = true; }
    }
    if (!changed) break;
    for (let c = 0; c < k; c++) {
      const members = X.filter((_, i) => assign[i] === c);
      if (members.length) centers[c] = dims.map((_, j) => members.reduce((s, m) => s + m[j], 0) / members.length);
    }
  }
  return assign;
}

// ---------- 主流程 ----------

const episodes = loadEpisodes();
const allSegs = [];
const episodeTimelines = [];
let skippedThin = 0;

for (const ep of episodes) {
  const platform = referencePlatform(ep.item);
  if (!platform) { skippedThin++; continue; }
  const analysisStart = ep.start - PRE_WINDOW_DAYS * DAY_MS;
  const analysisEnd = ep.end + POST_WINDOW_DAYS * DAY_MS;
  const pts = hourlySeries(ep.item, platform, analysisStart, Math.min(analysisEnd, Date.now()));
  if (pts.length < 10 * 24) { skippedThin++; continue; } // 不足 10 天数据的 episode 切不出可信段落
  const segs = [];
  segment(pts, 0, pts.length, segs);
  const feats = segs.map((s) => segmentFeatures(pts, s, ep, analysisStart, analysisEnd));
  feats.forEach((f, i) => { f.epIdx = episodeTimelines.length; f.segIdx = i; });
  allSegs.push(...feats);
  episodeTimelines.push({ ep, platform, nPts: pts.length, feats });
}

console.log(`episode 总数 ${episodes.length}（由 138 个窗口合并而来），可分析 ${episodeTimelines.length}，数据不足跳过 ${skippedThin}`);
console.log(`切出段落总数 ${allSegs.length}，平均每 episode ${(allSegs.length / episodeTimelines.length).toFixed(1)} 段\n`);

// 段落画像聚类：只用形态特征。durH 不进聚类（受数据覆盖影响大），volumeTrend 不进（6-22 前没有）
const DIMS = ["slopePctPerDay", "volPct", "mddPct"];
const median = (arr) => {
  const s = arr.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

for (const k of [4, 5, 6]) {
  const assign = kmeans(allSegs, DIMS, k);
  allSegs.forEach((s, i) => (s[`c${k}`] = assign[i]));
  console.log(`===== k=${k} 聚类画像 =====`);
  console.log("簇 |  n  | 涨速%/天 | 小时波动% | 最大回撤% | 时长h | 相对位置 | pre/in/post | 量变化%");
  const order = [...new Set(assign)].sort(
    (a, b) => median(allSegs.filter((s) => s[`c${k}`] === a).map((s) => s.relPos)) - median(allSegs.filter((s) => s[`c${k}`] === b).map((s) => s.relPos))
  );
  for (const c of order) {
    const m = allSegs.filter((s) => s[`c${k}`] === c);
    const ph = { pre: 0, in: 0, post: 0 };
    m.forEach((s) => ph[s.phase]++);
    console.log(
      `${String(c).padStart(2)} | ${String(m.length).padStart(3)} | ${median(m.map((s) => s.slopePctPerDay)).toFixed(2).padStart(8)} | ${median(m.map((s) => s.volPct)).toFixed(2).padStart(9)} | ${median(m.map((s) => s.mddPct)).toFixed(1).padStart(9)} | ${median(m.map((s) => s.durH)).toFixed(0).padStart(5)} | ${median(m.map((s) => s.relPos)).toFixed(2).padStart(8)} | ${ph.pre}/${ph.in}/${ph.post} | ${median(m.map((s) => s.volumeTrend)).toFixed(1)}`
    );
  }
  console.log("");
}

// 转移矩阵（k=6）：段落序列里簇 A 后面接簇 B 的次数，看剧本的"顺序"是否存在
const K = 6;
const trans = Array.from({ length: K }, () => new Array(K).fill(0));
for (const tl of episodeTimelines) {
  for (let i = 1; i < tl.feats.length; i++) trans[tl.feats[i - 1][`c${K}`]][tl.feats[i][`c${K}`]]++;
}
console.log("===== k=6 段落转移矩阵（行=前一段，列=后一段） =====");
console.log("     " + Array.from({ length: K }, (_, c) => String(c).padStart(4)).join(""));
trans.forEach((row, i) => console.log(String(i).padStart(4) + " " + row.map((v) => String(v).padStart(4)).join("")));

// 数据最厚的 12 个 episode 的时间线，供人工对照剧本
console.log("\n===== 代表性 episode 时间线（按数据量取前 12） =====");
const top = [...episodeTimelines].sort((a, b) => b.nPts - a.nPts).slice(0, 12);
for (const tl of top) {
  const d = (ts) => new Date(ts).toISOString().slice(5, 10);
  console.log(`\n${tl.ep.item}（${tl.platform}，窗口 ${d(tl.ep.start)}~${d(tl.ep.end)}，${tl.ep.tagCount} 个标注）`);
  for (const f of tl.feats) {
    console.log(
      `  [${f.phase.padEnd(4)}] c${f[`c${K}`]} ${String(f.durH).padStart(4)}h  涨速${f.slopePctPerDay.toFixed(2).padStart(7)}%/天  波动${(Number.isFinite(f.volPct) ? f.volPct : 0).toFixed(2).padStart(5)}%  回撤${f.mddPct.toFixed(1).padStart(5)}%  ¥${f.priceStart.toFixed(2)}→¥${f.priceEnd.toFixed(2)}`
    );
  }
}

// 量数据覆盖情况（6-22 之后才有在售量）
const withVol = allSegs.filter((s) => Number.isFinite(s.volumeTrend));
console.log(`\n在售量特征覆盖：${withVol.length}/${allSegs.length} 段（仅 2026-06-22 后有量数据）`);
