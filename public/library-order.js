(function (root) {
  function timestamp(item) {
    for (const value of [item?.organizedAt, item?.updatedAt, item?.updated_at, item?.createdAt, item?.created_at]) {
      if (!value) continue;
      const text = String(value).trim();
      // SQLite's UTC timestamps have no timezone suffix.
      const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text.replace(' ', 'T') + 'Z' : text;
      const time = Date.parse(normalized);
      if (Number.isFinite(time)) return time;
    }
    return 0;
  }
  function compare(a, b) {
    return timestamp(b) - timestamp(a) || String(a?.key ?? a?.id ?? a?.title ?? '')
      .localeCompare(String(b?.key ?? b?.id ?? b?.title ?? ''), 'en', { numeric:true });
  }
  root.OmniHubLibraryOrder = Object.freeze({ timestamp, compare });
})(globalThis);
