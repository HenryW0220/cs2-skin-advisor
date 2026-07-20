// 各平台卖出交易手续费率。2026-07 查证：C5 普通 1%（VIP 0.5%/SVIP 0%），
// 悠悠有品普通 1%（大会员有折扣/全免）。提现费（C5 0.9%、悠悠 1%）是批量行为
// 不按笔扣，不在这里。费率平台会调，变了改这一处即可（历史记录存了 gross 可重算）。
export const SELL_FEE_PRESETS = [
  { key: "c5", label: "C5", rate: 0.01 },
  { key: "c5_vip", label: "C5会员", rate: 0.005 },
  { key: "youpin", label: "悠悠有品", rate: 0.01 },
  { key: "none", label: "无手续费", rate: 0 },
] as const;

export type ISellFeeKey = (typeof SELL_FEE_PRESETS)[number]["key"];

export function netSellPrice(gross: number, feeKey: string): { net: number; label: string } {
  const preset = SELL_FEE_PRESETS.find((p) => p.key === feeKey) ?? SELL_FEE_PRESETS[3];
  return { net: gross * (1 - preset.rate), label: preset.label };
}
