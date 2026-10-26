import '../public/library-order.js';

// Keep a complete filter/search directory, without sending long summaries or
// every article body. The first reader can start without another network trip.
export function compactKnowledgeList(items, loadDetail, canLoadDetail = () => true) {
  const rows = [...items].sort(globalThis.OmniHubLibraryOrder.compare).map(item => {
    const { body, promptText, sources, claims, repositories, ...summary } = item;
    const text = Array.from(String(summary.summary || '').replace(/\s+/g, ' ').trim());
    return { ...summary, summary: text.slice(0, 120).join('') + (text.length > 120 ? '…' : '') };
  });
  if (rows.length && canLoadDetail(rows[0].id)) {
    const detail = loadDetail(rows[0].id);
    // Cap the entire inline record, including citations and metadata.
    if (detail && Buffer.byteLength(JSON.stringify(detail)) <= 64 * 1024) rows[0].initialDetail = detail;
  }
  return rows;
}
