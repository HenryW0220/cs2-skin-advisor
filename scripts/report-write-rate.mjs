// 采集写入速率，带对照基数。用法：node scripts/report-write-rate.mjs [库文件] [--window-minutes N]
//
// 为什么这个脚本存在（2026-08-14）：部署核对时我用一条临时查询报了"近 30 分钟 17332 条快照"，
// 两个错叠在一起：
//   ① `captured_at > datetime('now','-30 minutes')` 是**拿 ISO 字符串比非 ISO 字符串**——
//      `datetime('now')` 给的是 `2026-08-14 05:24:16`（空格、无 Z），而列里是
//      `2026-08-14T05:24:16.000Z`。字符串比较下 'T'(0x54) > ' '(0x20)，于是**今天所有行都命中**。
//      SQLite 不会为此给任何警告，返回的是一个看着合理的数。
//   ② 更要命的是第二个：拿到那个数之后我直接说了句"normal"，而**没有任何对照基数**。
//      一个数字单独出现时没有"正常"可言，只有"跟什么比"。真按历史基数算，当时那个口径
//      外推是历史均值的 1.7 倍——偏 1.7 倍还能起疑，偏 20% 就直接过去了。
//
// 所以这个脚本的规矩：**每个速率都必须跟历史基数一起打印，并且把算式写出来**。
// 不提供"只报一个绝对数"的用法。
//
// 时间比较一律 ISO vs ISO：窗口边界用 JS 的 toISOString() 生成，跟列里的格式一致
// （lib/ 里的生产代码本来就是这么做的，出问题的只有临时查询）。
import Database from "better-sqlite3";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "report-write-rate",
  usage:
    "node scripts/report-write-rate.mjs [库文件] [--window-minutes N] [--spike-multiple K] [--baseline-days N]",
  values: {
    "--window-minutes": { parse: Number, default: 40, label: "观察窗口分钟" },
    // 一分钟的写入量超过窗口内中位数的 K 倍就算"尖峰"，单独列出来。
    // 整点同步是一次性写两千多条，混在窗口里会把速率抬到看不出问题
    "--spike-multiple": { parse: Number, default: 5, label: "尖峰倍数" },
    "--baseline-days": { parse: Number, default: 7, label: "基数取几个完整日" },
  },
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});

const db = new Database(resolveDbPath(args.dbPath), { readonly: true });
const windowMinutes = args.values["--window-minutes"];
const spikeMultiple = args.values["--spike-multiple"];

const nowMs = Date.now();
const sinceIso = new Date(nowMs - windowMinutes * 60_000).toISOString();

// ---------- 对照基数 ----------
// **基数本身也要选对，不然对照比不对照更糟。** 第一版拿全表平均当基数，结果是每小时 280 行——
// 因为 price_snapshots 一路回溯到 2025-06-30，早期是 K 线回填的稀疏历史（少量饰品、每小时一条），
// 而现在是 325 个饰品 × 多平台 × 整点同步 + 10 分钟快速同步，**两个完全不同的量级混在一个平均里**。
// 拿它当基数，当前流量会显示成 20× "异常"，纯属自己吓自己。
// 所以基数取**最近若干个完整自然日的中位数**（默认 7 天，跟当前采集配置同一个régime），
// 全表平均只作为参考打印出来并明确标注不可比。
const span = db
  .prepare("SELECT MIN(captured_at) a, MAX(captured_at) b, COUNT(*) n FROM price_snapshots")
  .get();
const spanHours = (Date.parse(span.b) - Date.parse(span.a)) / 3_600_000;

const baselineDays = args.values["--baseline-days"];
// 只取完整自然日：今天还没过完，算进来会把基数压低
const todayIso = new Date(nowMs).toISOString().slice(0, 10);
const dayRows = db
  .prepare(
    `SELECT substr(captured_at, 1, 10) day, COUNT(*) n FROM price_snapshots
     WHERE captured_at < ? GROUP BY 1 ORDER BY 1 DESC LIMIT ?`
  )
  .all(`${todayIso}T00:00:00.000Z`, baselineDays);
if (!dayRows.length) {
  console.log("没有任何完整自然日的数据，算不出对照基数。");
  process.exit(1);
}
const sortedDaily = dayRows.map((r) => r.n).sort((a, b) => a - b);
const medianDaily = sortedDaily[Math.floor(sortedDaily.length / 2)];
const histPerHour = medianDaily / 24;

console.log("=== 对照基数（最近完整自然日的中位数）===");
for (const r of [...dayRows].reverse()) console.log(`  ${r.day}  ${r.n} 行`);
console.log(
  `算式：${dayRows.length} 天的中位数 ${medianDaily} 行/天 ÷ 24 = **每小时 ${histPerHour.toFixed(0)} 行**`
);
console.log(
  `参考（**不可比，别拿它当基数**）：全表 ${span.n} 行 ÷ ${spanHours.toFixed(1)} 小时 = ` +
    `每小时 ${(span.n / spanHours).toFixed(0)} 行——这个数被 2025 年那段稀疏的 K 线回填历史稀释了，` +
    `跟现在的采集配置不是同一个量级。`
);

