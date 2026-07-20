# 交接文档（HANDOFF）

> 写给完全没有上下文的新会话。先读 CLAUDE.md（项目规范），再读这份（现状与坑），路线图在 PLAN.md。
> 最后更新：2026-07-20（B2 剧本验证已跑完一版；洗盘信号上线；求购深度数据开始入库；C1/C2 预测模型第一版已跑完，结论是不满足上线门槛，见下；待审核队列清零后复核了特征 AUC 和聚类，结论稳定未变）

## ⚠️ 运行架构（先搞懂再动服务）

- **常驻采集器**：生产构建跑在 **3210 端口**（`scripts/start-collector.cmd`，登录自启via启动文件夹，日志 `data/collector.log`），负责每小时价格同步+异常扫描+预警。**改了采集/扫描相关代码要 `npm run build` 后重启它**（杀 3210 进程再跑 start-collector.cmd），不然跑的是旧逻辑。
- **开发服务器**：3000 端口，`.env.development` 里 `PRICE_SYNC_DISABLED=1`，不做定时同步（避免双倍消耗 API 配额），只用于开发。
- 两进程共写 `data/db.sqlite`（WAL，同机多进程安全）。**Docker 未安装也不需要装**：Dockerfile/compose 已写好但只给将来部署 Linux 服务器用，Windows bind mount 下 SQLite 多进程写锁不可靠，本机别跑容器。

## 一、我们在做什么

CS2 皮肤交易决策助手（Next.js 16 + SQLite + Tailwind v4，本地单用户）。表面是持仓/观察池/信号看板，**真正目标：训练能识别、最终能预测"操盘"的模型**。业务地基（用户口述）：市场由拉盘主导；同收藏品上下级联动（上级被拉→下级炼金料跟涨）；用户有小道消息。策略：规则+统计攒标注，样本够了再上小模型（不碰深度学习）。全程交易由用户手动，系统只出信号和记录。

## 二、已完成（全部已 commit，PLAN.md 的 A2/A3/B3/B4/D2 已落地）

- **页面**：持仓（收益率/今日涨跌可排序，未填购入价的沉底）、观察池、饰品详情（SVG 走势图+嫌疑分）、异常审核 /anomalies、**交易流水 /ledger**
- **数据管道**：每小时同步+90 天 K 线回填（17万条）；扫描覆盖持仓+观察池；加观察池自动回填 90 天历史（无快照新品用 C5 兜底）
- **标注体系**：anomaly_events 三分类审核（确认操盘/外部事件/正常波动）+ manipulation_tags 操盘窗口（138 个，confidence=high 来自"已购=操盘"规则批量生成）+ item_metadata 收藏品/品质
- **检测与预警**：操盘嫌疑分 v1（特征/阈值来自真实标注 AUC 分析：24h波动率 0.72/24h涨跌 0.66/偏离均线 0.62；单小时尖峰 0.52 已排除）；嫌疑分≥60 自动预警（3天冷却）；同收藏品上级异动→下级联动预警（事件带 context）
- **交易流水（D2）**：库存同步发现资产消失→自动落卖出记录，卖价优先 C5 卖单匹配，匹配不到用户手填（选平台自动扣手续费：C5 1%/C5会员 0.5%/悠悠 1%，费率集中在 `lib/fees.ts`，gross 留档可重算）；月度已实现盈利。**6 月以来 5 笔已录全**（薇帕姐×3、阴谋者×4打包、喧嚣杀戮），合计盈利 ¥2852.36
- 备份：`data/backups/db-before-anomaly-review-20260717.sqlite`

## 三、当前卡在哪里

1. ~~212 条待审核异常~~ **已通过范围调整解决**：2026-07-20 确认 buy_price=0（开箱所得、购入渠道未知）的持仓不需要人工判断是不是操盘——用户没内幕消息根本没法判断。已把这类持仓从追踪范围里整体排除（`lib/tracked-items.ts`），/anomalies 页面默认也不展示这类饰品的待审核事件（数据库不删，只是不展示）。**现状：剩余待审核清零**（当时用户手动清了一批到 120 条，全部集中在 buy_price=0 品种，过滤后可见数为 0）。以后异常扫描/K线回填/价格同步的追踪范围只剩持仓里 buy_price>0 的（56 个）+ 观察池（1 个），同步的饰品数从 121 砍到 57，SteamDT 配额压力也缓解了（同一轮同步错误数从 21 降到 0）。
2. **联动特征（coMove）区分度仍验证不出来，但机制已证实**：2026-07-20 用户补充了两组收藏品配对案例（手套收藏品：喧嚣杀戮+3下级；"激流大行动"收藏品：抽象派+2下级凑上已有的彼岸花），标记数 141→162，加进观察池（watchlist id 8-14）。查实喧嚣杀戮和 USP-S 次时代确实在同一小时（2026-05-22T04:00）一起异动——机制是对的，但重跑 AUC 只从 0.500 涨到 0.507，样本量还不够，需要更多轮这样的补充。
3. ~~成交量数据薄~~ **已部分解决（见下）**：SteamDT 批量/单品价格接口一直有返回求购价/求购数（`biddingPrice`/`biddingCount`），之前同步代码只存了在售数，求购这一侧被白白丢弃——不用新调研数据源，2026-07-20 已把这两个字段接进 `price_snapshots`（迁移 `013_add_bidding_depth.sql`），从这次重启起开始积累。C5 直连价格没有求购数据，这两列在 platform='C5' 的行固定是 null；K线回填的历史数据也没有（K线本身不带量），所以求购深度只能从现在开始往后攒，补不了历史。挂单深度调研仍然有缺口：这只是"求购"一侧，"在售"侧的深度（不同价位挂了多少单）还是没有，且这只是 SteamDT 聚合平台（BUFF/YOUPIN/STEAM 等），不是 C5 挂单簿。

