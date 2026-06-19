// 连续补充的令牌桶，用来限制对外部 API 的请求速率（QPS/QPM）。
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly maxTokens: number,
    private readonly windowMs: number
  ) {
    this.tokens = maxTokens;
    this.lastRefillAt = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillAt;
    const refillRatePerMs = this.maxTokens / this.windowMs;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsedMs * refillRatePerMs);
    this.lastRefillAt = now;
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
