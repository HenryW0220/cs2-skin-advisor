const INVENTORY_BASE_URL = "https://steamcommunity.com/inventory";

// 拼图标 URL 用：community/economy/image/{icon_url} 才是完整地址。
export const STEAM_ICON_BASE_URL = "https://community.fastly.steamstatic.com/economy/image";

interface ISteamAsset {
  assetid: string;
  classid: string;
  instanceid: string;
  amount: string;
}

interface ISteamDescription {
  classid: string;
  instanceid: string;
  market_hash_name: string;
  market_name: string; // 中文（或 l= 指定的语言）显示名，带磨损后缀，跟 market_hash_name 格式对应
  icon_url: string;
  tradable: number;
  marketable: number;
}

interface ISteamInventoryResponse {
  success: number;
  total_inventory_count?: number;
  assets?: ISteamAsset[];
  descriptions?: ISteamDescription[];
}

// 一个 ISteamInventoryItem 对应 Steam 库存里一个真实的独立 asset，不按 marketHashName 合并——
// 同一个饰品买了 28 个，Steam 那边本来就是 28 个独立资产，这里如实返回 28 条。
export interface ISteamInventoryItem {
  assetId: string;
  marketHashName: string;
  nameCn: string;
  iconUrl: string;
  quantity: number; // CS2 饰品基本都是 1，留着是因为 Steam 协议本身允许 amount > 1（堆叠类道具）
  tradable: boolean;
  marketable: boolean;
}

interface IResult<T> {
  data: T | null;
  error?: string;
}

interface ISteamMarketSearchResult {
  name: string; // 本地化展示名（受 l= 参数影响），不是 market_hash_name
  asset_description: {
    icon_url: string;
    market_hash_name: string;
  };
}

interface ISteamMarketSearchResponse {
  success: boolean;
  results?: ISteamMarketSearchResult[];
}

export interface ISteamMarketLookup {
  nameCn: string;
  iconUrl: string;
}

export interface ISteamMarketSearchItem {
  marketHashName: string; // 英文全名，给价格接口和入库用的 key
  nameCn: string;
  iconUrl: string;
}

async function fetchMarketSearchResults(
  query: string
): Promise<IResult<ISteamMarketSearchResult[]>> {
  try {
    const url = `https://steamcommunity.com/market/search/render/?query=${encodeURIComponent(
      query
    )}&appid=730&norender=1&l=schinese`;
    const res = await fetch(url);
    if (!res.ok) {
      return { data: null, error: `Steam 市场搜索接口返回 HTTP ${res.status}` };
    }

    const json = (await res.json()) as ISteamMarketSearchResponse;
    return { data: json.results ?? [] };
  } catch (err) {
    return {
      data: null,
      error: `Steam 市场搜索请求失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// 观察池里的饰品通常不在用户自己的库存里，没法靠库存导入顺带拿图标/中文名，
// 用 Steam 市场的公开搜索接口（不需要 key）按 market_hash_name 精确匹配查一次。
// 搜索是模糊匹配，可能返回好几个相近结果（普通/StatTrak/纪念品），必须按
// asset_description.market_hash_name 精确比对，不能直接拿第一条。
export async function lookupSteamMarketItem(
  marketHashName: string
): Promise<IResult<ISteamMarketLookup>> {
  const result = await fetchMarketSearchResults(marketHashName);
  if (result.error || !result.data) return { data: null, error: result.error };

  const match = result.data.find((r) => r.asset_description.market_hash_name === marketHashName);
  if (!match) {
    return { data: null, error: "Steam 市场搜索没找到精确匹配的饰品名" };
  }
  return { data: { nameCn: match.name, iconUrl: match.asset_description.icon_url } };
}

// 给加入观察池的搜索框用：支持中文/英文模糊查询，返回的每一条都带着真实的
// market_hash_name，用户从列表里选一条就不会再有名字/磨损度打错的问题。
export async function searchSteamMarketItems(
  query: string
): Promise<IResult<ISteamMarketSearchItem[]>> {
  const result = await fetchMarketSearchResults(query);
  if (result.error || !result.data) return { data: null, error: result.error };

  return {
    data: result.data.map((r) => ({
      marketHashName: r.asset_description.market_hash_name,
      nameCn: r.name,
      iconUrl: r.asset_description.icon_url,
    })),
  };
}

// Steam 的公开库存接口不需要 API_KEY，前提是这个 Steam 账号的库存隐私设置是公开的。
export async function getSteamInventory(
  steamId: string,
  appId = 730,
  contextId = 2
): Promise<IResult<ISteamInventoryItem[]>> {
  try {
    // count 上限是 2000，传更大的值 Steam 直接返回 400（实测确认），不是简单地截断。
    const url = `${INVENTORY_BASE_URL}/${steamId}/${appId}/${contextId}?l=schinese&count=2000`;
    const res = await fetch(url);

    if (res.status === 403) {
      return { data: null, error: "Steam 库存接口返回 403，库存隐私设置可能是私密的" };
    }
    if (!res.ok) {
      return { data: null, error: `Steam 库存接口返回 HTTP ${res.status}` };
    }

    const json = (await res.json()) as ISteamInventoryResponse;
    if (!json.success || !json.assets || !json.descriptions) {
      return { data: null, error: "Steam 库存返回为空，可能是私密库存或者账号没有 CS2 物品" };
    }

    const descByKey = new Map(
      json.descriptions.map((d) => [`${d.classid}_${d.instanceid}`, d])
    );

    const items: ISteamInventoryItem[] = [];
    for (const asset of json.assets) {
      const desc = descByKey.get(`${asset.classid}_${asset.instanceid}`);
      if (!desc) continue;

      items.push({
        assetId: asset.assetid,
        marketHashName: desc.market_hash_name,
        nameCn: desc.market_name,
        iconUrl: desc.icon_url,
        quantity: Number(asset.amount) || 1,
        tradable: desc.tradable === 1,
        marketable: desc.marketable === 1,
      });
    }

    return { data: items };
  } catch (err) {
    return {
      data: null,
      error: `Steam 库存请求失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