## 四、下一步计划（按优先级）

1. **B2 操盘剧本验证第一版已产出**：`scripts/analyze-playbook-stages.mjs` + `REPORT-B2.md`。结论：低位横盘（占比最大）、洗盘/砸盘（深回撤>15%接急拉，指纹清晰）、主拉升（急拉簇，涨速12.69%/天中位数，指纹清晰）三段能验证；吸货期和单纯横盘价格形态上分不开、会员进场看不见、出货期没有独立于普通回调的指纹——三个都卡在缺量/挂单数据。**洗盘指纹已实现上线**：`lib/signals/washout.ts`，接入 `lib/anomaly-scan.ts`，新增 `washout_signal` 异常类型（提示性质，独立冷却，不触发联动预警）。
2. **求购深度数据已开始积累**（2026-07-20 起）：等攒够几周数据后，重跑 `analyze-manipulation-features.mjs`/`analyze-playbook-stages.mjs` 时把 `bidding_count`/`bidding_price` 加进特征候选，看能不能补上吸货期/出货期指纹——这是之前卡住的地方，现在有数据来源了，缺的是时间。
3. ~~待审核队列已清零（见上）→ 现在随时可以重跑 `scripts/analyze-manipulation-features.mjs` 校准嫌疑分阈值 + 验证 coMove；episode 数变多后重跑 `analyze-playbook-stages.mjs` 让三个簇的边界更稳~~ **已重跑（2026-07-20）**：两个脚本的结论都稳定，不需要改阈值。`analyze-manipulation-features.mjs`——vol24h/move24h/maDev 三个特征的中位数和 AUC 几乎和首次校准时（`lib/signals/manipulation-score.ts` 注释里那版）一模一样（AUC 0.72/0.66/0.63 vs 首版 0.72/0.66/0.62），coMove 还是 0.507，没进一步移动。`analyze-playbook-stages.mjs`——episode 139→162（+21%），段落 1449→1829，k=6 聚类的崩跌/急拉/横盘三簇量级和首版基本吻合（详见 REPORT-B2.md 复核记录），`washout.ts` 里 15%/2% 的阈值继续有效。**结论：不是"没跑"，是跑了没变化——几天的数据增量还不足以移动这些统计量，要看到显著变化大概率得等 coMove 那类样本更稀疏的特征攒够更长时间。**注意 buy_price=0 的开箱品从这次起不再新增快照，用它们做特征分析时数据会在 2026-07-20 之后断档，历史数据不受影响
4. **C1/C2 预测模型第一版已跑完**：`scripts/build-prediction-baseline.mjs` + `REPORT-C1-C2.md`。逻辑回归名义上打赢了随机基准和 coMove 规则基准，**但不满足上线门槛**——候选池不是全市场随机样本（narrow/full 两套池对比直接量化了这个偏差）、规则基准本身在当前标注下是废的、最关键的是模型分不清"操盘"和"外部事件"（给版本更新等外部事件打的分几乎跟真实操盘一样高）。下一步要等全市场候选池、求购深度数据积累、能分开操盘/外部事件的特征后再重跑，C3 回测在这些问题解决前没意义。
5. **coMove 验证需要更多轮收藏品配对补充**（见上第2条）：用户手头如果还记得别的"同收藏品多个饰品都被拉过"的案例，随时可以再报，标记数越多、越集中在少数几个收藏品里，AUC 才会有统计意义地移动。
6. **D3 产品化第一版已完成（2026-07-20）**：PWA（`app/manifest.ts` + `public/sw.js` + `app/icon-192`/`app/icon-512`/`app/apple-icon.tsx`，图标用 `next/og` 的 `ImageResponse` 生成，没有额外美术资源）+ Web Push（`web-push` 库，VAPID 密钥在 `.env.local`）。订阅管理在新页面 `/settings`。推送订阅存 `push_subscriptions` 表（迁移 `014_add_push_subscriptions.sql`）。目前只接了两类高优先级信号：`lib/anomaly-scan.ts` 里嫌疑分预警（≥60）和同收藏品联动预警触发时会推送；z-score/成交量/洗盘这些事件型或提示型信号故意没接，太密会被当骚扰关掉通知。逃顶信号（D1）、预测高分（C3）还没做，做出来后要在 `scanForAnomalies` 里补进 `pushNotifications`。`scanForAnomalies` 从同步函数改成了异步（要 `await sendPushNotification`）——**已重启常驻采集器验证生效（2026-07-20）**。

