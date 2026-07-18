-- 审核异常事件时的备注（外部事件驱动的行情要记下是什么事件，如"武库开放炼金"），
-- 同时 status 增加第三种终态 'external'：外部事件驱动的真实行情——长得跟操盘一样
-- （突然放量暴涨）但成因完全不同，是训练时最有价值的"困难负样本"，不能跟普通
-- 正常波动混在一起。status 列本身没有 CHECK 约束，这里只需要加备注列。
ALTER TABLE anomaly_events ADD COLUMN review_note TEXT;
