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

// 实测确认：这个接口连续请求 2 次就报 4005 限流，要等约 60 秒才恢复
// （跟 K 线接口的限流规则完全不同，K 线 250ms 间隔连打没事，见 HANDOFF 踩坑 6c）。
const BATCH_PRICE_CHUNK_DELAY_MS = 60_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 超过 100 个名字自动分块串行请求，块间隔 60 秒避开限流。某一块失败（通常还是
// 4005，说明限流比预期更紧）不放弃后续块——继续跑完剩下的块，把失败块的名字
// 记进 error 里；调用方（sync.ts）按"哪些饰品不在返回列表里"判断这轮谁没同步到。
export async function getBatchPrice(
  marketHashNames: string[]
): Promise<ISteamDtResult<ISteamDTBatchPriceItem[]>> {
  const merged: ISteamDTBatchPriceItem[] = [];
  const chunkErrors: string[] = [];
  const chunks: string[][] = [];
  for (let i = 0; i < marketHashNames.length; i += BATCH_PRICE_MAX_NAMES) {
    chunks.push(marketHashNames.slice(i, i + BATCH_PRICE_MAX_NAMES));
  }

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(BATCH_PRICE_CHUNK_DELAY_MS);
    const result = await steamDtRequest<ISteamDTBatchPriceItem[]>("/open/cs2/v1/price/batch", {
      method: "POST",
      body: { marketHashNames: chunks[i] },
    });
    if (result.error || !result.data) {
      chunkErrors.push(`第${i + 1}/${chunks.length}块(${chunks[i].length}个)失败: ${result.error ?? "无数据"}`);
      continue;
    }
    merged.push(...result.data);
  }

  return { data: merged, error: chunkErrors.length > 0 ? chunkErrors.join("; ") : undefined };
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
