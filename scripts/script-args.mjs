// 一次性脚本的统一参数解析。所有 scripts/*.mjs 都从这里过一遍。
//
// 为什么值得单独抽一个模块出来（2026-08-14）：
// `build-market-baseline.mjs` 的窗口参数曾被静默吃掉一个——没传 `--throttle-ms` 时
// `indexOf` 返回 −1，过滤条件 `i !== throttleIdx + 1` 退化成 `i !== 0`，第一个窗口
// 就这么没了，而脚本照样正常退出、什么都不报。**这是"参数解析层的静默失效"**，跟踩坑 43
// （字段语义错配）、成交量死信号是同一族：不报错、不警告、结果看起来合理。
// 那次是靠"人恰好核对了抬头那行"发现的，而防线不能是"人恰好看了输出"。
//
// 所以这里定两条规矩，**故意做成硬失败**：
//   ① **不认识的参数直接报错退出，不是告警**。告警会被几十行日志滚上去；而这批脚本
//      动辄跑几十分钟，早退出的代价远小于跑完拿到一份错数字（还不知道它是错的）。
//   ② **抬头固定回显"我理解到的参数"**，跟基准的 provenance 那行并排。把上次那个偶然
//      变成惯例：每次跑都能一眼看出脚本收到的和你以为传的是不是同一回事。
//
// 用法：
//   const args = parseScriptArgs({
//     name: "build-market-baseline",
//     usage: "node scripts/build-market-baseline.mjs [窗口天数…] [--throttle-ms N]",
//     values: { "--throttle-ms": { parse: Number, default: 0, label: "让路毫秒" } },
//     restNumbers: { name: "horizons", default: [7], label: "窗口天数" },
//   });
//   args.values["--throttle-ms"]  // 0
//   args.horizons                 // [7]

/**
 * 统一"这个脚本读哪个库"的解析。此前 scripts/ 里同一件事有四种写法：写死
 * `data/db.sqlite`、`process.argv[2] ?? …`、`process.env.CS2_DB_PATH ?? …`、
 * 以及按 `import.meta.url` 算仓库根目录——**同一个脚本换个跑法就读到不同的库**，
 * 而读错库跟参数被吃掉一样不会报错，只会给出一份看起来合理的错数字。
 *
 * 优先级：显式位置参数 > CS2_DB_PATH > 仓库根的 data/db.sqlite。
 * 兜底那条按 `import.meta.url` 算，不用 `process.cwd()`——从别的目录调用时才不会跑偏。
 */
export function resolveDbPath(explicit) {
  if (explicit) return explicit;
  if (process.env.CS2_DB_PATH) return process.env.CS2_DB_PATH;
  return new URL("../data/db.sqlite", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

function fail(name, usage, message) {
  console.error(`✗ ${name}：${message}`);
  if (usage) console.error(`  用法：${usage}`);
  process.exit(1);
}

/**
 * @param name      脚本名，只用于报错和回显
 * @param usage     一行用法说明，报错时打出来
 * @param booleans  形如 ["--apply", "--revert"]，出现即为 true
 * @param values    形如 { "--seed": { parse: Number, default: 1, label: "抽样种子" } }，取后一个 argv
 * @param positionals 形如 [{ name: "dbPath", default: "data/db.sqlite", label: "库文件" }]，按顺序取
 * @param restNumbers 剩下的位置参数全部当数字收进一个数组，形如 { name: "horizons", default: [7] }
 * @returns { booleans, values, [positional names], [restNumbers.name], echo }
 */
export function parseScriptArgs({
  name,
  usage = "",
  booleans = [],
  values = {},
  positionals = [],
  restNumbers = null,
} = {}) {
  const argv = process.argv.slice(2);
  const out = { booleans: {}, values: {} };
  for (const b of booleans) out.booleans[b] = false;
  for (const [k, spec] of Object.entries(values)) out.values[k] = spec.default;

  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (booleans.includes(token)) {
      out.booleans[token] = true;
      continue;
    }
    if (Object.hasOwn(values, token)) {
      const raw = argv[i + 1];
      // `--seed` 后面什么都没有、或者跟的是另一个选项，都算漏了值——**不能当默认值放过**，
      // 那正是"看起来跑对了其实用的不是你给的参数"这一类
      if (raw === undefined || (raw.startsWith("--") && !Number.isFinite(Number(raw)))) {
        fail(name, usage, `${token} 后面缺一个值`);
      }
      const parsed = (values[token].parse ?? String)(raw);
      if (typeof parsed === "number" && !Number.isFinite(parsed)) {
        fail(name, usage, `${token} 的值 "${raw}" 不是有效数字`);
      }
      out.values[token] = parsed;
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      fail(name, usage, `不认识的选项 ${token}`);
    }
    rest.push(token);
  }

  for (const p of positionals) {
    out[p.name] = rest.length ? rest.shift() : p.default;
  }
  if (restNumbers) {
    const nums = rest.map(Number);
    const bad = rest.filter((r, i) => !Number.isFinite(nums[i]) || nums[i] <= 0);
    if (bad.length) fail(name, usage, `这些参数不是正数：${bad.join(" ")}`);
    out[restNumbers.name] = nums.length ? nums : restNumbers.default;
    rest.length = 0;
  }
  if (rest.length) fail(name, usage, `多余的参数：${rest.join(" ")}`);

  // ---- 抬头回显 ----
  const parts = [];
  for (const p of positionals) parts.push(`${p.label ?? p.name}=${out[p.name] ?? "（默认）"}`);
  if (restNumbers) {
    parts.push(`${restNumbers.label ?? restNumbers.name}=${out[restNumbers.name].join(",")}`);
  }
  for (const [k, spec] of Object.entries(values)) parts.push(`${spec.label ?? k}=${out.values[k]}`);
  for (const b of booleans) if (out.booleans[b]) parts.push(b);
  out.echo = `[${name}] 实参：${parts.join("  ") || "（无）"}`;
  console.log(out.echo);
  return out;
}
