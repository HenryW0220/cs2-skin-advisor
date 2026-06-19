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
  platform: "steamdt" | "c5";
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

// 价格查询响应字段未在文档里完整列出，目前只确认有 price，
// 其余字段先按 unknown 处理，等拿到真实响应再补全。
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
  sellPrice: number;
  sellCount: number;
  biddingPrice: number;
  biddingCount: number;
  updateTime: string;
}

export interface ISteamDTBatchPlatformPrice {
  platform: string;
  sellPrice: number;
  sellCount: number;
  biddingPrice: number;
  biddingCount: number;
}

export interface ISteamDTBatchPriceItem {
  marketHashName: string;
  dataList: ISteamDTBatchPlatformPrice[];
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
