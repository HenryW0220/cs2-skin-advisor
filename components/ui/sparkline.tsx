// 纯 SVG 走势图，不依赖图表库。颜色跟着项目里"涨红跌绿"的约定走。
export function Sparkline({ prices }: { prices: number[] }) {
  if (prices.length < 2) {
    return <span className="text-xs text-neutral-600">数据不足</span>;
  }

  const width = 80;
  const height = 28;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const points = prices
    .map((price, i) => {
      const x = (i / (prices.length - 1)) * width;
      const y = height - ((price - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const trendingUp = prices[prices.length - 1] >= prices[0];

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
