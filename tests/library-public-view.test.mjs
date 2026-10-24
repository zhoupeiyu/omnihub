import test from 'node:test';
import assert from 'node:assert/strict';
import { publicPromptView } from '../lib/library-public-view.js';

test('legacy and pipeline publications retain preview media without exposing raw captures', () => {
  for (const pipeline of [false, true]) {
    const result = publicPromptView({ id:'example',title:'已发布成果',text:'可复用提示词',summary:'已发布总结',pipeline,
      sourceUrl:'https://fixture-user:fixture-password@x.com/author/status/123?token=fixture-query#fixture-fragment',
      sourceContent:'private-original',content:'private-original',image:'private-image',poster:'private-poster',
      media:[{type:'photo',url:'https://pbs.twimg.com/media/example.jpg',privateField:'private-image'}],mediaUrls:['private-image'],sourceMedia:'private-image',methodId:'method-1' });
    assert.equal(result.title,'已发布成果');assert.equal(result.text,'可复用提示词');assert.equal(result.methodId,'method-1');
    assert.equal(result.sourceUrl,'https://x.com/author/status/123');assert.equal(result.media[0].url,'https://pbs.twimg.com/media/example.jpg');
    assert.equal(result.mediaPrivate,false);
    assert.doesNotMatch(JSON.stringify(result),/fixture-user|fixture-password|fixture-query|fixture-fragment|private-original|private-image|private-poster/);
  }
});

test('published previews whitelist image hosts, archive routes and video variants', () => {
  const archived='/api/x-media/12/'+'a'.repeat(64);
  const result=publicPromptView({media:[
    {type:'photo',url:archived,alt_text:'效果图',unknown:'hidden'},
    {type:'photo',url:'https://user:secret@pbs.twimg.com/media/private.jpg'},
    {type:'photo',url:'https://evil.example/image.jpg'},
    {type:'photo',url:'/api/x-media/12/'+'b'.repeat(64)+'/extra'},
    {type:'video',preview_image_url:archived,variants:[
      {content_type:'video/mp4',bitrate:100,url:'https://video.twimg.com/example.mp4'},
      {content_type:'video/mp4',bitrate:900,url:'https://evil.example/private.mp4'}]},
  ]});
  assert.equal(result.media.length,2);assert.equal(result.media[0].url,archived);
  assert.equal(result.media[1].video_url,'https://video.twimg.com/example.mp4');
  assert.doesNotMatch(JSON.stringify(result),/secret|evil.example|unknown|hidden|variants|extra/);
});

test('public citations accept only canonical X post URLs', () => {
  for (const sourceUrl of ['javascript:alert(1)','https://evil.example/a/status/123','https://x.com/settings','not a url']) assert.equal(publicPromptView({sourceUrl}).sourceUrl,'');
});
