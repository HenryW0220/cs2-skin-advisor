@AGENTS.md

# CLAUDE.md — CS2 皮肤交易决策助手

> 这个文件是给 Claude Code 读的项目说明书。每次写代码前要先读完这个文件。

---

## 项目目标

帮助 CS2 皮肤投资者决策"什么时候卖、什么时候买"。
核心价值：**数据驱动的建议 + 自然语言的理由**，不做自动交易。

未来计划公开给其他用户使用，所以代码要干净、可维护。

---

## 技术栈

- **框架**：Next.js 15 (App Router) + TypeScript
- **数据库**：better-sqlite3（SQLite 本地文件）
- **样式**：Tailwind CSS v4
- **包管理**：npm
- **数据源**：SteamDT OpenAPI（K线、报价、成交量）、C5Game OpenAPI（库存、订单）
- **LLM**：NVIDIA NIM API（免费，兼容 OpenAI SDK 格式）

---

## 目录结构规范

严格遵守以下结构，不要随意新增顶层目录：

```
/
├── app/                    # Next.js App Router
│   ├── api/                # API 路由（每个功能一个子目录）
│   ├── (dashboard)/        # 主要页面页面组
│   └── layout.tsx
├── lib/                    # 纯逻辑，无 React 依赖
│   ├── db/                 # 数据库操作（每张表一个文件）
│   ├── api/                # 外部 API 封装
│   │   ├── steamdt.ts      # SteamDT API
│   │   ├── c5.ts           # C5Game API
│   │   └── nvidia-llm.ts   # NVIDIA NIM LLM 调用
│   ├── signals/            # 技术指标计算（MA、RSI、成交量）
│   ├── rules/              # 规则引擎（决策逻辑）
│   └── types.ts            # 全局 TypeScript 类型
├── components/             # React UI 组件
│   ├── ui/                 # 基础组件（Button、Badge、Card 等）
│   └── features/           # 功能组件（InventoryTable、WatchlistPanel 等）
├── prisma/ 或 db/schema.sql # 数据库 schema
├── scripts/                # 一次性脚本（数据迁移、种子数据等）
├── data/                   # 本地缓存数据文件（.gitignore 排除内容）
└── .env.local              # 环境变量（不提交 git）
```

---

## 编码规范

### 通用原则
- 所有文件用 TypeScript，不写 `.js` 文件（除配置文件外）
- 函数优先：避免过深的类继承
- 每个函数只做一件事，超过 50 行考虑拆分
- 错误处理：所有外部 API 调用必须有 try/catch，失败返回 `{ error: string }` 而非抛出

### 命名规范
- 文件名：kebab-case（`steam-dt.ts`、`inventory-table.tsx`）
- 函数/变量：camelCase
- 类型/接口：PascalCase（接口以 `I` 开头，如 `IInventoryItem`）
- 常量：UPPER_SNAKE_CASE

### API 路由规范
- 每个路由文件只导出 `GET`、`POST` 等 HTTP 方法函数
- 统一返回格式：`{ data: T, error?: string }`
- 不在 API 路由里写业务逻辑，调用 `lib/` 里的函数

### 数据库规范
- 所有数据库操作封装在 `lib/db/` 里，页面和 API 路由不直接写 SQL
- 每张表对应一个文件，如 `lib/db/inventory.ts`、`lib/db/snapshots.ts`
- Schema 变更存放在 `db/migrations/` 里，带时间戳命名（`001_init.sql`、`002_add_watchlist.sql`）
- 数据库连接必须是全局单例（用模块级缓存或 `globalThis` 持有连接），否则 Next.js dev 模式热重载会反复打开连接，导致 `database is locked` 报错

### 测试规范
- `lib/signals/`（技术指标）和 `lib/rules/`（买卖判断）必须有单元测试——这两块算错了会直接影响真实交易决策
- 其他模块的测试按需添加，不强制要求覆盖率

### 注释规范
- 注释解释"为什么"，不解释"是什么"——变量/函数名本身要能说明在做什么，重复一遍代码逻辑的注释不要写
- 导出的函数（尤其是 `lib/signals/`、`lib/rules/`、`lib/api/` 里的）用 JSDoc 写清楚：参数含义、返回值、隐藏的前提条件或单位（如"价格单位是分还是元"、"RSI 周期是 14 天"）
- 非显而易见的业务规则（如规则引擎里某个阈值为什么是这个数字、为什么要排除某种饰品）必须写明依据来源，方便几个月后回来看还能懂
- 不要保留注释掉的代码——要删的代码直接删，git 历史里能找回来
- 不要写"修改记录"类注释（如 `// 2024-01 改成这样` ），这类信息属于 git commit，不属于代码
- TODO 注释要带上下文，不要只写 `// TODO`，至少说明要做什么、为什么现在没做

