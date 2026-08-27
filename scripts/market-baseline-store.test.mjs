// market-baseline-store 的定型规则测试。
//
// 为什么单独给 scripts/ 加测试（此前 scripts/ 一条测试都没有）：这个模块写出来的行
// **按设计永不重算**（迁移 024 的护栏 (b)：旧行永远保留、增量跳过已存过的天）。
// 也就是说**它写错一行，那一行就永久错着**——没有"下次跑就自愈"这回事。
// 这类"错了不可逆"的代码，判据不能是"跑一次看着对"。
//
// 锁的是同一个缺陷的第三次形态。前两次：
//   ① b9645fa10：逐小时 break + 整天写库 ⇒ 边界日写成半天且从此不重算（每窗口各一天，14 小时）。
//   ② 修法是新开一版口径 b03672dc0，把 `dayCompleteness: "whole-day-only"` 写进指纹。
// **但 ② 只在 `--daily` 模式里实现了**，全量模式那段注释明写"全量模式保持原样不动"。
// 而 b03672dc0 的整表回填**走的正是全量模式** ⇒ 缺陷原样复发，且更严重（3 小时）。
// **指纹声明了一个口径，实现只在一半的代码路径上执行它，两边都不报错。**
import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  BASELINE_CALIBER,
  BASELINE_CALC_VERSION,
  DAY_MS,
  HOUR_MS,
  assertCoverageFrontier,
  assertNoTruncatedTail,
  ensureBaselines,
  loadBaseline,
  settleCutoff,
} from "./market-baseline-store.mjs";

const HORIZON = 7;
// 历史长度门槛是 24×(窗口+14) = 504 小时，参考平台门槛是 200 条快照。
// 多给一些余量，让门槛不成为这组测试的变量。
const TOTAL_HOURS = 24 * 30;
const ITEMS = ["item-a", "item-b", "item-c"];

