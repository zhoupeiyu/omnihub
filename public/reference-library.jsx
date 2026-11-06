// Keep the native selector for keyboard and mobile interaction while placing
// the visible chevron directly after the selected label.
function InlineSelect({ children, className = '', ...props }) {
  const options = React.Children.toArray(children);
  const optionValue = option => String(option.props.value ?? option.props.children);
  const selected = options.find(option => optionValue(option) === String(props.value ?? props.defaultValue ?? '')) || options[0];
  return <span className={`inline-select ${className}${props.disabled ? ' is-disabled' : ''}`}>
    <span className="inline-select-label" aria-hidden="true">{selected?.props.children}</span>
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 9 6 6 6-6" /></svg>
    <select {...props}>{children}</select>
  </span>;
}

// Match the preview surface to the image; originals are never modified.
function prepareReferenceThumbnail(event) {
  const image = event.currentTarget;
  if (image.dataset.preparedSource === (image.currentSrc || image.src)) return;
  image.dataset.preparedSource = image.currentSrc || image.src;
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { width: w, height: h } = canvas;
    const pixels = ctx.getImageData(0, 0, w, h).data;
    const whiteColumn = x => {
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        if (pixels[i] < 248 || pixels[i + 1] < 248 || pixels[i + 2] < 248 || pixels[i + 3] < 250) return false;
      }
      return true;
    };
    let left = 0, right = w - 1;
    if (image.closest('.reference-card-costume')) {
      while (left < w * .15 && whiteColumn(left)) left++;
      while (right > w * .85 && whiteColumn(right)) right--;
      if (!left || right === w - 1 || left >= w * .15 || right <= w * .85) { left = 0; right = w - 1; }
    }
    const samples = [[left, 0], [right, 0], [left, h - 1], [right, h - 1]].map(([x, y]) => (y * w + x) * 4);
    const rgb = [0, 1, 2].map(channel => samples.map(i => pixels[i + channel]).sort((a, b) => a - b).slice(1, 3).reduce((a, b) => a + b) / 2);
    if (samples.every(i => pixels[i + 3] > 250)) image.parentElement.style.backgroundColor = `rgb(${rgb.join(',')})`;
    if (left || right < w - 1) {
      const cropped = document.createElement('canvas');
      cropped.width = right - left + 1; cropped.height = h;
      cropped.getContext('2d').drawImage(canvas, left, 0, cropped.width, h, 0, 0, cropped.width, h);
      const preview = cropped.toDataURL('image/png');
      image.dataset.preparedSource = preview;
      image.removeAttribute('srcset');
      image.src = preview;
    }
  } catch { /* Keep the intact preview when pixels cannot be read. */ }
}

const REFERENCE_LABELS = { face: '人物', costume: '服装', pose: '姿势' };
// One image per role, always attached in this order so 图1/图2/图3 in the
// combined prompt match the images the studio receives.
const REFERENCE_ROLE_ORDER = ['face', 'costume', 'pose'];
const REFERENCE_ROLE_PROMPTS = {
  face: '人物参考：保留其面部特征、发型和气质',
  costume: '服装参考：沿用其服装款式、材质和配色',
  pose: '姿势参考：采用其身体姿势、动作和视角',
};
// Display order for the top kind nav follows the approved PoseWear reference
// (姿势/服装/人像); prompt assembly order above is unchanged by this.
const KIND_NAV_ORDER = ['pose', 'costume', 'face'];
const referenceCompositionMemory = new Map();

function referenceCompositionKey(userId) {
  const id = Number(userId);
  return Number.isSafeInteger(id) && id > 0 && String(id) === String(userId) ? `omnihub:reference-composition:v1:${id}` : null;
}
// Stored selections are display hints only; the original is re-read from the
// owner-only library when sent, so nothing here grants access to an image.
function normalizeReferenceSelection(value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(REFERENCE_LABELS, value.kind)) return null;
  const text = (input, max) => typeof input === 'string' ? input.slice(0, max) : '';
  const id = text(value.id, 160);
  if (!id) return null;
  const thumbnailUrl = typeof value.thumbnailUrl === 'string' && value.thumbnailUrl.length <= 500 && /^\/api\/[^/]/.test(value.thumbnailUrl) ? value.thumbnailUrl : '';
  return { kind: value.kind, id, title: text(value.title, 160) || id, stem: text(value.stem, 160), category: text(value.category, 80),
    thumbnailUrl, originalReady: value.originalReady === true };
}
function normalizeReferenceComposition(value) {
  const result = {};
  for (const kind of REFERENCE_ROLE_ORDER) {
    const selection = normalizeReferenceSelection(value?.[kind]);
    if (selection && selection.kind === kind) result[kind] = selection;
  }
  return result;
}
function setReferenceSelection(composition, item) {
  const selection = normalizeReferenceSelection(item);
  return selection ? { ...normalizeReferenceComposition(composition), [selection.kind]: selection } : normalizeReferenceComposition(composition);
}
function removeReferenceSelection(composition, kind) {
  const next = normalizeReferenceComposition(composition);
  delete next[kind];
  return next;
}
function orderedReferenceSelections(composition) {
  const value = normalizeReferenceComposition(composition);
  return REFERENCE_ROLE_ORDER.filter(kind => value[kind]).map(kind => value[kind]);
}
// Accepts a composition or an already ordered list of items with kind/title.
function buildReferenceCompositionPrompt(value) {
  const items = Array.isArray(value)
    ? REFERENCE_ROLE_ORDER.flatMap(kind => value.filter(item => item?.kind === kind).slice(0, 1))
    : orderedReferenceSelections(value);
  if (!items.length) return '';
  const name = item => typeof item.title === 'string' && item.title.trim() ? `（${item.title.trim().slice(0, 80)}）` : '';
  const lines = items.length === 1
    ? [`请依据我提供的参考图创作。参考图是${REFERENCE_ROLE_PROMPTS[items[0].kind]}${name(items[0])}。`]
    : [`请依据我按顺序提供的 ${items.length} 张参考图创作：`,
      ...items.map((item, index) => `图${index + 1}是${REFERENCE_ROLE_PROMPTS[item.kind]}${name(item)}。`),
      '把以上参考合成为同一个人物，各图只取所述部分。'];
  return [...lines, '其余画面按我的场景要求创作：'].join('\n');
}
function readReferenceComposition(userId, storage) {
  const key = referenceCompositionKey(userId);
  if (!key) return {};
  if (referenceCompositionMemory.has(key)) return referenceCompositionMemory.get(key);
  try {
    const saved = JSON.parse((storage || globalThis.localStorage).getItem(key));
    return saved?.version === 1 ? normalizeReferenceComposition(saved.selections) : {};
  } catch { return {}; }
}
function writeReferenceComposition(userId, composition, storage) {
  const key = referenceCompositionKey(userId);
  if (!key) return false;
  const value = normalizeReferenceComposition(composition);
  referenceCompositionMemory.set(key, value);
  try { (storage || globalThis.localStorage).setItem(key, JSON.stringify({ version: 1, selections: value })); return true; }
  catch { return false; }
}

