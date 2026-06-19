// 简单移动平均线（SMA），MA7/MA30 都是调这个函数传不同 period。
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
