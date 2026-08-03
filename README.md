# CS2 皮肤交易决策助手

帮 CS2 皮肤投资者决策"什么时候卖、什么时候买"的个人工具。数据驱动的买卖建议 + 自然语言理由，不做自动交易——交易永远由用户手动执行。

表面是持仓/观察池/信号看板，真正目标是训练一套能识别、最终能预测"操盘"的规则+统计模型（不碰深度学习，样本不够就不上 ML）。

## 技术栈

Next.js 16（App Router）+ TypeScript + better-sqlite3 + Tailwind CSS v4，数据源是 SteamDT/C5Game OpenAPI，理由生成用 NVIDIA NIM（免费 LLM API）。详细规范见 [CLAUDE.md](CLAUDE.md)。

## 本地开发

```bash
npm install
cp .env.local.example .env.local   # 没有这个文件就参考 CLAUDE.md「环境变量」一节手动建
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。开发环境默认不跑定时价格同步（`.env.development` 里 `PRICE_SYNC_DISABLED=1`），需要手动 `POST /api/sync` 触发，或者去 `/settings` 点"同步饰品目录"之类的手动同步按钮。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 本地开发服务器（3000 端口） |
| `npm run build` | 生产构建 |
| `npm run start` | 跑生产构建（配合 build） |
| `npm run lint` | ESLint |
| `npm run test` | Vitest 单元测试（`lib/signals/`、`lib/rules/` 强制要求覆盖） |

## 文档地图

这个仓库的文档不是"写完就不管"的静态说明，是每次开发会话都要读、要更新的工作文档：

- **[CLAUDE.md](CLAUDE.md)**（+ 引用的 [AGENTS.md](AGENTS.md)）—— 项目规范：目录结构、编码规范、Git 规范、开发优先级。**任何时候写代码前先读这个**，两个文件名是 Claude Code 工具约定识别的保留名，不要改名。
- **[HANDOFF.md](HANDOFF.md)** —— 交接文档：当前生产环境架构、部署流程、每次会话的变更摘要、踩过的坑（不要重复踩）。**给完全没有上下文的新会话看的现状文档**。
- **[PLAN.md](PLAN.md)** —— 路线图：分阶段（A 数据/标注 → B 检测 → C 预测 → D 产品化 → E 多用户）的任务拆解、进度、决策依据。
- **[HYPOTHESES.md](HYPOTHESES.md)** —— 特征假设库：**外部概念（股市技术分析、市场微观结构、行为金融、CS2 供给侧、项目所有者的经验剧本）进入这个项目的闸门**。每条按状态归档——已上线 / 已验证未上线 / 待验证 / 数据不足 / **已证伪** / 不适用。两条规矩：概念只能当假设来源不能当证据，进 `lib/signals`、`lib/rules` 必须过它第五节那七关（按标的算 AUC、剔退化样本、量纲归一、多重检验校正、效应量下限、阈值从回测反推、影子并行）；**已证伪的条目永远不删**，它们防的是几个月后有人（包括 AI）冒出同样的直觉再花一遍同样的时间。
- **[REPORT-manipulation-playbook-stages.md](REPORT-manipulation-playbook-stages.md)** —— 操盘剧本六阶段的数据验证报告（低位横盘/吸货/会员进场/洗盘/主拉升/出货）。
- **[REPORT-prediction-baseline.md](REPORT-prediction-baseline.md)** —— C1/C2 预测模型第一版基线报告，结论是不满足上线门槛，原因和下一步都写在里面。
- **[REPORT-bidding-depth-features.md](REPORT-bidding-depth-features.md)** —— 求购深度（挂单簿需求侧）特征验证，第一个统计上站得住的非价格特征。
- **[REPORT-t7-actionable-labels.md](REPORT-t7-actionable-labels.md)** —— T+7（交易保护新规下 7 天强制锁仓）约束下的可行动买卖标签验证。

生产环境是部署在 Oracle Cloud 的 Docker 容器，具体部署/更新流程见 HANDOFF.md「运行架构」一节，不要在这份 README 里重复维护，避免两处不同步。

## 不要做的事

- 不要自己训练 ML 模型；不要在组件里直接调用外部 API（必须走 `/api/` 路由）；不要把 API key 硬编码；不要一次塞太多功能。完整清单见 CLAUDE.md 底部。
