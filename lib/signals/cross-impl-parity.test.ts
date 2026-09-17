// 生产实现（lib/signals/*.ts）与回测脚本（scripts/*.mjs）的同名特征对拍测试。
//
// **为什么存在**：HANDOFF 第四节 0.5。现在同一个特征有两份实现——线上跑的在 `lib/signals/`，
// 反推阈值的在 `scripts/`。只要两边定义不同，**从回测反推出来的阈值就没有落在它被验证的
// 那个量上**，而"阈值必须能从回测反推"是卖出规则 v2 的立身之本。
// 这件事**不会报错**：两边各自都自洽，各自的单测也都是绿的。
//
// **锁的是双份实现的第二阶段危害**（0.5 的补充判据）：两份实现一开始可能完全一致，
// 到某一次**单边修改**时才分岔，而做那次修改的人完全不知道有第二份。
// 所以这里锁的不是"我核对过一次"，是"将来谁单边改了，这组测试会红"。
//
// **已知的两个实例**（都不是推理，是实测出来的）：
//   ① 洗盘回撤：`lib/signals/washout.ts` 是"窗口内任意时点的最大回撤"，
//      `build-sell-rule-baseline.mjs` 是"当前价距 48h 高点的回撤"，生产的定义更松（㉗b）。
//   ② **`vol24h` 差一格**（2026-09-17 本次查出，此前无人记录）：
//      生产的 24 个收益率**含当前小时**，`analyze-manipulation-features.mjs` 的**不含**。
//      实测 300/300 个样本全部不同，最大差 0.00163——而生产阈值的两个锚点是
//      平时中位 0.0064 / 操盘中位 0.0154，**这个差是阈值量级的 10~25%，不是浮点噪声**。
//      详见本文件 `vol24h` 那一组的注释。
//
// **为什么用复制一份脚本实现的方式对拍**：脚本是 `.mjs`、生产是 `.ts`，`scripts/*.mjs` 里
// 那几个函数是模块内私有的、没有导出，跨不过去（0.5 里写明了这个坎）。
// 复制品有它自己的风险——**脚本改了这里不会自动跟着改**。所以：
//   - 复制品逐字照抄，**改动只允许是删掉与本测试无关的部分**，不允许"顺手写得更好看"；
//   - 每个复制品都标注来源文件与函数名，脚本那边也回指这里（0.5 说的"两处互相写明对方的位置"）；
//   - 真正的保险是下面 `PARITY_SOURCES` 那组快照断言：**它锁住被抄的那几行源码本身**，
//     脚本侧一改，快照不匹配，这里就红。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { movingAverage } from "./moving-average";
import { rsi } from "./rsi";

// ---------- 测试数据：CS2 皮肤真实的价格量级（几元到几千元、两位小数） ----------
/** 确定性伪随机价格序列。固定种子，跨机器跨次可复现。 */
function priceSeries(length: number, seed: number): number[] {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out: number[] = [];
  let p = 10 + rnd() * 3000;
  for (let i = 0; i < length; i++) {
    p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.08));
    out.push(Math.round(p * 100) / 100);
  }
  return out;
}

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

// ================= 脚本侧实现的复制品（逐字照抄，标明出处） =================

/** 抄自 `scripts/build-rsi-trend-baseline.mjs` 的 `movingAverage`（滑动窗口累加）。 */
function scriptMovingAverage(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 抄自 `scripts/build-rsi-trend-baseline.mjs` 的 `rsi`（Wilder 平滑）。 */
function scriptRsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch > 0) gainSum += ch;
    else lossSum += -ch;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  const calc = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = calc(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
    out[i] = calc(avgGain, avgLoss);
  }
  return out;
}

/** 抄自 `scripts/analyze-manipulation-features.mjs` 的 `rollingStats`（不含 index 自身的过去 window 期）。 */
function scriptRollingStats(
  values: number[],
  window: number,
  index: number
): { mean: number; std: number } | null {
  const from = Math.max(0, index - window);
  const slice = values.slice(from, index);
  if (slice.length < Math.min(window, 24)) return null;
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
  return { mean, std: Math.sqrt(variance) };
}

/**
 * 抄自 `scripts/analyze-manipulation-features.mjs` 主循环里那三个特征的算法，
 * 参数 `i` 就是那个循环变量（"当前时刻"的下标）。
 */
