// We avoid importing better-sqlite3 types to keep TS simple across ESM builds.
export interface QueryParams {
  text?: string;
}

export function simpleQuery(db: any, q: QueryParams) {
  if (!q.text) {
    return db.prepare('SELECT * FROM asset ORDER BY created_ts DESC LIMIT 200').all();
  }
  const terms = q.text.toLowerCase().split(/\s+/).filter(Boolean);
  const clauses = terms.map(() => 't.term LIKE ?').join(' OR ');
  const rows = db.prepare(`
    SELECT a.*
    FROM asset a
    LEFT JOIN index_terms t ON a.id = t.asset_id
    WHERE ${clauses}
    GROUP BY a.id
    ORDER BY a.created_ts DESC
    LIMIT 500
  `).all(...terms.map(t => `%${t}%`));
  return rows;
}
