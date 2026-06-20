const BASE_URL = process.env.NVIDIA_API_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
const API_KEY = process.env.NVIDIA_API_KEY ?? "";
// 具体用哪个免费模型 CLAUDE.md 里没定下来，这个 id 没有用真实 key 验证过，
// 拿到 key 之后第一次调用要确认这个模型在 NVIDIA NIM 目录里确实可用、确实免费。
const MODEL = process.env.NVIDIA_MODEL ?? "meta/llama-3.1-8b-instruct";

interface ILlmResult {
  data: string | null;
  error?: string;
}

interface IChatCompletionResponse {
  choices: { message: { content: string } }[];
}

// NVIDIA NIM 兼容 OpenAI chat completions 格式：POST {base}/chat/completions。
async function chatCompletion(systemPrompt: string, userPrompt: string): Promise<ILlmResult> {
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

export async function generateTradeReason(input: {
  itemName: string;
  action: string;
  score: number;
  reasons: string[];
}): Promise<ILlmResult> {
  const systemPrompt =
    "你是 CS2 饰品交易顾问，根据给定的技术指标信号，用简洁的中文向用户解释为什么给出这个建议。" +
    "不超过 3 句话，不要重复输出指标原始数值，用自然语言转述。";
  const userPrompt = [
    `饰品：${input.itemName}`,
    `建议操作：${input.action}`,
    `信号强度 score：${input.score}`,
    `触发的信号：${input.reasons.join("；") || "无明显信号"}`,
  ].join("\n");

  return chatCompletion(systemPrompt, userPrompt);
}