function scriptFeaturesAt(prices: number[], i: number) {
  const returns = prices.map((p, k) => (k === 0 || prices[k - 1] <= 0 ? 0 : (p - prices[k - 1]) / prices[k - 1]));
  const r24 = returns.slice(Math.max(1, i - 23), i + 1);
  const vol24h = Math.sqrt(r24.reduce((s, v) => s + v * v, 0) / r24.length);
  const ma = scriptRollingStats(prices, 168, i);
  const maDev = ma && ma.mean > 0 ? Math.abs(prices[i] - ma.mean) / ma.mean : 0;
  const from24 = Math.max(0, i - 24);
  const absReturn24h = prices[from24] > 0 ? Math.abs(prices[i] - prices[from24]) / prices[from24] : 0;
  return { vol24h, maDev, absReturn24h };
}

/**
 * 生产侧 `lib/signals/manipulation-score.ts` 里那三个特征的算法，对序列末端求值。
 *
 * **这里刻意重算而不是调 `computeManipulationScore`**：那个函数只返回算完的分数和三个
 * 特征值，中间的窗口取法看不见，而这组测试要比的正是窗口取法。若将来生产那边改了窗口，
 * 这里不会自动跟着改 —— 由下面 `PARITY_SOURCES` 的源码快照来兜底。
 */
function prodFeaturesAtEnd(hourlyPrices: number[]) {
  const n = hourlyPrices.length;
  const returns: number[] = [];
  for (let i = 1; i < n; i++) {
    if (hourlyPrices[i - 1] > 0) returns.push((hourlyPrices[i] - hourlyPrices[i - 1]) / hourlyPrices[i - 1]);
  }
  const last24 = returns.slice(-24);
  const volatility24h = Math.sqrt(last24.reduce((s, r) => s + r * r, 0) / last24.length);
  const window168 = hourlyPrices.slice(-169, -1);
  const ma168 = window168.reduce((s, p) => s + p, 0) / window168.length;
  const maDeviation = ma168 > 0 ? Math.abs(hourlyPrices[n - 1] - ma168) / ma168 : 0;
  const prev24Price = hourlyPrices[n - 25];
  const move24h = prev24Price > 0 ? Math.abs(hourlyPrices[n - 1] - prev24Price) / prev24Price : 0;
  return { volatility24h, move24h, maDeviation };
}

// ================= 对拍 =================

describe("MA7/MA30：生产 vs build-rsi-trend-baseline.mjs", () => {
  // 两边算法不同：生产每个位置重新求和，脚本用滑动窗口累加（加一项减一项）。
  // 数学上等价，浮点上不等价——实测 86.78% 的位置末位不同，最大绝对差 1e-11。
  //
  // **判成"等价"而不是"缺陷"的理由**：这个量最终只进分档
  // （趋势状态比较 ma7/ma30 的大小、maDev 进 ramp 的 0.032/0.11 两个锚点）。
  // 1e-11 要改变分档结果，得价格恰好落在档位边界的 1e-11 邻域里。
  // 所以这里的判据用相对误差上界，不是逐位相同 —— 并把那个上界锁死，
  // 将来谁把某一边改成真正不同的算法（比如换成 EMA），相对误差会暴涨，这条会红。
  it.each([7, 30])("period=%i 时两边相对误差不超过 1e-12", (period) => {
    let worstRel = 0;
    for (const seed of SEEDS) {
      const values = priceSeries(400, seed);
      const prod = movingAverage(values, period);
      const script = scriptMovingAverage(values, period);
      expect(script.length).toBe(prod.length);
      for (let i = 0; i < values.length; i++) {
        // null 的位置必须完全一致：这锁的是"前 period-1 个位置数据不够"这条边界口径
        expect(prod[i] === null).toBe(script[i] === null);
        if (prod[i] === null) continue;
        const rel = Math.abs(prod[i]! - script[i]!) / Math.abs(prod[i]!);
        worstRel = Math.max(worstRel, rel);
      }
    }
    expect(worstRel).toBeLessThan(1e-12);
  });
});

