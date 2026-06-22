-- 按 Steam 真实 asset 去重用，每个独立资产一行，不再按 marketHashName 合并数量。
-- 手动添加的持仓没有这个字段，留空即可。
ALTER TABLE inventory ADD COLUMN steam_asset_id TEXT;

CREATE INDEX IF NOT EXISTS idx_inventory_steam_asset_id ON inventory (steam_asset_id);
