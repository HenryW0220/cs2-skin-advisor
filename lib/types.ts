export interface IInventoryItem {
  id: number;
  item_name: string; // 英文 market_hash_name，跨 SteamDT/C5 查价用的 key，不直接展示给用户
  name_cn: string | null; // 中文显示名，Steam 导入才有，手动添加的持仓是 null
  icon_url: string | null; // Steam 图标 CDN 路径片段，要拼 https://community.fastly.steamstatic.com/economy/image/ 前缀才能用
  platform: "steam" | "c5";
  buy_price: number;
  quantity: number;
  buy_date: string;
  notes: string | null;
  steam_asset_id: string | null; // Steam 导入按这个去重，每个独立 asset 一行；手动添加的是 null
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

// price_zscore/volume_ratio 是统计异常；manipulation_score 是操盘嫌疑分预警（≥60 触发）；
// collection_linkage 是"同收藏品上级异动，下级炼金料可能跟涨"的联动预警。
export type IAnomalyMetric =
  | "price_zscore"
  | "volume_ratio"
  | "manipulation_score"
  | "collection_linkage";
// confirmed=确认操盘（正样本）；external=外部事件驱动的真实行情（版本更新/炼金开放/
// 大赛等，困难负样本，review_note 记录具体事件）；dismissed=正常波动（普通负样本）。
export type IAnomalyStatus = "pending" | "confirmed" | "external" | "dismissed";

// 自动异常检测（无需标签）产生的候选事件，见 db/migrations/007_add_anomaly_events.sql。
export interface IAnomalyEvent {
  id: number;
  item_name: string;
  platform: string;
  metric: IAnomalyMetric;
  detected_at: string;
  value: number;
  price: number;
  status: IAnomalyStatus;
  context: string | null; // 检测时写入的说明（联动来源、触发时特征值），区别于审核时的 review_note
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
}

// 饰品结构资料（收藏品/箱子/品质），同系列联动分析用，见 db/migrations/009_add_item_metadata.sql。
export interface IItemMetadata {
  id: number;
  item_name: string;
  collection: string | null;
  crate: string | null;
  rarity: string | null;
  rarity_rank: number | null;
  updated_at: string;
}

// 卖出流水，见 db/migrations/011_add_sales_records.sql。
export interface ISaleRecord {
  id: number;
  item_name: string;
  name_cn: string | null;
  icon_url: string | null;
  quantity: number;
  buy_price: number;
  sell_price: number | null;
  sell_source: string | null;
  steam_asset_id: string | null;
  sold_at: string;
  created_at: string;
}

export type IManipulationConfidence = "high" | "medium" | "low";

// 用户凭小道消息标记的"操盘时间窗口"，是将来训练操盘检测模型的正样本标签，
// 也直接喂给规则引擎/LLM 做决策参考——见 db/migrations/006_add_manipulation_tags.sql。
export interface IManipulationTag {
  id: number;
  item_name: string;
  start_date: string;
  end_date: string | null;
  confidence: IManipulationConfidence;
  note: string | null;
  created_at: string;
}

export interface IWatchlistItem {
  id: number;
  item_name: string;
  name_cn: string | null; // 加入观察池时查 Steam 市场搜索接口顺带存的，查不到就是 null
  icon_url: string | null;
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

export interface IC5ProductPrice {
  itemId: string;
  marketHashName: string;
  price: number;
  count: number;
  website: string;
}

// 批量价格查询的 data 是按 marketHashName 做 key 的 map，不是数组。
export type IC5ProductPriceMap = Record<string, IC5ProductPrice>;

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

// K线每行实测是 [unix秒级时间戳(字符串), open, high, low, close]，没有成交量字段。
// type=1 实测不是"日线"而是滚动最近 90 天的整点小时线（固定 2160 = 90*24 条），
// 文档写的"日线"跟实测行为对不上，先按实测的来。
export type ISteamDTKlinePoint = [string, number, number, number, number];
