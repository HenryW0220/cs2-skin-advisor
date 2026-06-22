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
