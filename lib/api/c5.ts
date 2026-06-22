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

export async function getProductPrices(
  marketHashNames: string[],
  appId = "730"
): Promise<IC5Result<IC5ProductPriceMap>> {
  return c5Request<IC5ProductPriceMap>("/merchant/product/price/batch", {
    method: "POST",
    body: { appId, marketHashNames },
  });
}
