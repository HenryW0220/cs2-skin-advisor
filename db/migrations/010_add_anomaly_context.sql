-- 检测时写入的上下文说明（跟审核时的 review_note 区分开）：
-- 联动预警要说明是被同收藏品哪个上级带动的、嫌疑分预警要带当时的特征值，
-- 不然用户在审核页看到一条"联动"不知道从何而来。
ALTER TABLE anomaly_events ADD COLUMN context TEXT;
