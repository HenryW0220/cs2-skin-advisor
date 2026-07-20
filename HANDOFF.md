# 交接文档（HANDOFF）

> 写给完全没有上下文的新会话。先读 CLAUDE.md（项目规范），再读这份（现状与坑），路线图在 PLAN.md。
> 最后更新：2026-07-20

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

1. **~212 条待审核异常等用户判断**（含新的嫌疑分/联动预警），集中在 buy_price=0 开箱品；千瓦收藏品 7 品、手套收藏品 4 品联动嫌疑最大。这是 B2 和模型校准的前置条件。
2. **联动特征（coMove）区分度验证不了**：已标注品多为印花（无收藏品结构），等上面标完。
3. **成交量数据薄**：K线无量，只有小时同步的在售数在攒；挂单深度类数据源还没调研（PLAN A2 遗留）。

## 四、下一步计划（按优先级）

1. 用户清完待审核 → 重跑 `scripts/analyze-manipulation-features.mjs` 校准嫌疑分阈值 + 验证 coMove
2. **B2 操盘剧本验证**（核心）：用户给的六阶段剧本（低位横盘→吸货→会员进场→砸盘洗盘→主拉→出货）逐段做特征画像，先无监督变点切段再对照剧本命名（防循环论证）。产出喂两头：吸货期指纹=买点预测特征，出货期指纹=逃顶信号
3. C 阶段预测模型（逻辑回归起步，precision@top-K + 提前量，须胜过随机和纯规则两个笨基准）
4. D3 产品化：PWA + Web Push 推送（最终目标是电脑+手机 App）

## 五、踩过的坑——绝对不要再踩

**标注/业务语义（搞错污染训练集）**
1. `buy_price>0` = 用户凭操盘消息买入（饰品级操盘标签）；`=0` = 开箱，未知。已按此批量标注过。
2. Souvenir MP7 | Tall Grass 是外部事件（5-22 纪念品可炼金更新），用户明确判断过，别被规则误翻。
3. 2026-05-22 Valve 更新两件事：纪念品可炼金（廉价纪念品暴涨）+ 取消印花胶囊（旧 Major 印花绝版重定价，前两周板块抢跑）。外部事件必须写明事由。
4. 操盘标记必须带时间窗口；¥0.5 以下低价品波动特征虚高（最小报价单位）。
5. **流水的价格都是单件价**（quantity>1 的打包出售要除以数量再入库），sell_price 是扣完手续费的净价，gross 留档。

**外部 API 实测（文档全不可信）**
6. SteamDT kline `type=1` 是 90 天滚动小时线（2160 条）非日线，无量，platform 参数有效；鉴权 `Authorization: Bearer`；batch 上限 100 名；限流 4005。
7. Steam 库存 count 上限 2000（超了 400），last_assetid 翻页；**任何一页失败必须整体报错**（同步按"不在=已卖"删行+落流水，半份列表会误删误记）。
8. ByMykel API：skins_not_grouped 才有 market_hash_name，skins.json 才有 collections/rarity，skin_id join；collections/crates 字段可缺省。
9. C5 卖单接口 status 枚举文档没写清（代码里试 2/3/4）；实测用户真实卖出也常匹配不到价（可能在悠悠出的），留 NULL 手填是常态。

**工程**
10. **数据库迁移只在进程启动时跑**：加 migration 必须重启 dev server（采集器要重 build+重启）。重启后用户浏览器旧标签页点导航会 404——让用户 Ctrl+F5，不是代码坏了。
11. Next 16：无 `next lint`（用 npm run lint）；params/searchParams 是 Promise；**无 searchParams 的页面会被生产构建静态预渲染成死数据，要 `export const dynamic = "force-dynamic"`**（/anomalies、/ledger 都踩过）。
12. JSX 中文文案用中文引号（react/no-unescaped-entities）；一次性脚本用 .mjs 放 scripts/（node 跑不了 lib 的 .ts）。
13. **schtasks 计划任务要管理员权限**，被拒就用启动文件夹（register-collector-task.ps1 已做兜底）；**.ps1 带中文必须 UTF-8 BOM**，不然 PowerShell 5.1 按 ANSI 读直接语法炸。
14. PowerShell 里跑带复杂引号的 `node -e` 会解析炸，用 Bash 工具跑。
15. `.env*` 被 gitignore，非敏感的 .env.development 要 `git add -f`。
16. Commit 规范：`type(scope): 中文描述`，不准出现 claude/AI 字样，按模块拆且每个 commit 可独立构建；涨=红跌=绿。
17. 操盘标记/流水是喂模型和记账的，UI 从简（操盘标记列已按用户要求从持仓页移除，别加回去）。

*持久记忆存了第 1、3 条的摘要，交接以本文档为准。*
