import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';

const source = readFileSync(new URL('../public/refinery.jsx', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('function PromptVideoPlayer'), source.indexOf('function PromptExampleGallery'));
const media = {url:'https://pbs.twimg.com/poster.jpg', videoUrl:'https://video.twimg.com/clip.mp4'};

function setup(players = []) {
  const hooks = [];
  let cursor = 0, effects = [];
  const context = vm.createContext({
    React:{createElement:(type,props,...children) => ({type,props:{...props,children}})},
    PromptExampleImage:'poster', document:{querySelectorAll:() => players},
    useRefineryState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index],value => {hooks[index] = typeof value === 'function' ? value(hooks[index]) : value;}];
    },
    useRefineryRef(value) {const index=cursor++; return hooks[index] ||= {current:value};},
    useRefineryEffect(effect,deps) {
      const index=cursor++;
      if (!hooks[index] || deps.some((value,i) => value !== hooks[index][i])) effects.push(effect);
      hooks[index]=deps;
    }
  });
  vm.runInContext(transformSync(component,{loader:'jsx'}).code,context);
  return props => {
    cursor=0; effects=[];
    const tree=context.PromptVideoPlayer({media,...props});
    effects.forEach(effect=>effect());
    return tree;
  };
}

function find(node,type) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  for (const child of (Array.isArray(node) ? node : node.props?.children || [])) {
    const match=find(child,type); if(match) return match;
  }
  return null;
}

test('video playback starts only on click, pauses other players, and stops when its page is hidden', () => {
  let played=0, paused=0, otherPaused=0;
  const player={isConnected:true, play:()=>{played++;return Promise.resolve();}, pause:()=>{paused++;}};
  const render=setup([player,{pause:()=>{otherPaused++;}}]);
  let tree=render();
  find(tree,'video').props.ref.current=player;
  assert.equal(played,0);
  assert.equal(find(tree,'video').props.preload,'none');
  assert.equal(find(tree,'button').props['aria-label'],'播放视频');
  find(tree,'button').props.onClick();
  assert.equal(played,1);
  tree=render();
  assert.equal(find(tree,'button').props.disabled,true);
  find(tree,'video').props.onPlay({currentTarget:player});
  assert.equal(otherPaused,1); assert.equal(paused,0);
  find(tree,'video').props.onPlaying();
  assert.equal(find(render(),'button'),null);
  render({active:false}); assert.equal(paused,1);
});

test('failed requests offer a real retry and missing video files do not pretend to be playable', async () => {
  let reloaded=0;
  const player={isConnected:true,error:{code:2},load:()=>{reloaded++;},play:()=>Promise.reject(new Error('unavailable'))};
  const render=setup();
  let tree=render({sourceUrl:'https://x.com/example/status/1'});
  find(tree,'video').props.ref.current=player;
  find(tree,'button').props.onClick();
  await Promise.resolve();
  tree=render({sourceUrl:'https://x.com/example/status/1'});
  assert.equal(find(tree,'button').props['aria-label'],'重试播放视频');
  assert.equal(find(tree,'a').props.href,'https://x.com/example/status/1');
  player.play=()=>Promise.resolve();
  find(tree,'button').props.onClick();
  assert.equal(reloaded,2);
  assert.equal(find(render(),'button').props.disabled,true);
  const missing=setup()({media:{url:media.url},sourceUrl:'https://x.com/example/status/1'});
  assert.equal(find(missing,'video'),null);
  assert.equal(find(missing,'button'),null);
  assert.equal(find(missing,'a').props.href,'https://x.com/example/status/1');
});
