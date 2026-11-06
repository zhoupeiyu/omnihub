import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';

const source=readFileSync(new URL('../public/cephalon-settings.jsx',import.meta.url),'utf8');

test('Cephalon settings exposes a bounded read-only connection test with explicit state',()=>{
  assert.doesNotThrow(()=>transformSync(source,{loader:'jsx',target:'es2020'}));
  assert.match(source,/function testConnection\(\)/);
  assert.match(source,/api\('\/api\/cephalon\/connection-test',\{method:'POST',body:\{\}\}\)/);
  assert.match(source,/result\?\.connected===true/);
  assert.match(source,/测试连接/);
  assert.match(source,/busy==='test'\?'测试中…':'测试连接'/);
  assert.match(source,/phase:'unconfigured'/);
  assert.match(source,/phase:'unverified'/);
  assert.match(source,/phase:'testing'/);
  assert.match(source,/phase:'connected'/);
  assert.match(source,/phase:'failed'/);
  assert.match(source,/unconfigured:'未配置',unverified:'已保存，待测试',testing:'测试中',connected:'连接正常',failed:'测试失败'/);
  assert.match(source,/已验证服务密钥，可读取在线模型列表；尚未验证平台公私钥，不表示在线生成可用。/);
  assert.match(source,/在线模型 \$\{connection\.models\} 个/);
  assert.match(source,/setConnection\(\{phase:'unverified',message:'',models:null\}\)/);
  assert.match(source,/setConnection\(\{phase:'unconfigured',message:'',models:null\}\)/);
  assert.match(source,/service_key_required:'请先配置端脑云服务密钥后再测试。'/);
  assert.match(source,/authentication_rejected:'端脑云服务认证未通过，请核对接口配置与已保存的凭证。'/);
  assert.match(source,/service_unavailable:'端脑云服务暂不可用，请稍后重试并核对服务状态。'/);
  assert.match(source,/invalid_response:'端脑云返回无效响应，请稍后重试；若持续出现请核对接口配置。'/);
  assert.match(source,/err\?\.status===401/);
  assert.match(source,/服务认证未通过，请核对接口配置与已保存的凭证/);
  assert.doesNotMatch(source,/运行无费用预检/);
});
