// Record the review of non-public source material without changing visibility or the DB.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const directory = new URL('../data/audits/x-classification-20260928/', import.meta.url);
const rows = JSON.parse(readFileSync(new URL('local-only.json', directory), 'utf8'));
const output = new URL('decisions-local.jsonl', directory);
if (existsSync(output)) throw new Error('Reuse the existing audit; do not overwrite it.');
const explicit = new Map([
  [65, ['keep','resource','私密资源目录','检索目录中的账号资料','正文介绍目录检索与分组功能，不含可复制提示词或操作教程。','媒体未审阅；保持私密。','私密账号目录的检索与分组入口']],
  [88, ['keep','resource','私密资源目录','浏览带封面和搜索功能的目录','正文为资源网站的功能介绍，与另一条目录收藏有关联，不是方法文章。','媒体未审阅；保持私密。','私密资源目录的图文浏览入口']],
  [114, ['reclassify','reference','盆底肌训练','识别训练营销中的效果宣称','正文将训练与未经证实的效果保证相连，属于待核验营销材料，不能提炼成已验证的训练知识。','视频未审阅；医疗效果未核实，保持私密。','盆底肌训练营销内容与待核验主张']],
  [1152, ['reclassify','resource','私密商店清单','保留商店名称供本人检索','正文为多个商店名称的清单，不是提示词、仓库或具体教程。','店铺真实性与商品未核实；保持私密。','私密商店名称清单']],
  [1314, ['insufficient','reference','盆底肌训练视频','保存训练视频线索','正文只有训练主题与视频链接，没有动作说明，不能据标题整理操作方法。','视频内容未审阅；保持私密，不输出训练指导。','盆底肌训练视频待补充说明']],
  [1668, ['keep','resource','盆底肌训练视频','保留五项训练的视频资源','文字能确定视频主题，但没有动作细节，资源分类可保留，不能当作已核验教程。','视频未审阅，效果与适用人群未核实；保持私密。','五项盆底肌训练的视频资源']],
  [1700, ['reclassify','reference','盆底肌训练','区分动作视频与效果宣称','正文包含肌肉和激素效果的推断，没有给出可核验依据，只能保留为待核验参考。','视频与医疗主张未核实；保持私密。','盆底肌训练视频中的效果主张待核验']],
  [1731, ['reclassify','reference','Bilibili 国际版','辨认国际版的地区定位','正文澄清服务面向的地区，属于简短平台说明，没有具体操作流程。','服务当前状态未核实；保持私密。','Bilibili 国际版与地区定位说明']],
  [3952, ['insufficient','reference','Qwen Image / Hojo ASR','核对正文与引用的关联','正文介绍图像模型，引用却是长篇语音识别比较，主题明显不同，不能直接合成同一篇方法。','先核对引用关联；图片未审阅，原状态保持未审核。','图像模型帖子与语音识别引用的关联待核对']],
  [3959, ['reclassify','resource','Qwen Image','保留图像模型量化版本线索','正文为图像模型及硬件需求的介绍，没有完整提示词或已识别的仓库入口；主题宜为图像而非通用软件。','模型与硬件宣称未验证，图片未审阅；保持未审核。','Qwen Image 量化版本与硬件需求线索']],
]);
const repositoryLinks = new Map([
  [141,'miuuyy/codex-chatgpt-web'],[310,'droidrun/mobile-harness'],
  [521,'google-labs-code/design.md'],[1206,'Justineo/working-with-ai'],
]);
const decisions = rows.map(row => {
  const item = explicit.get(row.id);
  if (item) {
    const [verdict,primary,tool,purpose,reason,uncertainty,suggestedTitle] = item;
    return {id:row.id,verdict,primary,secondary:[],tool,purpose,reason,
      evidence:row.text.slice(0,100),suggestedTitle,uncertainty};
  }
  // These 375 records were checked: all have no body beyond a short URL,
  // no quoted text and no media. This is an evidence-availability ledger,
  // not semantic classification of the unread linked article.
  if (row.status !== 'ignored' || row.quote || row.media.length ||
      (row.text && !/^https:\/\/t\.co\/[A-Za-z0-9]+$/.test(row.text))) {
    throw new Error(`Unexpected source content requires individual review: ${row.id}`);
  }
  const repository = repositoryLinks.get(row.id);
  const site = row.id === 512;
  return {id:row.id,verdict:'insufficient',primary:repository ? 'repository' : site ? 'resource' : 'unavailable',secondary:[],
    tool:repository || (site ? 'Product Design Psychology' : '未确定'),
    purpose:repository ? '保留可识别的仓库地址，具体用途待补' : site ? '保留产品设计心理学网站地址，具体内容待补' : '等待补回原始正文后再分类',
    reason:repository ? '展开链接可识别仓库实体，但数据库没有介绍或方法，不能推断用途，也不自动恢复公开。' : site ? '展开链接可识别网站，但没有正文说明，不能据域名编写方法。' : row.text ? '仅保存短链接和文章地址，没有正文、引用或媒体，无法判定文章主题。' : '正文、链接、引用与媒体均为空，缺少可分类证据。',
    evidence:repository || site ? row.links[0] : row.text,
    suggestedTitle:repository ? `${repository} 仓库入口待补充介绍` : site ? 'Product Design Psychology 网站入口待补充介绍' : '原始正文缺失，暂不生成知识标题',
    uncertainty:'链接目标正文未读取；维持忽略状态，不据此声称已阅读全文。'};
});
if (decisions.length !== 385 || new Set(decisions.map(row=>row.id)).size !== rows.length) throw new Error('Coverage mismatch');
writeFileSync(output,decisions.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({output:fileURLToPath(output),count:decisions.length,bodyReviewed:explicit.size,missingBody:decisions.length-explicit.size,databaseModified:false}));