/** 建一个只有本模块用得到的那两张表的内存库。 */
function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE price_snapshots (
      item_name TEXT NOT NULL, platform TEXT NOT NULL,
      price REAL NOT NULL, captured_at TEXT NOT NULL
    );
    CREATE TABLE market_baseline_daily (
      day TEXT NOT NULL, horizon_days INTEGER NOT NULL, calc_version TEXT NOT NULL,
      median_return REAL NOT NULL, sample_count INTEGER NOT NULL, item_count INTEGER NOT NULL,
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      invalid_reason TEXT, invalidated_at TEXT, superseded_by TEXT,
      PRIMARY KEY (day, horizon_days, calc_version)
    );
    CREATE TABLE market_baseline_meta (
      calc_version TEXT PRIMARY KEY, caliber_json TEXT NOT NULL, script_sha TEXT NOT NULL,
      git_commit TEXT NOT NULL, horizons TEXT NOT NULL, first_day TEXT, last_day TEXT,
      row_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deprecated_reason TEXT, deprecated_at TEXT
    );
  `);
  return db;
}

/**
 * 灌入整点小时价，最后一条落在 `endMs`（含）。
 * 价格用确定性的小幅波动，保证中位数算得出来又不全等。
 *
 * ⚠️ **起点必须对齐到 00:00**，否则序列首日天然只有半天数据。那是采集密度不是定型缺陷，
 * 而这组测试要抓的恰恰是后者——混进来的话测试会因为错误的原因变红
 * （写这个文件时先踩了一次：首日 20 小时被当成了边界日缺陷）。
 */
function seed(db, endMs, hours = TOTAL_HOURS) {
  const startMs = Math.ceil((endMs - (hours - 1) * HOUR_MS) / DAY_MS) * DAY_MS;
  const insert = db.prepare(
    "INSERT INTO price_snapshots (item_name, platform, price, captured_at) VALUES (?, ?, ?, ?)"
  );
  const tx = db.transaction(() => {
    for (let ts = startMs, i = 0; ts <= endMs; ts += HOUR_MS, i++) {
      for (const [k, item] of ITEMS.entries()) {
        const price = 100 + k * 10 + Math.sin(i / 7 + k) * 5;
        insert.run(item, "C5", price, new Date(ts).toISOString());
      }
    }
  });
  tx();
}

/**
 * 数据末端：`lagDays` 天前的**当天 12:00 UTC**。
 *
 * **对齐到 12:00 是这组测试能不能测到东西的关键，不是随手取的。** 缺陷天的样本数等于
 * 边界落在一天中的第几个小时；落在凌晨时那一天只有几条样本，会被 `MIN_SAMPLES_PER_DAY`
 * （20 条）整天丢掉，于是**测试变绿——不是因为没有缺陷，是因为缺陷那一天被门槛吃了**。
 * 写这个文件时先踩了一次：不对齐的版本在 20:57 跑是绿的，缺陷却原样在那儿。
 * 取 12:00 让缺陷天稳定有 13 小时 × 3 个饰品 = 39 条样本，稳过门槛。
 */
const dataEndAt = (lagDays) =>
  Math.floor((Date.now() - lagDays * DAY_MS) / DAY_MS) * DAY_MS + 12 * HOUR_MS;

const hoursOf = (row) => row.sample_count / row.item_count;
const rowsOf = (db) =>
  db
    .prepare(
      "SELECT day, sample_count, item_count FROM market_baseline_daily WHERE horizon_days = ? ORDER BY day"
    )
    .all(HORIZON);

describe("market-baseline-store 的定型规则", () => {
  // 这一条是纲：指纹里写了 whole-day-only，那它就必须对**所有**写库路径成立。
  // 只在一条路径上成立的口径，等于没有口径——而指纹会让人以为有。
  it("指纹声明了 whole-day-only", () => {
    assert.equal(BASELINE_CALIBER.dayCompleteness, "whole-day-only");
  });

  it("全量模式不写半天行（b03672dc0 那 9 行边界日就是这么来的）", () => {
    const db = makeDb();
    // 数据止于某个整点，而"现在"要比它晚很多——这正是**对备份副本跑**时的形状，
    // 而踩坑 49 规定重活就该对副本跑。于是墙上时钟认为早已定型的那些天，
    // 数据其实只覆盖到一小部分小时。
    const dataEnd = dataEndAt(3);
    seed(db, dataEnd);

    ensureBaselines(db, [HORIZON]);
    const rows = rowsOf(db);
    assert.ok(rows.length > 0, "应当至少写出几天，否则这组测试什么都没测到");

    const partial = rows.filter((r) => hoursOf(r) < 24);
    assert.deepEqual(
      partial.map((r) => `${r.day} 只有 ${hoursOf(r)} 小时`),
      [],
      "全量模式写出了不足 24 小时的天：这一天从此不会再重算，永久是半份"
    );
  });

  it("daily 模式同样不写半天行（这条本来就该过，作为对照）", () => {
    const db = makeDb();
    const dataEnd = dataEndAt(3);
    seed(db, dataEnd);

    ensureBaselines(db, [HORIZON], { daily: true });
    const partial = rowsOf(db).filter((r) => hoursOf(r) < 24);
    expect(partial.map((r) => `${r.day} 只有 ${hoursOf(r)} 小时`)).toEqual([]);
  });

  // 定型的定义是"算这一天所需要的数据都已经**观测到**了"，那是数据的属性不是时钟的属性。
  // 拿墙上时钟当界，对一份止于昨天的副本跑，就会把"数据还没到"误判成"已经定型"——
  // 而踩坑 49 恰恰规定重活必须对副本跑，所以这条路径是常态不是意外。
  it("写出的每一天都必须被数据完整覆盖，跟墙上时钟无关", () => {
    for (const lagDays of [3, 10]) {
      const db = makeDb();
      const dataEnd = dataEndAt(lagDays);
      seed(db, dataEnd);
      ensureBaselines(db, [HORIZON]);

      for (const row of rowsOf(db)) {
        const lastHourMs = Date.parse(`${row.day}T23:00:00.000Z`);
        assert.ok(
          lastHourMs + HORIZON * DAY_MS <= dataEnd,
          `数据止于 ${new Date(dataEnd).toISOString()}，但写出了 ${row.day}：` +
            `它最后一小时的 T+${HORIZON} 落在数据末端之后，不可能算完整`
        );
      }
    }
  });

  // 把"定型看数据末端不看墙上时钟"直接钉在函数上，而不是只从 ensureBaselines 的输出反推。
  // 从输出反推的测试有个弱点：换一条实现路径（比如又冒出第三个模式）就测不到了。
  it("settleCutoff 取数据末端，不取 Date.now()", () => {
    const db = makeDb();
    const dataEnd = dataEndAt(3);
    seed(db, dataEnd);

    const cutoff = settleCutoff(db);
    assert.equal(
      cutoff,
      dataEnd,
      `settleCutoff 应当等于数据末端 ${new Date(dataEnd).toISOString()}，` +
        `实得 ${new Date(cutoff).toISOString()}`
    );
    assert.ok(cutoff < Date.now(), "数据末端在过去，cutoff 不该等于墙上时钟");

    // 反向：数据里出现未来时间戳（时钟漂移/脏数据）时，不能被它把界拉到未来去
    db.prepare(
      "INSERT INTO price_snapshots (item_name, platform, price, captured_at) VALUES (?,?,?,?)"
    ).run("item-a", "C5", 100, new Date(Date.now() + 30 * DAY_MS).toISOString());
    assert.ok(
      settleCutoff(db) <= Date.now(),
      "库里有未来时间戳时，cutoff 必须被墙上时钟压住"
    );
  });
});

describe("market-baseline-store 的坏行防线", () => {
  /** 手工塞一行，绕开 ensureBaselines 的写入守卫——模拟"历史上已经写坏了"的状态。 */
  function insertRow(db, day, { hours, items = 100, version = BASELINE_CALC_VERSION, invalid = null }) {
    db.prepare(
      `INSERT INTO market_baseline_daily
         (day, horizon_days, calc_version, median_return, sample_count, item_count, invalid_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(day, HORIZON, version, -0.02, Math.round(hours * items), items, invalid);
  }

  it("尾部塌陷会被 assertNoTruncatedTail 抓住", () => {
    const db = makeDb();
    for (const d of ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]) {
      insertRow(db, d, { hours: 24 });
    }
    insertRow(db, "2026-08-05", { hours: 3 }); // 这就是 b03672dc0 那九行的形状
    assert.throws(() => assertNoTruncatedTail(db), /2026-08-05 只有 3\.00 小时/);
  });

  // 这一条守的是**断言本身的可用性**。历史上 2026-05 每天只有约 17.3 小时、06 月约 22.6，
  // 那是采集频率就那样、所有拿得到的小时都用上了——完整，只是稀疏。
  // 一条会对七百行正确数据报警的断言活不过两周，会被人加 `|| true` 然后永远绿着。
  it("渐变的稀疏采集不算截断（否则断言会被误报淹掉）", () => {
    const db = makeDb();
    for (const [d, h] of [
      ["2026-05-01", 17.2],
      ["2026-05-02", 17.4],
      ["2026-05-03", 17.1],
      ["2026-05-04", 17.3],
      ["2026-05-05", 17.0],
    ]) {
      insertRow(db, d, { hours: h });
    }
    assert.deepEqual(assertNoTruncatedTail(db, { throwOnFail: false }), []);
  });

  // 整版作废（迁移 026 的 deprecated_reason）也算"已登记"。
  // 不豁免的话，b9645fa10 窗口 7 的 14 小时那一行会让这条断言从上线第一天起永远红着——
  // 而它早就逐字写在 DEPRECATED_CALC_VERSIONS 里了。一条永远红的断言会被关掉。
  it("整版已作废的版本整体跳过", () => {
    const db = makeDb();
    for (const d of ["2026-08-01", "2026-08-02", "2026-08-03"]) {
      insertRow(db, d, { hours: 24, version: "oldver" });
    }
    insertRow(db, "2026-08-04", { hours: 3, version: "oldver" });

    // 还没登记作废 ⇒ 应当报警
    assert.equal(assertNoTruncatedTail(db, { throwOnFail: false }).length, 1);

    // 登记之后 ⇒ 不再报警
    db.prepare(
      `INSERT INTO market_baseline_meta
         (calc_version, caliber_json, script_sha, git_commit, horizons, row_count, deprecated_reason)
       VALUES ('oldver', '{}', 'x', 'y', '7', 4, '已知的边界日半天数据')`
    ).run();
    assert.deepEqual(assertNoTruncatedTail(db, { throwOnFail: false }), []);
  });

  it("显式标了 invalid_reason 的坏行不再报警（已登记 ≠ 没发现）", () => {
    const db = makeDb();
    for (const d of ["2026-08-01", "2026-08-02", "2026-08-03"]) insertRow(db, d, { hours: 24 });
    insertRow(db, "2026-08-04", { hours: 3, invalid: "已知坏行，迁移 028 登记" });
    assert.deepEqual(assertNoTruncatedTail(db, { throwOnFail: false }), []);
  });

  it("loadBaseline 默认跳过作废行，includeInvalid 才读得到（取证用）", () => {
    const db = makeDb();
    insertRow(db, "2026-08-01", { hours: 24 });
    insertRow(db, "2026-08-02", { hours: 3, invalid: "边界日截断" });

    assert.equal(loadBaseline(db, HORIZON).size, 1, "作废行不该被默认读出来");
    assert.equal(
      loadBaseline(db, HORIZON, BASELINE_CALC_VERSION, { includeInvalid: true }).size,
      2,
      "取证读法必须仍能拿到原值——护栏 (b) 说旧行不得改写，迁移 028 也确实没改任何一个数"
    );
  });

  it("覆盖提前截止会被 assertCoverageFrontier 抓住（窗口 7 止于 08-08 那种）", () => {
    const db = makeDb();
    const dataEnd = dataEndAt(1);
    seed(db, dataEnd);
    // 数据允许算到 dataEnd − 7 天左右，这里只写到再往前 6 天，制造 6 天的落后
    const stopAt = dataEnd - (HORIZON + 6) * DAY_MS;
    for (let i = 3; i >= 0; i--) {
      insertRow(db, new Date(stopAt - i * DAY_MS).toISOString().slice(0, 10), { hours: 24 });
    }
    assert.throws(() => assertCoverageFrontier(db, HORIZON), /覆盖提前截止|落后/);
  });

  // 写入期那道守卫在正常路径上**够不到**——定型判据已经先把它挡住了。
  // 够不到的守卫等于死代码，会烂掉而没人知道。这一条专门把它逼出来：
  // 让定型判据放行（数据末端远在后面），但把 T+N 那一段的数据挖掉，制造塌陷。
  it("写入期拒绝塌陷的天（这道守卫平时够不到，必须专门逼一次）", () => {
    const db = makeDb();
    const dataEnd = dataEndAt(1);
    seed(db, dataEnd);

    // 挑一天，把它 T+7 那一天靠后的小时删掉 ⇒ 那一天只剩前 9 小时配得出对子。
    //
    // **9 这个数是算出来的，不是随手取的**：要同时满足两头——
    //   · 9 小时 × 3 个饰品 = 27 条样本 ≥ MIN_SAMPLES_PER_DAY(20)，否则这一天会被
    //     聚合那句 `WHERE sample_count >= 20` **整天丢掉，根本走不到守卫**
    //     （第一版写的是删 ≥3 小时，只剩 9 条样本，测试因此变绿——又一次"绿得没道理"）；
    //   · 9/24 = 37.5% < COLLAPSE_RATIO(50%)，才够得上"塌陷"。
    const victim = Math.floor((dataEnd - 12 * DAY_MS) / DAY_MS) * DAY_MS;
    const targetDay = new Date(victim + HORIZON * DAY_MS).toISOString().slice(0, 10);
    db.prepare(
      `DELETE FROM price_snapshots
       WHERE substr(captured_at,1,10) = ? AND CAST(substr(captured_at,12,2) AS INTEGER) >= 9`
    ).run(targetDay);

    assert.throws(() => ensureBaselines(db, [HORIZON]), /拒绝写入|只用了/);
  });

  it("散落的采集缺口不算塌陷（22.84/24 那种是正常的）", () => {
    const db = makeDb();
    const dataEnd = dataEndAt(1);
    seed(db, dataEnd);
    // 随手抠掉几个不连续的小时，模拟真实采集缺口
    const day = new Date(Math.floor((dataEnd - 10 * DAY_MS) / DAY_MS) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    db.prepare(
      `DELETE FROM price_snapshots
       WHERE substr(captured_at,1,10) = ? AND CAST(substr(captured_at,12,2) AS INTEGER) IN (5, 11, 17)`
    ).run(day);
    assert.doesNotThrow(() => ensureBaselines(db, [HORIZON]));
  });

  it("正常追上进度时不报警", () => {
    const db = makeDb();
    const dataEnd = dataEndAt(1);
    seed(db, dataEnd);
    ensureBaselines(db, [HORIZON]);
    assert.equal(assertCoverageFrontier(db, HORIZON, { throwOnFail: false }), null);
  });
});
