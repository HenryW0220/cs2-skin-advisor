import { getDb } from "./client";
import type { IItemCatalogEntry } from "../api/cs-item-db";

export interface IItemCatalogRow {
  market_hash_name: string;
  name_cn: string;
  icon_url: string | null;
  item_type: string;
  updated_at: string;
}

/**
 * 全量替换目录表。数据集本身就是全量快照，增量对比没有意义；
 * 整个替换放在一个事务里，中途失败会回滚，不会留下半份目录。
 */
export function replaceItemCatalog(entries: IItemCatalogEntry[]): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO item_catalog (market_hash_name, name_cn, icon_url, item_type)
     VALUES (@marketHashName, @nameCn, @iconUrl, @itemType)
     ON CONFLICT(market_hash_name) DO UPDATE SET
       name_cn = excluded.name_cn,
       icon_url = excluded.icon_url,
       item_type = excluded.item_type,
       updated_at = datetime('now')`
  );
  db.transaction(() => {
    db.prepare("DELETE FROM item_catalog").run();
    for (const entry of entries) insert.run(entry);
  })();
}

export function countItemCatalog(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS n FROM item_catalog").get() as { n: number }
  ).n;
}

export function getItemCatalogEntry(marketHashName: string): IItemCatalogRow | undefined {
  return getDb()
    .prepare("SELECT * FROM item_catalog WHERE market_hash_name = ?")
    .get(marketHashName) as IItemCatalogRow | undefined;
}

/**
 * 中/英文分词匹配搜索：查询按空格拆词，每个词都要命中（中英文混着命中也算），
 * 所以"破碎铅秋 崭新"能搜到"M4A1消音版 | 破碎铅秋 (崭新出厂)"。
 * 排序：首词前缀命中的排前面（搜"AK-47"时 AK-47 系列排在"卡拉彼波 | AK-47 表情"
 * 这类中段命中之前），其余按名字长度升序——短名字通常是基础款，比
 * StatTrak/纪念品变体更可能是用户要找的。
 */
export function searchItemCatalog(query: string, limit = 20): IItemCatalogRow[] {
  // LIKE 的 % 和 _ 是通配符，用户输入里出现时按字面转义
  const tokens = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[\\%_]/g, (ch) => `\\${ch}`));
  if (tokens.length === 0) return [];

  const tokenClauses = tokens
    .map(
      (_, i) =>
        `(name_cn LIKE @substr${i} ESCAPE '\\' OR market_hash_name LIKE @substr${i} ESCAPE '\\')`
    )
    .join(" AND ");
  const params: Record<string, string | number> = { prefix: `${tokens[0]}%`, limit };
  tokens.forEach((t, i) => {
    params[`substr${i}`] = `%${t}%`;
  });

  return getDb()
    .prepare(
      `SELECT * FROM item_catalog
       WHERE ${tokenClauses}
       ORDER BY
         CASE WHEN name_cn LIKE @prefix ESCAPE '\\' OR market_hash_name LIKE @prefix ESCAPE '\\' THEN 0 ELSE 1 END,
         length(name_cn) ASC,
         name_cn ASC
       LIMIT @limit`
    )
    .all(params) as IItemCatalogRow[];
}
