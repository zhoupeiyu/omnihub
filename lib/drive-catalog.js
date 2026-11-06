import {DRIVE_COLLECTIONS} from './openlist-library.js';

// Only completed root scans can replace a live listing, including empty roots.
export function readIndexedCollections(db, userId) {
  const doneCheck = db.prepare('SELECT state FROM drive_scan_dirs WHERE user_id=? AND path=?');
  for (const collection of DRIVE_COLLECTIONS) {
    if (doneCheck.get(userId, collection.root)?.state !== 'done') return null;
  }
  const countDirectChildren = db.prepare('SELECT count(*) n FROM drive_index WHERE user_id=? AND parent=?');
  return DRIVE_COLLECTIONS.map(collection => ({
    ...collection,
    total: countDirectChildren.get(userId, collection.root).n,
    available: true,
  }));
}
