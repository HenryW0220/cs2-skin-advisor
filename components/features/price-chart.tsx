"use client";

import { useMemo, useRef, useState } from "react";

export interface IPriceChartPoint {
  t: string; // 快照 captured_at（ISO 字符串）
  price: number;
  ma7: number | null; // 窗口是 7 个快照（同步频率为每小时时约等于 7 小时），跟 lib/signal-summary 的口径一致
  ma30: number | null;
  volume: number | null;
}

// 三个系列的颜色跑过 dataviz 调色板校验（暗色表面 #171717，CVD ΔE 全部达标），
// 不要随手换成 Tailwind 色板里的近似色。
const COLOR_PRICE = "#3987e5";
const COLOR_MA7 = "#008300";
const COLOR_MA30 = "#d55181";
const COLOR_GRID = "#2c2c2a";
const COLOR_AXIS_TEXT = "#898781";
const COLOR_SURFACE = "#171717";

const VIEW_W = 820;
const VIEW_H = 300;
const PAD = { top: 16, right: 20, bottom: 30, left: 56 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PLOT_H = VIEW_H - PAD.top - PAD.bottom;

const SERIES_META = [
  { key: "price", label: "价格", color: COLOR_PRICE },
  { key: "ma7", label: "MA7", color: COLOR_MA7 },
  { key: "ma30", label: "MA30", color: COLOR_MA30 },
] as const;

function niceTicks(min: number, max: number, targetCount: number): number[] {
  if (min === max) return [min];
  const rawStep = (max - min) / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

function formatTime(iso: string, withTime: boolean): string {
  const d = new Date(iso);
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (!withTime) return md;
  return `${md} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 线段在 null 处断开而不是跨过去连线，避免把"没数据"画成"价格平稳"。
function buildPath(
  points: IPriceChartPoint[],
  xs: number[],
  yFor: (v: number) => number,
  pick: (p: IPriceChartPoint) => number | null
): string {
  let d = "";
  let penDown = false;
  points.forEach((p, i) => {
    const v = pick(p);
    if (v === null) {
      penDown = false;
      return;
    }
    d += `${penDown ? "L" : "M"}${xs[i].toFixed(1)},${yFor(v).toFixed(1)}`;
    penDown = true;
  });
  return d;
}

export function PriceChart({ points }: { points: IPriceChartPoint[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const geometry = useMemo(() => {
    if (points.length < 2) return null;

    const t0 = new Date(points[0].t).getTime();
    const tN = new Date(points[points.length - 1].t).getTime();
    const tSpan = tN - t0 || 1;
    const xs = points.map(
      (p) => PAD.left + ((new Date(p.t).getTime() - t0) / tSpan) * PLOT_W
    );

    const values = points.flatMap((p) =>
      [p.price, p.ma7, p.ma30].filter((v): v is number => v !== null)
    );
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const padY = (rawMax - rawMin || rawMax || 1) * 0.06;
    const yMin = rawMin - padY;
    const yMax = rawMax + padY;
    const yFor = (v: number) => PAD.top + PLOT_H - ((v - yMin) / (yMax - yMin)) * PLOT_H;

    const yTicks = niceTicks(yMin, yMax, 4);
    // X 轴刻度：快照时间分布可能很不均匀（手动同步的稀疏点 + 定时任务的密集点），
    // 按索引均匀取会让标签在密集区挤成一团，所以按目标像素位置找最近的点，再按最小间距去重。
    const xLabelIndexes: number[] = [];
    const targetCount = Math.min(5, points.length);
    const minGap = 80;
    for (let k = 0; k < targetCount; k++) {
      const targetX = PAD.left + (k / (targetCount - 1 || 1)) * PLOT_W;
      let nearest = 0;
      for (let i = 1; i < xs.length; i++) {
        if (Math.abs(xs[i] - targetX) < Math.abs(xs[nearest] - targetX)) nearest = i;
      }
      const lastKept = xLabelIndexes[xLabelIndexes.length - 1];
      if (lastKept === undefined || xs[nearest] - xs[lastKept] >= minGap) {
        xLabelIndexes.push(nearest);
      }
    }
    // 跨度小于 3 天时 x 轴标签带上时分，否则只显示月-日
    const withTime = tSpan < 3 * 24 * 60 * 60 * 1000;

    return { xs, yFor, yTicks, xLabelIndexes, withTime };
  }, [points]);

  if (!geometry || points.length < 2) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-neutral-500">
        价格快照不足两条，先同步几次价格再来看走势
      </div>
    );
  }

  const { xs, yFor, yTicks, xLabelIndexes, withTime } = geometry;
  const last = points[points.length - 1];

  function nearestIndex(clientX: number): number {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    const xView = ((clientX - rect.left) / rect.width) * VIEW_W;
    let best = 0;
    for (let i = 1; i < xs.length; i++) {
      if (Math.abs(xs[i] - xView) < Math.abs(xs[best] - xView)) best = i;
    }
    return best;
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowLeft" ? -1 : 1;
    setActiveIndex((prev) =>
      Math.max(0, Math.min(points.length - 1, (prev ?? points.length - 1) + delta))
    );
  }

  const active = activeIndex !== null ? points[activeIndex] : null;
  const activeX = activeIndex !== null ? xs[activeIndex] : null;
  // tooltip 靠右会溢出容器，超过 62% 就翻到十字线左侧
  const tooltipFlipped = activeX !== null && activeX > VIEW_W * 0.62;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4 text-xs text-neutral-400">
        {SERIES_META.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ backgroundColor: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="w-full touch-none select-none focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-600"
          tabIndex={0}
          role="img"
          aria-label="价格走势图，含 MA7 和 MA30 均线，按左右方向键逐点查看数值"
          onPointerMove={(e) => setActiveIndex(nearestIndex(e.clientX))}
          onPointerLeave={() => setActiveIndex(null)}
          onKeyDown={handleKeyDown}
          onBlur={() => setActiveIndex(null)}
        >
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={VIEW_W - PAD.right}
                y1={yFor(tick)}
                y2={yFor(tick)}
                stroke={COLOR_GRID}
                strokeWidth="1"
              />
              <text
                x={PAD.left - 8}
                y={yFor(tick) + 3.5}
                textAnchor="end"
                fontSize="11"
                fill={COLOR_AXIS_TEXT}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {tick.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
              </text>
            </g>
          ))}

          {xLabelIndexes.map((i) => (
            <text
              key={i}
              x={xs[i]}
              y={VIEW_H - 8}
              textAnchor="middle"
              fontSize="11"
              fill={COLOR_AXIS_TEXT}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {formatTime(points[i].t, withTime)}
            </text>
          ))}

          <path
            d={buildPath(points, xs, yFor, (p) => p.ma30)}
            fill="none"
            stroke={COLOR_MA30}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d={buildPath(points, xs, yFor, (p) => p.ma7)}
            fill="none"
            stroke={COLOR_MA7}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d={buildPath(points, xs, yFor, (p) => p.price)}
            fill="none"
            stroke={COLOR_PRICE}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* 收尾点：带表面色描边圈，压在均线上也能看清 */}
          <circle
            cx={xs[xs.length - 1]}
            cy={yFor(last.price)}
            r="4"
            fill={COLOR_PRICE}
            stroke={COLOR_SURFACE}
            strokeWidth="2"
          />

          {activeX !== null && active && (
            <g>
              <line
                x1={activeX}
                x2={activeX}
                y1={PAD.top}
                y2={PAD.top + PLOT_H}
                stroke="#52514e"
                strokeWidth="1"
              />
              <circle
                cx={activeX}
                cy={yFor(active.price)}
                r="4"
                fill={COLOR_PRICE}
                stroke={COLOR_SURFACE}
                strokeWidth="2"
              />
            </g>
          )}
        </svg>

        {active && activeX !== null && (
          <div
            className="pointer-events-none absolute top-3 z-10 rounded border border-neutral-700 bg-neutral-900/95 px-3 py-2 text-xs shadow-lg"
            style={{
              left: `${(activeX / VIEW_W) * 100}%`,
              transform: tooltipFlipped ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
            }}
          >
            <div className="mb-1 text-neutral-500">{formatTime(active.t, true)}</div>
            {SERIES_META.map((s) => {
              const value = active[s.key];
              if (value === null) return null;
              return (
                <div key={s.key} className="flex items-center gap-2">
                  <span
                    className="inline-block h-0.5 w-3 rounded"
                    style={{ backgroundColor: s.color }}
                  />
                  <span
                    className="font-semibold text-neutral-100"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    ¥{value.toFixed(2)}
                  </span>
                  <span className="text-neutral-500">{s.label}</span>
                </div>
              );
            })}
            {active.volume !== null && (
              <div className="mt-1 text-neutral-500">在售 {active.volume.toLocaleString("zh-CN")}</div>
            )}
          </div>
        )}
      </div>

      <details className="text-xs text-neutral-400">
        <summary className="cursor-pointer select-none text-neutral-500 hover:text-neutral-300">
          查看数据表格
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto rounded border border-neutral-800">
          <table className="w-full" style={{ fontVariantNumeric: "tabular-nums" }}>
            <thead className="sticky top-0 bg-neutral-900 text-neutral-500">
              <tr>
                <th className="px-3 py-2 text-left font-normal">时间</th>
                <th className="px-3 py-2 text-right font-normal">价格</th>
                <th className="px-3 py-2 text-right font-normal">MA7</th>
                <th className="px-3 py-2 text-right font-normal">MA30</th>
                <th className="px-3 py-2 text-right font-normal">在售量</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/60">
              {[...points].reverse().map((p) => (
                <tr key={p.t}>
                  <td className="px-3 py-1.5">{formatTime(p.t, true)}</td>
                  <td className="px-3 py-1.5 text-right">{p.price.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-right">{p.ma7?.toFixed(2) ?? "-"}</td>
                  <td className="px-3 py-1.5 text-right">{p.ma30?.toFixed(2) ?? "-"}</td>
                  <td className="px-3 py-1.5 text-right">{p.volume?.toLocaleString("zh-CN") ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