// ---------- 观察窗口 ----------
const perMinute = db
  .prepare(
    `SELECT substr(captured_at, 1, 16) minute, COUNT(*) n FROM price_snapshots
     WHERE captured_at > ? GROUP BY 1 ORDER BY 1`
  )
  .all(sinceIso);
const total = perMinute.reduce((s, r) => s + r.n, 0);

console.log("");
console.log(`=== 观察窗口：最近 ${windowMinutes} 分钟（${sinceIso} 起）===`);
if (!perMinute.length) {
  console.log("窗口内一条都没有——采集停了，先查容器日志和定时器。");
  process.exit(0);
}

const counts = perMinute.map((r) => r.n).sort((a, b) => a - b);
const medianPerMinute = counts[Math.floor(counts.length / 2)];
const spikes = perMinute.filter((r) => r.n > medianPerMinute * spikeMultiple);
const spikeTotal = spikes.reduce((s, r) => s + r.n, 0);

const rate = (rows, minutes) => (rows / minutes) * 60;
const ratio = (v) => `${(v / histPerHour).toFixed(2)}×`;

console.log(
  `窗口内合计 ${total} 行 → 算式：${total} ÷ ${windowMinutes} 分钟 × 60 = ` +
    `**每小时 ${rate(total, windowMinutes).toFixed(0)} 行**，是历史均值的 ${ratio(rate(total, windowMinutes))}`
);

if (spikes.length) {
  const restMinutes = windowMinutes - spikes.length;
  const restRate = rate(total - spikeTotal, restMinutes);
  console.log("");
  console.log(
    `⚠️ 窗口内有 ${spikes.length} 个尖峰分钟（>${medianPerMinute * spikeMultiple} 行/分，` +
      `窗口中位数 ${medianPerMinute} 行/分），共 ${spikeTotal} 行：`
  );
  for (const s of spikes) console.log(`     ${s.minute}  ${s.n} 行`);
  console.log(
    `   **整点同步是一次性写几千条，混在窗口里会把速率抬起来** —— 剔除尖峰后：` +
      `算式 ${total - spikeTotal} ÷ ${restMinutes} 分钟 × 60 = **每小时 ${restRate.toFixed(0)} 行**，` +
      `是历史均值的 ${ratio(restRate)}`
  );
  console.log(
    `   读法：历史均值本身**包含**整点同步，所以"剔除尖峰后的速率"应当明显低于历史均值；` +
      `如果它反而接近或高于 1.00×，说明常态写入变多了，才值得查。`
  );
}

console.log("");
console.log("判读（不要只看绝对数，绝对数没有正常可言）：");
console.log(`  · 含尖峰 ${ratio(rate(total, windowMinutes))}：窗口里有没有整点同步会让这个数大幅摆动，`);
console.log("    只有窗口跨度远大于一小时时才有可比性。");
console.log("  · 真正稳定的判据是**剔除尖峰后的常态速率**，以及窗口内有没有出现 0 行的分钟。");
// 空档阈值必须大于**最稀的那个定时器的周期**，否则报的是作息不是故障。
// c5-fast 是每 10 分钟一轮，两轮之间本来就可能十来分钟没有任何写入——
// 第一版阈值定在 3 分钟，于是把正常作息报成了"踩坑 49 那次饿死的形状"。
// 取 10 分钟周期 + 50% 余量 = 15 分钟。
const C5_FAST_INTERVAL_MINUTES = 10;
const GAP_ALERT_MINUTES = Math.ceil(C5_FAST_INTERVAL_MINUTES * 1.5);
const gaps = [];
for (let i = 1; i < perMinute.length; i++) {
  const prev = Date.parse(`${perMinute[i - 1].minute}:00.000Z`);
  const cur = Date.parse(`${perMinute[i].minute}:00.000Z`);
  const missing = (cur - prev) / 60_000 - 1;
  if (missing >= GAP_ALERT_MINUTES) {
    gaps.push(`${perMinute[i - 1].minute} 之后断了 ${missing} 分钟`);
  }
}
console.log(
  gaps.length
    ? `  · ⚠️ 窗口内有 ≥${GAP_ALERT_MINUTES} 分钟的写入空档：${gaps.join("；")}` +
        `——踩坑 49 那次采集器被饿死就是这个形状。`
    : `  · 窗口内没有 ≥${GAP_ALERT_MINUTES} 分钟的写入空档（c5-fast 每 ${C5_FAST_INTERVAL_MINUTES} 分钟一轮，` +
        `十来分钟没写入是作息不是故障）。`
);
