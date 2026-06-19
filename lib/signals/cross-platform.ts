export interface IPlatformPricePoint {
  platform: string;
  price: number;
}

export interface ICrossPlatformSpread {
  cheapest: IPlatformPricePoint;
  mostExpensive: IPlatformPricePoint;
  spread: number;
  spreadPercent: number; // spread / cheapest.price
}

// 跨平台价差：传入同一个饰品在各平台的最新价格（比如 SteamDT 单品价格接口返回的 data 数组），
// 找出最便宜和最贵的平台。price <= 0 的条目（缺货/未上架）会被过滤掉。
export function computeCrossPlatformSpread(
  prices: IPlatformPricePoint[]
): ICrossPlatformSpread | null {
  const valid = prices.filter((p) => p.price > 0);
  if (valid.length < 2) return null;

  let cheapest = valid[0];
  let mostExpensive = valid[0];
  for (const p of valid) {
    if (p.price < cheapest.price) cheapest = p;
    if (p.price > mostExpensive.price) mostExpensive = p;
  }

  const spread = mostExpensive.price - cheapest.price;
  return {
    cheapest,
    mostExpensive,
    spread,
    spreadPercent: spread / cheapest.price,
  };
}
