-- 手续费扣除：用户填的是平台成交价（gross），入账的 sell_price 是扣掉平台交易
-- 手续费后的净到手价，盈利按净到手算。gross 和平台留档，方便回看和以后改费率重算。
-- 提现手续费不在这里扣——提现是批量行为，不按笔归属。
ALTER TABLE sales_records ADD COLUMN sell_platform TEXT;
ALTER TABLE sales_records ADD COLUMN sell_price_gross REAL;
