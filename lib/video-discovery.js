const fail = message => Object.assign(new Error(message), { status: 400 });
const text = (value, max = 500) => String(value ?? '').slice(0, max);
const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const numericId = value => /^\d{1,32}$/.test(String(value || ''));
const support = Object.freeze({
  'search-posts': ['tiktok', 'bilibili'], 'search-users': ['tiktok', 'bilibili'],
  trending: ['douyin', 'bilibili'], comments: ['douyin', 'tiktok', 'bilibili'],
  replies: ['douyin', 'tiktok', 'bilibili'], music: ['douyin', 'tiktok'],
  'music-posts': ['douyin', 'tiktok'], hashtag: ['douyin', 'tiktok'],
  'hashtag-posts': ['tiktok'], live: ['douyin', 'tiktok', 'bilibili'],
});
const routes = Object.freeze({
  'search-posts': 'search/posts', 'search-users': 'search/users', trending: 'trending',
  comments: 'video/comments', replies: 'video/comments/replies', music: 'music',
  'music-posts': 'music/posts', hashtag: 'hashtag', 'hashtag-posts': 'hashtag/posts', live: 'live',
});
export function publicUrl(value) {
  try {
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port || !u.hostname.includes('.') || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname)) return '';
    return u.href.slice(0, 4096);
  } catch { return ''; }
}
function inputUrl(value) {
  const urls = value.match(/https?:\/\/[^\s<>"\u3000]+/gi) || [];
  if (urls.length !== 1) throw fail('请输入一个完整的平台链接。');
  let url;
  try { url = new URL(urls[0].replace(/[。，、；！？）】》」』.,;!?)\]]+$/u, '')); } catch { throw fail('链接格式不正确。'); }
  if (!publicUrl(url.href)) throw fail('请输入公开的平台链接。');
  return url;
}
export function discoveryRequest(input, parseVideoLink) {
  const { operation, platform } = input;
  if (!support[operation]?.includes(platform)) throw fail('该平台暂不支持此查询，请切换平台或查询类型。');
  if (typeof input.text !== 'string' || input.text.length > 4096) throw fail('输入内容过长。');
  const value = input.text.trim();
  const query = {};
  if (operation.startsWith('search-')) {
    if (!value || value.length > 120 || /[\x00-\x1f]/.test(value)) throw fail('请输入 1 至 120 字的关键词。');
    query.keyword = value;
  } else if (operation === 'trending') {
    const board = input.board || 'hot';
    if (!(platform === 'douyin' ? ['hot', 'entertainment', 'society', 'challenge'] : ['hot']).includes(board)) throw fail('这个榜单暂不支持。');
    query.board = board;
  } else if (['comments', 'replies'].includes(operation)) {
    const link = parseVideoLink(value);
    if (link.platform !== platform) throw fail('所选平台与作品链接不一致。');
    query.url = link.url;
    if (operation === 'replies') {
      if (!numericId(input.commentId)) throw fail('请选择一条有效评论。');
      query.comment_id = String(input.commentId);
    } else {
      const sort = input.sort || 'hot';
      if (!['hot', 'new'].includes(sort) || (sort === 'new' && platform !== 'bilibili')) throw fail('该平台暂不支持此排序。');
      query.sort = sort;
    }
  } else if (operation === 'live') {
    const url = inputUrl(value), host = url.hostname, path = url.pathname;
    const valid = platform === 'douyin' ? host === 'live.douyin.com' && /^\/\d+\/?$/.test(path)
      : platform === 'bilibili' ? host === 'live.bilibili.com' && /^\/(?:h5\/)?\d+\/?$/.test(path)
      : ['www.tiktok.com', 'tiktok.com'].includes(host) && /^\/@[\w.-]+\/live\/?$/.test(path);
    if (!valid) throw fail('请填写所选平台的直播间网页链接。');
    query.url = url.href;
  } else {
    const isMusic = operation.startsWith('music');
    const id = input.resourceId || (numericId(value) ? value : '');
    if (id) {
      if (!numericId(id)) throw fail('请输入有效的音乐或话题编号。');
      query[isMusic ? 'music_id' : 'hashtag_id'] = String(id);
    } else if (operation === 'hashtag' && platform === 'tiktok' && !/https?:/i.test(value)) {
      const name = value.replace(/^#/, '');
      if (!name || name.length > 100 || /[\s/\\\x00-\x1f]/.test(name)) throw fail('请输入话题名称或编号。');
      query.name = name;
    } else {
      const url = inputUrl(value);
      const hosts = platform === 'douyin' ? ['www.douyin.com', 'douyin.com'] : ['www.tiktok.com', 'tiktok.com'];
      const type = isMusic ? 'music' : platform === 'douyin' ? 'hashtag' : 'tag';
      if (!hosts.includes(url.hostname) || !url.pathname.startsWith('/' + type + '/')) throw fail('请填写对应平台的音乐或话题链接，也可直接输入编号。');
      if (operation.endsWith('-posts')) throw fail('请先查询音乐或话题，再打开相关作品。');
      query.url = url.href;
    }
  }
  return { platform, operation, discoveryQuery: query, url: query.url || '' };
}
export function discoveryPath(job, cursor) {
  if (!support[job.operation]?.includes(job.platform)) throw fail('不支持这个查询。');
  const params = new URLSearchParams({ ...job.discoveryQuery, wait: '0', include_raw: 'false', refresh: String(Boolean(job.refreshParse)) });
  if (!['music', 'hashtag', 'live', 'trending'].includes(job.operation)) params.set('count', '20');
  if (cursor) params.set('cursor', String(cursor).slice(0, 512));
  return `/api/v1/${job.platform}/${routes[job.operation]}?${params}`;
}
export function discoveryResult(job, data) {
  if (!data || typeof data !== 'object') throw fail('平台没有返回可用结果。');
  const operation = job.operation;
  const detailMode = ['live', 'music', 'hashtag'].includes(operation);
  if (detailMode) {
    if (data.platform !== job.platform) throw fail('平台返回的内容不匹配。');
    job.discovery = { items: [], cursor: null, hasMore: false, detail: {
      title: text(data.title || data.name || '直播间'), text: text(data.description, 2000),
      author: text(data.author?.nickname || data.owner?.nickname || (typeof data.author === 'string' ? data.author : '')),
      url: publicUrl(data.web_url || job.url), cover: publicUrl(data.cover?.url),
      ...(operation === 'live' ? {isLive: Boolean(data.is_live), viewerCount: number(data.viewer_count)} : {}), count: number(data.content_count),
      musicId: text(data.music_id, 32), hashtagId: text(data.hashtag_id, 32),
      streams: (data.streams || []).slice(0, 12).map(s => ({ url: publicUrl(s.url), protocol: text(s.format, 20), quality: text(s.quality, 40) })).filter(s => s.url),
    } };
  } else {
    if (!Array.isArray(data.items)) throw fail('平台没有返回可用列表。');
    const items = data.items.slice(0, 200).filter(i => i && i.platform === job.platform && !i.is_private && !i.is_deleted).map(i => {
      const type = ['comments', 'replies'].includes(operation) ? 'comment' : operation === 'trending' ? 'trend' : operation === 'search-users' ? 'author' : 'post';
      return { id: text(i.comment_id || i.content_id || i.sec_uid || i.uid || i.word, 150), type,
        title: text(i.title || i.word || i.nickname || i.description), text: text(i.text || i.signature, 5000),
        author: text(i.author?.nickname, 100), url: publicUrl(i.web_url),
        cover: publicUrl(i.cover?.url || i.avatar?.url || i.media?.covers?.[0]?.url),
        likes: number(i.digg_count ?? i.stats?.digg_count), replies: number(i.reply_count),
        rank: i.rank == null ? null : number(i.rank), hotValue: number(i.hot_value), count: number(i.content_count),
        resourceId: text(i.music_id || i.hashtag_id, 32),
      };
    }).filter(i => i.id);
    const old = job.discovery || { items: [] };
    const entries = [...new Map([...(old.items || []), ...items].map(i => [i.id, i])).values()].slice(0, 200);
    const cursor = typeof data.cursor === 'string' ? data.cursor.slice(0, 512) : null;
    job.discovery = { items: entries, detail: null, cursor, hasMore: Boolean(data.has_more && cursor && cursor !== old.cursor && entries.length < 200) };
  }
  job.state = 'ready'; job.error = '';
  return job;
}
export function discoveryExport(job, format) {
  const value = { platform: job.platform, operation: job.operation, input: job.input, created: job.created, updated: job.updated, ...job.discovery };
  if (format === 'json') return JSON.stringify(value, null, 2);
  const rows = job.discovery?.detail ? [job.discovery.detail] : job.discovery?.items || [];
  const keys = ['title', 'text', 'author', 'url', 'likes', 'replies', 'rank', 'hotValue', 'count'];
  const cell = value => { let s = String(value ?? ''); if (/^[\s]*[=+@-]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
  return '\uFEFF' + [keys.join(','), ...rows.map(row => keys.map(k => cell(row[k])).join(','))].join('\r\n');
}
