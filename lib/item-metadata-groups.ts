/**
 * 从饰品名推导"联动分组"——印花按赛事胶囊、探员按所属组织。
 *
 * 为什么需要这个：`item_metadata.collection` 来自 ByMykel 皮肤数据集，**印花和探员天然没有
 * 收藏品**（那是皮肤才有的概念），所以这两类的 collection 一直是 null。后果是同收藏品联动
 * 特征（coMove）对它们恒为 0——2026-08-03 查出来，67 个有操盘标记的饰品里有 34 个属于这种
 * 情况，把 coMove 的 AUC 稀释到看起来像没有区分度（详见 HANDOFF 踩坑 44）。
 *
 * 但它们有天然的等价物：同一个赛事胶囊里的印花、同一个组织的探员会一起动。已实测验证
 * （`scripts/analyze-group-comove.mjs`）：按这个分组算，25/26 个饰品的联动特征同方向，
 * 24 小时联动 AUC 中位数 0.651，符号检验 p≈4×10⁻⁷。
 *
 * **和收藏品联动的语义差别（很重要）**：收藏品是**层级**关系（上级被拉→下级炼金料跟涨，
 * 靠 rarity_rank 排序）；胶囊/组织是**平级**关系，没有炼金链条，观察到的是同涨同跌。
 * 所以这两种分组在 `lib/anomaly-scan.ts` 里走的是不同的预警逻辑，别混用。
 */

/** 联动分组的来源。official=ByMykel 数据集里的真实收藏品；derived=按下面的规则从名字推的。 */
export type ICollectionSource = "official" | "derived";

const CAPSULE_PREFIX = "capsule:";
const AGENT_PREFIX = "agentgroup:";

// 探员的名字格式是 `角色名 | 所属组织`，没有品类前缀。但音乐盒（`Music Kit | 艺人, 曲名`）、
// 挂件（`Charm | 名字`）、布章（`Patch | 名字`）、涂鸦这些同样是两段式，会被误判成探员——
// 实测回填演练时就把 `StatTrak™ Music Kit | Repiet & Julia Kleijn, On And On` 分成了
// "组织"。它们各自只有一件、不会真的产生联动预警，但语义是错的，明确排除掉。
const NON_AGENT_TYPE_PREFIXES = [
  "Music Kit |",
  "Charm |",
  "Patch |",
  "Graffiti |",
  "Sealed Graffiti |",
  "Sticker |",
];

/**
 * 推导联动分组。皮肤一律返回 null（它们用真实收藏品，不该被这里覆盖）。
 *
 * @param itemName market_hash_name，如 `Sticker | Aurora (Holo) | Austin 2025`
 * @returns 带前缀的分组标识（`capsule:Austin 2025` / `agentgroup:SWAT`），推不出来返回 null。
 *   **带前缀是有意的**：这一列同时装着真实收藏品名，不加前缀万一某个收藏品叫 "SWAT"
 *   就会跟探员组织撞在一起，凭空生出一个跨品类的假分组。
 */
export function deriveLinkageGroup(itemName: string): string | null {
  const parts = itemName.split("|").map((s) => s.trim());

  // 印花名格式固定是 `Sticker | 队伍名 (Holo) | 赛事名`，最后一段就是胶囊
  if (itemName.startsWith("Sticker |")) {
    return parts.length >= 3 ? CAPSULE_PREFIX + parts[parts.length - 1] : null;
  }

  // 探员是 `角色名 | 所属组织`，两段且不以磨损括号结尾——
  // 皮肤都带磨损后缀（`AK-47 | Redline (Field-Tested)`），用这个区分开。
  // StatTrak™ 前缀要先剥掉再判品类，否则 `StatTrak™ Music Kit | ...` 会漏过排除名单。
  const withoutQuality = itemName.replace(/^StatTrak™\s+/, "").replace(/^Souvenir\s+/, "");
  if (NON_AGENT_TYPE_PREFIXES.some((p) => withoutQuality.startsWith(p))) return null;
  if (parts.length === 2 && !itemName.endsWith(")")) {
    return AGENT_PREFIX + parts[1];
  }

  return null;
}

/** 这个分组是不是推导出来的（而不是真实收藏品）。预警逻辑要按这个分流。 */
export function isDerivedGroup(collection: string | null | undefined): boolean {
  if (!collection) return false;
  return collection.startsWith(CAPSULE_PREFIX) || collection.startsWith(AGENT_PREFIX);
}

/** 去掉前缀，给界面文案用（`capsule:Austin 2025` → `Austin 2025`）。 */
export function displayGroupName(collection: string): string {
  if (collection.startsWith(CAPSULE_PREFIX)) return collection.slice(CAPSULE_PREFIX.length);
  if (collection.startsWith(AGENT_PREFIX)) return collection.slice(AGENT_PREFIX.length);
  return collection;
}
