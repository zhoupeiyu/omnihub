import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fetchMediaBytes, hash} from './repository-guide-pipeline.js';
export {repositoryMediaCandidates} from './repository-guide-pipeline.js';

const exec = promisify(execFile);

export function isAnimatedWebp(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) return false;
    if (name === 'ANIM') return true;
    offset += 8 + size + (size % 2);
  }
  return false;
}

export async function archiveRepositoryMedia(item, assets) {
  const maximumBytes = 8_000_000;
  const temp = await mkdtemp(path.join(tmpdir(), 'omnihub-guide-media-'));
  try {
    const {bytes, extension} = await fetchMediaBytes(item.url, {maximum: 40_000_000});
    const input = path.join(temp, `source.${extension}`), output = path.join(temp, 'preview.webp');
    await writeFile(input, bytes);
    const options = {maxBuffer: 65536, timeout: 60_000};
    const animatedInput = extension === 'webp' && isAnimatedWebp(bytes);
    let width, height;
    if (animatedInput) {
      const probe = await exec('webpmux', ['-info', input], options);
      const canvas = probe.stdout.match(/Canvas size: (\d+) x (\d+)/);
      if (canvas) [, width, height] = canvas.map(Number);
    } else {
      const probe = await exec('ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',input], options);
      ({width, height} = JSON.parse(probe.stdout).streams?.[0] || {});
    }
    if (!width || !height || width < 240 || height < 140 || width / height > 6 || height / width > 8 || width * height > 40_000_000) throw new Error('non_demo_dimensions');
    let converted;
    if (animatedInput) converted = bytes;
    else if (extension === 'gif') {
      await exec('gif2webp', ['-quiet','-lossy','-q','75','-metadata','none',input,'-o',output], options);
      converted = await readFile(output);
      if (converted.length > maximumBytes) {
        // Keep the full duration and animation; reduce resolution/frame rate
        // only when the full conversion cannot fit the preview budget.
        await exec('ffmpeg', ['-v','error','-y','-i',input,'-vf',"fps=12,scale=w='min(1200,iw)':h=-2",'-c:v','libwebp_anim','-q:v','70','-loop','0',output], options);
        converted = await readFile(output);
      }
    } else {
      await exec('cwebp', ['-quiet','-q','80',...(width > 1800 ? ['-resize','1800','0'] : []),input,'-o',output], options);
      converted = await readFile(output);
    }
    if (converted.length > maximumBytes) throw new Error('media_too_large');
    const name = `media-${hash(converted).slice(0,24)}.webp`;
    await writeFile(path.join(assets, name), converted);
    return {url:`/assets/repository-guides/${name}`,alt:(item.alt || item.heading || '仓库演示').slice(0,160),sourceUrl:item.sourceUrl,originalUrl:item.url,animated:isAnimatedWebp(converted)};
  } finally {
    await rm(temp, {recursive:true, force:true});
  }
}
