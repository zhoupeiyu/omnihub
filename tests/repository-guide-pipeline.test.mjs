import test from 'node:test';
import assert from 'node:assert/strict';
import {guideFilename,permittedMediaUrl,fetchGithubJson,fetchMediaBytes,boundedResponse,extractDocument,selectEvidence,compileGuide,compileGuideBatch,unsafeCommand,sanitizeGuideCommands,unverifiedProseCommand} from '../lib/repository-guide-pipeline.js';

const doc={repository:'owner/project',revision:'a'.repeat(40),path:'docs/README.md',sourceUrl:`https://github.com/owner/project/blob/${'a'.repeat(40)}/docs/README.md`,text:'# Project\nUseful public tool.\n## Install\nRequires Node 22.\n```sh\nnpm install example\n```\n## Usage\nRun in a test folder.\n![Editor](./screen.png)\n![badge](https://img.shields.io/test)\n<img src="../demo.jpg" alt="界面演示">\n![Logo](logo.png)\n'};
test('key filenames cannot escape output directory',()=>{
  assert.equal(guideFilename('Owner/Repo.Name'),'owner~repo.name.json');
  for(const key of ['../x/y','owner/repo/../../secret','owner/~repo','owner/%2e%2e','owner/repo?token=x'])assert.throws(()=>guideFilename(key));
});
test('document parsing pins relative media and preserves literal commands with evidence',()=>{
  const parsed=extractDocument(doc);
  assert.equal(parsed.codes[0].code,'npm install example');
  assert.equal(parsed.codes[0].sourceUrl,doc.sourceUrl+'#L5');
  assert.equal(parsed.media.length,2);
  assert.equal(parsed.media[0].url,`https://raw.githubusercontent.com/owner/project/${doc.revision}/docs/screen.png`);
  assert.equal(parsed.media[1].url,`https://raw.githubusercontent.com/owner/project/${doc.revision}/demo.jpg`);
  const evidence=selectEvidence([doc]);assert.equal(evidence.codes.length,1);
});
test('all media destinations and every redirect are allowlisted without credentials',async()=>{
  for(const url of ['http://raw.githubusercontent.com/a/b','https://127.0.0.1/x','https://github.com.evil.test/x','https://github.com/login','https://x:password@raw.githubusercontent.com/a/b','https://raw.githubusercontent.com:444/x'])assert.equal(permittedMediaUrl(url),null);
  let count=0;
  await assert.rejects(()=>fetchMediaBytes('https://raw.githubusercontent.com/a/b/main/x.png',{fetchImpl:async(url,options)=>{count++;assert.equal(options.headers,undefined);return new Response('',{status:302,headers:{location:'http://127.0.0.1/private'}});}}),/unsupported_media_host/);
  assert.equal(count,1);
});
test('GitHub credentials cannot follow a redirect outside its API host',async()=>{
  let count=0;
  await assert.rejects(()=>fetchGithubJson('https://api.github.com/repos/a/b','fake-test-token',{fetchImpl:async()=>{count++;return new Response('',{status:302,headers:{location:'https://evil.test'}});}}),/unsafe_github_url/);
  assert.equal(count,1);
});
test('response size and image signature are enforced independent of MIME header',async()=>{
  await assert.rejects(()=>boundedResponse(new Response('123456789'),4),/response_too_large/);
  await assert.rejects(()=>fetchMediaBytes('https://raw.githubusercontent.com/a/b/main/x.png',{fetchImpl:async()=>new Response('<svg onload="x">',{headers:{'content-type':'image/png'}})}),/unsupported_media_format/);
});
test('guide compilation requires real source IDs and never accepts generated commands',()=>{
  const record={key:'owner/project',canonicalKey:'owner/project',revision:doc.revision,documents:[doc]};
  const input={key:record.key,status:'ready',summary:'帮助开发者完成任务。',intro:'一个公开工具。',requirements:'准备 Node 22。',steps:[{title:'安装工具',text:'在终端安装。',sourceIds:['D0S1'],codeIds:['D0C0'],code:'invented command'}],mediaIds:['D0M0']};
  const result=compileGuide(record,input);
  assert.equal(result.steps[0].code,'npm install example');assert.equal(result.tested,false);assert.equal(result.example,null);
  assert.equal(result.selectedMedia[0].url,extractDocument(doc).media[0].url);
  assert.throws(()=>compileGuide(record,{...input,steps:[{...input.steps[0],codeIds:['D0C99']}]}),/unknown_code_source/);
  assert.throws(()=>compileGuide(record,{...input,steps:[{...input.steps[0],sourceIds:['fake']}]}),/unknown_step_source/);
  assert.throws(()=>compileGuide(record,{...input,mediaIds:['invented-image']}),/unknown_media_source/);
});
test('high privilege, deletion and piped installers are not offered as copyable instructions',()=>{
  for(const code of ['sudo npm install x','rm -rf /somewhere','curl https://example.com/install.sh | bash','docker compose down -v','agent --dangerously-skip-permissions','bash -c "$(curl https://example.com/install)"','bash <(curl https://example.com/script)','irm https://example.com | iex','chmod -R 777 folder','rm --recursive folder','git clean -fdx','docker system prune -a --volumes','docker run --privileged image'])assert.equal(unsafeCommand(code),true,code);
  assert.equal(unsafeCommand('git clone https://github.com/owner/repo.git\ncd repo\nnpm install'),false);
});
test('fence info inside code is literal content and malformed media links are skipped',()=>{
  const parsed=extractDocument({...doc,text:'# Test\n```markdown\n```bash\necho example\n```\n## Usage\nText\n![bad](https://[bad])\n![good](screen.png)'});
  assert.equal(parsed.codes[0].code,'```bash\necho example');
  assert.ok(parsed.sections.some(s=>s.heading==='Usage'));
  assert.equal(parsed.media.length,1);
  const list=extractDocument({...doc,text:'- Install\n\n    ```sh\n    git clone https://github.com/owner/project.git\n    ```\n'});
  assert.equal(list.codes[0].code,'    git clone https://github.com/owner/project.git');
});
test('one invalid guide does not discard successful siblings, and prose cannot bypass safety checks',()=>{
  const one={key:'owner/one',documents:[doc]},two={key:'owner/two',documents:[doc]};
  const valid={key:one.key,status:'ready',summary:'一个公开工具。',intro:'用官方说明配置工具。',steps:[{title:'安装工具',text:'准备安装环境。',sourceIds:['D0S1'],codeIds:['D0C0']}]};
  const batch=compileGuideBatch([one,two],[valid,{...valid,key:two.key,steps:[{...valid.steps[0],sourceIds:['unknown']}]}]);
  assert.equal(batch.guides.length,1);assert.equal(batch.errors[0].key,two.key);
  const sanitized=sanitizeGuideCommands({steps:[{text:'运行 sudo rm -rf folder',code:'sudo rm -rf folder'}]});
  assert.equal(sanitized.steps[0].code,undefined);assert.doesNotMatch(sanitized.steps[0].text,/sudo|rm -rf/);
  assert.equal(unverifiedProseCommand('执行 npm install invented-package。',[doc]),true);
  assert.equal(unverifiedProseCommand('执行 npm install example。',[doc]),false);
});
