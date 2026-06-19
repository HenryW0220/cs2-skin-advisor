import { TokenBucket } from "./rate-limiter";
import type { IC5InventoryItem, IC5PriceQuery, IC5SellerOrder } from "../types";

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
  query: Record<string, string | number | undefined>,
  extraLimiter?: TokenBucket
): Promise<IC5Result<T>> {
  if (extraLimiter) await extraLimiter.acquire();
  await globalLimiter.acquire();

  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  url.searchParams.set("app-key", APP_KEY);

  try {
    const res = await fetch(url, {
      headers: { "Accept-Encoding": "gzip, br, zstd, deflate" },
    });
    if (!res.ok) {
      return { data: null, error: `C5 ${path} 返回 HTTP ${res.status}` };
    }
    // C5 响应是否有 code/msg 包装层，文档片段里没确认，这里先把响应体当作 data 本体解析；
    // 等接到真实响应后如果发现有包装层，再在这里加一层解包。
    const json = (await res.json()) as T;
    return { data: json };
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
): Promise<IC5Result<IC5InventoryItem[]>> {
  return c5Request<IC5InventoryItem[]>(
    `/merchant/inventory/v2/${encodeURIComponent(steamId)}/${appId}`,
    {
      language: options.language ?? "zh",
      startAssetId: options.startAssetId ?? 0,
      count: options.count ?? 20,
    },
    inventoryLimiter
  );
}

export async function getSellerOrderList(
  steamId: string,
  options: { appId?: number; status?: number; page?: number; limit?: number } = {}
): Promise<IC5Result<IC5SellerOrder[]>> {
  return c5Request<IC5SellerOrder[]>("/merchant/order/v1/list", {
    steamId,
    appId: options.appId ?? 730,
    status: options.status ?? 1,
    page: options.page,
    limit: options.limit,
  });
}

export async function getProductPrice(
  marketHashName: string
): Promise<IC5Result<IC5PriceQuery>> {
  return c5Request<IC5PriceQuery>("/open/product/price", { marketHashName });
}
