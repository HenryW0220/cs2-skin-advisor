// 简单移动平均线（SMA），MA7/MA30 都是调这个函数传不同 period。
// ⚠️ 第二份实现在 scripts/build-rsi-trend-baseline.mjs（那边用滑动窗口累加，数学等价、
// 浮点上末位有 1e-11 级差异，只进分档所以不影响结论），改这里要同步那边。
// 对拍测试：lib/signals/cross-impl-parity.test.ts。背景见 HANDOFF 第四节 0.5。
// 返回数组长度跟输入一致，前 period-1 个位置因为数据不够填 null。
export function movingAverage(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error("period 必须大于 0");

  return values.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    return sum / period;
  });
}