describe("RSI：生产 vs build-rsi-trend-baseline.mjs", () => {
  // 这两份是逐行同构的（同样的 Wilder 平滑、同样的 period 起点、同样的除零返回 100），
  // 所以判据就是最严的那个：逐位相同。
  it("两边逐位相同（含 null 的位置）", () => {
    for (const seed of SEEDS) {
      const values = priceSeries(400, seed);
      expect(scriptRsi(values, 14)).toEqual(rsi(values, 14));
    }
  });

  it("序列长度不足 period 时两边都是全 null", () => {
    const short = priceSeries(10, 1);
    expect(rsi(short, 14)).toEqual(new Array(10).fill(null));
    expect(scriptRsi(short, 14)).toEqual(new Array(10).fill(null));
  });

  it("单调上涨时两边都给 100（除零分支也要一致）", () => {
    const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
    expect(rsi(rising, 14)[59]).toBe(100);
    expect(scriptRsi(rising, 14)[59]).toBe(100);
  });
});

describe("maDev / move24h：生产 vs analyze-manipulation-features.mjs", () => {
  // 实测 300/300 个样本逐位相同。窗口口径两边确实是同一个：
  // 生产 `slice(-169,-1)` 与脚本 `rollingStats(prices,168,i)` 都是**排除当前价**的 168 个点。
  it("maDev 与 move24h 在序列末端逐位相同", () => {
    for (const seed of SEEDS) {
      const prices = priceSeries(400, seed);
      const prod = prodFeaturesAtEnd(prices);
      const script = scriptFeaturesAt(prices, prices.length - 1);
      expect(script.maDev).toBe(prod.maDeviation);
      expect(script.absReturn24h).toBe(prod.move24h);
    }
  });
});

describe("vol24h：生产 vs analyze-manipulation-features.mjs（2026-09-17 已对齐）", () => {
  // **这一组曾经锁的是一个已知的不一致，现在锁的是「已对齐」。**
  // 历史：脚本原本取 `[i-24, i)`（不含当前小时）、生产取 `slice(-24)`（含），错开一格；
  // 实测 300/300 样本全不同、最大差 0.00163（ramp 锚点 0.0064/0.031 的 10~25%）。
  // 按 HANDOFF 0.9 拍板选 (a)：**改脚本去对齐生产，生产一行没动**。
  //
  // ⚠️ **翻成「逐位相同」之后，这一组最大的风险变成了「空绿」**——断言两个本来就相等的
  // 东西，把两边一起改坏也测不出来。所以第三条**刻意保留反向断言**：把窗口移回旧的那一格，
  // 必须重新变得不同。**它证明这组测试对这一格是敏感的，不是恒真。**

  it("两边逐位相同（窗口已对齐到含当前小时）", () => {
    for (const seed of SEEDS) {
      const prices = priceSeries(400, seed);
      const prod = prodFeaturesAtEnd(prices).volatility24h;
      const script = scriptFeaturesAt(prices, prices.length - 1).vol24h;
      expect(script).toBe(prod);
    }
  });

  it("右移之后窗口长度仍是 24，不是 25", () => {
    // 差一格有两种改法：起点终点一起右移（对，长度不变），只把终点右移（错，长度变 25）。
    // 这条锁的是选对了那一种 —— 长度变 25 的话上面那条也会红，但这条能直接指出错在哪。
    const prices = priceSeries(400, 1);
    const i = prices.length - 1;
    const returns = prices.map((p, k) => (k === 0 || prices[k - 1] <= 0 ? 0 : (p - prices[k - 1]) / prices[k - 1]));
    expect(returns.slice(Math.max(1, i - 23), i + 1)).toHaveLength(24);

    const prodReturns: number[] = [];
    for (let k = 1; k < prices.length; k++) prodReturns.push((prices[k] - prices[k - 1]) / prices[k - 1]);
    expect(prodReturns.slice(-24)).toHaveLength(24);
  });

  it("移回旧窗口必须重新变得不同 ⇒ 这组断言对那一格敏感，不是恒真", () => {
    // **防空绿的第一条：对「那一格」敏感。**
    let differing = 0;
    let worstAbs = 0;
    for (const seed of SEEDS) {
      const prices = priceSeries(400, seed);
      const i = prices.length - 1;
      const returns = prices.map((p, k) => (k === 0 || prices[k - 1] <= 0 ? 0 : (p - prices[k - 1]) / prices[k - 1]));
      const oldWindow = returns.slice(Math.max(1, i - 24), i); // 对齐之前的旧口径
      const volOld = Math.sqrt(oldWindow.reduce((s, v) => s + v * v, 0) / oldWindow.length);
      const prod = prodFeaturesAtEnd(prices).volatility24h;
      if (volOld !== prod) {
        differing++;
        worstAbs = Math.max(worstAbs, Math.abs(volOld - prod));
      }
    }
    expect(differing).toBe(SEEDS.length);
    expect(worstAbs).toBeGreaterThan(1e-4);
  });

  it("vol24h 必须真的随行情变化，两边都不能退化成常量", () => {
    // **防空绿的第二条，补第一条的漏。**
    // 第一条用的是**内联重算**的旧窗口，所以把 `scriptFeaturesAt` / `prodFeaturesAtEnd`
    // **一起**改坏（例如两边都写死成常量）时，"逐位相同"和第一条会同时保持绿。
    // 这不是假想：写这组测试时做变异测试，把两边一起退化成 0.5，**14 条全绿**——
    // 那正是 ㉜ 记的"一次偶然的绿"，只不过换了个地方重演。
    // 所以这里直接断言两个函数的**输出本身**有区分度：平静行情与剧烈行情必须给出不同的值。
    const calm = Array.from({ length: 400 }, (_, i) => 100 + (i % 2) * 0.01);
    const wild = priceSeries(400, 7);

    const prodCalm = prodFeaturesAtEnd(calm).volatility24h;
    const prodWild = prodFeaturesAtEnd(wild).volatility24h;
    const scriptCalm = scriptFeaturesAt(calm, calm.length - 1).vol24h;
    const scriptWild = scriptFeaturesAt(wild, wild.length - 1).vol24h;

    expect(prodWild).toBeGreaterThan(prodCalm * 10);
    expect(scriptWild).toBeGreaterThan(scriptCalm * 10);
    // 并且两边对同一段行情仍然相等（把等价性和区分度绑在一起，缺一不可）
    expect(scriptCalm).toBe(prodCalm);
    expect(scriptWild).toBe(prodWild);
  });
});

