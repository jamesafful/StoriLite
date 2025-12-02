import Database from 'better-sqlite3';

export interface QueryParams {
  text?: string;
}

export function simpleQuery(db: Database, q: QueryParams) {
  if (!q.text) {
    return db.prepare('SELECT * FROM asset LIMIT 200').all();
  }
  const terms = q.text.toLowerCase().split(/\s+/).filter(Boolean);
  const clauses = terms.map(() => 'term LIKE ?').join(' OR ');
  const rows = db.prepare(`
    SELECT a.* FROM asset a
    LEFT JOIN index_terms t ON a.id = t.asset_id
    WHERE ${clauses}
    GROUP BY a.id
    LIMIT 500
  `).all(...terms.map(t => `%${t}%`));
  return rows;
}
