// Personal references never copy, publish, or change the source article.
export function createKnowledgePersonalStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_personal (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    article_id TEXT NOT NULL,
    saved_at TEXT,
    read_at TEXT,
    PRIMARY KEY(user_id, owner_id, article_id)
  )`);
  const columns = 'article_id AS id, saved_at AS savedAt, read_at AS readAt';
  return {
    list(userId, ownerId) {
      return db.prepare(`SELECT ${columns} FROM knowledge_personal WHERE user_id=? AND owner_id=?
        ORDER BY read_at DESC, saved_at DESC`).all(userId, ownerId);
    },
    update(userId, ownerId, id, patch) {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO knowledge_personal(user_id,owner_id,article_id,saved_at,read_at)
        VALUES(?,?,?,?,?) ON CONFLICT(user_id,owner_id,article_id) DO UPDATE SET
        saved_at=CASE WHEN ? THEN CASE WHEN ? THEN COALESCE(saved_at,excluded.saved_at) ELSE NULL END ELSE saved_at END,
        read_at=CASE WHEN ? THEN excluded.read_at ELSE read_at END`).run(
        userId, ownerId, id, patch.saved ? now : null, patch.read ? now : null,
        Number('saved' in patch), Number(Boolean(patch.saved)), Number(Boolean(patch.read)));
      // Keep the latest 100 reads per catalogue, plus every saved reference.
      db.prepare(`DELETE FROM knowledge_personal WHERE user_id=? AND owner_id=? AND saved_at IS NULL
        AND (read_at IS NULL OR article_id NOT IN (SELECT article_id FROM knowledge_personal
          WHERE user_id=? AND owner_id=? AND read_at IS NOT NULL ORDER BY read_at DESC,article_id DESC LIMIT 100))`)
        .run(userId,ownerId,userId,ownerId);
      return db.prepare(`SELECT ${columns} FROM knowledge_personal WHERE user_id=? AND owner_id=? AND article_id=?`)
        .get(userId,ownerId,id) || {id,savedAt:null,readAt:null};
    },
  };
}
