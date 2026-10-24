import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadPromptMediaReview, promptPostUrl, reviewedPromptMedia, createPromptMediaSourceLookup } from '../lib/prompt-media.js';
import { publicPromptView } from '../lib/library-public-view.js';

const url = 'https://x.com/example/status/101';
const parent = 'https://x.com/example/status/100';
const original = {type:'photo',url:'https://pbs.twimg.com/media/original.jpg'};
const video = {type:'video',preview_image_url:'https://pbs.twimg.com/media/poster.jpg',variants:[
  {content_type:'video/mp4',bitrate:100,url:'https://video.twimg.com/clip.mp4'},
  {content_type:'video/mp4',bitrate:900,url:'https://untrusted.example/clip.mp4'}
]};
const records = new Map([[url,{status:'checked',posts:[
  {sourceUrl:url,relation:'original',media:[original]},
  {sourceUrl:parent,relation:'reply_parent',media:[video]},
]}]]);

test('reviewed media includes the actual parent video and keeps source provenance', () => {
  const media=reviewedPromptMedia({sourceUrl:url,media:[]},records);
  const publicView=publicPromptView({sourceUrl:url,media});
  assert.equal(publicView.media.length,2);
  assert.equal(publicView.media[1].video_url,'https://video.twimg.com/clip.mp4');
  assert.equal(publicView.media[1].sourceUrl,parent);
  assert.equal(publicView.media[1].sourceRelation,'reply_parent');
  assert.equal('variants' in publicView.media[1],false);
});

test('current related-source privacy and archive state override the reviewed snapshot', () => {
  const item={sourceUrl:url,media:[original]};
  for(const source of [{id:2,status:'pending',visibility:'private'},{id:2,status:'ignored',visibility:'public'}]) {
    assert.equal(reviewedPromptMedia(item,records,{findSource:key=>key===parent?source:null}).length,1);
  }
  assert.equal(reviewedPromptMedia(item,records,{publicOnly:false,findSource:key=>key===parent?{id:2,status:'pending',visibility:'private'}:null}).length,2);
});

test('archive rewriting uses each media source identity, not the prompt source identity', () => {
  const ids=[];
  reviewedPromptMedia({sourceUrl:url,sourceInboxId:1,media:[]},records,{
    findSource:key=>({id:key===parent?2:1,status:'pending',visibility:'public'}),
    rewrite:(id,media)=>{ids.push(id);return media;}
  });
  assert.deepEqual(ids,[1,2]);
});

test('real source lookup recognizes private legacy URLs by tweet ID and stays owner-scoped', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE inbox(id INTEGER, user_id INTEGER, source TEXT, external_id TEXT, url TEXT, visibility TEXT, status TEXT)");
    const insert = db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?,?,?)');
    insert.run(2,1,'x','100','http://twitter.com/OldHandle/status/100','private','pending');
    insert.run(3,2,'x','100',parent,'public','pending');
    const findSource = createPromptMediaSourceLookup(db,1);
    assert.equal(findSource(parent).id,2);
    assert.equal(reviewedPromptMedia({sourceUrl:url,media:[original]},records,{findSource}).length,1);
    db.prepare("UPDATE inbox SET visibility='public', status='ignored' WHERE user_id=1").run();
    assert.equal(reviewedPromptMedia({sourceUrl:url,media:[original]},records,{findSource:createPromptMediaSourceLookup(db,1)}).length,1);
  } finally { db.close(); }
});

test('unavailable or unmatched posts retain saved media and unsafe source links never escape', () => {
  assert.deepEqual(reviewedPromptMedia({sourceUrl:url,media:[original]},new Map()),[original]);
  assert.deepEqual(reviewedPromptMedia({sourceUrl:url,media:[original]},new Map([[url,{status:'unavailable'}]])),[original]);
  for(const bad of ['javascript:alert(1)','https://x.com.evil.test/example/status/101','https://user@x.com/example/status/101']) assert.equal(promptPostUrl(bad),'');
  assert.equal(promptPostUrl('https://twitter.com/Example/status/101'),'https://x.com/example/status/101');
});

test('both reported missing videos have explicit checked parent sources', () => {
  const reviewed=loadPromptMediaReview();
  for(const sourceUrl of ['https://x.com/CrazyKaomei/status/2098379528733401305','https://x.com/PixelAigc/status/2098198420116910084']) {
    const media=publicPromptView({sourceUrl,media:reviewedPromptMedia({sourceUrl,media:[]},reviewed)}).media;
    assert.ok(media.some(item=>item.type==='video'&&item.video_url&&item.sourceRelation==='reply_parent'));
  }
});
