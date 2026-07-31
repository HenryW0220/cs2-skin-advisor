// 图只有 80 像素宽，超过 80 个点必然有多个点落在同一像素列上——画不出任何差别，
// 却要按点数成倍撑大 HTML（持仓页 121 行，实测每多 750 个点就多出约 1MB HTML）。
// 等间距抽样降到 ≤80 点，首尾都保留（末点决定涨跌配色和最新价，不能被抽掉）。
// 代价是两个采样点之间的短时尖峰会被略过——这个图本来就是扫一眼看趋势的，
// 要看细节走饰品详情页的完整图表（那边读全分辨率历史，不走这个组件）。
export function downsampleForWidth(prices: number[], maxPoints: number): number[] {
  if (prices.length <= maxPoints) return prices;
  const step = (prices.length - 1) / (maxPoints - 1);
  const sampled: number[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    sampled.push(prices[Math.round(i * step)]);
  }
  return sampled;
}

// 纯 SVG 走势图，不依赖图表库。颜色跟着项目里"涨红跌绿"的约定走。
export function Sparkline({ prices }: { prices: number[] }) {
  if (prices.length < 2) {
    return <span className="text-xs text-neutral-600">数据不足</span>;
  }

  const width = 80;
  const height = 28;
  const sampled = downsampleForWidth(prices, width);
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min || 1;

  const points = sampled
    .map((price, i) => {
      const x = (i / (sampled.length - 1)) * width;
      const y = height - ((price - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const trendingUp = sampled[sampled.length - 1] >= sampled[0];

  return (
    <svg width={width} height={height} className="inline-block">
      <polyline
        points={points}
        fill="none"
        stroke={trendingUp ? "#f87171" : "#34d399"}
        strokeWidth="1.5"
      />
    </svg>
  );
}
