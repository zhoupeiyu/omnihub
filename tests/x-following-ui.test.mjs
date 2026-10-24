import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const source=readFileSync(new URL('../public/x-watch-accounts.jsx',import.meta.url),'utf8');
const compiled=transformSync(source+'\nglobalThis.View=XWatchAccountsView;', {loader:'jsx',target:'es2020'}).code;
const settings={accounts:[],available:false,dailyRequests:0,requestsToday:0};
const cache={available:true,handle:'zane9588',pages:1,generation:'fixture',users:[{id:'1',handle:'example',name:'示例',description:''}],
  complete:true,hasMore:false,limited:false,updatedAt:Date.parse('2026-09-29T10:00:00Z'),refreshAfter:0,skipped:0};

function createView({tab='following',picked=[],directory=cache,search='',accounts=[],sourceEditing=false,handle='zane9588',moreError='',busy='',group='',editing=null,api=()=>{}}={}) {
  let index=0;
  const states=[{...settings,accounts},directory,tab,handle,search,picked,'',group,editing,busy,'','',Date.now(),sourceEditing,moreError];
  const hooks={...React,useState:initial=>{const key=index++;return [key<states.length?states[key]:initial,value=>{states[key]=typeof value==='function'?value(states[key]):value;}];},useRef:value=>({current:value}),useEffect:()=>{}};
  const context=vm.createContext({React:hooks,URL,URLSearchParams,Date,setTimeout,clearTimeout,IntersectionObserver:function(){},api});
  vm.runInContext(compiled,context);
  return {element:context.View(),states};
}

function render(options) {
  return renderToStaticMarkup(createView(options).element);
}

test('cached following list has one refresh action without duplicated counters or an empty add form',()=>{
  const html=render();
  assert.match(html,/<button type="button" class="btn"[^>]*>刷新列表<\/button>/);assert.doesNotMatch(html,/拉取我的关注|返回关注动态|已选 0|暂无公开简介/);
  assert.doesNotMatch(html,/<form|添加到分组|启用后的采集间隔/);
  assert.equal((html.match(/已加载 1 人/g)||[]).length,1);assert.match(html,/仅拉取时计费/);
  assert.doesNotMatch(html,/<h2>监听账号|aria-label="我的 X 账号"|显示 1 人/);
  assert.match(html,/@zane9588 的关注/);assert.match(html,/更换账号/);
  const tabs=html.match(/<div class="watch-manager-tabs"[\s\S]*?<\/div>/)[0];
  assert.doesNotMatch(tabs,/手动添加/);assert.match(html,/手动添加/);
});

test('selection reveals the add form and retains the paused-state warning',()=>{
  const html=render({picked:['example']});
  assert.match(html,/<form/);assert.match(html,/添加到分组/);assert.match(html,/添加 1 个账号/);
  assert.match(html,/添加后默认暂停/);assert.doesNotMatch(html,/启用后的采集间隔/);
  assert.match(html,/<form class="watch-add-bar has-selection"/);
  assert.match(html,/<button type="button" class="watch-text-button"[^>]*>清空<\/button>/);
  assert.equal((html.match(/已选 1 人/g)||[]).length,1);
});

test('group picker offers organized presets and deduplicated existing groups without defaulting a selection',()=>{
  const html=render({picked:['example'],accounts:[{handle:'one',group:'币圈与 Web3'},{handle:'two',group:'我的研究'},{handle:'three',group:'我的研究'}]});
  assert.match(html,/<select required="" aria-label="添加到分组"/);
  assert.match(html,/<optgroup label="已有分组">/);
  for(const label of ['AI 与技术','商业与投资','内容与生活'])assert.ok(html.includes(`<optgroup label="${label}">`));
  for(const name of ['AI 资讯','AI 编程与 Agent','软件开发','开源项目','硬件与科技','币圈与 Web3','投资与交易','宏观经济','创业与商业','产品与设计','营销与增长','影视与短剧','图像与视频创作','写作与自媒体','知识与效率','生活与兴趣'])
    assert.ok(html.includes(`value="group:${name}"`),`Missing preset: ${name}`);
  assert.equal((html.match(/value="group:我的研究"/g)||[]).length,1);
  assert.equal((html.match(/value="group:币圈与 Web3"/g)||[]).length,1);
  assert.match(html,/<option value="" disabled="" selected="">选择分组<\/option>/);
  assert.match(html,/<option value="custom">自定义分组…<\/option>/);
  assert.doesNotMatch(html,/<datalist|aria-label="自定义分组名称"/);
});

test('group picker preserves custom names and is shared by manual entry and saved-account editing',()=>{
  const html=render({picked:['example'],group:'自己的新分类'});
  assert.match(html,/<input required="" aria-label="自定义分组名称" maxLength="60"[^>]*value="自己的新分类"/);
  assert.match(render({tab:'manual',group:'产品与设计'}),/<option value="group:产品与设计" selected="">/);
  const editing={id:1,handle:'one',group:'旧分组',intervalMinutes:30,dailyRequests:0,enabled:false};
  const saved=render({tab:'saved',accounts:[editing],editing});
  assert.match(saved,/<select required="" aria-label="编辑账号分组"/);
  assert.match(saved,/<option value="group:旧分组" selected="">/);
  assert.match(render({picked:['example'],busy:'add'}),/<select required="" aria-label="添加到分组" disabled=""/);
});

test('manual entry remains discoverable without a selection and explains validation limits',()=>{
  const html=render({tab:'manual'});
  assert.match(html,/<textarea/);assert.match(html,/<form/);assert.match(html,/不调用接口验证/);assert.match(html,/添加后默认暂停/);
});

