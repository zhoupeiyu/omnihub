import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import '../public/library-order.js';

const source = readFileSync(new URL('../public/refinery.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/prompt-library.css', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function promptMediaIndex'), source.indexOf('function PromptMediaViewer'));
const context = vm.createContext({ PROMPT_TAG_LABELS: { cinematic: '电影感', cinematicStyle: '电影感' } });
vm.runInContext(helpers, context);

test('media selection remains bounded for empty, single and multi-image collections', () => {
  for (const [index, count, expected] of [[0, 0, 0], [3, 1, 0], [-1, 4, 0], [4, 4, 3], [2, 4, 2], [NaN, 4, 0]]) {
    assert.equal(context.promptMediaIndex(index, count), expected);
  }
});

test('swiping requires intentional horizontal movement, not a tap or vertical scroll', () => {
  const start = { clientX: 100, clientY: 100 };
  assert.equal(context.promptSwipeDirection(start, { clientX: 30, clientY: 105 }), 1);
  assert.equal(context.promptSwipeDirection(start, { clientX: 175, clientY: 105 }), -1);
  assert.equal(context.promptSwipeDirection(start, { clientX: 90, clientY: 105 }), 0);
  assert.equal(context.promptSwipeDirection(start, { clientX: 30, clientY: 210 }), 0);
  assert.equal(context.promptSwipeDirection(null, start), 0);
});

test('display tags are deduplicated after localization without changing the source', () => {
  const tags = ['cinematic', 'cinematicStyle', '电影感', 'gpt_image'];
  assert.equal(JSON.stringify(context.promptDisplayTags(tags)), JSON.stringify(['电影感', 'gpt_image']));
  assert.equal(tags.length, 4);
});

test('card thumbnails switch only the cover and overflow opens the complete original set', () => {
  const card = source.slice(source.indexOf('function PromptLibraryCard'), source.indexOf('function PromptDetail'));
  assert.match(card, /<article className=/);
  assert.match(card, /media\.slice\(0, 4\)/);
  assert.match(card, /onClick=\{\(\) => selectCover\(i\)\}/);
  assert.match(card, /setCoverHeight\(cover.current\?\.getBoundingClientRect\(\).height/);
  assert.match(card, /media\.length > 4/);
  assert.match(card, /onPreview\(item, 4\)/);
  assert.match(card, /onPreview\(item, index\)/);
  assert.match(card, /onOpen\(item, index\)/);
  assert.match(card, /!current && <p>/);
});

test('detail is an independent overlay and preserves full source text and media order', () => {
  const drawerCss = readFileSync(new URL('../public/detail-drawer.css', import.meta.url), 'utf8');
  assert.match(drawerCss, /\.detail-drawer \{[^}]*position:fixed/);
  assert.match(drawerCss, /overscroll-behavior:contain/);
  assert.match(drawerCss, /prefers-reduced-motion:reduce/);
  assert.match(source, /<DetailDrawer id="prompt-detail"/);
  assert.match(source, /<pre>\{content.text\}<\/pre>/);
  assert.match(source, /clipboard.writeText\(item.text\)/);
  assert.match(source, /media\.map\(\(entry, i\)/);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /label = "原帖配图"/);
  assert.match(source, /aria-label=\{`\$\{label\}预览`\}/);
  assert.match(source, /event.key === "Tab"/);
  assert.doesNotMatch(source, /autoPlay/);
});

function renderLibrary() {
  const states = [];
  let cursor = 0;
  const runtime = vm.createContext({
    OmniHubLibraryOrder:globalThis.OmniHubLibraryOrder,
    React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},
    useRefineryState(initial) {
      const slot = cursor++;
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
      return [states[slot], value => {states[slot] = typeof value === 'function' ? value(states[slot]) : value;}];
    },
    useRefineryRef:()=>({current:null}),useRefineryEffect:()=>{},
    document:{activeElement:null},inboxMedia:item=>item.media||[],
    PROMPT_TAG_LABELS:{cinematic:'电影感'},PromptLibraryCard:'card',PromptDetail:'detail',PromptMediaViewer:'viewer',
  });
  vm.runInContext(helpers+'\n'+transformSync(source.slice(source.indexOf('function PromptLibraryView')), {loader:'jsx'}).code, runtime);
  return props => {cursor=0;return runtime.PromptLibraryView({query:'',...props});};
}
function findElement(node, type) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  for (const child of (Array.isArray(node) ? node : node.props?.children || [])) {
    const found = findElement(child,type); if(found)return found;
  }
  return null;
}

test('list image opens the selected image directly; text opens detail instead', () => {
  const render = renderLibrary();
  const item = {id:1,title:'Pictures',tags:[],media:[{url:'one.jpg'},{url:'two.jpg'}]};
  const props = {items:[item]};
  findElement(render(props),'card').props.onPreview(item,1);
  let tree = render(props);
  assert.equal(findElement(tree,'viewer').props.index,1);
  assert.equal(findElement(tree,'detail'),null);
  findElement(tree,'viewer').props.onSelect(0);
  assert.equal(findElement(render(props),'viewer').props.index,0);
  findElement(render(props),'viewer').props.onClose();
  assert.equal(findElement(render(props),'viewer'),null);
  findElement(render(props),'card').props.onOpen(item,1);
  tree = render(props);
  assert.equal(findElement(tree,'detail').props.initialIndex,1);
  assert.equal(findElement(tree,'viewer'),null);
  findElement(tree,'card').props.onPreview(item,0);
  assert.equal(findElement(render(props),'detail'),null);
  assert.equal(findElement(render({...props,active:false}),'viewer'),null);
});

test('video covers keep the original playable detail entry and empty media does not open a viewer', () => {
  const render = renderLibrary();
  const item = {id:2,title:'Video',tags:[],media:[{url:'poster.jpg',video:true,videoUrl:'video.mp4'}]};
  const props = {items:[item]};
  findElement(render(props),'card').props.onPreview(item,0);
  assert.equal(findElement(render(props),'detail').props.initialIndex,0);
  assert.equal(findElement(render(props),'viewer'),null);
  findElement(render(props),'detail').props.onClose();
  findElement(render(props),'card').props.onPreview({...item,media:[]},0);
  assert.equal(findElement(render(props),'viewer'),null);
});


test('reading separates trailing X attachment links without changing URLs used in the prompt', () => {
  const original = 'Create an image.\nKeep this spacing.\n\nhttps://t.co/Ab123\nhttps://t.co/Cd456';
  const result = context.promptReadingContent(original);
  assert.equal(result.text, 'Create an image.\nKeep this spacing.');
  assert.deepEqual(Array.from(result.links), ['https://t.co/Ab123','https://t.co/Cd456']);
  for (const text of ['Open https://t.co/Ab123 in the browser.', 'Use this URL:\nhttps://example.com/model', 'https://t.co/Ab123', 'Copy this code:\n```text\nhttps://t.co/Ab123', 'Copy this code:\n~~~\nhttps://t.co/Ab123']) {
    assert.equal(context.promptReadingContent(text).text, text);
    assert.equal(context.promptReadingContent(text).links.length, 0);
  }
  assert.equal(context.promptReadingContent(original,true).text,original);
  assert.equal(context.promptReadingContent('Frame in 9:16 https://t.co/Ab123').text,'Frame in 9:16');
  assert.equal(context.promptReadingContent('Keep <instructions> and **markdown** intact.').text, 'Keep <instructions> and **markdown** intact.');
});

function findAll(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...(Array.isArray(node) ? node : node.props?.children || []).flatMap(child => findAll(child,predicate))];
}

