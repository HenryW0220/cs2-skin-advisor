export interface IVolumeAnomalyResult {
  isAnomaly: boolean;
  latestVolume: number;
  averageVolume: number;
  ratio: number; // latestVolume / averageVolume，historyAverage 为 0 时按 Infinity/0 处理
}

// 最新一期成交量相对历史均值的异动检测。window 是看多少期历史（不含最新一期），
// threshold 是超过历史均值多少倍算异动，默认 2 倍是经验值。
export function detectVolumeAnomaly(
  volumes: number[],
  options: { window?: number; threshold?: number } = {}
): IVolumeAnomalyResult | null {
  const window = options.window ?? 7;
  const threshold = options.threshold ?? 2;
  if (volumes.length < window + 1) return null;

  const latestVolume = volumes[volumes.length - 1];
  const history = volumes.slice(volumes.length - 1 - window, volumes.length - 1);
  const averageVolume = history.reduce((sum, v) => sum + v, 0) / history.length;
  const ratio =
    averageVolume === 0 ? (latestVolume > 0 ? Infinity : 0) : latestVolume / averageVolume;

  return {
    isAnomaly: ratio >= threshold,
    latestVolume,
    averageVolume,
    ratio,
  };
}