test('incomplete and halted pages retain warnings even after copy simplification',()=>{
  const partial=render({directory:{...cache,complete:false,hasMore:true}});
  assert.match(partial,/未加载完整/);assert.match(partial,/滚动到底部自动加载/);
  assert.ok(partial.indexOf('watch-load-more')>partial.indexOf('watch-people-list'));
  assert.doesNotMatch(partial,/继续加载/);
  const halted=render({directory:{...cache,complete:false,limited:true,stopReason:'repeated_cursor',skipped:2}});
  assert.match(halted,/上游分页重复，已停止；名单未完整/);assert.match(halted,/已跳过 2 条无法识别/);
  assert.ok(halted.indexOf('上游分页重复')>halted.indexOf('watch-people-list'));
  assert.doesNotMatch(halted,/滚动到底部自动加载/);
});

test('pagination status and retry live below the cards, with a local-search pause',()=>{
  const directory={...cache,complete:false,hasMore:true};
  const loading=render({directory,busy:'more'});
  assert.match(loading,/正在加载更多账号/);
  assert.match(loading,/aria-busy="true"/);
  const failed=render({directory,moreError:'网络暂不可用'});
  assert.match(failed,/网络暂不可用/);assert.match(failed,/重试加载/);
  assert.ok(failed.indexOf('重试加载')>failed.indexOf('watch-people-list'));
  assert.doesNotMatch(failed,/滚动到底部自动加载/);
  const searching=render({directory,search:'example'});
  assert.match(searching,/仅搜索已加载账号/);assert.doesNotMatch(searching,/滚动到底部自动加载/);
  assert.match(render(),/已加载全部关注/);
});

test('card grid renders every loaded account, not just nine, with labeled checkboxes',()=>{
  const users=Array.from({length:50},(_,i)=>({id:String(i+1),name:`作者 ${i+1}`,handle:`author${i+1}`,description:'分享产品设计与开发经验'}));
  const html=render({directory:{...cache,users},picked:['author1'],accounts:[{handle:'author2',group:'研究'}]});
  assert.match(html,/<ul class="watch-people-list" aria-label="关注账号">/);
  assert.equal((html.match(/<li>/g)||[]).length,50);
  assert.equal((html.match(/aria-label="选择 @author/g)||[]).length,50);
  assert.match(html,/已加载 50 人/);assert.doesNotMatch(html,/显示 50 人/);assert.match(html,/全选已加载/);
  assert.match(html,/class="watch-person is-picked"/);
  assert.match(html,/aria-label="选择 @author2" disabled="" checked=""/);
  const filtered=render({directory:{...cache,users},search:'author50'});
  assert.equal((filtered.match(/<li>/g)||[]).length,1);
  assert.match(filtered,/找到 1 人/);assert.match(filtered,/全选搜索结果/);
});

test('source editing is explicit, cancellable, and does not enable an unchanged switch',()=>{
  const html=render({sourceEditing:true});
  assert.match(html,/aria-label="我的 X 账号"/);assert.match(html,/取消/);assert.match(html,/拉取并切换/);
  assert.match(html,/<button type="submit"[^>]*disabled=""[^>]*>拉取并切换/);
  assert.doesNotMatch(html,/>刷新列表<|继续加载/);
  const initial=render({directory:{...cache,users:[],pages:0,updatedAt:0,complete:false}});
  assert.match(initial,/aria-label="我的 X 账号"/);assert.match(initial,/拉取关注/);
});

test('refresh is explicit, shows progress, and retains the existing cooldown',()=>{
  assert.match(render(),/title="重新拉取 @zane9588 的关注名单，从第一页开始"/);
  assert.match(render({busy:'load'}),/<button type="button" class="btn" disabled=""[^>]*>刷新中…<\/button>/);
  const cooling=render({directory:{...cache,refreshAfter:Date.now()+600000}});
  assert.match(cooling,/<button type="button" class="btn" disabled="" title="每 10 分钟可刷新一次"[^>]*>刷新列表<\/button>/);
});

test('refresh button requests a fresh generation rather than appending or only reading cache',async()=>{
  const calls=[];
  const refreshed={...cache,pages:1,generation:'refreshed',users:[{id:'2',name:'最新账号',handle:'new_account'}]};
  const {element,states}=createView({directory:{...cache,pages:3},picked:['example'],api:async(path,options)=>{calls.push({path,...options});return refreshed;}});
  function findRefresh(node) {
    if(!node||typeof node!=='object')return;
    if(node.type==='button'&&node.props.children==='刷新列表')return node;
    for(const child of React.Children.toArray(node.props?.children)){const found=findRefresh(child);if(found)return found;}
  }
  await findRefresh(element).props.onClick();
  assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/x-watch/following');
  assert.equal(calls[0].method,'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)),{handle:'zane9588',action:'refresh',generation:'fixture',page:3});
  assert.equal(states[1],refreshed);assert.equal(states[5].length,0);assert.equal(states[9],'');
});

test('private accounts remain unselectable and avatar failures retain a name fallback',()=>{
  const html=render({directory:{...cache,users:[{id:'1',name:'作者',handle:'private',description:'',protected:true,avatar:'https://pbs.twimg.com/fixture.png'}]}});
  assert.match(html,/aria-label="选择 @private" disabled=""/);
  assert.match(html,/非公开账号/);
  assert.match(html,/<span aria-hidden="true">作<\/span><img/);
});

test('unavailable service keeps a manual-entry fallback and disabled polling status',()=>{
  assert.match(render({directory:{...cache,available:false}}),/当前环境未配置 SocialData，可手动添加账号/);
  const html=render({tab:'saved'});assert.match(html,/自动采集未启用/);assert.doesNotMatch(html,/最近 24 小时请求 0/);
});
