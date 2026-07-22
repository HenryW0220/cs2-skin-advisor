# 交接文档（HANDOFF）

> 写给完全没有上下文的新会话。先读 CLAUDE.md（项目规范），再读这份（现状与坑），路线图在 PLAN.md。
> 最后更新：2026-07-22（**运维补课，处理了 07-21 记录的两个待办之一 + 新增数据库备份**：①云端 VM 公网 IP 转成了 OCI Reserved Public IP（原地转换，地址 `170.9.25.139` 没变），HTTPS/PWA/推送不再受实例 stop/start 影响；②云端数据库此前完全没有备份，加了 `scripts/backup-db.sh`（用 better-sqlite3 在线备份 API，不阻塞写入，cron 每天 03:00 UTC 跑，保留最近7天+每周日份留8周）+ 本机 Windows 计划任务 `CS2-CloudBackupPull`（每天 21:00 本地时间把云端最新备份拉一份到本机做异地冗余，云端和本机备份都存在同一台机器丢失时会一起丢，两边都留一份才是真的冗余）。细节见"运行架构"一节。)
>
> 2026-07-21 晚间（**云端迁移后第一次验收 + 部署稳定性/性能一批修复**：验收 Docker 迁移后的第一夜同步（无断档、无限流报错、求购数据正常入库），过程中发现 Basic Auth 的 `middleware.ts` 在服务器上是从没进过 git 的游离文件、本机 master 还有 2 个 commit 从没推到 origin/main——已推送 + 把 `middleware.ts` 收编进 git，现在本机/origin/云端三边一致；补了 **HTTPS**（Caddy 反代 + `sslip.io` 免费域名 + Let's Encrypt，公网只留 80/443，`3210` 端口收回只给本机），手机 PWA 安装和 Web Push 都要求真实证书，裸 HTTP+IP 之前是装不上的；发现并修复了手机端导航栏、持仓页统计卡片因为中文没有天然折行点、窄屏被挤成竖排单字的 UI bug；发现并修复了持仓/观察池页面的严重性能问题——同一个饰品一次页面渲染被重复查了 3~6 次同一张表，两次小时同步之间的重复页面渲染也一样重新查库，271 件持仓的 `/positions` 页面首字节耗时从 11-18 秒压到稳定 2-3 秒（`/watchlist` <1.3 秒）。细节见"运行架构"一节和第五节新增第 21-25 条踩坑）
>
> 2026-07-21 深夜（**生产环境从本机 Windows 迁到 Oracle Cloud（Always Free VM + Docker）**，本机 Windows 常驻采集器已停用，改成开发环境；公网访问加了 Basic Auth 最低限度保护；细节见"运行架构"一节和第五节第19/20条踩坑记录。当天早些时候还做了：PLAN.md 里 A2/D3/M2 三处过时的 Docker 描述改成实际的 Windows 原生方案——**这条现在又反过来过时了，因为晚上确实部署了 Docker，不用再改，历史记录留着**；C1/C2 用真正的全市场随机候选池复核过，结论比原先更不乐观，见第四节第4条和 REPORT-C1-C2.md；T+7 可行动标签第一版跑完，抓到并修复了评估方法的真实bug，"别追涨"和"洗盘回撤"是目前最可靠的复现信号；追涨风险信号上线；buy_price=0 资产离开库存不再落流水）
>
> 2026-07-20 更新：B2 剧本验证已跑完一版；洗盘信号上线；求购深度数据开始入库；C1/C2 预测模型第一版已跑完，结论是不满足上线门槛，见下；待审核队列清零后复核了特征 AUC 和聚类，结论稳定未变；**D3 PWA+Web Push 第一版已上线**；修了 start-collector.cmd 的中文编码坑；核实了 2026-07-15 交易保护新规但判断不能直接拿来批量改标注，理由见第五节

## ⚠️ 运行架构（先搞懂再动服务，2026-07-21 有重大变化）

**常驻采集器已经从本机搬到云端，本机 Windows 现在只是开发环境。**