## 五、踩过的坑——绝对不要再踩

**标注/业务语义（搞错污染训练集）**
1. `buy_price>0` = 用户凭操盘消息买入（饰品级操盘标签）；`=0` = 开箱，未知。已按此批量标注过。
2. Souvenir MP7 | Tall Grass 是外部事件（5-22 纪念品可炼金更新），用户明确判断过，别被规则误翻。
3. 2026-05-22 Valve 更新两件事：纪念品可炼金（廉价纪念品暴涨）+ 取消印花胶囊（旧 Major 印花绝版重定价，前两周板块抢跑）。外部事件必须写明事由。
4. 操盘标记必须带时间窗口；¥0.5 以下低价品波动特征虚高（最小报价单位）。
5. **流水的价格都是单件价**（quantity>1 的打包出售要除以数量再入库），sell_price 是扣完手续费的净价，gross 留档。

**外部 API 实测（文档全不可信）**
6. SteamDT kline `type=1` 是 90 天滚动小时线（2160 条）非日线，无量，platform 参数有效；鉴权 `Authorization: Bearer`；batch 上限 100 名；限流 4005。
6b. SteamDT 价格接口（单品/批量）一直有返回 `biddingPrice`/`biddingCount`（求购价/求购数），之前只用了 `sellPrice`/`sellCount`，这两个字段被平白丢弃了一个月——加新特征前先看现有接口返回里有没有已经在拉但没存的字段，不要默认"没有就得调研新数据源"。
7. Steam 库存 count 上限 2000（超了 400），last_assetid 翻页；**任何一页失败必须整体报错**（同步按"不在=已卖"删行+落流水，半份列表会误删误记）。
8. ByMykel API：skins_not_grouped 才有 market_hash_name，skins.json 才有 collections/rarity，skin_id join；collections/crates 字段可缺省。
9. C5 卖单接口 status 枚举文档没写清（代码里试 2/3/4）；实测用户真实卖出也常匹配不到价（可能在悠悠出的），留 NULL 手填是常态。

**工程**
10. **数据库迁移只在进程启动时跑**：加 migration 必须重启 dev server（采集器要重 build+重启）。重启后用户浏览器旧标签页点导航会 404——让用户 Ctrl+F5，不是代码坏了。
11. Next 16：无 `next lint`（用 npm run lint）；params/searchParams 是 Promise；**无 searchParams 的页面会被生产构建静态预渲染成死数据，要 `export const dynamic = "force-dynamic"`**（/anomalies、/ledger 都踩过）。
12. JSX 中文文案用中文引号（react/no-unescaped-entities）；一次性脚本用 .mjs 放 scripts/（node 跑不了 lib 的 .ts）。
13. **schtasks 计划任务要管理员权限**，被拒就用启动文件夹（register-collector-task.ps1 已做兜底）；**.ps1 带中文必须 UTF-8 BOM**，不然 PowerShell 5.1 按 ANSI 读直接语法炸。**.cmd/.bat 反过来——中文注释千万别存 UTF-8（哪怕带 BOM 也不行,cmd.exe 批处理解析器不吃）**，`cmd.exe` 按系统 GBK 代码页读会把整个文件读乱，报一串跟内容毫不相关的"'x' 不是内部或外部命令"，`start-collector.cmd` 已经踩过、改成纯 ASCII 注释修好了（2026-07-20）。
14. PowerShell 里跑带复杂引号的 `node -e` 会解析炸，用 Bash 工具跑。
15. `.env*` 被 gitignore，非敏感的 .env.development 要 `git add -f`。
16. Commit 规范：`type(scope): 中文描述`，不准出现 claude/AI 字样，按模块拆且每个 commit 可独立构建；涨=红跌=绿。
17. 操盘标记/流水是喂模型和记账的，UI 从简（操盘标记列已按用户要求从持仓页移除，别加回去）。

*持久记忆存了第 1、3 条的摘要，交接以本文档为准。*
