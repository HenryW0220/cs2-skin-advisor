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