- **生产环境**：Oracle Cloud Always Free 一台 Ubuntu 24.04 VM（`VM.Standard.E2.1.Micro`，1核1GB+4GB swap，region us-sanjose-1），跑 Docker（`docker compose up -d --build`，用仓库根目录的 `Dockerfile`/`docker-compose.yml`），容器 `restart: unless-stopped` + Docker daemon 开机自启（`systemctl enable docker`），VM 重启/容器崩溃都会自动拉起来，不依赖本机开不开机。
  - SSH 访问：私钥在本机 `~/.ssh/oracle_cs2_deploy`，`~/.ssh/config` 里配了别名，直接 `ssh cs2-cloud` 就能连上（IP/密码等具体连接信息不写进这份文档——这个仓库是公开的，别把访问凭证提交进 git）。
  - **部署/更新流程**：改完代码 → 本机 commit → `git push origin master:main`（远端默认分支是 `main`，本机开发一直用的是 `master`，push 时注意分支名要对上，见下方踩坑记录）→ `ssh cs2-cloud` 上 `cd ~/cs2-skin-advisor && git pull origin main && sudo docker compose up -d --build`。1GB内存机器编译一次 Next.js 大概 4-8 分钟（第一次全新build更久，后面有 Docker layer 缓存会快一些）。
  - **公网访问加了 Basic Auth**（`middleware.ts`，读 `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` 环境变量，服务器 `.env.local` 里配的，本机 `.env.local` 没配这两个变量所以本机开发不受影响不会被锁）。这是最低限度的保护——项目本身没有登录体系，公网IP+没鉴权=任何人能看到持仓/策略/交易记录，Basic Auth 只是先堵上最基本的暴露，不是正经的账号系统，以后真要多人用还是得做真的登录。
  - **HTTPS（2026-07-21 补）**：VM 上装了 [Caddy](https://caddyserver.com)（`sudo systemctl status/restart caddy`，配置在 `/etc/caddy/Caddyfile`，**这个文件不在 git 仓库里，是直接在服务器上写的**），反代到 `localhost:3210`，域名用免费的 [sslip.io](https://sslip.io) 魔法域名 `170-9-25-139.sslip.io`（IP 编码进域名，自动解析到这台 VM，不用买域名），证书是 Let's Encrypt 自动签发/续期的真实受信任证书。访问地址变成 `https://170-9-25-139.sslip.io/`。**`3210` 端口已经从公网收回**（本机 iptables + OCI Security List 两层都删了这条规则），只留 80（跳转用）和 443，防止绕过 Caddy 走明文访问泄露 Basic Auth 密码。手机装 PWA、订阅 Web Push 都必须用这个新 HTTPS 地址——旧的 `http://IP:3210` 书签和已订阅的推送不会自动跟过来（Service Worker 按 origin 算），得重新访问、重新订阅。**2026-07-22 已把 `170.9.25.139` 转成 OCI 的 Reserved Public IP**（OCI 控制台：Compute → Instances → 实例 → Attached VNICs → 对应 VNIC → IP administration 标签页 → 该 Public IP 的 `⋯` 菜单 → Reserve IPv4 address，原地转换不改地址值），实例 stop/start 不会再丢这个 IP，域名/证书的这条风险已解除。
  - 数据库：`data/db.sqlite` 是 2026-07-21 一次性从本机拷贝过去的快照，之后云端自己独立积累。**本机的常驻采集器已经停用**（进程杀掉、开机自启文件夹里的 `.cmd` 改名成 `.disabled-moved-to-cloud` 禁用了，想切回本机运行就把后缀去掉），避免本机和云端各自采集出两份不同步的数据。
  - **数据库备份（2026-07-22 新增，此前云端完全没有备份）**：`scripts/backup-db.sh`（仓库根目录，`chmod +x` 后已放进云端 VM 的 crontab，`crontab -l` 能看到 `0 3 * * *` 这条）——用 better-sqlite3 的 `db.backup()` 在线备份 API（SQLite Online Backup，不停容器不阻塞写入），备份文件落在 `data/backups/`（bind mount，宿主机和容器都能看到），gzip 压缩，保留策略：7天内每天一份，超过7天只留每周日那份、留够8周，更老的自动删。**本机再加一层异地冗余**：`scripts/pull-cloud-backup.ps1` + Windows 计划任务 `CS2-CloudBackupPull`（每天本地时间 21:00 触发，`schtasks /Query /TN CS2-CloudBackupPull` 能查状态），把云端当天的备份 scp 拉一份到本机 `data/backups/cloud-db-*.sqlite.gz`，本机只留最近14天。**注意**：这套本机计划任务依赖 SSH 免密（`~/.ssh/oracle_cs2_deploy` + `~/.ssh/config` 的 `cs2-cloud` 别名）和本机开机联网，不是强保证，是云端 cron 备份之外的第二道保险，不是替代。
- **本机开发服务器**：3000 端口，`npm run dev`，`.env.development` 里 `PRICE_SYNC_DISABLED=1` 不做定时同步。本机的 `data/db.sqlite` 现在是部署那一刻的旧快照，会跟云端持续分叉——**本机这份数据库以后只用来看历史/跑一次性分析脚本，不代表当前真实状态，真实数据以云端为准**。
- Dockerfile/docker-compose.yml 原本注释写着"只给将来部署Linux服务器用"——现在这个"将来"已经发生了，注释里的判断已经落地，不用再改。

## 一、我们在做什么

CS2 皮肤交易决策助手（Next.js 16 + SQLite + Tailwind v4，本地单用户）。表面是持仓/观察池/信号看板，**真正目标：训练能识别、最终能预测"操盘"的模型**。业务地基（用户口述）：市场由拉盘主导；同收藏品上下级联动（上级被拉→下级炼金料跟涨）；用户有小道消息。策略：规则+统计攒标注，样本够了再上小模型（不碰深度学习）。全程交易由用户手动，系统只出信号和记录。

## 二、已完成（全部已 commit，PLAN.md 的 A2/A3/B3/B4/D2 已落地）

- **页面**：持仓（收益率/今日涨跌可排序，未填购入价的沉底）、观察池、饰品详情（SVG 走势图+嫌疑分）、异常审核 /anomalies、**交易流水 /ledger**、**设置 /settings（D3：Web Push 订阅/取消订阅/测试推送，PWA 安装引导）**
- **数据管道**：每小时同步+90 天 K 线回填（17万条）；扫描覆盖持仓+观察池；加观察池自动回填 90 天历史（无快照新品用 C5 兜底）
- **标注体系**：anomaly_events 三分类审核（确认操盘/外部事件/正常波动）+ manipulation_tags 操盘窗口（138 个，confidence=high 来自"已购=操盘"规则批量生成）+ item_metadata 收藏品/品质
- **检测与预警**：操盘嫌疑分 v1（特征/阈值来自真实标注 AUC 分析：24h波动率 0.72/24h涨跌 0.66/偏离均线 0.62；单小时尖峰 0.52 已排除）；嫌疑分≥60 自动预警（3天冷却）；同收藏品上级异动→下级联动预警（事件带 context）；**追涨风险信号（2026-07-21）**：`lib/signals/momentum-chase.ts`，24h涨幅>15%触发（阈值来自 REPORT-T7.md：这个量级的历史涨幅未来7天平均收益-10.74%，70.8%概率为负），提示性质不进联动预警、不推送，新增 anomaly_events 的 `momentum_chase` 类型——**这个改动要 npm run build + 重启常驻采集器才会生效**（见第五节第10条）
- **交易流水（D2）**：库存同步发现资产消失→自动落卖出记录，卖价优先 C5 卖单匹配，匹配不到用户手填（选平台自动扣手续费：C5 1%/C5会员 0.5%/悠悠 1%，费率集中在 `lib/fees.ts`，gross 留档可重算）；月度已实现盈利。**6 月以来 5 笔已录全**（薇帕姐×3、阴谋者×4打包、喧嚣杀戮），合计盈利 ¥2852.36。**buy_price=0（开箱/来源不明）的资产离开库存不落流水**（2026-07-21）：这类东西没有成本价算不出盈亏，离开库存大多是开箱消耗不是真卖出，落一条待手填卖价的流水纯粹是噪音，逻辑在 `lib/inventory-import.ts`
- **产品化（D3）**：PWA（`app/manifest.ts`+`public/sw.js`+`next/og`生成的图标）+ Web Push（`web-push`库，`/settings`页管理订阅），目前接了嫌疑分预警和联动预警两类推送，详见下方第四节第6条
- **全市场候选池（C1/C2 复核用）**：`market_candidate_pool` 表（迁移 `015_add_market_candidate_pool.sql`）+ `scripts/backfill-candidate-pool.mjs`（抽样+K线回填）+ `scripts/backfill-candidate-pool-metadata.mjs`（补收藏品/品质，让 coMove 特征在全市场范围也能算），都独立于生产采集器。目标规模默认500，脚本增量补齐（已抽过的不重抽）；再跑 `node scripts/backfill-candidate-pool.mjs [目标数]` 扩大规模后记得重跑一遍 metadata 脚本。当前500个里363个有可用价格数据（其余是无真实成交的冷门磨损组合，抽样正常现象），500个全部匹配到了收藏品结构
- **移动端可用性（2026-07-21）**：导航栏（`app/(dashboard)/layout.tsx`）和持仓页统计卡片行（`app/(dashboard)/positions/page.tsx`）原本是纯桌面横向布局，窄屏下中文没有天然折行边界，被挤到极限宽度时浏览器逐字换行，手机上看起来像每个字单独占一行——导航栏改横向可滚动（`overflow-x-auto` + `whitespace-nowrap`），统计卡片/筛选栏窄屏下改纵向堆叠（`grid-cols-1`/`flex-wrap`），宽屏不受影响。
- **持仓/观察池页面性能（2026-07-21）**：两处问题叠加导致 `/positions`（271 件持仓）首字节耗时一度到 11-18 秒。①单次页面渲染内，同一个饰品的"各平台最新价"被 `pickReferencePlatform`/`computeSignalSummary`/显式调用各查一次，加上持仓页 totals 汇总又把整套逻辑重跑一遍，一个饰品实际查了 3~6 次同一张表——`pickReferencePlatform`/`computeSignalSummary`（`lib/signal-summary.ts`）加了可选的 `prefetched` 参数，调用方查一次传下去复用，totals 直接从已经算好的行数据汇总，不再重新查库。②两次小时同步之间页面反复渲染，价格数据根本没变但每次还是重新查库重新算——加了请求间缓存（`lib/signal-cache.ts`，`getLatestPricesByPlatform`/`getPriceHistory` 按饰品名/平台缓存，`insertPriceSnapshot`——快照唯一写入口——写完立刻让对应饰品缓存失效，不需要 TTL）。两项加起来 `/positions` 稳定态首字节压到 2-3 秒，`/watchlist` <1.3 秒。
- 备份：`data/backups/db-before-anomaly-review-20260717.sqlite`

## 三、当前卡在哪里

1. ~~212 条待审核异常~~ **已通过范围调整解决**：2026-07-20 确认 buy_price=0（开箱所得、购入渠道未知）的持仓不需要人工判断是不是操盘——用户没内幕消息根本没法判断。已把这类持仓从追踪范围里整体排除（`lib/tracked-items.ts`），/anomalies 页面默认也不展示这类饰品的待审核事件（数据库不删，只是不展示）。**现状：剩余待审核清零**（当时用户手动清了一批到 120 条，全部集中在 buy_price=0 品种，过滤后可见数为 0）。以后异常扫描/K线回填/价格同步的追踪范围只剩持仓里 buy_price>0 的（56 个）+ 观察池（1 个），同步的饰品数从 121 砍到 57，SteamDT 配额压力也缓解了（同一轮同步错误数从 21 降到 0）。
2. **联动特征（coMove）区分度仍验证不出来，但机制已证实**：2026-07-20 用户补充了两组收藏品配对案例（手套收藏品：喧嚣杀戮+3下级；"激流大行动"收藏品：抽象派+2下级凑上已有的彼岸花），标记数 141→162，加进观察池（watchlist id 8-14）。查实喧嚣杀戮和 USP-S 次时代确实在同一小时（2026-05-22T04:00）一起异动——机制是对的，但重跑 AUC 只从 0.500 涨到 0.507，样本量还不够，需要更多轮这样的补充。
3. ~~成交量数据薄~~ **已部分解决（见下）**：SteamDT 批量/单品价格接口一直有返回求购价/求购数（`biddingPrice`/`biddingCount`），之前同步代码只存了在售数，求购这一侧被白白丢弃——不用新调研数据源，2026-07-20 已把这两个字段接进 `price_snapshots`（迁移 `013_add_bidding_depth.sql`），从这次重启起开始积累。C5 直连价格没有求购数据，这两列在 platform='C5' 的行固定是 null；K线回填的历史数据也没有（K线本身不带量），所以求购深度只能从现在开始往后攒，补不了历史。挂单深度调研仍然有缺口：这只是"求购"一侧，"在售"侧的深度（不同价位挂了多少单）还是没有，且这只是 SteamDT 聚合平台（BUFF/YOUPIN/STEAM 等），不是 C5 挂单簿。

## 四、下一步计划（按优先级）

1. **B2 操盘剧本验证第一版已产出**：`scripts/analyze-playbook-stages.mjs` + `REPORT-B2.md`。结论：低位横盘（占比最大）、洗盘/砸盘（深回撤>15%接急拉，指纹清晰）、主拉升（急拉簇，涨速12.69%/天中位数，指纹清晰）三段能验证；吸货期和单纯横盘价格形态上分不开、会员进场看不见、出货期没有独立于普通回调的指纹——三个都卡在缺量/挂单数据。**洗盘指纹已实现上线**：`lib/signals/washout.ts`，接入 `lib/anomaly-scan.ts`，新增 `washout_signal` 异常类型（提示性质，独立冷却，不触发联动预警）。
2. **求购深度数据已开始积累**（2026-07-20 起）：等攒够几周数据后，重跑 `analyze-manipulation-features.mjs`/`analyze-playbook-stages.mjs` 时把 `bidding_count`/`bidding_price` 加进特征候选，看能不能补上吸货期/出货期指纹——这是之前卡住的地方，现在有数据来源了，缺的是时间。
3. ~~待审核队列已清零（见上）→ 现在随时可以重跑 `scripts/analyze-manipulation-features.mjs` 校准嫌疑分阈值 + 验证 coMove；episode 数变多后重跑 `analyze-playbook-stages.mjs` 让三个簇的边界更稳~~ **已重跑（2026-07-20）**：两个脚本的结论都稳定，不需要改阈值。`analyze-manipulation-features.mjs`——vol24h/move24h/maDev 三个特征的中位数和 AUC 几乎和首次校准时（`lib/signals/manipulation-score.ts` 注释里那版）一模一样（AUC 0.72/0.66/0.63 vs 首版 0.72/0.66/0.62），coMove 还是 0.507，没进一步移动。`analyze-playbook-stages.mjs`——episode 139→162（+21%），段落 1449→1829，k=6 聚类的崩跌/急拉/横盘三簇量级和首版基本吻合（详见 REPORT-B2.md 复核记录），`washout.ts` 里 15%/2% 的阈值继续有效。**结论：不是"没跑"，是跑了没变化——几天的数据增量还不足以移动这些统计量，要看到显著变化大概率得等 coMove 那类样本更稀疏的特征攒够更长时间。**注意 buy_price=0 的开箱品从这次起不再新增快照，用它们做特征分析时数据会在 2026-07-20 之后断档，历史数据不受影响
4. **C1/C2 预测模型第一版已跑完，且已用真正的全市场随机候选池复核两轮（2026-07-21）**：`scripts/build-prediction-baseline.mjs` + `REPORT-C1-C2.md`。第一版逻辑回归名义上打赢了随机基准和 coMove 规则基准，但候选池只是131个用户自己跟踪的饰品，不是真随机样本。**第一轮复核**：`scripts/backfill-candidate-pool.mjs` 从全市场 2万+ 饰品里分层随机抽500个（363个有可用数据，独立于生产采集器，靠 K 线接口一次性回填90天历史，不碰限流很紧的批量价格接口）补进 full 池，模型对随机基准的领先幅度基本消失（N=7 只剩1.08倍，之前2.1倍）。**第二轮复核**：`scripts/backfill-candidate-pool-metadata.mjs` 给这500个样本补上收藏品/品质结构后再重跑，结果更差——模型在 N=1/N=3 上现在连随机基准都赢不了，coMove 规则基准的精度也跟着大幅下滑（不是模型一家的问题，说明"同收藏品联动"这个信号本身在全市场噪声下没那么可靠，跟 coMove 特征 AUC 一直卡在0.507是同一件事的另一个印证）。**不满足上线门槛的结论没变，但现在证据更扎实、也更悲观**。外部事件混淆问题（问题三）依旧没解决。下一步：等求购深度数据积累、找能分开操盘/外部事件的特征，C3 回测在这些问题解决前仍没意义。
5. **coMove 验证需要更多轮收藏品配对补充**（见上第2条）：用户手头如果还记得别的"同收藏品多个饰品都被拉过"的案例，随时可以再报，标记数越多、越集中在少数几个收藏品里，AUC 才会有统计意义地移动。
6. **D3 产品化第一版已完成（2026-07-20）**：PWA（`app/manifest.ts` + `public/sw.js` + `app/icon-192`/`app/icon-512`/`app/apple-icon.tsx`，图标用 `next/og` 的 `ImageResponse` 生成，没有额外美术资源）+ Web Push（`web-push` 库，VAPID 密钥在 `.env.local`）。订阅管理在新页面 `/settings`。推送订阅存 `push_subscriptions` 表（迁移 `014_add_push_subscriptions.sql`）。目前只接了两类高优先级信号：`lib/anomaly-scan.ts` 里嫌疑分预警（≥60）和同收藏品联动预警触发时会推送；z-score/成交量/洗盘这些事件型或提示型信号故意没接，太密会被当骚扰关掉通知。逃顶信号（D1）、预测高分（C3）还没做，做出来后要在 `scanForAnomalies` 里补进 `pushNotifications`。`scanForAnomalies` 从同步函数改成了异步（要 `await sendPushNotification`）——**已重启常驻采集器验证生效（2026-07-20）**。
7. ~~两个运维层面的待办（2026-07-21 发现）：①云端 VM 的公网 IP 还不是 OCI 的 Reserved Public IP...②`price_snapshots` 表一晚上从 65 万行涨到 88 万行...~~ **①已处理（2026-07-22）**：`170.9.25.139` 转成了 Reserved Public IP，见"运行架构"一节。**②仍是待观察项，不是待办**：截至 07-22 表已到 89 万+行，增速符合预期（观察池新品回填 90 天历史是一次性的，不是持续增长源），目前有请求间缓存顶着页面不慢，磁盘 36% 用量（29G 剩余）还早。加了数据库备份后这张表的体积也是备份大小的主要来源（当前压缩后单份 19M），保留策略（7天+每周8周）已经把这个成本控制住了，不用现在处理。
8. **数据库备份已补上（2026-07-22）**：云端 cron 每日 + 本机计划任务异地镜像，细节见"运行架构"一节。这是这次会话里认为的当前最大单点风险（云端此前完全没有备份，标注数据不可再生），已解决。

## 五、踩过的坑——绝对不要再踩

**标注/业务语义（搞错污染训练集）**
1. `buy_price>0` = 用户凭操盘消息买入（饰品级操盘标签）；`=0` = 开箱，未知。已按此批量标注过。
2. Souvenir MP7 | Tall Grass 是外部事件（5-22 纪念品可炼金更新），用户明确判断过，别被规则误翻。
3. 2026-05-22 Valve 更新两件事：纪念品可炼金（廉价纪念品暴涨）+ 取消印花胶囊（旧 Major 印花绝版重定价，前两周板块抢跑）。外部事件必须写明事由。
3b. **2026-07-15 Steam"交易保护"新规（"黄盾"）**：7天交易锁定+双方无条件可撤回，上线48小时内市场普跌（高端刀流动性归零）。**T+7 对策略的全部影响已写进 PLAN.md 原则6**（模拟脚本 `scripts/analyze-t7-forced-hold.mjs`：完美买点下也有60%的盘7天内过峰、仅50%第7天卖还净赚），核心结论：买入侧只有慢盘有意义、C3回测必须硬编码7天锁、逃顶(D1)优先级上调。**T+7 是不对称的（用户口述，2026-07-21）**：庄家吸货是中长线，拉升时手里的货早过锁定期，出一小部分就回本、之后卖什么价都是赚——被锁死的是拉升中段跟进的散户/会员，所以别指望新规逼庄家放慢节奏，快盘会继续存在。**已核实是真事件，但没拿来改任何 anomaly_events 标注**——用项目自己的数据比对过（131 个跟踪饰品里 19 个同期跌幅≥5%），方向和时间对得上，但自动扫描在这个窗口触发的 pending 候选清一色是低价品的价格上蹿，跟"普跌"方向对不上，说明这次事件对当前跟踪的饰品来说大多没跑出自身噪音基线。**教训：外部事件的新闻日期只是"提示去哪儿核对"，不能直接拿日期窗口反推批量改 status，会引入错误标签。**每一条要单独核对该品种自己的价格数据方向是否吻合，再决定标不标。
4. 操盘标记必须带时间窗口；¥0.5 以下低价品波动特征虚高（最小报价单位）。
5. **流水的价格都是单件价**（quantity>1 的打包出售要除以数量再入库），sell_price 是扣完手续费的净价，gross 留档。

**外部 API 实测（文档全不可信）**
6. SteamDT kline `type=1` 是 90 天滚动小时线（2160 条）非日线，无量，platform 参数有效；鉴权 `Authorization: Bearer`；batch 上限 100 名；限流 4005。
6c. **批量价格接口（`/price/batch`）和 K 线接口（`/item/v1/kline`）的限流规则完全不同**（2026-07-21 实测）：批量价格接口连续请求 2 次就 4005 报错，要等约 60 秒才恢复——之前"121个饰品→21个错误"其实就是2次批量请求里第2次（21个）撞了限流，跟总配额、总饰品数无关；砍到57个"修好"只是因为57个饰品一次批量请求（上限100）够用，不需要第2次请求。K 线接口反而没这个限制，250ms 间隔连续请求490次全部成功。**以后任何要扩大同步范围的改动，先确认会不会让批量价格接口单轮请求数超过100（需要拆成第2次请求），会的话必须加约60秒间隔，不能直接抄 kline 现有的250ms节奏。**
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
18. **VSCode 内置 Simple Browser（编辑器里嵌的那个网页预览）不支持 Web Push**：点"开启推送"会报 `Registration failed - push service not available`，不是代码或 VAPID 配置的问题——这个内嵌 webview 本身没接入真正的推送服务。测 Push 相关功能必须在独立浏览器窗口（系统默认的 Chrome/Edge，不是编辑器里点开的那个标签页）里测，2026-07-21 已在独立窗口验证订阅+测试推送成功。
19. **GitHub 远端默认分支是 `main`，本机开发从项目一开始就一直用 `master`**，两者分叉（`git push` 时用 `git push origin master:main`，别直接 `git push` 图省事，会因为没有本地 main 分支报错或者建出一个新分支）——2026-07-21 部署时发现本机 master 领先 main 整整 52 个commit，从来没推送过，云服务器 clone 下来是一年前的老代码，查了半天才发现是分支不对，不是代码丢了。以后每次要把代码同步到云端之前，先确认本机 master 已经推到 main 了。
20. **Oracle Cloud Always Free 的 Ampere A1.Flex 经常显示 "Out of capacity"**（免费机型抢不到是常态，尤其 us-sanjose-1 这种单可用区的region），退而求其次用 `VM.Standard.E2.1.Micro`（x86，1核1GB，稳定能开出来）。**1GB内存编译 Next.js 会因为内存不够变得极慢/有OOM风险，必须先加 swap**（`fallocate -l 4G /swapfile` 那一套），不加会卡在 `npm run build` 出不来。另外 Oracle 的 Ubuntu 镜像自带 iptables 规则只放行 22 端口，云端安全组（Security List）开了端口不代表机器自己防火墙也开了，两边都要配（`sudo iptables -I INPUT <n> -p tcp --dport <port> -j ACCEPT` + `netfilter-persistent save`）。
21. **部署时手动传到服务器的文件很容易漏进 git，出问题前完全看不出来**：2026-07-21 迁移当晚 `middleware.ts`（Basic Auth 全部逻辑）大概率是手动 scp 上去的，从没 `git add` 过，`git status` 显示 `??`。因为 Docker build 时 `COPY . .` 直接拷贝磁盘上的文件（不管有没有入 git），容器照样正常工作，**表面上完全看不出问题**——只有下次有人在服务器上 `git clean -fd`，或者从干净的 clone 重新部署（灾难恢复/换新 VM）时，Basic Auth 会无声消失，公网直接裸奔。这是第 19 条踩过的"master 没推到 main"在新变体上又发生了一次。**教训：任何一次手动登录服务器改文件之后，收工前跑一遍 `git status`，确认改动最终会通过 `git push`+`git pull` 的正常流程走，而不是只活在这一台服务器的磁盘上。**
22. **Oracle Cloud 控制台里，实例详情页的"Security"标签页不是防火墙规则的地方**——那是"Shielded instance"（Secure Boot/vTPM 之类）的设置。真正的入站防火墙规则（Ingress Rules）在 **Networking 标签 → 对应 VNIC → 所在 Subnet → 页面里的 Security Lists → 点进去 → Security Rules 标签**，跟第 20 条已经记录的"两层防火墙"是同一件事，这次是给新端口（80/443）踩了一遍完整流程，顺便记下控制台导航路径，下次不用再摸索。
23. **免费的 `sslip.io`/`nip.io` 这类"IP 编码进域名"服务，能不买域名直接拿到真实 Let's Encrypt 证书**（Caddy 装好、防火墙开 80/443 端口就行，证书自动签发/续期），个人项目/单人使用场景够用，不用为了一个 HTTPS 走完整的买域名+配 DNS 流程。**代价是证书绑定这台机器当前的公网 IP**，IP 一变证书就失效，所以配的时候要么把 IP 转成 OCI 的 Reserved Public IP（免费），要么接受"IP 变了就得重新配一次 Caddyfile+重启"这个小成本。
24. **中文/CJK 文本在窄 flex 容器里会被逐字符换行，不是逐词换行**：西文靠空格分词，浏览器算 flex 子项的"内容最小宽度"时以单词为最小单位；中文没有天然分词符，行内断行允许发生在任意两个汉字之间，所以窄屏把 flex 子项挤到极限时，中文标签会退化成每个字单独一行的竖排效果（英文界面不会出现这个问题，容易在纯桌面测试时漏掉）。**排查依据**：看到界面上文字变成竖着一个字一个字排列，先怀疑是不是这个原因，不是组件坏了。**修法**：给会被挤压的文字容器加 `whitespace-nowrap`（配合 `shrink-0` 防止内容被压缩到消失），父容器视情况用 `overflow-x-auto`（保持单行，超出滚动）或 `flex-wrap`（允许整个子项换行，但子项内部文字不断行）。
25. **SQLite 单机小库/慢盘场景下，"重复查询"和"没有缓存"是两个独立的性能杀手，容易只治一个就以为解决了**：这次 `/positions` 页面先修的是"单次渲染里同一数据被查 3~6 次"（改法：函数加可选 `prefetched` 参数，调用方查一次到处传），这一步单独测（跳过 HTTP，直接测 DB 层）确认查询平均耗时降了 3 倍，但端到端页面耗时几乎没变——因为**两次页面渲染之间**（不同请求）同样的查询还在重复发生，且云端 1 核 1GB 机器内存小、系统盘缓存装不下 80 万+行的 `price_snapshots` 表，每次都有相当比例要真的碰磁盘。加一层"数据没变就不重查"的请求间缓存（用 `insertPriceSnapshot`——快照唯一写入口——做失效触发点，不需要 TTL）才是真正让端到端耗时掉下来的一步。**教训：诊断页面慢，要先用 curl 的 `time_starttransfer`/`time_total` 或直接在 DB 层单独计时，分清"单次请求内浪费多少"和"跨请求重复浪费多少"是两个不同量级的问题，只优化前者可能验证时看着有效、上线后感知不到。**

*持久记忆存了第 1、3 条的摘要，交接以本文档为准。*
