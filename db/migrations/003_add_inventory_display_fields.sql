-- Steam 导入饰品的中文显示名和图标，手动添加的持仓没有这两个字段，留空即可。
ALTER TABLE inventory ADD COLUMN name_cn TEXT;
ALTER TABLE inventory ADD COLUMN icon_url TEXT;