// --- Facet / grouping helpers --------------------------------------------
// The backend computes facets={styles,genders,categories,hairs,actions,angles} and
// groupCounts={face,costume,pose} from the whole dataset before pagination.
// These helpers only read what the backend sent; they never invent counts.
function facetList(source) {
  return Array.isArray(source) ? source.filter(entry => entry && typeof entry.value === 'string' && entry.value).map(entry => ({
    value: entry.value,
    count: Number.isFinite(entry.count) ? entry.count : 0,
    imageCount: Number.isFinite(entry.imageCount) ? entry.imageCount : (Number.isFinite(entry.count) ? entry.count : 0),
  })) : [];
}
const STYLE_FACETS = [
  { value: '', label: '全部' },
  { value: 'realistic', label: '真人写实' },
  { value: 'anime', label: '动漫' },
  { value: 'unmarked', label: '未标注' },
];
const GENDER_FACETS = [
  { value: '', label: '全部' },
  { value: 'female', label: '女性' },
  { value: 'male', label: '男性' },
  { value: 'neutral', label: '中性' },
  { value: 'unmarked', label: '未标注' },
];
function scopedFacetChips(options, source) {
  const counts = new Map(facetList(source).map(entry => [entry.value, entry.count]));
  return options.map(option => ({ ...option, count: option.value ? (counts.get(option.value) || 0) : null }));
}
// Angle pills: real values from facets.angles plus a synthetic "全部角度"
// aggregate (sum of real counts, not a fabricated number).
function angleChips(facets) {
  const angles = facetList(facets?.angles);
  const total = null;
  return [{ value: '', label: '全部角度', count: total }, ...angles.map(entry => ({ value: entry.value, label: entry.value, count: entry.count }))];
}
// Series/category chips: prefer the new facets (with group+image counts);
// fall back to the legacy plain-string category list with no fabricated count.
function categoryChips(data) {
  const fromFacets = facetList(data?.facets?.categories);
  if (fromFacets.length) return fromFacets;
  return Array.isArray(data?.categories) ? data.categories.filter(Boolean).map(value => ({ value, count: null, imageCount: null })) : [];
}
// Action chips come from manifest pose tags[1]; distinct from series/category.
function actionChips(data) { return facetList(data?.facets?.actions); }
function hairChips(data) {
  const fromFacets = facetList(data?.facets?.hairs);
  if (fromFacets.length) return fromFacets;
  return Array.isArray(data?.hairs) ? data.hairs.filter(Boolean).map(value => ({ value, count: null, imageCount: null })) : [];
}
// The top kind nav shows group counts for pose while grouped, raw counts otherwise.
function navKindCount(data, kind, grouped) {
  if (grouped && data?.groupCounts && Number.isFinite(data.groupCounts[kind])) return data.groupCounts[kind];
  return Number.isFinite(data?.counts?.[kind]) ? data.counts[kind] : null;
}
// group=pose is opt-in on the wire but the UI defaults poses to grouped;
// raw mode is an explicit choice and still supports angle/action filters.
function resolveMode(kind, modeParam) {
  if (kind !== 'pose') return 'raw';
  return modeParam === 'raw' ? 'raw' : 'group';
}
function groupVariants(item) {
  const angles = ['正面', '俯视', '仰视', '侧面', '斜45°'];
  const rank = angle => { const index = angles.indexOf(angle); return index < 0 ? angles.length : index; };
  if (Array.isArray(item?.variants) && item.variants.length) return item.variants.slice().sort((a, b) => rank(a.angle) - rank(b.angle));
  return [];
}
function groupKeyOf(item) {
  return JSON.stringify([item?.collectionId || '', item?.groupId || item?.id || '']);
}
// Random combination: each list is already randomly ordered by the backend
// (sort=random); this just keeps face/costume/pose role order and only
// includes roles that actually returned a result.
function pickRandomCombo(lists) {
  const picked = {};
  for (const kind of REFERENCE_ROLE_ORDER) {
    const list = Array.isArray(lists?.[kind]) ? lists[kind] : [];
    const item = list.find(entry => entry && entry.kind === kind);
    if (item) picked[kind] = item;
  }
  return picked;
}