---

## 核心数据流

```
SteamDT API → 价格快照（price_snapshots 表）
     ↓
lib/signals/ → 计算 MA7、MA30、RSI14、成交量异常
     ↓
lib/rules/ → 规则引擎输出 action（SELL/TRIM/HOLD/WATCH）+ score
     ↓
lib/api/nvidia-llm.ts → 把 signals + action 转成自然语言理由
     ↓
Dashboard 展示
```

---

## 环境变量

```ini
# C5Game
C5_APP_KEY=
C5_API_BASE_URL=https://openapi.c5game.com

# SteamDT
STEAMDT_APP_KEY=
STEAMDT_API_BASE_URL=https://open.steamdt.com

# NVIDIA NIM（免费 LLM）
NVIDIA_API_KEY=
NVIDIA_API_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=deepseek-ai/deepseek-v4-flash

# Steam 官方 Web API（用来导入库存，库存接口本身不需要 key，只在确认账号身份时用到 ResolveVanityURL）
STEAM_API_KEY=
STEAM_USER_ID=

# 开发模式
USE_MOCK=false
```

---

## Git 规范

**Commit 格式**（不要让 AI 自动生成随机 commit message）：

```
<type>(<scope>): <描述>

type: feat | fix | refactor | docs | chore
scope: db | api | ui | signals | rules | llm

例子：
feat(signals): 添加 RSI14 计算函数
fix(api): 修复 SteamDT 批量请求超时问题
refactor(ui): 拆分 InventoryTable 为子组件
```

---

## 开发优先级（按顺序）

1. **Phase 1 — 数据库基础**
   - [x] 项目初始化（Next.js + TypeScript + Tailwind）
   - [x] 数据库 schema（inventory、price_snapshots、watchlist）
   - [x] SteamDT API 封装（单品价格、批量价格、K线、7天均价）
   - [x] C5 API 封装（库存列表、卖家订单列表、价格查询）
   - [x] 数据刷新策略：手动触发 `POST /api/sync`，遍历持仓+观察池里的饰品拉取价格并写入 price_snapshots
   - [x] Steam 官方库存自动导入（`POST /api/inventory/import-steam`，按 marketHashName 去重，成本价未知先填 0，需要手动 PATCH 改成真实购入价）

2. **Phase 2 — 信号与规则**
   - [x] 技术指标计算（MA7/30、RSI14、成交量异常）
   - [x] 规则引擎（输出 SELL/TRIM/HOLD/WATCH + score，权重是经验值，跑一段时间后需要回来调）
   - [x] 跨平台价差计算（C5 vs Steam）

3. **Phase 3 — LLM 理由生成**
   - [x] NVIDIA NIM API 封装（用真实 key 实测确认 deepseek-ai/deepseek-v4-flash 可用且免费）
   - [x] 把信号 prompt 化，生成中文建议理由
   - [x] 理由缓存（落库 reason_cache 表，按饰品+action+score+日期做 key）

4. **Phase 4 — Dashboard UI**
   - [ ] 持仓总览页（/positions）
   - [ ] 观察池页（/watchlist）
   - [ ] 饰品详情页（价格走势图）

5. **Phase 5 — 多用户支持**（公开给他人用时再做）
   - [ ] 用户认证
   - [ ] PostgreSQL 迁移
   - [ ] 部署配置

---

## 不要做的事

- ❌ 不要自己训练 ML 模型（数据量不够，耗时长，性价比低）
- ❌ 不要在组件里直接调用外部 API（必须通过 `/api/` 路由）
- ❌ 不要把 API key 硬编码在代码里
- ❌ 不要一次写太多功能，按 Phase 顺序来
- ❌ 不要随意安装新依赖，先问是否有必要
- ❌ Commit message 不要用 "feat: update" 这种没意义的描述
- ❌ Commit message 不要包含 "claude"、"Claude"、"AI generated" 等字样，所有提交看起来应该像人写的
