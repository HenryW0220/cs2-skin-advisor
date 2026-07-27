import type Database from "better-sqlite3";
import { createConnection } from "./client";

// 建一个跑过真实 db/migrations/*.sql 的内存态数据库给 lib/db/*.test.ts 用——用真实
// migrations 而不是手写一份精简 schema，是为了让测试能测出 schema 和代码假设不一致的
// 问题（比如某次改了迁移文件忘了同步改查询），手写 schema 测不出这种漂移。
export function createTestDb(): Database.Database {
  return createConnection(":memory:");
}
