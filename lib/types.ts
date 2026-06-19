export interface IInventoryItem {
  id: number;
  item_name: string;
  platform: "steam" | "c5";
  buy_price: number;
  quantity: number;
  buy_date: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface IPriceSnapshot {
  id: number;
  item_name: string;
  // SteamDT 单品价格接口返回的是聚合后的具体交易平台代码（如 BUFF/YOUPIN/STEAM），
  // 直连 C5 价格接口时固定写 'c5'，所以这里用 string 而不是字面量联合类型。
  platform: string;
  price: number;
  volume: number | null;
  captured_at: string;
  created_at: string;
}

export interface IWatchlistItem {
  id: number;
  item_name: string;
  target_buy_price: number | null;
  target_sell_price: number | null;
  notes: string | null;
  created_at: string;
}

// C5Game 接口返回类型

export interface IC5InventoryItem {
  assetId: string;
  itemId: string;
  name: string;
  marketHashName: string;
  imageUrl: string;
  price: number;
  assetInfo: {
    wear: number;
    paintIndex: number;
    paintSeed: number;
  };
  itemInfo: {
    exteriorName: string;
    rarityName: string;
  };
  ifTradable: boolean;
}

export interface IC5SellerOrder {
  orderId: string;
  name: string;
  marketHashName: string;
  price: number;
  status: number;
  orderCreateTime: string;
  assetInfo: {
    wear: number;
  };
}

// C5 响应统一是 {success, data, errorCode, errorMsg, errorData, errorCodeStr} 包装层（实测确认）。
export interface IC5Envelope<T> {
  success: boolean;
  data: T;
  errorCode: number | string;
  errorMsg: string | null;
  errorData: unknown;
  errorCodeStr: string | null;
}

export interface IC5InventoryListData {
  steamId: string;
  appId: number;
  total: number;
  lastAssetId: number | string | null;
  list: IC5InventoryItem[];
}

export interface IC5SellerOrderListData {
  total: number;
  pages: number;
  page: number;
  limit: number;
  list: IC5SellerOrder[];
}

// 价格查询接口的真实 path 还没确认（文档里给的 /open/product/price 实测 404），
// 响应字段先按 price 占位，等路径确认后再补全。
export interface IC5PriceQuery {
  price: number;
  [key: string]: unknown;
}

// SteamDT 接口返回类型

export interface ISteamDTEnvelope<T> {
  success: boolean;
  data: T;
  errorCode: string | number;
  errorMsg: string | null;
}

export interface ISteamDTPlatformPrice {
  platform: string;
  platformItemId: string;
  sellPrice: number;
  sellCount: number;
  biddingPrice: number;
  biddingCount: number;
  updateTime: number; // Unix 秒级时间戳，不是字符串（实测确认，文档没写清楚）
}

// 实测确认 batch 接口的 dataList 跟单品价格接口字段一样（文档里少写了 platformItemId/updateTime）。
export interface ISteamDTBatchPriceItem {
  marketHashName: string;
  dataList: ISteamDTPlatformPrice[];
}

export interface ISteamDTAvgPriceEntry {
  platform: string;
  avgPrice: number;
}

export interface ISteamDTAvgPrice {
  marketHashName: string;
  avgPrice: number;
  dataList: ISteamDTAvgPriceEntry[];
}

// K线每行实测是 [时间戳字符串, open, high, low, close]，没有成交量字段，时间戳是字符串不是数字。
export type ISteamDTKlinePoint = [string, number, number, number, number];