describe("被抄的脚本源码没有单边改动", () => {
  // **这一组才是真正的保险。**上面那些对拍用的是脚本实现的**复制品**，
  // 复制品有个根本弱点：脚本那边改了，复制品不会自动跟着改，对拍照样全绿 ——
  // 那正是 0.5 说的"双份实现的第二阶段危害"，只不过换个地方重演一遍。
  //
  // 所以这里直接读**脚本源文件**，断言被抄的那几行还在原样。脚本侧任何改动都会让这里红，
  // 红了的处置是：回到上面把复制品同步过来，重新看对拍结论是否还成立。
  const repoRoot = join(import.meta.dirname, "..", "..");
  // 换行符要归一化再比：仓库在 Windows 上 checkout 出来是 CRLF，断言里写的是 LF，
  // 不归一化的话这组会在"源码根本没改"的情况下红，那种红比不红更糟（会被当成噪声忽略掉）。
  const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");

  const PARITY_SOURCES: { file: string; label: string; snippet: string }[] = [
    {
      file: "scripts/build-rsi-trend-baseline.mjs",
      label: "movingAverage 的滑动窗口累加",
      snippet: `    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;`,
    },
    {
      file: "scripts/build-rsi-trend-baseline.mjs",
      label: "rsi 的 Wilder 平滑递推",
      snippet: `    avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;`,
    },
    {
      file: "scripts/analyze-manipulation-features.mjs",
      label: "vol24h 的窗口取法（2026-09-17 已对齐生产，含当前小时）",
      snippet: `    const r24 = returns.slice(Math.max(1, i - 23), i + 1);
    const vol24 = Math.sqrt(r24.reduce((s, v) => s + v * v, 0) / r24.length);`,
    },
    {
      file: "scripts/analyze-manipulation-features.mjs",
      label: "rollingStats 的不含自身窗口",
      snippet: `  const from = Math.max(0, index - window);
  const slice = values.slice(from, index);`,
    },
  ];

  it.each(PARITY_SOURCES)("$file：$label", ({ file, snippet }) => {
    expect(read(file)).toContain(snippet);
  });

  it("生产侧 vol24h / maDev 的窗口取法没有单边改动", () => {
    // 同一道保险对生产侧再做一次：`prodFeaturesAtEnd` 也是复制品。
    const src = read("lib/signals/manipulation-score.ts");
    expect(src).toContain("const last24 = returns.slice(-24);");
    expect(src).toContain("const window168 = hourlyPrices.slice(-169, -1);");
  });
});
