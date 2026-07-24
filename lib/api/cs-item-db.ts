// ByMykel/CSGO-API：社区维护的 CS2 饰品静态数据集（GitHub 上的公开 JSON，无需鉴权）。
// 用它拿饰品 → 收藏品/箱子/品质 的映射，这是"同系列联动"分析的基础。
// 两份文件要 join：skins_not_grouped.json 有 market_hash_name（每个磨损一条），
// skins.json（按皮肤分组）才有 collections/crates，用 skin_id 关联。

const BASE_URL =
  "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/zh-CN";

// collections/crates 实测部分条目会缺字段（如不属于任何箱子的地图收藏品皮肤），全部按可缺省处理。
interface IGroupedSkin {
  id: string;
  rarity?: { id: string; name: string } | null;
  collections?: { name: string }[];
  crates?: { name: string }[];
}

interface IUngroupedSkin {
  skin_id: string;
  market_hash_name: string | null;
  name: string;
  image: string | null;
}

interface IAgent {
  market_hash_name: string | null;
  name: string;
  image: string | null;
}

export interface IItemStructureInfo {
  collection: string | null;
  crate: string | null;
  rarity: string | null;
  rarityRank: number | null;
}

export interface IItemCatalogEntry {
  marketHashName: string;
  nameCn: string;
  iconUrl: string | null; // Steam CDN 路径（已去掉域名前缀），同 watchlist.icon_url 口径
  itemType: "skin" | "agent";
}

interface IResult<T> {
  data: T | null;
  error?: string;
}

// 品质等级数值化，炼金方向是从低到高（10 个下级换 1 个上一级）。
// id 后缀有 _weapon 也有裸的（如 rarity_contraband），按前缀匹配。
const RARITY_RANK: [prefix: string, rank: number][] = [
  ["rarity_common", 1], // 消费级
  ["rarity_uncommon", 2], // 工业级
  ["rarity_rare", 3], // 军规级
  ["rarity_mythical", 4], // 受限
  ["rarity_legendary", 5], // 保密
  ["rarity_ancient", 6], // 隐秘
  ["rarity_contraband", 7], // 违禁
];

function rarityRankOf(rarityId: string | undefined): number | null {
  if (!rarityId) return null;
  const hit = RARITY_RANK.find(([prefix]) => rarityId.startsWith(prefix));
  return hit ? hit[1] : null;
}

async function fetchJson<T>(path: string): Promise<IResult<T>> {
  try {
    const res = await fetch(`${BASE_URL}/${path}`);
    if (!res.ok) {
      return { data: null, error: `CS 饰品数据集 ${path} 返回 HTTP ${res.status}` };
    }
    return { data: (await res.json()) as T };
  } catch (err) {
    return {
      data: null,
      error: `CS 饰品数据集 ${path} 请求失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 拉取全量皮肤数据，返回 market_hash_name → 结构信息 的映射。
 * 两份 JSON 合计约 30MB，调用方应该一次拉取批量使用，不要按单个饰品反复调。
 * 印花、探员、布章等非武器皮肤不在数据集里，映射不到的饰品调用方自行按 null 处理。
 */
// 数据集里 image 是完整 URL（community.akamai.steamstatic.com/economy/image/xxx），
// 项目里 icon_url 统一只存路径部分再拼 STEAM_ICON_BASE_URL，这里把域名前缀剥掉。
function stripIconPrefix(image: string | null): string | null {
  if (!image) return null;
  const marker = "/economy/image/";
  const idx = image.indexOf(marker);
  return idx === -1 ? null : image.slice(idx + marker.length);
}

/**
 * 拉取全量饰品目录（皮肤所有磨损/StatTrak 变体 + 探员），给本地联想搜索的
 * item_catalog 表用。皮肤约 2.1 万条 + 探员几十条，一次全量拉取批量入库。
 * 印花/挂件/音乐盒暂时不含——观察池目前只有皮肤和探员，需要时再加对应 JSON。
 */
export async function fetchItemCatalogEntries(): Promise<IResult<IItemCatalogEntry[]>> {
  const [skins, agents] = await Promise.all([
    fetchJson<IUngroupedSkin[]>("skins_not_grouped.json"),
    fetchJson<IAgent[]>("agents.json"),
  ]);
  if (skins.error || !skins.data) return { data: null, error: skins.error };
  if (agents.error || !agents.data) return { data: null, error: agents.error };

  const entries: IItemCatalogEntry[] = [];
  for (const skin of skins.data) {
    if (!skin.market_hash_name) continue;
    entries.push({
      marketHashName: skin.market_hash_name,
      nameCn: skin.name,
      iconUrl: stripIconPrefix(skin.image),
      itemType: "skin",
    });
  }
  for (const agent of agents.data) {
    if (!agent.market_hash_name) continue;
    entries.push({
      marketHashName: agent.market_hash_name,
      nameCn: agent.name,
      iconUrl: stripIconPrefix(agent.image),
      itemType: "agent",
    });
  }
  return { data: entries };
}

export async function fetchItemStructureMap(): Promise<
  IResult<Map<string, IItemStructureInfo>>
> {
  const [grouped, ungrouped] = await Promise.all([
    fetchJson<IGroupedSkin[]>("skins.json"),
    fetchJson<IUngroupedSkin[]>("skins_not_grouped.json"),
  ]);
  if (grouped.error || !grouped.data) return { data: null, error: grouped.error };
  if (ungrouped.error || !ungrouped.data) return { data: null, error: ungrouped.error };

  const groupedById = new Map(grouped.data.map((skin) => [skin.id, skin]));

  const map = new Map<string, IItemStructureInfo>();
  for (const entry of ungrouped.data) {
    if (!entry.market_hash_name) continue;
    const group = groupedById.get(entry.skin_id);
    if (!group) continue;
    map.set(entry.market_hash_name, {
      collection: group.collections?.[0]?.name ?? null,
      crate: group.crates?.[0]?.name ?? null,
      rarity: group.rarity?.name ?? null,
      rarityRank: rarityRankOf(group.rarity?.id),
    });
  }
  return { data: map };
}
