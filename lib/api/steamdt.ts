import type {
  ISteamDTAvgPrice,
  ISteamDTBatchPriceItem,
  ISteamDTEnvelope,
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
        "app-key": APP_KEY,
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

export async function getBatchPrice(
  marketHashNames: string[]
): Promise<ISteamDtResult<ISteamDTBatchPriceItem[]>> {
  return steamDtRequest<ISteamDTBatchPriceItem[]>("/open/cs2/v1/price/batch", {
    method: "POST",
    body: { marketHashNames },
  });
}

// 文档目前只确认 type=1（日线），其他取值未知。
export type ISteamDTKlineType = 1;

// K线返回的二维数组每行的列含义文档没有列出，拿到真实响应后需要补一个解析函数把列映射成具名字段。
export async function getKline(
  marketHashName: string,
  options: {
    type?: ISteamDTKlineType;
    platform?: string;
    specialStyle?: string;
  } = {}
): Promise<ISteamDtResult<number[][]>> {
  return steamDtRequest<number[][]>("/open/cs2/item/v1/kline", {
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
