import type {
  ISteamDTAvgPrice,
  ISteamDTBatchPriceItem,
  ISteamDTEnvelope,
  ISteamDTKlinePoint,
  ISteamDTPlatformPrice,
} from "../types";

const BASE_URL = process.env.STEAMDT_API_BASE_URL ?? "https://open.steamdt.com";
const APP_KEY = process.env.STEAMDT_APP_KEY ?? "";

interface ISteamDtResult<T> {
  data: T | null;
  error?: string;
}

async function steamDtRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST";
    query?: Record<string, string | undefined>;
    body?: unknown;
  } = {}
): Promise<ISteamDtResult<T>> {
  const url = new URL(path, BASE_URL);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }

  try {
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        // 实测确认鉴权要用 Authorization: Bearer <key>，header 名不是 app-key（跟文档描述不一致）。
        Authorization: `Bearer ${APP_KEY}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      return { data: null, error: `SteamDT ${path} 返回 HTTP ${res.status}` };
    }

    const json = (await res.json()) as ISteamDTEnvelope<T>;
    if (!json.success) {
      return {
        data: null,
        error: `SteamDT ${path} 返回错误 ${json.errorCode}: ${json.errorMsg}`,
      };
    }
    return { data: json.data };
  } catch (err) {
    return {
      data: null,
      error: `SteamDT ${path} 请求失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function getSinglePrice(
  marketHashName: string
): Promise<ISteamDtResult<ISteamDTPlatformPrice[]>> {
  return steamDtRequest<ISteamDTPlatformPrice[]>("/open/cs2/v1/price/single", {
    query: { marketHashName },
  });
}

// 批量接口单次最多 100 个名字，101 个就报 100002 参数错误（实测确认，文档没写）。
const BATCH_PRICE_MAX_NAMES = 100;

// 超过 100 个名字自动分块串行请求。某一块失败（常见是 4005 限流，这个接口有独立
// 的小额配额）时不丢弃已成功块的数据：返回拿到的部分 + error，调用方按"哪些饰品
// 不在返回列表里"判断这轮谁没同步到。
export async function getBatchPrice(
  marketHashNames: string[]
): Promise<ISteamDtResult<ISteamDTBatchPriceItem[]>> {
  const merged: ISteamDTBatchPriceItem[] = [];
  for (let i = 0; i < marketHashNames.length; i += BATCH_PRICE_MAX_NAMES) {
    const chunk = marketHashNames.slice(i, i + BATCH_PRICE_MAX_NAMES);
    const result = await steamDtRequest<ISteamDTBatchPriceItem[]>("/open/cs2/v1/price/batch", {
      method: "POST",
      body: { marketHashNames: chunk },
    });
    if (result.error || !result.data) {
      return { data: merged, error: result.error ?? "无数据" };
    }
    merged.push(...result.data);
  }
  return { data: merged };
}

// 文档目前只确认 type=1（日线），其他取值未知。
export type ISteamDTKlineType = 1;

export async function getKline(
  marketHashName: string,
  options: {
    type?: ISteamDTKlineType;
    platform?: string;
    specialStyle?: string;
  } = {}
): Promise<ISteamDtResult<ISteamDTKlinePoint[]>> {
  return steamDtRequest<ISteamDTKlinePoint[]>("/open/cs2/item/v1/kline", {
    method: "POST",
    body: {
      marketHashName,
      type: options.type ?? 1,
      platform: options.platform,
      specialStyle: options.specialStyle,
    },
  });
}

export async function getSevenDayAvgPrice(
  marketHashName: string
): Promise<ISteamDtResult<ISteamDTAvgPrice>> {
  return steamDtRequest<ISteamDTAvgPrice>("/open/cs2/v1/price/avg", {
    query: { marketHashName },
  });
}