test('category tabs combine with search and facets; switching tabs clears stale facets', () => {
  const render = renderLibrary();
  const items = [
    {id:1,title:'Cat image',text:'Draw',category:'图像生成',tags:['cinematic'],facets:{subject:{value:'animal'},style:{value:'cinematic'}}},
    {id:2,title:'Cat film',text:'Record',category:'视频生成',tags:[],facets:{subject:{value:'animal'},style:{value:'photorealistic'}}},
    {id:3,title:'Code',text:'Build',category:'编程',tags:[],facets:{subject:{value:'software'}}}
  ];
  const props = {items};
  const tab = (tree,value) => findAll(tree,node => node.props?.role === 'tab').find(node => node.props.children[0] === value);
  const cards = tree => findAll(tree,node => node.type === 'card').map(node => node.props.item.id);
  let tree = render(props);
  assert.deepEqual(cards(tree),[1,2,3]);
  tab(tree,'图像生成').props.onClick();
  tree = render(props);
  assert.deepEqual(cards(tree),[1]);
  findAll(tree,node => node.type === 'select' && node.props['aria-label'] === '按风格筛选提示词')[0].props.onChange({target:{value:'cinematic'}});
  tab(render(props),'视频生成').props.onClick();
  assert.deepEqual(cards(render(props)),[2]);
  tab(render(props),'全部').props.onClick();
  assert.deepEqual(cards(render({...props,query:'Cat'})),[1,2]);
  assert.deepEqual(cards(render({...props,query:'电影感'})),[1]);
  assert.deepEqual(cards(render({...props,query:'no match'})),[]);
});
