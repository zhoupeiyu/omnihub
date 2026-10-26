import test from 'node:test';
import assert from 'node:assert/strict';
import { compactInboxListRow, inboxSearchMatches } from '../lib/inbox-list.js';
const row = (more = {}) => ({ id: 12, source: 'x', title: 'Title', author: '@author', url: 'https://x.com/a/status/12', content: 'brief note', aiSummary: 'AI summary', media: '[]', links: '[]', metrics: '{}', status: 'pending', visibility: 'private', ...more });
test('compact inbox index keeps queue signals while excluding source bodies and raw supplements', () => {
  const full = row({ content: 'body '.repeat(900), metrics: JSON.stringify({ article: { body: 'article source body' }, recoveredPost: { text: 'recovered' }, likes: 4, private: 'drop' }), aiExtract: JSON.stringify({ xOrganization: { topic:'software', assetType:'knowledge', groupId:'g', groupTitle:'Long group', coverage:'complete', contentIncomplete:false, private:'drop' }, xDigest:{summary:'long digest',status:'source_excerpt',private:'drop'} }), media: JSON.stringify([{ type:'video', preview_image_url:'https://pbs.twimg.com/poster.jpg', variants:[{content_type:'video/mp4',url:'https://video.twimg.com/low.mp4',bitrate:1},{content_type:'video/mp4',url:'https://video.twimg.com/high.mp4',bitrate:2}] }]) });
  const index = compactInboxListRow(full);
  assert.equal('content' in index, false); assert.equal(index.hasArticle, true); assert.equal(index.contentPreview.length, 180);
  assert.equal(JSON.parse(index.metrics).private, undefined); assert.deepEqual(JSON.parse(index.aiExtract).xOrganization, { topic:'software', assetType:'knowledge', groupId:'g', groupTitle:'Long group', coverage:'complete', contentIncomplete:false }); assert.equal(JSON.parse(index.media)[0].verifiedVideoUrl, 'https://video.twimg.com/high.mp4');
});
test('inbox search retains phrase semantics and finds full recovered/article material', () => {
  const full = row({ metrics: JSON.stringify({ recoveredPost:{text:'a recoverable original'}, article:{plainText:'long article only phrase'} }) });
  assert.equal(inboxSearchMatches(full, 'recoverable original'), true);
  assert.equal(inboxSearchMatches(full, 'article only phrase'), true);
  assert.equal(inboxSearchMatches(full, 'recoverable phrase'), false, 'Inbox phrase search does not silently become token AND');
  assert.equal(inboxSearchMatches(full, 'recoverable phrase', {terms:true}), true, 'token mode is explicit for Chat-like callers');
});
