import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "db.sqlite");
const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

// Next.js dev 模式热重载会重新执行模块顶层代码，
// 用 globalThis 持有连接，避免每次热重载都新开一个 sqlite 连接导致 database is locked。
declare global {
  var __db: Database.Database | undefined;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map(
      (row) => row.name
    )
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
    })();
  }
}

// 参数化成接受任意路径，是为了让 lib/db/testing.ts 能传 ":memory:" 建一个跑过同一套
// migrations 的临时库给单测用——WAL 模式在内存库上不支持，只给真实文件路径开。
export function createConnection(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  if (dbPath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  runMigrations(db);
  return db;
}

export function getDb(): Database.Database {
  if (!global.__db) {
    global.__db = createConnection(DB_PATH);
  }
  return global.__db;
}
