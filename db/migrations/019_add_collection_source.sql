-- 区分 item_metadata.collection 这一列里装的是"真实收藏品"还是"推导出来的联动分组"。
--
-- 背景（2026-08-03）：印花和探员天然没有收藏品（那是皮肤才有的概念），所以同收藏品联动
-- 特征对它们恒为 0，实测把 coMove 的 AUC 稀释到看起来像没区分度（HANDOFF 踩坑 44）。
-- 它们有天然等价物——印花属于同一赛事胶囊、探员属于同一组织，实测这个分组的联动
-- AUC 中位 0.651、25/26 个饰品同方向，所以把它写进同一列让下游直接受益。
--
-- 为什么要多这一列而不是只看前缀：①下游要能按来源分流，平级分组（胶囊/组织，同涨同跌）
-- 和层级分组（收藏品，上级拉升→下级炼金料跟涨）走的是不同的预警逻辑；②观察期内
-- 推导分组的联动预警只入库不推送，要有个明确依据来筛，不能靠字符串猜。
ALTER TABLE item_metadata ADD COLUMN collection_source TEXT NOT NULL DEFAULT 'official';

-- 已有的行全部是 ByMykel 数据集里的真实收藏品，默认值就是对的，不需要额外回填。
CREATE INDEX IF NOT EXISTS idx_item_metadata_collection ON item_metadata (collection);
