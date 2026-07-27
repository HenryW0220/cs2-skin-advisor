import { TokenBucket } from "./rate-limiter";
import type {
  IC5Envelope,
  IC5InventoryListData,
  IC5ProductPriceMap,
  IC5SellerOrderListData,
} from "../types";

const BASE_URL = process.env.C5_API_BASE_URL ?? "https://openapi.c5game.com";
const APP_KEY = process.env.C5_APP_KEY ?? "";

// 平台限流 50 QPS；库存接口额外限制 60 秒 1800 次（约 30 QPS），单独建一个更紧的桶。
const globalLimiter = new TokenBucket(50, 1_000);
const inventoryLimiter = new TokenBucket(1800, 60_000);

interface IC5Result<T> {
  data: T | null;
  error?: string;
}

async function c5Request<T>(
  path: string,
  options: {
    method?: "GET" | "POST";
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    extraLimiter?: TokenBucket;
  } = {}
): Promise<IC5Result<T>> {
  if (options.extraLimiter) await options.extraLimiter.acquire();
  await globalLimiter.acquire();

  const url = new URL(path, BASE_URL);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set("app-key", APP_KEY);

  try {
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "Accept-Encoding": "gzip, br, zstd, deflate",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
      return { data: null, error: `C5 ${path} 返回 HTTP ${res.status}` };
    }
    const json = (await res.json()) as IC5Envelope<T>;
    if (!json.success) {
      return {
        data: null,
        error: `C5 ${path} 返回错误 ${json.errorCode}: ${json.errorMsg}`,
      };
    }
    return { data: json.data };
  } catch (err) {
    return {
      data: null,
      error: `C5 ${path} 请求失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function getInventoryList(
  steamId: string,
  appId: number,
  options: { startAssetId?: number; count?: number; language?: string } = {}
): Promise<IC5Result<IC5InventoryListData>> {
  return c5Request<IC5InventoryListData>(
    `/merchant/inventory/v2/${encodeURIComponent(steamId)}/${appId}`,
    {
      query: {
        language: options.language ?? "zh",
        startAssetId: options.startAssetId ?? 0,
        count: options.count ?? 20,
      },
      extraLimiter: inventoryLimiter,
    }
  );
}

export async function getSellerOrderList(
  steamId: string,
  options: { appId?: number; status?: number; page?: number; limit?: number } = {}
): Promise<IC5Result<IC5SellerOrderListData>> {
  return c5Request<IC5SellerOrderListData>("/merchant/order/v1/list", {
    query: {
      steamId,
      appId: options.appId ?? 730,
      status: options.status ?? 1,
      page: options.page,
      limit: options.limit,
    },
  });
}

// 批量接口没有文档记录的名字数量上限，实测 338 个报 500211（超出参数数值上限）。
// 取跟 SteamDT 批量接口一致的 100 作为分块大小，没有再往上探边界的必要。
const PRODUCT_PRICE_MAX_NAMES = 100;

// 分块请求会打这个接口，但没有证据表明它跟 SteamDT 一样有连续请求限流（报错是参数数量
// 超限，不是限流），所以块间不加 SteamDT 那种 60 秒等待，避免同步耗时被无谓拉长。
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 超过 100 个名字自动分块串行请求，把各块返回的价格 map 合并成一个。某一块失败不放弃
// 后续块——继续跑完剩下的块，把失败块的名字记进 error 里；调用方（sync.ts）按"哪个
// 名字不在返回 map 里"判断这轮谁没同步到。
export async function getProductPrices(
  marketHashNames: string[],
  appId = "730"
): Promise<IC5Result<IC5ProductPriceMap>> {
  const merged: IC5ProductPriceMap = {};
  const chunkErrors: string[] = [];
  const chunks: string[][] = [];
  for (let i = 0; i < marketHashNames.length; i += PRODUCT_PRICE_MAX_NAMES) {
    chunks.push(marketHashNames.slice(i, i + PRODUCT_PRICE_MAX_NAMES));
  }

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(1_000);
    const result = await c5Request<IC5ProductPriceMap>("/merchant/product/price/batch", {
      method: "POST",
      body: { appId, marketHashNames: chunks[i] },
    });
    if (result.error || !result.data) {
      chunkErrors.push(`第${i + 1}/${chunks.length}块(${chunks[i].length}个)失败: ${result.error ?? "无数据"}`);
      continue;
    }
    Object.assign(merged, result.data);
  }

  return { data: merged, error: chunkErrors.length > 0 ? chunkErrors.join("; ") : undefined };
}