// --- Minimal inline stroke icons (no emoji) -------------------------------
function ReferenceIconChevronDown({ className }) {
  return <svg className={className} viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ReferenceIconChevronLeft() {
  return <svg viewBox="0 0 16 16" width="18" height="18" fill="none" aria-hidden="true"><path d="M10 3l-5 5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ReferenceIconChevronRight() {
  return <svg viewBox="0 0 16 16" width="18" height="18" fill="none" aria-hidden="true"><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ReferenceIconFilter() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><path d="M2 3h12M4.5 8h7M7 13h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
}
function ReferenceIconShuffle() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><path d="M2 4h3l6 8h3M2 12h3l2.2-2.9M11 4h3M11 4l-1.7-1.7M11 4l-1.7 1.7M14 12l-1.7 1.7M14 12l-1.7-1.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ReferenceIconCheck() {
  return <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function AiArtCover({ active }) {
  const [images, setImages] = React.useState([]);
  const [coverFailed, setCoverFailed] = React.useState(false);
  React.useEffect(() => {
    if (!active || images.length) return;
    const controller = new AbortController();
    Promise.all(Object.keys(REFERENCE_LABELS).map(kind => api(`/api/reference-library?kind=${kind}`, { signal: controller.signal })))
      .then(libraries => { if (!controller.signal.aborted) { const covers = libraries.map(library => library.items[0]?.thumbnailUrl).filter(Boolean); setImages(covers); setCoverFailed(!covers.length); } })
      .catch(() => { if (!controller.signal.aborted) setCoverFailed(true); });
    return () => controller.abort();
  }, [active, images.length]);
  return <span className="ai-art-cover" aria-hidden="true">{!images.length && !coverFailed && <span className="ai-art-cover-loading" />} {images.map((src, index) => <img key={src} src={src} alt="" className={`ai-art-cover-${index}`} />)}</span>;
}

function AiArtWorkspace({ active, hash, showToast, onCreate, userId, user }) {
  return <section className="ai-art-workspace" aria-labelledby="ai-art-title">
    <a className="ai-art-back" href="#tools?space=mine">全部工具</a>
    <header className="ai-art-heading">
      <h1 id="ai-art-title">AI 作图</h1>
      <nav aria-label="AI 作图相关页面">
        <a className="btn btn-ghost" href="#works?space=mine">我的作品</a>
        <a className="btn" href="#studio?space=mine">创作台</a>
      </nav>
    </header>
    <ReferenceLibraryTool active={active} visible hash={hash} showToast={showToast} onCreate={onCreate} userId={userId ?? user?.id} />
  </section>;
}

function ReferenceComposer({ composition, kind, onShow, onBrowse, onRemove, onClear, onSend, sending, sendError, canSend, onRandomCombo, randomComboLoading, randomComboError }) {
  const selections = orderedReferenceSelections(composition), prompt = buildReferenceCompositionPrompt(composition);
  const previews = selections.filter(item => !item.originalReady).length;
  const [expanded, setExpanded] = React.useState(false);
  return <aside className={`reference-composer${expanded ? ' expanded' : ''}`} aria-labelledby="reference-composer-title">
    <header><button type="button" className="reference-composer-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><h2 id="reference-composer-title">当前组合 <small>{selections.length}/3</small></h2><ReferenceIconChevronDown /></button>
      <div className="reference-mini-previews">{REFERENCE_ROLE_ORDER.map(role => <button key={role} type="button" onClick={() => composition[role] ? onShow(composition[role]) : onBrowse(role)} aria-label={`查看${REFERENCE_LABELS[role]}组合槽`}>{composition[role]?.thumbnailUrl ? <img src={composition[role].thumbnailUrl} alt="" /> : <span>{REFERENCE_LABELS[role]}</span>}</button>)}</div>
      <button type="button" className="reference-tray-send" onClick={onSend} disabled={!selections.length || sending || !canSend}>{sending ? '准备中…' : '去创作台'}</button>
      <div className="reference-composer-header-actions">

        {selections.length > 0 && <button type="button" className="reference-text-button" onClick={onClear} disabled={sending}>清空</button>}
      </div>
    </header>
    <p className="reference-composer-hint">人物、服装、姿势各选一张，可在不同分类间切换选择。</p>
    {randomComboError && <p className="reference-composer-error" role="alert">{randomComboError}</p>}
    <ul className="reference-slots">{REFERENCE_ROLE_ORDER.map(role => {
      const item = composition[role];
      return <li key={role} className={`reference-slot${item ? ' filled' : ''}${kind === role ? ' current' : ''}`}>
        <div className="reference-slot-image">{item?.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" /> : <span aria-hidden="true">{REFERENCE_LABELS[role]}</span>}</div>
        <div className="reference-slot-body">
          <span className="reference-slot-role">{REFERENCE_LABELS[role]}</span>
          {item ? <strong title={item.title}>{item.title}</strong> : <span className="reference-slot-empty">未选择</span>}
          <div className="reference-slot-actions">{item ? <>
            <button type="button" onClick={() => onShow(item)} aria-label={`查看${REFERENCE_LABELS[role]}参考：${item.title}`}>查看</button>
            <button type="button" onClick={() => onBrowse(role)} aria-label={`更换${REFERENCE_LABELS[role]}参考`}>更换</button>
            <button type="button" onClick={() => onRemove(role)} disabled={sending} aria-label={`移除${REFERENCE_LABELS[role]}参考：${item.title}`}>移除</button>
          </> : kind !== role && <button type="button" onClick={() => onBrowse(role)}>去选择{REFERENCE_LABELS[role]}</button>}</div>
        </div>
      </li>;
    })}</ul>
    {prompt && <div className="reference-composer-prompt"><span>组合说明</span><p>{prompt}</p></div>}
    {previews > 0 && <p className="reference-composer-note">{`${previews} 张还没有原图，会先使用预览图。`}</p>}
    {sendError && <p className="reference-composer-error" role="alert">{sendError}</p>}
    <button type="button" className="btn btn-primary reference-send" onClick={onSend} disabled={!selections.length || sending || !canSend}>
      {sending ? '正在准备原图…' : selections.length ? `带 ${selections.length} 张参考图去创作台` : '先选择参考图'}</button>
    <p className="reference-composer-note">原图会保存到我的作品；在创作台确认后才会生成。</p>
  </aside>;
}

// A pose group card shows its five real variant thumbnails below the hero
// image; clicking a thumbnail only switches the hero shown on this card
// (local, no detail dialog needed). Selecting into the composition always
// uses whichever variant is currently shown as the hero.
function PoseGroupCard({ item, pickedId, onToggle, onOpen, selectLabel, sending }) {
  const variants = groupVariants(item);
  const options = variants.length ? variants : [item];
  const [heroIndex, setHeroIndex] = React.useState(0);
  React.useEffect(() => setHeroIndex(0), [item.id, options.map(v => v.id).join(',')]);
  const rawHero = options[heroIndex] || item;
  const hero = { ...rawHero, kind: rawHero.kind || item.kind };
  const picked = options.some(variant => variant.id === pickedId) || item.id === pickedId;
  const badge = item.stem?.match(/P\d+/i)?.[0] || '';
  return <li className={`reference-card reference-card-pose${picked ? ' picked' : ''}`}>
    <button type="button" className={`reference-card-select${hero.id === pickedId ? ' is-selected' : ''}`} aria-pressed={hero.id === pickedId} onClick={() => onToggle(hero)} disabled={sending} aria-label={`${selectLabel(hero)}：${hero.title}`}>
      {hero.id === pickedId ? <ReferenceIconCheck /> : <span aria-hidden="true">＋</span>}
    </button>
    <button type="button" className="reference-preview" onClick={() => onOpen(hero)} aria-label={`查看大图：${hero.title}`}>
      <div className="reference-image"><img loading="lazy" decoding="async" width="200" height="250" src={hero.thumbnailUrl} alt="" />
        {badge && <span className="reference-pose-code">{badge}</span>}
      </div>
      <div className="reference-caption"><strong>{hero.title}</strong><span>{hero.angle || item.category}</span></div>
    </button>
    {options.length > 1 && <ul className="reference-variant-strip" aria-label="可选角度">{options.slice(0, 5).map((variant, index) => <li key={variant.id || index}>
      <button type="button" className={index === heroIndex ? 'active' : ''} aria-pressed={index === heroIndex} onClick={() => setHeroIndex(index)} aria-label={`切换到${variant.angle || variant.title}角度`}>
        <img loading="lazy" decoding="async" src={variant.thumbnailUrl} alt="" /><span>{variant.angle || variant.title}</span>
      </button>
    </li>)}</ul>}
  </li>;
}

function ReferenceLibraryTool({ active, visible, hash, showToast, onCreate, userId }) {
  const params = workspaceHashParams(hash), kind = params.get('kind') || 'face';
  const query = params.get('q') || '', collection = params.get('collection') || '', category = params.get('category') || '', hair = params.get('hair') || '';
  const action = params.get('action') || '', angle = params.get('angle') || '', hairstyle = params.get('hairstyle') || '';
  const style = params.get('style') || '', gender = params.get('gender') || '';
  const requestScope = JSON.stringify([userId,kind,collection,query,category,hair,hairstyle,action,angle,style,gender,params.get('mode'),params.get('page'),params.get('sort'),params.get('originals')]);
  const mode = resolveMode(kind, params.get('mode'));
  const selectedId = params.get('reference') || '';
  const [search, setSearch] = React.useState(query), [snapshot, setSnapshot] = React.useState(null), [status, setStatus] = React.useState(null);
  const data = snapshot?.scope === requestScope ? snapshot.value : null;
  // Keep controls mounted while results for the next filter are loading.
  const navigationData = snapshot && snapshot.userId === userId ? snapshot.value : null;
  const filterData = snapshot && snapshot.userId === userId && snapshot.kind === kind ? snapshot.value : null;
  const [originalId, setOriginalId] = React.useState('');
  const [originalError, setOriginalError] = React.useState('');
  const [detail, setDetail] = React.useState(null), [error, setError] = React.useState(''), [detailError, setDetailError] = React.useState('');
  const [loading, setLoading] = React.useState(false), [sending, setSending] = React.useState(false), [revision, setRevision] = React.useState(0);
  const [expanded, setExpanded] = React.useState(false);
  const [randomOneLoading, setRandomOneLoading] = React.useState(false);
  const [randomComboLoading, setRandomComboLoading] = React.useState(false), [randomComboError, setRandomComboError] = React.useState('');
  const [composition, setComposition] = React.useState(() => readReferenceComposition(userId)), [sendError, setSendError] = React.useState('');
  const dialog = React.useRef(null), uploaded = React.useRef(new Map()), lastFocused = React.useRef(null);
  const gallery = React.useRef(null);
  React.useEffect(() => { if (gallery.current) gallery.current.scrollTop = 0; }, [requestScope]);
  const navigate = updates => {
    const next = new URLSearchParams(workspaceHashParams(window.location.hash));
    next.delete('tab'); next.set('space', 'mine');
    for (const [key, value] of Object.entries(updates)) value ? next.set(key, value) : next.delete(key);
    window.location.hash = `#ai-art?${next}`;
  };
  // Selections belong to the signed-in account; switching accounts reloads them.
  React.useEffect(() => { setComposition(readReferenceComposition(userId)); uploaded.current = new Map(); }, [userId]);
  const updateComposition = next => { setComposition(next); setSendError(''); writeReferenceComposition(userId, next); };
  const select = item => updateComposition(setReferenceSelection(composition, item));
  const remove = role => updateComposition(removeReferenceSelection(composition, role));
  React.useEffect(() => setSearch(query), [query]);
  React.useEffect(() => {
    if (!active || search === query) return;
    const timer = setTimeout(() => navigate({ q: search, page: '', reference: '' }), 300);
    return () => clearTimeout(timer);
  }, [search, query, active]);
  React.useEffect(() => {
    if (!active) return;
    const controller = new AbortController(), q = new URLSearchParams();
    for (const key of ['kind', 'collection', 'q', 'category', 'hair', 'hairstyle', 'action', 'angle', 'style', 'gender', 'page', 'sort', 'originals']) if (params.get(key)) q.set(key, params.get(key));
    if (kind === 'pose' && mode === 'group') q.set('group', 'pose');
    setLoading(true); setError('');
    api(`/api/reference-library?${q}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setSnapshot({ scope: requestScope, userId, kind, value }); }).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    api('/api/reference-library/status', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setStatus(value); }).catch(() => {});
    return () => controller.abort();
  }, [active, kind, collection, query, category, hair, hairstyle, action, angle, style, gender, mode, userId, params.get('page'), params.get('sort'), params.get('originals'), revision]);
  React.useEffect(() => {
    if (!active || !selectedId) return;
    const viewport = window.visualViewport;
    const resize = () => {
      const node = dialog.current;
      if (!node) return;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      const gap = width <= 720 ? 8 : 16;
      const panelWidth = Math.min(1120, width - gap * 2);
      node.style.setProperty('--detail-width', `${panelWidth}px`);
      node.style.setProperty('--detail-height', `${Math.max(160, height - gap * 2)}px`);
      node.style.setProperty('--detail-left', `${(viewport?.offsetLeft || 0) + (width - panelWidth) / 2}px`);
      node.style.setProperty('--detail-top', `${(viewport?.offsetTop || 0) + gap}px`);
      node.classList.toggle('is-compact', panelWidth < 760);
    };
    resize();
    window.addEventListener('resize', resize);
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
    };
  }, [active, selectedId]);
  React.useEffect(() => {
    if (!active || !selectedId) { setDetail(null); dialog.current?.close(); return; }
    const controller = new AbortController(); setDetailError(''); setOriginalId(''); setOriginalError(''); setDetail(null);
    if (!dialog.current?.open) { lastFocused.current = document.activeElement; dialog.current?.showModal(); }
    api(`/api/reference-library/items/${encodeURIComponent(selectedId)}`, { signal: controller.signal }).then(async value => {
      const preview = new Image();
      preview.src = value.thumbnailUrl;
      await preview.decode();
      if (!controller.signal.aborted) setDetail(value);
    })
      .catch(e => { if (!controller.signal.aborted) setDetailError(e.message); });
    return () => controller.abort();
  }, [active, selectedId]);
  React.useEffect(() => {
    if (!active) return;
    const before = document.body.style.overflow;
    if (selectedId) document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = before; };
  }, [active, selectedId]);
  const listIds = Array.isArray(data?.items) ? data.items.map(item => item.id) : [];
  const listIndex = detail ? (data?.items || []).findIndex(item => item.id === detail.id || groupVariants(item).some(v => v.id === detail.id)) : -1;
  const prevId = listIndex > 0 ? listIds[listIndex - 1] : null;
  const nextId = listIndex >= 0 && listIndex < listIds.length - 1 ? listIds[listIndex + 1] : null;
  React.useEffect(() => {
    if (!active || !selectedId) return;
    function onKey(e) {
      if (e.key === 'ArrowLeft' && prevId) navigate({ reference: prevId });
      else if (e.key === 'ArrowRight' && nextId) navigate({ reference: nextId });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, selectedId, prevId, nextId]);
  const close = () => { dialog.current?.close(); navigate({ reference: '' }); lastFocused.current?.focus?.(); };
  // Every selected original is re-read from the library and saved to the
  // account's works in role order, then handed to the studio in one step.
  // The studio's own draft overwrite confirmation and cost consent still apply.
  async function sendToStudio() {
    const selections = orderedReferenceSelections(composition);
    if (!selections.length || sending || !onCreate) return;
    setSending(true); setSendError('');
    try {
      const assets = [], items = [];
      for (const selection of selections) {
        const item = await api(`/api/reference-library/items/${encodeURIComponent(selection.id)}`);
        if (item.kind !== selection.kind) throw new Error(`${REFERENCE_LABELS[selection.kind]}参考已变化，请重新选择。`);
        const cacheKey = `${item.id}:${item.imageUrl}`;
        let asset = uploaded.current.get(cacheKey);
        if (!asset) {
          const response = await fetch(item.imageUrl, { credentials: 'same-origin' });
          if (!response.ok) throw new Error(`${REFERENCE_LABELS[item.kind]}参考图读取失败，请重试。`);
          const blob = await response.blob(), extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : 'webp';
          asset = await uploadMediaFile(new File([blob], `${item.stem}.${extension}`, { type: blob.type }), { title: item.title });
          uploaded.current.set(cacheKey, asset);
        }
        assets.push(asset); items.push(item);
      }
      const prompt = buildReferenceCompositionPrompt(items);
      const title = `组合参考：${items.map(item => REFERENCE_LABELS[item.kind]).join('、')}`;
      if (dialog.current?.open) { dialog.current.close(); close(); }
      await onCreate(assets[0], { ...items[0], title, prompt, composition: true, assets,
        referenceAssetIds: assets.map(asset => asset.id),
        references: items.map((item, index) => ({ kind: item.kind, id: item.id, title: item.title, assetId: assets[index].id, originalReady: item.originalReady === true })) });
    } catch (e) { setSendError(e.message); showToast?.(e.message); }
    finally { setSending(false); }
  }
  async function copyPrompt() {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(`请以我提供的${REFERENCE_LABELS[detail.kind]}参考图为依据。${detail.title}。${detail.tags.slice(0, 8).join('、')}。保留参考中的关键特征，并按我的场景要求创作。`);
      showToast?.('参考说明已复制，请与图片一起使用');
    } catch { showToast?.('无法访问剪贴板，请下载图片后使用'); }
  }
  // Honest single-item random: reuses the exact filters currently applied
  // (not just the current page), so the result can never mismatch the view.
  async function randomOne() {
    setRandomOneLoading(true);
    try {
      const q = new URLSearchParams();
      for (const key of ['kind', 'collection', 'q', 'category', 'hair', 'hairstyle', 'action', 'angle', 'style', 'gender', 'originals']) if (params.get(key)) q.set(key, params.get(key));
      q.set('sort', 'random'); q.set('page', '1');
      if (kind === 'pose' && mode === 'group') q.set('group', 'pose');
      const result = await api(`/api/reference-library?${q}`);
      const first = Array.isArray(result?.items) ? result.items[0] : null;
      if (first) navigate({ reference: first.id });
      else showToast?.('当前筛选范围内没有可用的参考图。');
    } catch (e) { showToast?.(e.message || '随机获取失败，请重试。'); }
    finally { setRandomOneLoading(false); }
  }
  // Random combination replaces face+costume+pose together, only on explicit
  // click, and shows the picked trio immediately with no upload/generation.
  async function randomCombo() {
    if (Object.keys(composition).length > 0) {
      const confirmed = (typeof window !== 'undefined' && typeof window.confirm === 'function') ? window.confirm('将替换当前已选的人物、服装、姿势参考，是否继续？') : true;
      if (!confirmed) return;
    }
    setRandomComboLoading(true); setRandomComboError('');
    try {
      const requestRole = async (roleKind, fixedStyle = style) => {
        const q = new URLSearchParams({ kind: roleKind, sort: 'random', page: '1' });
        if (fixedStyle) q.set('style', fixedStyle);
        if (gender) q.set('gender', gender);
        if (roleKind === 'pose') q.set('group', 'pose');
        const result = await api(`/api/reference-library?${q}`);
        return Array.isArray(result?.items) ? result.items : [];
      };
      // Pick the face first.  When no style is selected, its returned style
      // becomes the scope for costume and pose; an unknown style may not be
      // represented as a coherent visual family, so require an explicit style.
      if (!style) { setRandomComboError('请先选择“动漫”或其他已标注风格，再随机组合，避免混用不同画风。'); return; }
      const face = await requestRole('face');
      if (!face.length) { setRandomComboError('当前风格和性别范围内没有人物参考，未替换现有组合。'); return; }
      const fixedStyle = face[0].style || style;
      const [costume, pose] = await Promise.all([requestRole('costume', fixedStyle), requestRole('pose', fixedStyle)]);
      const missing = [['服装', costume], ['姿势', pose]].filter(([, rows]) => !rows.length).map(([label]) => label);
      if (missing.length) { setRandomComboError(`当前${fixedStyle === 'anime' ? '动漫' : '所选'}范围缺少${missing.join('、')}参考，未替换现有组合。`); return; }
      const picked = pickRandomCombo({ face: [face[0]], costume, pose });
      if (Object.keys(picked).length !== REFERENCE_ROLE_ORDER.length) { setRandomComboError('当前筛选无法组成完整参考组合，未替换现有组合。'); return; }
      updateComposition(normalizeReferenceComposition(picked));
    } catch (e) { setRandomComboError(e.message || '随机组合失败，请重试。'); }
    finally { setRandomComboLoading(false); }
  }
  const selectLabel = item => composition[item.kind]?.id === item.id ? '取消选择' : composition[item.kind] ? `替换${REFERENCE_LABELS[item.kind]}` : `选为${REFERENCE_LABELS[item.kind]}`;
  const toggle = item => composition[item.kind]?.id === item.id ? remove(item.kind) : select(item);
  const changeScopeFacet = (key, value) => {
    const next = value === (key === 'style' ? style : gender) ? '' : value;
    if (Object.keys(composition).length) {
      updateComposition({});
      showToast?.('已清除当前组合，避免与新的风格或性别范围混用。');
    }
    setRandomComboError('');
    navigate({ [key]: next, page: '', reference: '' });
  };
  if (!visible) return null;
  const totalLabel = filterData?.total || 0;
  return <section className="reference-library" aria-label="作图参考库">
    <div className="reference-sticky-controls">
    <div className="reference-toolbar"><a className="reference-back" href="#tools?space=mine" aria-label="全部工具"><ReferenceIconChevronLeft /></a>
      <div className="reference-kinds" aria-label="参考图类型">{KIND_NAV_ORDER.map(id => {
        const count = navKindCount(navigationData, id, id === 'pose');
        return <button key={id} type="button" className={kind === id ? 'active' : ''} aria-pressed={kind === id}
          onClick={() => { setSearch(''); navigate({ kind: id, q: '', category: '', hair: '', hairstyle: '', action: '', angle: '', page: '', reference: '' }); }}>
          <span>{REFERENCE_LABELS[id]}</span>
          {composition[id] && <><i className="reference-kind-picked" aria-hidden="true" /><b className="reference-visually-hidden">已选择</b></>}
          <span className="reference-kind-count">{count != null ? count.toLocaleString() : '—'}{id === 'pose' ? ' 组' : ''}</span>
        </button>;
      })}</div>
      <button type="button" className="reference-random-combo" onClick={randomCombo} disabled={randomComboLoading || sending}><ReferenceIconShuffle />{randomComboLoading ? '正在选取…' : '随机组合'}</button>
      <label className="reference-search"><IconSearch /><input aria-label="搜索参考图" type="search" placeholder="搜索名称、标签或编号" value={search} onChange={e => setSearch(e.target.value)} /></label><a className="reference-top-link" href="#works?space=mine">我的作品</a><a className="reference-top-link" href="#studio?space=mine">创作台</a>
    </div>
    {randomComboError && <p role="alert" className="reference-composer-error">{randomComboError}</p>}
    <div className="reference-filterbar">
      <div className="reference-filterbar-left">
        <span className="reference-count" aria-live="polite">{!filterData ? <span className="sk-line reference-count-skeleton" aria-label="正在加载数量" /> : `${totalLabel.toLocaleString()} ${kind === 'pose' && mode === 'group' ? '个姿势 / ' + (filterData?.imageTotal || 0).toLocaleString() + ' 张' : '项'}`}</span>
        <button type="button" className={`reference-expand-toggle${expanded ? ' open' : ''}`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ReferenceIconFilter />更多筛选<ReferenceIconChevronDown className="reference-chevron" /></button>
      </div>
      <div className="reference-filterbar-right">
        {kind === 'pose' && <div className="reference-mode-toggle" role="group" aria-label="姿势显示方式">
          <button type="button" className={mode === 'group' ? 'active' : ''} aria-pressed={mode === 'group'} onClick={() => navigate({ mode: '', page: '' })}>按姿势</button>
          <button type="button" className={mode === 'raw' ? 'active' : ''} aria-pressed={mode === 'raw'} onClick={() => navigate({ mode: 'raw', page: '' })}>按单张</button>
        </div>}
        <InlineSelect aria-label="排序方式" className="reference-sort" value={params.get('sort') || ''} onChange={e => navigate({ sort: e.target.value, page: '' })}><option value="">默认排序</option><option value="newest">最近加入</option></InlineSelect>
        <button type="button" className="reference-shuffle" onClick={randomOne} disabled={randomOneLoading}><ReferenceIconShuffle />{randomOneLoading ? '正在选取…' : '随机一个'}</button>
      </div>
    </div>
    <div className="reference-capsules" role="group" aria-label="系列分类"><span className="reference-row-label">{kind === 'pose' ? '系列' : kind === 'face' ? '类型' : '分类'}</span>
      <button type="button" className={category ? '' : 'active'} aria-pressed={!category} onClick={() => navigate({ category: '', page: '' })}>全部</button>
      {!filterData && [0,1,2].map(index => <span key={index} className="sk-line reference-chip-skeleton" aria-hidden="true" />)}
      {categoryChips(filterData).map(chip => <button key={chip.value} type="button" className={category === chip.value ? 'active' : ''} aria-pressed={category === chip.value} onClick={() => navigate({ category: category === chip.value ? '' : chip.value, hairstyle: '', page: '' })}>
        {kind === 'face' ? ({'脸部特写':'正脸','造型':'生活照'}[chip.value] || chip.value) : chip.value}{chip.count != null && <span>{chip.count.toLocaleString()}</span>}
      </button>)}
    </div>
    <div className="reference-chip-row reference-scope-facets" role="group" aria-label="画面风格"><span className="reference-row-label">风格</span>{scopedFacetChips(STYLE_FACETS, filterData?.facets?.styles).map(chip => <button key={chip.value || 'all'} type="button" disabled={chip.value === 'realistic' && chip.count === 0} className={style === chip.value ? 'active' : ''} aria-pressed={style === chip.value} onClick={() => changeScopeFacet('style', chip.value)}>{chip.label}{chip.count != null && <span>{chip.count.toLocaleString()}</span>}</button>)}</div>
    <div className="reference-chip-row reference-scope-facets" role="group" aria-label="性别标注"><span className="reference-row-label">性别</span>{scopedFacetChips(GENDER_FACETS, filterData?.facets?.genders).map(chip => <button key={chip.value || 'all'} type="button" className={gender === chip.value ? 'active' : ''} aria-pressed={gender === chip.value} onClick={() => changeScopeFacet('gender', chip.value)}>{chip.label}{chip.count != null && <span>{chip.count.toLocaleString()}</span>}</button>)}</div>
    <div className="reference-pose-filters">
      {kind === 'pose' && angleChips(filterData?.facets).length > 1 && <div className="reference-chip-row reference-angles-row" aria-label="角度"><span className="reference-row-label">机位</span>{angleChips(filterData?.facets).map(chip => <button key={chip.value || 'all'} type="button" className={angle === chip.value ? 'active' : ''} aria-pressed={angle === chip.value} onClick={() => navigate({ angle: chip.value, page: '' })}>{chip.label}{chip.count ? <span>{chip.count.toLocaleString()}</span> : null}</button>)}</div>}
      {kind === 'pose' && actionChips(filterData).length > 0 && <label className="reference-action-select"><span aria-hidden="true">{action || '全部动作'}<ReferenceIconChevronDown /></span><select aria-label="动作分类" value={action} onChange={e => navigate({action:e.target.value,page:''})}><option value="">全部动作</option>{actionChips(filterData).map(chip => <option key={chip.value} value={chip.value}>{chip.value}（{chip.count}）</option>)}</select></label>}
    </div>
    {expanded && <div className="reference-expanded">
      {kind === 'face' && hairChips(filterData).length > 0 && <div className="reference-chip-row" aria-label="头发长度"><span className="reference-row-label">发长</span><button type="button" className={!hair ? 'active' : ''} onClick={() => navigate({hair:'',page:''})}>全部</button>{hairChips(filterData).map(chip => <button key={chip.value} type="button" className={hair === chip.value ? 'active' : ''} aria-pressed={hair === chip.value} onClick={() => navigate({ hair: hair === chip.value ? '' : chip.value, hairstyle: '', page: '' })}>{chip.value}{chip.count != null && <span>{chip.count.toLocaleString()}</span>}</button>)}</div>}
      {kind === 'face' && <div className="reference-chip-row" aria-label="发型"><span className="reference-row-label">发型</span><button type="button" className={!hairstyle ? 'active' : ''} aria-pressed={!hairstyle} onClick={() => navigate({hairstyle:'',page:''})}>全部</button>{facetList(filterData?.facets?.hairstyles).map(chip => <button type="button" key={chip.value} className={hairstyle === chip.value ? 'active' : ''} aria-pressed={hairstyle === chip.value} onClick={() => navigate({hairstyle:hairstyle === chip.value ? '' : chip.value,page:''})}>{chip.value}<span>{chip.count}</span></button>)}</div>}
      <div className="reference-legacy">
        <InlineSelect className="reference-collection" aria-label="素材集" value={collection} onChange={e => { setSearch(''); navigate({ collection: e.target.value, category: '', hair: '', hairstyle: '', action: '', angle: '', reference: '', q: '', page: '' }); }}><option value="">全部素材集</option>{(navigationData?.collections || []).map(item => <option key={item.id} value={item.id}>{item.name}（{item.count.toLocaleString()}）</option>)}</InlineSelect>
        <label className="reference-original-filter"><input type="checkbox" checked={params.get('originals') === '1'} onChange={e => navigate({ originals: e.target.checked ? '1' : '', page: '' })} />原图已导入</label>
        <span className="reference-private">仅自己可见</span>
        <details className="reference-sync"><summary>{status?.state === 'syncing' ? '正在同步' : ['failed', 'partial'].includes(status?.state) ? '同步待重试' : '同步状态'}</summary><div className="reference-sync-info"><p>每天自动检查新增素材，已有图片保留。</p><p>最近一次新增 {status?.added || 0} 张，更新 {status?.changed || 0} 张。</p><p>已导入 {status?.originalCount || 0} 张原图；{status?.pendingOriginals || 0} 张等待原图。</p>{status?.checkedAt && <p>最近检查：{new Date(status.checkedAt).toLocaleString('zh-CN')}</p>}{status?.nextCheckAt && <p>下次检查：{new Date(status.nextCheckAt).toLocaleString('zh-CN')}</p>}{status?.error && <p role="status">上次同步未完成，已保存的素材仍可用。</p>}</div></details>
        <button type="button" className="reference-refresh" onClick={() => setRevision(value => value + 1)} disabled={loading}>刷新</button>
      </div>
    </div>}
    </div>
    <div className="reference-workspace"><div className="reference-gallery" ref={gallery} tabIndex={0} role="region" aria-label="参考图列表">
    {!error && !data && <div className="reference-grid reference-skeleton-grid" role="status" aria-label="正在加载参考图" aria-busy="true">{Array.from({length:12},(_,index)=><div key={index} className="reference-skeleton-card" aria-hidden="true"><div className="sk-line reference-skeleton-image" /><div className="sk-line lg" /><div className="sk-line sm" /></div>)}</div>}
    {error && <div className="reference-empty" role="alert">{error}<button className="btn" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
    {!error && !loading && data && !data.items.length && <div className="reference-empty"><strong>{data?.counts?.[kind] ? '没有匹配的参考图' : '素材正在准备'}</strong><p>{data?.counts?.[kind] ? '换个关键词，或清除分类筛选。' : '导入完成后，图片会显示在这里。'}</p></div>}
    {!error && data && <ul key={requestScope} className="reference-grid" aria-busy={loading || !data}>{data?.items.filter(item => item.kind === kind).map(item => (
      kind === 'pose' && mode === 'group'
        ? <PoseGroupCard key={groupKeyOf(item)} item={item} pickedId={composition.pose?.id} onToggle={toggle} onOpen={hero => navigate({ reference: hero.id })} selectLabel={selectLabel} sending={sending} />
        : (() => {
            const picked = composition[item.kind]?.id === item.id;
            return <li className={`reference-card reference-card-${item.kind}${picked ? ' picked' : ''}`} key={item.id}>
              <button type="button" className={`reference-card-select${picked ? ' is-selected' : ''}`} aria-pressed={picked} onClick={() => toggle(item)} disabled={sending} aria-label={`${selectLabel(item)}：${item.title}`}>
                {picked ? <ReferenceIconCheck /> : <span aria-hidden="true">＋</span>}
              </button>
              <button type="button" className="reference-preview" onClick={() => navigate({ reference: item.id })} aria-label={`查看大图：${item.title}`}>
                <div className="reference-image"><img loading="lazy" decoding="async" width="200" height="250" onLoad={item.kind === 'costume' ? prepareReferenceThumbnail : undefined} src={item.thumbnailUrl} alt="" /></div>
                <div className="reference-caption"><strong>{item.title}</strong><span>{item.angle || item.hair || item.category}</span></div>
              </button>
            </li>;
          })()
    ))}</ul>}
    {data?.pages > 1 && <nav className="reference-pagination" aria-label="参考图库分页"><button className="btn" disabled={data.page === 1 || loading} onClick={() => navigate({ page: String(data.page - 1) })}>上一页</button><span>{data.page} / {data.pages}</span><button className="btn" disabled={data.page === data.pages || loading} onClick={() => navigate({ page: String(data.page + 1) })}>下一页</button></nav>}
    </div>
    <ReferenceComposer composition={composition} kind={kind} sending={sending} sendError={sendError} canSend={Boolean(onCreate)}
      onShow={item => navigate({ reference: item.id })}
      onBrowse={role => { if (role !== kind) { setSearch(''); navigate({ kind: role, q: '', category: '', hair: '', hairstyle: '', action: '', angle: '', page: '', reference: '' }); } }}
      onRemove={remove} onClear={() => updateComposition({})} onSend={sendToStudio}
      onRandomCombo={randomCombo} randomComboLoading={randomComboLoading} randomComboError={randomComboError} />
    </div>
    <dialog className="reference-dialog" ref={dialog} aria-label="参考图详情" onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <button className="reference-close btn" aria-label="关闭参考图" onClick={close}><IconX /></button>
      {detail ? <div className="reference-detail">
          <div className="reference-detail-image">
            {prevId && <button type="button" className="reference-nav reference-nav-prev" aria-label="上一张" onClick={() => navigate({ reference: prevId })}><ReferenceIconChevronLeft /></button>}
            <img src={originalId === detail.id ? detail.imageUrl : detail.thumbnailUrl} onLoad={prepareReferenceThumbnail} onError={() => { if (originalId === detail.id) { setOriginalId(''); setOriginalError('原图加载失败，请重试。'); } }} alt={detail.title} />
            {nextId && <button type="button" className="reference-nav reference-nav-next" aria-label="下一张" onClick={() => navigate({ reference: nextId })}><ReferenceIconChevronRight /></button>}
          </div>
          <div className="reference-inspector">
            <span className="reference-detail-kind">{REFERENCE_LABELS[detail.kind]}参考 · {detail.category}{listIndex != null && listIndex >= 0 && data?.items.length ? ` · 第 ${listIndex + 1} / ${data.items.length} 项` : ''}</span>
            <h2>{detail.title}</h2>
            <p className="reference-detail-id">{detail.collectionName}<br />{detail.stem}</p>
            {detail.variants.length > 1 && <div className="reference-angles" aria-label="姿势角度">{detail.variants.map(item => <button key={item.id} className={item.id === detail.id ? 'active' : ''} onClick={() => navigate({ reference: item.id })}>{item.angle}</button>)}</div>}
            <div className="reference-detail-description"><p>{detail.title}。{detail.category ? `${detail.category}。` : ''}{detail.originalReady ? '已保存原图，可直接用于创作。' : '当前为预览图，原图导入后会自动替换，无需重新选择。'}</p><button type="button" className="reference-copy" onClick={copyPrompt}>复制参考说明</button></div>
            <div className="reference-tags">{detail.tags.slice(0, 12).map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</div>
            <button type="button" className={`reference-use${composition[detail.kind]?.id === detail.id ? ' is-selected' : ''}`} aria-pressed={composition[detail.kind]?.id === detail.id} onClick={() => toggle(detail)} disabled={sending}>
              {composition[detail.kind]?.id === detail.id ? '已加入组合' : `用作${REFERENCE_LABELS[detail.kind]}参考`}
            </button>
            {originalError && <p role="alert">{originalError}</p>}
            <div className="reference-detail-actions">{detail.originalReady && <button type="button" className="btn" onClick={() => { setOriginalError(''); setOriginalId(originalId === detail.id ? '' : detail.id); }}>{originalId === detail.id ? '返回预览图' : '查看原图'}</button>}<a className="btn" href={`${detail.imageUrl}?download=1`} download>{detail.originalReady ? '下载原图' : '下载预览图'}</a><a className="reference-source btn btn-ghost" href={detail.sourceUrl} target="_blank" rel="noopener noreferrer">查看素材来源</a></div>
          </div>
        </div> : detailError ? <div className="reference-detail-error" role="alert"><p>{detailError}</p><button className="btn" onClick={close}>返回图库</button></div> : <div className="reference-detail reference-detail-loading" aria-busy="true" aria-label="正在加载参考图详情">
          <div className="reference-detail-image"><div className="sk-line reference-detail-placeholder" /></div>
          <div className="reference-inspector" aria-hidden="true">
            <div className="sk-line" style={{width:'55%',height:12}} />
            <div className="sk-line" style={{width:'90%',height:24}} />
            <div className="sk-line" style={{width:'70%',height:14}} />
            <div className="sk-line" style={{width:'100%',height:100}} />
            <div className="sk-line" style={{width:'75%',height:30}} />
            <div className="sk-line" style={{width:'100%',height:40}} />
          </div>
        </div>}
    </dialog>
  </section>;
}
