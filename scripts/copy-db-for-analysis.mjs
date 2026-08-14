// 给分析脚本做一份数据库副本，之后所有重活都对着副本跑。
//
// 用法（云端容器里跑）：
//   node scripts/copy-db-for-analysis.mjs /tmp/analysis.sqlite
//
// 为什么需要它：2026-08-13 直接对着生产库跑多窗口基准回填，长时间占着写锁 + 打满
// 磁盘，把常驻采集器**饿了 40 分钟**——快照一条没写、每小时同步和 10 分钟快速同步
// 全部停摆，而且没有任何报错（HANDOFF 踩坑 49）。这台机器是 1 核 1GB，重活和采集
// 抢的是同一块盘，所以规矩是：**重活对副本跑，只有最后合并结果那一下碰生产库。**
//
// 用的是 SQLite 的在线备份 API（跟 scripts/backup-db.sh 同一套），不停容器、不阻塞写入。
import Database from "better-sqlite3";
import { statSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("用法：node scripts/copy-db-for-analysis.mjs <目标路径>");
  process.exit(1);
}

const db = new Database(process.env.CS2_DB_PATH ?? "data/db.sqlite", { readonly: true });
const startedAt = Date.now();
await db.backup(target);
db.close();

const mb = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`已复制到 ${target}（${mb} MB，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒）`);
console.log("接下来对副本跑重活，例如：");
console.log(`  CS2_DB_PATH=${target} node scripts/build-market-baseline.mjs 8 9 10 11 12 13`);
console.log(`  node scripts/merge-market-baseline.mjs ${target}`);
