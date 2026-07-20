import { getDb } from "./client";
import type { ISaleRecord } from "../types";

export function addSaleRecord(record: {
  item_name: string;
  name_cn: string | null;
  icon_url: string | null;
  quantity: number;
  buy_price: number;
  sell_price: number | null;
  sell_source: string | null;
  steam_asset_id: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sales_records (item_name, name_cn, icon_url, quantity, buy_price, sell_price, sell_source, steam_asset_id)
       VALUES (@item_name, @name_cn, @icon_url, @quantity, @buy_price, @sell_price, @sell_source, @steam_asset_id)`
    )
    .run(record);
}

export function listSaleRecords(): ISaleRecord[] {
  return getDb()
    .prepare("SELECT * FROM sales_records ORDER BY sold_at DESC")
    .all() as ISaleRecord[];
}

// sellPrice 是扣完手续费的净到手价，gross 是用户填的平台成交价（留档可重算）
export function updateSaleSellPrice(
  id: number,
  sellPrice: number,
  gross: number,
  platform: string
): ISaleRecord | undefined {
  getDb()
    .prepare(
      "UPDATE sales_records SET sell_price = ?, sell_price_gross = ?, sell_platform = ?, sell_source = 'manual' WHERE id = ?"
    )
    .run(sellPrice, gross, platform, id);
  return getDb().prepare("SELECT * FROM sales_records WHERE id = ?").get(id) as
    | ISaleRecord
    | undefined;
}
