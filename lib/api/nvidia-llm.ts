const BASE_URL = process.env.NVIDIA_API_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
const API_KEY = process.env.NVIDIA_API_KEY ?? "";
// 用真实 key 实测过 deepseek-ai/deepseek-v4-flash 可用且免费。
const MODEL = process.env.NVIDIA_MODEL ?? "deepseek-ai/deepseek-v4-flash";

interface ILlmResult {
  data: string | null;
  error?: string;
}

interface IChatCompletionResponse {
  choices: { message: { content: string } }[];
}

async function chatCompletionOnce(systemPrompt: string, userPrompt: string): Promise<ILlmResult> {
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.5,
        max_tokens: 300,
      }),
    });

    if (!res.ok) {
      return { data: null, error: `NVIDIA NIM 返回 HTTP ${res.status}` };
    }

    const json = (await res.json()) as IChatCompletionResponse;
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      return { data: null, error: "NVIDIA NIM 返回里没有 choices[0].message.content" };
    }
    return { data: content.trim() };
  } catch (err) {
    return {
      data: null,
      error: `NVIDIA NIM 请求失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// NVIDIA NIM 兼容 OpenAI chat completions 格式：POST {base}/chat/completions。
// 免费额度的 NIM 接口偶尔会短暂过载（HTTP 503）或网络抖动，失败了等一下重试一次；
// 真是配置错误（比如 401）重试也没用，但多等一次不会有额外副作用，不值得为了区分错误类型加复杂度。
async function chatCompletion(systemPrompt: string, userPrompt: string): Promise<ILlmResult> {
  const first = await chatCompletionOnce(systemPrompt, userPrompt);
  if (first.data) return first;

  await new Promise((resolve) => setTimeout(resolve, 800));
  return chatCompletionOnce(systemPrompt, userPrompt);
}

export async function generateTradeReason(input: {
  itemName: string;
  action: string;
  score: number;
  reasons: string[];
  recentPrices?: number[];
  changeTodayPercent?: number | null;
}): Promise<ILlmResult> {
  // 这里只是让 LLM 用人话描述"近期走势看起来怎样、什么时候买卖更合适"，
  // 本质还是基于规则引擎已经算出来的 score/reasons 做转述和外推，不是独立的预测模型。
  const systemPrompt =
    "你是 CS2 饰品交易顾问。根据给定的技术指标信号和近期价格走势，用简洁的中文做两件事：" +
    "1）说明当前操作建议的理由；2）判断近期走势可能怎么走，给一个买入或卖出时间窗口的建议" +
    "（比如「短期均线走弱，可以等价格再回落一些再考虑」）。" +
    "不超过 4 句话，不要逐字重复输入的数值，不要用免责声明式的套话。";

  const userPrompt = [
    `饰品：${input.itemName}`,
    `建议操作：${input.action}`,
    `信号强度 score：${input.score}`,
    `触发的信号：${input.reasons.join("；") || "无明显信号"}`,
    input.changeTodayPercent != null ? `今日涨跌：${input.changeTodayPercent.toFixed(2)}%` : null,
    input.recentPrices && input.recentPrices.length > 1
      ? `近7天价格序列（按时间从早到晚）：${input.recentPrices.map((p) => p.toFixed(2)).join(", ")}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return chatCompletion(systemPrompt, userPrompt);
}
