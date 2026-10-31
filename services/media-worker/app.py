"""Bounded local media worker.  It never accepts a filesystem path or shell text from HTTP."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import ipaddress
import json
import mimetypes
import math
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from urllib.request import Request as URLRequest, build_opener, ProxyHandler, HTTPRedirectHandler
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field, model_validator
from gallery import extract_image_candidates, is_available as gallery_available
from video_edit import ASPECTS, build_command as build_edit_command, build_concat_command

ROOT = Path(os.getenv('MEDIA_WORKER_ROOT', '/var/lib/media-worker')).resolve()
FILES = ROOT / 'files'
TMP = ROOT / 'tmp'
DB_PATH = ROOT / 'jobs.sqlite3'
TOKEN = os.getenv('MEDIA_WORKER_TOKEN', '')
MAX_UPLOAD = int(os.getenv('MEDIA_WORKER_MAX_UPLOAD_BYTES', str(100 * 1024 * 1024)))
MAX_OUTPUT = int(os.getenv('MEDIA_WORKER_MAX_OUTPUT_BYTES', str(250 * 1024 * 1024)))
CACHE_LIMIT = int(os.getenv('MEDIA_WORKER_CACHE_BYTES', str(2 * 1024 * 1024 * 1024)))
TIMEOUT = int(os.getenv('MEDIA_WORKER_JOB_TIMEOUT_SECONDS', '600'))
THREADS = max(1, min(2, int(os.getenv('MEDIA_WORKER_THREADS', '2'))))
QUEUE: asyncio.Queue[str] = asyncio.Queue(maxsize=8)
WORKER: asyncio.Task | None = None
ALLOWED_INPUT = {'video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'image/jpeg', 'image/png', 'image/webp'}
IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/webp'}
GALLERY_IMAGE_TYPES = {'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp'}
Image.MAX_IMAGE_PIXELS = 16_000_000
MEDIA_FORMATS = {
    'video/mp4': {'mov,mp4,m4a,3gp,3g2,mj2'},
    'video/webm': {'matroska,webm'},
    'audio/mpeg': {'mp3'},
    'audio/mp4': {'mov,mp4,m4a,3gp,3g2,mj2'},
    'audio/wav': {'wav'},
}
FORMATS = {'mp4', 'webm', 'mp3', 'wav', 'png', 'jpeg'}
PLATFORMS = ('youtube.com', 'youtu.be', 'vimeo.com', 'x.com', 'twitter.com', 'instagram.com', 'soundcloud.com')
GALLERY_PLATFORMS = ('imgur.com', 'imgur.io')
ADVANCED_MODELS = Path(os.getenv('MEDIA_ADVANCED_MODELS', '/models/advanced'))
ADVANCED_RUNNER = Path(os.getenv('MEDIA_ADVANCED_RUNNER', '/opt/advanced/advanced-runner.py'))


def advanced_features() -> dict[str, bool]:
    enabled = os.getenv('MEDIA_ADVANCED_ENABLED', '').split(',')
    runner = ADVANCED_RUNNER.is_file()
    return {
        'subtitles': runner and 'subtitles' in enabled and (ADVANCED_MODELS / 'faster-whisper-base/model.bin').is_file(),
        'translation': runner and 'translation' in enabled and all((ADVANCED_MODELS / 'argos' / direction / filename).is_file() for direction in ('en_zh', 'zh_en') for filename in ('model/model.bin', 'sentencepiece.model')),
        'separation': runner and 'separation' in enabled and (ADVANCED_MODELS / 'uvr-mdx/UVR-MDX-NET-Inst_HQ_3.onnx').is_file(),
    }


def fail(status: int, message: str) -> HTTPException:
    return HTTPException(status, message)


def safe_name(value: str) -> str:
    if not value or Path(value).name != value or value in {'.', '..'} or not re.fullmatch(r'[\w. -]{1,180}', value):
        raise fail(400, '文件名不合法。')
    return value


def display_name(value: str) -> str:
    if not value or len(value) > 180 or any(ord(c) < 32 or c in {'/', '\\', '\x7f'} for c in value) or value in {'.', '..'}:
        raise fail(400, '文件名不合法。')
    return value


def clean_error(error: BaseException) -> str:
    text = str(error).replace(str(ROOT), '<storage>').replace(str(TMP), '<tmp>')
    return re.sub(r'https?://\S+', '<remote-url>', text)[:280] or '处理失败，请稍后重试。'


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def init_db() -> None:
    ROOT.mkdir(parents=True, exist_ok=True); FILES.mkdir(exist_ok=True); TMP.mkdir(exist_ok=True)
    for item in (ROOT, FILES, TMP): item.chmod(0o700)
    db = connect()
    db.execute('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, created REAL NOT NULL, updated REAL NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL)')
    db.execute('CREATE INDEX IF NOT EXISTS jobs_updated ON jobs(updated)')
    db.commit(); db.close()


def write(job: dict[str, Any]) -> dict[str, Any]:
    job['updated'] = time.time()
    db = connect(); db.execute('INSERT OR REPLACE INTO jobs VALUES(?,?,?,?,?)', (job['id'], job['created'], job['updated'], job['state'], json.dumps(job, ensure_ascii=False))); db.commit(); db.close()
    return job


def read(job_id: str) -> dict[str, Any]:
    db = connect(); row = db.execute('SELECT payload FROM jobs WHERE id=?', (job_id,)).fetchone(); db.close()
    if not row: raise fail(404, '找不到这项任务。')
    return json.loads(row['payload'])


def visible(job: dict[str, Any]) -> dict[str, Any]:
    safe = {key: value for key, value in job.items() if key not in {'command', 'source_path', 'download_url', 'internal_error'}}
    return safe


def media_info(path: Path, content_type: str) -> dict[str, Any]:
    info = {'title': path.stem[:180], 'duration': 0, 'hasVideo': content_type.startswith('video/'), 'imageCount': 0, 'width': 0, 'height': 0}
    if content_type in IMAGE_TYPES:
        try:
            with Image.open(path) as image:
                image.verify()
            with Image.open(path) as image:
                if image.width * image.height > Image.MAX_IMAGE_PIXELS: raise fail(413, '图片像素过大。')
                info.update({'imageCount': 1, 'width': image.width, 'height': image.height})
        except Image.DecompressionBombError: raise fail(413, '图片像素过大。')
        except (UnidentifiedImageError, OSError): raise fail(415, '图片文件无效。')
    else:
        try:
            probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration,format_name:stream=codec_type,width,height', '-of', 'json', str(path)], capture_output=True, text=True, timeout=12, check=True)
            data = json.loads(probe.stdout); fmt = data.get('format', {}).get('format_name')
            if fmt not in MEDIA_FORMATS.get(content_type, set()): raise ValueError('format mismatch')
            streams = data.get('streams') or []
            if not streams or (content_type.startswith('video/') and not any(s.get('codec_type') == 'video' for s in streams)) or (content_type.startswith('audio/') and not any(s.get('codec_type') == 'audio' for s in streams)):
                raise ValueError('stream mismatch')
            video = next((s for s in streams if s.get('codec_type') == 'video'), {})
            duration = max(0, round(float(data.get('format', {}).get('duration') or 0) * 1000))
            width, height = video.get('width') or 0, video.get('height') or 0
            if content_type.startswith('video/') and (not duration or duration > 1_800_000 or not width or not height or max(width, height) > 3840 or width * height > 3840 * 2160):
                raise ValueError('video bounds exceeded')
            info.update({'duration': duration, 'hasVideo': bool(video), 'width': width, 'height': height})
        except Exception: raise fail(415, '媒体文件无法读取。')
    return info


def resolve_source(source_id: str, source_file: str | None) -> tuple[dict[str, Any], dict[str, Any], Path]:
    source = read(source_id)
    if source.get('state') != 'saved': raise fail(409, '源文件尚未准备好。')
    files = source.get('files', [])
    file = next((item for item in files if item['name'] == source_file), None) if source_file else (files[0] if len(files) == 1 else None)
    if not file: raise fail(400, '请指定一个已保存的源文件。')
    path = (FILES / source_id / file['name']).resolve()
    if path.parent != (FILES / source_id).resolve() or not path.is_file(): raise fail(410, '源文件已被清理，请重新上传或下载。')
    return source, file, path


def is_public_host(host: str) -> bool:
    try:
        addresses = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror: return False
    for item in addresses:
        ip = ipaddress.ip_address(item[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified: return False
    return True


def allowed_url(value: str) -> str:
    if len(value) > 2048: raise fail(400, '链接过长。')
    parsed = urlparse(value)
    host = (parsed.hostname or '').lower()
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port or not any(host == domain or host.endswith('.' + domain) for domain in PLATFORMS) or not is_public_host(host):
        raise fail(400, '仅支持公开的 YouTube、Vimeo、X、Instagram 或 SoundCloud 单作品 HTTPS 链接。')
    path = parsed.path.rstrip('/')
    query = __import__('urllib.parse', fromlist=['parse_qs']).parse_qs(parsed.query)
    single = (
        (host.endswith('youtube.com') and (path == '/watch' and bool(query.get('v')) or bool(re.fullmatch(r'/(shorts|embed)/[\w-]+', path))))
        or (host == 'youtu.be' and bool(re.fullmatch(r'/[\w-]+', path)))
        or (host.endswith('vimeo.com') and bool(re.fullmatch(r'/\d+', path)))
        or (host in {'x.com', 'twitter.com'} and bool(re.fullmatch(r'/[\w-]+/status/\d+', path)))
        or (host.endswith('instagram.com') and bool(re.fullmatch(r'/(p|reel|tv)/[\w-]+', path)))
        or (host.endswith('soundcloud.com') and bool(re.fullmatch(r'/[\w-]+/[\w-]+', path)))
    )
    if not single or 'list' in query: raise fail(400, '仅支持单个公开作品链接。')
    return value


def allowed_gallery_url(value: str) -> str:
    if len(value) > 2048: raise fail(400, '链接过长。')
    parsed = urlparse(value); host = (parsed.hostname or '').lower(); path = parsed.path.rstrip('/')
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in {None, 443} or not any(host == domain or host.endswith('.' + domain) for domain in GALLERY_PLATFORMS) or not is_public_host(host):
        raise fail(400, '当前仅支持公开 Imgur 图片或相册 HTTPS 链接。')
    if not re.fullmatch(r'/(?:a|gallery)/[A-Za-z0-9]+|/[A-Za-z0-9]{5,8}', path):
        raise fail(400, '图库链接格式不支持。')
    return value


@contextlib.contextmanager
def public_network_only():
    """yt-dlp resolves many platform CDNs; deny any DNS result outside public IP space."""
    original = socket.getaddrinfo
    original_connect = socket.socket.connect
    def guarded(host, *args, **kwargs):
        result = original(host, *args, **kwargs)
        for item in result:
            ip = ipaddress.ip_address(item[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
                raise socket.gaierror('non-public upstream refused')
        return result
    socket.getaddrinfo = guarded
    def guarded_connect(sock, address):
        if isinstance(address, tuple):
            host = address[0]
            try:
                ip = ipaddress.ip_address(host)
                if not ip.is_global: raise OSError('non-public upstream refused')
            except ValueError:
                if not is_public_host(host): raise OSError('non-public upstream refused')
        return original_connect(sock, address)
    socket.socket.connect = guarded_connect
    try: yield
    finally:
        socket.getaddrinfo = original
        socket.socket.connect = original_connect


def validate_options(operation: str, options: dict[str, Any]) -> dict[str, Any]:
    allowed = {'language', 'targetLanguage', 'burnIn'} if operation == 'subtitles' else set() if operation in {'separate', 'gallery', 'concat'} else {'aspect', 'fit', 'rotation', 'speed', 'mute', 'volume'} if operation == 'edit' else {'start', 'end', 'quality', 'format', 'maxHeight', 'at'}
    if not isinstance(options, dict) or set(options) - allowed: raise fail(400, '处理参数不合法。')
    result = dict(options)
    if operation == 'subtitles':
        if not isinstance(result.get('language', 'auto'), str) or not isinstance(result.get('targetLanguage', 'none'), str) or result.get('language', 'auto') not in {'auto', 'zh', 'en'} or result.get('targetLanguage', 'none') not in {'none', 'zh', 'en'}: raise fail(400, '字幕语言不支持。')
        if 'burnIn' in result and type(result['burnIn']) is not bool: raise fail(400, '字幕参数不合法。')
    if operation == 'edit':
        defaults = {'aspect': 'original', 'fit': 'crop', 'rotation': 0, 'speed': 1, 'mute': False, 'volume': 1}
        result = {**defaults, **result}
        if result['aspect'] not in ASPECTS or result['fit'] not in {'crop', 'pad'} or result['rotation'] not in {0, 90, 180, 270} or result['speed'] not in {0.5, 1, 1.5, 2} or type(result['mute']) is not bool or type(result['volume']) not in {int, float} or not 0 <= result['volume'] <= 2:
            raise fail(400, '编辑参数不合法。')
    if 'quality' in result and (not isinstance(result['quality'], str) or result['quality'] not in {'balanced', 'small', 'high'}): raise fail(400, '质量参数不合法。')
    if 'format' in result and (not isinstance(result['format'], str) or result['format'] not in FORMATS): raise fail(400, '输出格式不支持。')
    if 'maxHeight' in result and (type(result['maxHeight']) is not int or result['maxHeight'] not in {0, 720, 1080}): raise fail(400, '分辨率参数不支持。')
    for name in ('start', 'end', 'at'):
        if name in result and (type(result[name]) not in {int, float} or not math.isfinite(result[name]) or result[name] < 0 or result[name] > 36000): raise fail(400, '时间参数不合法。')
    if operation == 'trim' and not (result.get('end', 0) > result.get('start', 0)): raise fail(400, '裁剪结束时间必须晚于开始时间。')
    return result


class JobRequest(BaseModel):
    operation: Literal['trim', 'compress', 'convert', 'audio', 'frame', 'remove-background', 'download', 'gallery', 'edit', 'concat', 'subtitles', 'separate']
    requestId: uuid.UUID | None = None
    sourceId: str | None = Field(default=None, max_length=64)
    sourceFile: str | None = Field(default=None, max_length=180)
    sources: list[dict[str, str]] | None = None
    options: dict[str, Any] = Field(default_factory=dict)
    url: str | None = Field(default=None, max_length=2048)

    @model_validator(mode='after')
    def source_contract(self):
        if self.operation in {'download', 'gallery'}:
            if not self.url or self.sourceId or self.sourceFile: raise ValueError('下载只接受作品链接。')
        elif self.operation == 'concat':
            if self.sourceId or self.sourceFile or self.url or not self.sources or not 2 <= len(self.sources) <= 5:
                raise ValueError('拼接需要 2 至 5 个已保存视频源。')
            for item in self.sources:
                if set(item) != {'sourceId', 'sourceFile'} or not item['sourceId'] or not item['sourceFile']:
                    raise ValueError('拼接源不合法。')
        elif not self.sourceId or self.url or self.sources: raise ValueError('此操作需要已保存的源文件。')
        return self


async def auth(authorization: str | None = Header(default=None)) -> None:
    if not TOKEN or not authorization or not secrets.compare_digest(authorization, f'Bearer {TOKEN}'): raise fail(401, '未授权。')


def output_path(job_id: str, ext: str) -> Path:
    target = FILES / job_id; target.mkdir(mode=0o700)
    return target / f'output.{ext}'


def ffmpeg(command: list[str]) -> None:
    try:
        run = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=TIMEOUT, check=False, env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'OMP_NUM_THREADS': str(THREADS)})
    except subprocess.TimeoutExpired: raise RuntimeError('处理超时。')
    if run.returncode != 0: raise RuntimeError('FFmpeg 无法完成此文件的处理。')


def make_file(path: Path, kind: str = 'output') -> dict[str, Any]:
    size = path.stat().st_size
    if size > MAX_OUTPUT: raise RuntimeError('输出文件超过 250 MB 限制。')
    content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    return {'name': path.name, 'type': content_type, 'kind': kind, 'bytes': size, 'label': path.name}


def run_media(job: dict[str, Any]) -> dict[str, Any]:
    operation, options = job['operation'], job['options']
    source, source_file, input_path = resolve_source(job['sourceId'], job.get('sourceFile'))
    type_ = source_file['type']
    if operation in {'subtitles', 'separate'}:
        if not type_.startswith(('video/', 'audio/')): raise RuntimeError('此操作需要视频或音频文件。')
        if source.get('content', {}).get('duration', 0) > 300000: raise RuntimeError('字幕和人声分离仅支持 5 分钟以内的媒体。')
        folder = FILES / job['id']; folder.mkdir(mode=0o700)
        runtime_options = {**options, 'modelDir': str(ADVANCED_MODELS / ('faster-whisper-base' if operation == 'subtitles' else 'uvr-mdx'))}
        request = {'operation': operation, 'input_path': str(input_path), 'out_dir': str(folder), 'options': runtime_options, 'max_bytes': MAX_UPLOAD, 'timeout': TIMEOUT}
        try:
            process = subprocess.run([sys.executable, str(ADVANCED_RUNNER)], input=json.dumps(request), capture_output=True, text=True, timeout=TIMEOUT,
                env={**os.environ, 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'ARGOS_PACKAGES_DIR': str(ADVANCED_MODELS / 'argos')})
        except subprocess.TimeoutExpired: raise RuntimeError('处理超时，请缩短素材后重试。')
        try: result = json.loads(process.stdout)
        except (ValueError, TypeError): raise RuntimeError('字幕或音频处理未能完成，请缩短素材后重试。')
        if process.returncode or not result.get('ok'): raise RuntimeError(str(result.get('error') or '字幕或音频处理失败。')[:200])
        value = result['result']; outputs = []
        for item in value.get('files', [])[:8]:
            path = folder / safe_name(item.get('name', ''))
            if path.resolve().parent != folder.resolve() or not path.is_file(): raise RuntimeError('处理结果文件无效。')
            file = make_file(path, item.get('kind', 'output'))
            file['type'] = {'.srt': 'application/x-subrip', '.vtt': 'text/vtt', '.txt': 'text/plain'}.get(path.suffix, file['type'])
            file['label'] = str(item.get('label') or path.name)[:100]; outputs.append(file)
        if not outputs or sum(f['bytes'] for f in outputs) > MAX_OUTPUT: raise RuntimeError('输出文件超过限制。')
        job['files'] = outputs; job['content'] = value.get('content') or source.get('content', {})
        job['content']['title'] = source.get('content', {}).get('title') or '媒体文件'
        if operation == 'subtitles': job['subtitles'] = value.get('subtitles') or {}
        return job
    if operation == 'edit':
        if not type_.startswith('video/'): raise RuntimeError('编辑仅支持视频源文件。')
        out = output_path(job['id'], 'mp4')
        ffmpeg(build_edit_command(input_path, out, options, MAX_OUTPUT, THREADS))
        job['files'] = [make_file(out)]; job['content'] = media_info(out, 'video/mp4')
        job['content']['title'] = source.get('content', {}).get('title') or source.get('input') or '媒体文件'
        return job
    defaults = {'trim': 'mp4', 'compress': 'mp4', 'convert': 'mp4', 'audio': 'mp3', 'frame': 'png', 'remove-background': 'png'}
    audio_trim = operation == 'trim' and type_.startswith('audio/')
    ext = options.get('format') or ('mp3' if audio_trim else defaults[operation])
    compatible = {'trim': {'mp4', 'webm'}, 'compress': {'mp4', 'webm'}, 'convert': {'mp4', 'webm'}, 'audio': {'mp3', 'wav'}, 'frame': {'png', 'jpeg'}, 'remove-background': {'png'}}
    if audio_trim: compatible['trim'] = {'mp3', 'wav'}
    if ext not in compatible[operation]: raise RuntimeError('该操作不支持此输出格式。')
    if operation in {'trim', 'compress', 'convert', 'frame'} and not type_.startswith('video/') and not audio_trim:
        raise RuntimeError('此操作需要视频源文件。')
    out = output_path(job['id'], ext)
    if operation == 'remove-background':
        if type_ not in IMAGE_TYPES: raise RuntimeError('抠图仅支持 PNG、JPEG 或 WebP 图片。')
        from rembg import new_session, remove
        with Image.open(input_path) as image:
            image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
            remove(image.convert('RGBA'), session=new_session('u2netp')).save(out, 'PNG')
    else:
        command = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-filter_threads', str(THREADS), '-threads', str(THREADS), '-protocol_whitelist', 'file,pipe']
        if operation == 'trim': command += ['-ss', str(options['start']), '-to', str(options['end'])]
        command += ['-i', str(input_path), '-threads', str(THREADS), '-fs', str(MAX_OUTPUT)]
        if operation == 'audio' or audio_trim: command += ['-vn', '-c:a', 'libmp3lame' if ext == 'mp3' else 'pcm_s16le']
        elif operation == 'frame': command += ['-ss', str(options.get('at', 0)), '-frames:v', '1']
        elif operation in {'trim', 'compress', 'convert'}:
            height = options.get('maxHeight', 720 if operation == 'compress' else 0)
            if height: command += ['-vf', f'scale=-2:min({height}\\,ih)']
            quality = options.get('quality', 'balanced')
            command += ['-c:v', 'libvpx-vp9' if ext == 'webm' else 'libx264', '-crf', {'small':'31','balanced':'25','high':'20'}[quality]]
            if ext == 'mp4': command += ['-preset', 'veryfast', '-c:a', 'aac']
            else: command += ['-deadline', 'realtime', '-cpu-used', '5', '-b:v', '0', '-c:a', 'libopus']
        command += [str(out)]
        ffmpeg(command)
    job['files'] = [make_file(out)]; job['content'] = media_info(out, job['files'][0]['type'])
    job['content']['title'] = source.get('content', {}).get('title') or source.get('input') or '媒体文件'
    return job


def run_download(job: dict[str, Any]) -> dict[str, Any]:
    url = allowed_url(job['url'])
    # Extraction uses Python sockets under public_network_only. Media bytes are fetched with
    # urllib, without proxies, and every redirect is checked again before connecting.
    from yt_dlp import YoutubeDL
    destination = FILES / job['id']; destination.mkdir(mode=0o700)
    opts = {'noplaylist': True, 'no_warnings': True, 'quiet': True, 'socket_timeout': 20, 'retries': 1, 'fragment_retries': 1, 'max_filesize': MAX_UPLOAD, 'cachedir': False, 'noprogress': True, 'proxy': '', 'no_color': True, 'extract_flat': False, 'skip_download': True}
    class CheckedRedirect(HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            validate_remote_url(newurl)
            return super().redirect_request(request, fp, code, msg, headers, newurl)
    opener = build_opener(ProxyHandler({}), CheckedRedirect())
    with public_network_only(), YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if info.get('_type') in {'playlist', 'multi_video'} or info.get('is_live') or info.get('live_status') in {'is_live', 'is_upcoming'}:
            raise RuntimeError('不支持播放列表或直播。')
        if info.get('extractor_key') not in {'Youtube', 'Vimeo', 'Twitter', 'Instagram', 'Soundcloud'}:
            raise RuntimeError('作品平台不受支持。')
        candidates = [f for f in (info.get('formats') or [info]) if f.get('ext') in {'mp4', 'webm', 'm4a', 'mp3'} and f.get('protocol') == 'https' and f.get('url') and not f.get('is_live')]
        candidates = [f for f in candidates if not f.get('filesize') or f['filesize'] <= MAX_UPLOAD]
        if not candidates: raise RuntimeError('没有可安全下载的单文件媒体格式。')
        # Some extractors omit codec metadata for direct video URLs. Only an
        # explicit "none" means the stream is absent; validate the saved bytes below.
        combined = [f for f in candidates if f['ext'] in {'mp4', 'webm'} and f.get('vcodec') != 'none' and f.get('acodec') != 'none']
        video_only = [f for f in candidates if f.get('vcodec') != 'none' and f.get('acodec') == 'none' and f['ext'] in {'mp4', 'webm'}]
        audio_only = [f for f in candidates if f.get('vcodec') == 'none' and f.get('acodec') not in {None, 'none'}]
        for formats in (combined, video_only, audio_only): formats.sort(key=lambda f: (f.get('height') or 0, f.get('abr') or 0), reverse=True)
        deadline = time.monotonic() + TIMEOUT; count = 0
        def fetch(media: dict[str, Any], target: Path) -> None:
            nonlocal count
            remote = validate_remote_url(media['url'])
            request_headers = {'User-Agent': 'Mozilla/5.0'}
            for key, value in (media.get('http_headers') or info.get('http_headers') or {}).items():
                if key.lower() in {'referer', 'origin', 'accept', 'accept-language'} and isinstance(value, str): request_headers[key] = value
            with opener.open(URLRequest(remote, headers=request_headers), timeout=20) as response, target.open('xb') as output:
                while True:
                    if time.monotonic() > deadline: raise RuntimeError('下载超时。')
                    chunk = response.read(1024 * 1024)
                    if not chunk: break
                    count += len(chunk)
                    if count > MAX_UPLOAD: raise RuntimeError('下载文件超过 100 MB 限制。')
                    output.write(chunk)
        if combined:
            selected = combined[0]; ext = selected['ext']; path = destination / f'source.{ext}'
            fetch(selected, path)
        elif video_only and audio_only:
            selected = video_only[0]
            match = [f for f in audio_only if f['ext'] == ('m4a' if selected['ext'] == 'mp4' else 'webm')]
            if not match: raise RuntimeError('没有可配对的安全音轨。')
            ext = selected['ext']; path = destination / f'source.{ext}'
            video_part = destination / f'video.{ext}'; audio_part = destination / f'audio.{match[0]["ext"]}'
            fetch(selected, video_part); fetch(match[0], audio_part)
            ffmpeg(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-filter_threads', str(THREADS), '-threads', str(THREADS), '-protocol_whitelist', 'file,pipe', '-i', str(video_part), '-protocol_whitelist', 'file,pipe', '-i', str(audio_part), '-threads', str(THREADS), '-c', 'copy', '-fs', str(MAX_UPLOAD), str(path)])
            video_part.unlink(); audio_part.unlink()
        elif video_only:
            selected = video_only[0]; ext = selected['ext']; path = destination / f'source.{ext}'
            fetch(selected, path)
        else:
            playable_audio = [f for f in audio_only if f['ext'] in {'mp3', 'm4a'}]
            if not playable_audio: raise RuntimeError('没有可安全下载的完整媒体格式。')
            selected = playable_audio[0]; ext = selected['ext']; path = destination / f'source.{ext}'
            fetch(selected, path)
    content_type = {'mp4': 'video/mp4', 'webm': 'video/webm', 'm4a': 'audio/mp4', 'mp3': 'audio/mpeg'}[ext]
    job['files'] = [make_file(path, 'download')]; job['content'] = media_info(path, content_type)
    job['content']['title'] = str(info.get('title') or '下载作品')[:300]
    job['content']['author'] = str(info.get('uploader') or '')[:100]
    job['input'] = url; return job


def run_gallery(job: dict[str, Any]) -> dict[str, Any]:
    url = allowed_gallery_url(job['url'])
    destination = FILES / job['id']; destination.mkdir(mode=0o700)
    deadline, total, files, skipped = time.monotonic() + TIMEOUT, 0, [], 0
    class CheckedRedirect(HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            validate_remote_url(newurl)
            return super().redirect_request(request, fp, code, msg, headers, newurl)
    opener = build_opener(ProxyHandler({}), CheckedRedirect())
    with public_network_only():
        candidates = extract_image_candidates(url, 30)
        if not candidates: raise RuntimeError('图库中没有可获取的公开图片。')
        for index, candidate in enumerate(candidates, 1):
            if time.monotonic() > deadline: raise RuntimeError('下载超时。')
            remote = validate_remote_url(candidate)
            response = opener.open(URLRequest(remote, headers={'User-Agent': 'OmniHubMedia/1.0'}), timeout=20)
            with response:
                content_type = response.headers.get_content_type().lower()
                if content_type == 'image/gif':
                    raise RuntimeError('图库包含 GIF 动画；当前图库采集不支持 GIF。')
                if content_type not in GALLERY_IMAGE_TYPES:
                    skipped += 1; continue
                length = response.headers.get('Content-Length')
                if length and int(length) > 15 * 1024 * 1024:
                    skipped += 1; continue
                target = destination / f'image-{index:02d}.{GALLERY_IMAGE_TYPES[content_type]}'
                amount = 0
                with target.open('xb') as output:
                    while True:
                        if time.monotonic() > deadline: raise RuntimeError('下载超时。')
                        chunk = response.read(1024 * 1024)
                        if not chunk: break
                        amount += len(chunk); total += len(chunk)
                        if amount > 15 * 1024 * 1024 or total > MAX_UPLOAD: raise RuntimeError('图库图片超过限制。')
                        output.write(chunk)
                try:
                    with Image.open(target) as image:
                        image.verify()
                    with Image.open(target) as image:
                        if image.width * image.height > Image.MAX_IMAGE_PIXELS:
                            raise Image.DecompressionBombError('image bounds exceeded')
                except (Image.DecompressionBombError, UnidentifiedImageError, OSError):
                    target.unlink(missing_ok=True); total -= amount; skipped += 1; continue
                files.append(make_file(target, 'gallery'))
    if not files: raise RuntimeError('没有通过安全校验的图库图片。')
    job['files'] = files
    job['content'] = {'title': '图库图片', 'duration': 0, 'hasVideo': False, 'imageCount': len(files), 'skippedCount': skipped, 'width': 0, 'height': 0}
    job['partial'] = bool(skipped)
    job['input'] = url
    return job


def concat_input(path: Path) -> tuple[float, bool]:
    try:
        probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', str(path)], capture_output=True, text=True, timeout=12, check=True)
        data = json.loads(probe.stdout); duration = float(data.get('format', {}).get('duration') or 0)
        streams = data.get('streams') or []
        if not math.isfinite(duration) or duration <= 0 or not any(item.get('codec_type') == 'video' for item in streams): raise ValueError
        return duration, any(item.get('codec_type') == 'audio' for item in streams)
    except Exception: raise RuntimeError('拼接源文件无法读取。')


def run_concat(job: dict[str, Any]) -> dict[str, Any]:
    sources, inputs, total = job['sources'], [], 0.0
    for item in sources:
        source, file, path = resolve_source(item['sourceId'], item['sourceFile'])
        if not file['type'].startswith('video/'): raise RuntimeError('拼接仅支持视频源文件。')
        if path.stat().st_size > MAX_UPLOAD or sum(value[0].stat().st_size for value in inputs) + path.stat().st_size > 200 * 1024 * 1024:
            raise RuntimeError('拼接输入超过 200 MB 限制。')
        duration, has_audio = concat_input(path); total += duration
        if total > 600: raise RuntimeError('拼接总时长不能超过 10 分钟。')
        inputs.append((path, duration, has_audio))
    out = output_path(job['id'], 'mp4')
    ffmpeg(build_concat_command(inputs, out, MAX_OUTPUT, THREADS))
    job['files'] = [make_file(out)]; job['content'] = media_info(out, 'video/mp4')
    job['content']['title'] = '拼接视频'; return job


def validate_remote_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.port not in {None, 443} or not is_public_host(parsed.hostname):
        raise RuntimeError('下载地址不是公共 HTTPS 地址。')
    return value


async def execute(job_id: str) -> None:
    job = read(job_id); job['state'] = 'processing'; write(job)
    try:
        runner = run_download if job['operation'] == 'download' else run_gallery if job['operation'] == 'gallery' else run_concat if job['operation'] == 'concat' else run_media
        result = await asyncio.to_thread(runner, job)
        result['state'] = 'saved'; result.pop('error', None); write(result)
    except Exception as error:
        job['state'] = 'failed'; job['error'] = clean_error(error); write(job)
        shutil.rmtree(FILES / job_id, ignore_errors=True)
    finally: cleanup()


async def queue_worker() -> None:
    while True:
        job_id = await QUEUE.get()
        try: await execute(job_id)
        finally: QUEUE.task_done()


def cleanup() -> None:
    now = time.time(); db = connect(); rows = db.execute('SELECT payload FROM jobs ORDER BY updated ASC').fetchall(); total = 0
    parsed = [(json.loads(row['payload']), row['payload']) for row in rows]
    protected = {job.get('sourceId') for job, _ in parsed if job.get('state') in {'queued', 'processing'} and job.get('sourceId')}
    for job, _ in parsed:
        total += sum(int(f.get('bytes') or 0) for f in job.get('files', []))
    for job, _ in parsed:
        expired = now - job.get('updated', now) > 30 * 86400
        if job.get('state') == 'saved' and job['id'] not in protected and (expired or total > CACHE_LIMIT):
            directory = FILES / job['id']; size = sum(int(f.get('bytes') or 0) for f in job.get('files', [])); shutil.rmtree(directory, ignore_errors=True); job['files'] = []; job['state'] = 'expired'; job['error'] = '缓存已清理，请使用原始输入重新处理。'; job['updated'] = now; db.execute('UPDATE jobs SET updated=?,state=?,payload=? WHERE id=?', (now, job['state'], json.dumps(job), job['id'])); total -= size
    db.commit(); db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global WORKER, QUEUE
    init_db()
    QUEUE = asyncio.Queue(maxsize=8)
    db = connect()
    for row in db.execute("SELECT payload FROM jobs WHERE state IN ('queued','processing')").fetchall():
        interrupted = json.loads(row['payload']); interrupted['state'] = 'failed'; interrupted['error'] = '服务重启中断了任务，请重试。'; interrupted['updated'] = time.time()
        db.execute('UPDATE jobs SET updated=?,state=?,payload=? WHERE id=?', (interrupted['updated'], 'failed', json.dumps(interrupted, ensure_ascii=False), interrupted['id']))
        shutil.rmtree(FILES / interrupted['id'], ignore_errors=True)
    db.commit(); db.close(); cleanup(); WORKER = asyncio.create_task(queue_worker())
    yield
    if WORKER: WORKER.cancel();
    with contextlib.suppress(asyncio.CancelledError):
        if WORKER: await WORKER


app = FastAPI(lifespan=lifespan)

@app.get('/health')
async def health(_: None = Depends(auth)):
    gallery_ready = gallery_available()
    return {'available': bool(TOKEN), 'features': {'ffmpeg': shutil.which('ffmpeg') is not None, 'backgroundRemoval': (Path('/models/u2netp.onnx').is_file()), 'downloader': True, 'gallery': gallery_ready and bool(GALLERY_PLATFORMS), 'edit': shutil.which('ffmpeg') is not None, 'concat': shutil.which('ffmpeg') is not None, **advanced_features()}, 'platforms': list(PLATFORMS), 'galleryPlatforms': list(GALLERY_PLATFORMS), 'maxUploadMB': MAX_UPLOAD // 1024 // 1024}

@app.post('/v1/uploads')
async def upload(request: Request, name: str, _: None = Depends(auth)):
    original_name = display_name(name); content_type = request.headers.get('content-type', '').split(';', 1)[0].lower()
    if content_type not in ALLOWED_INPUT: raise fail(415, '不支持这个文件类型。')
    extension = {'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp'}[content_type]
    filename = f'source.{extension}'
    job_id = str(uuid.uuid4()); folder = FILES / job_id; folder.mkdir(mode=0o700); target = folder / filename; amount = 0
    try:
        with target.open('xb') as output:
            async for chunk in request.stream():
                amount += len(chunk)
                if amount > MAX_UPLOAD: raise fail(413, '文件超过 100 MB 限制。')
                output.write(chunk)
        if not amount: raise fail(400, '上传内容为空。')
        info = media_info(target, content_type); info['title'] = Path(original_name).stem[:180]
        job = {'id': job_id, 'created': time.time(), 'state': 'saved', 'operation': 'upload', 'input': original_name, 'files': [make_file(target, 'upload')], 'content': info}; write(job); cleanup(); return visible(job)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True); raise

@app.post('/v1/jobs')
async def create_job(body: JobRequest, _: None = Depends(auth)):
    operation = body.operation; options = validate_options(operation, body.options)
    source_file = safe_name(body.sourceFile) if body.sourceFile else None
    job_id = str(body.requestId) if body.requestId else str(uuid.uuid4())
    sources = [{'sourceId': item['sourceId'], 'sourceFile': safe_name(item['sourceFile'])} for item in body.sources] if body.sources else None
    proposed = {'operation': operation, 'sourceId': body.sourceId, 'sourceFile': source_file, 'sources': sources, 'options': options, 'url': body.url if operation in {'download', 'gallery'} else None}
    db = connect(); row = db.execute('SELECT payload FROM jobs WHERE id=?', (job_id,)).fetchone(); db.close()
    if row:
        existing = json.loads(row['payload'])
        if all(existing.get(key) == value for key, value in proposed.items()): return visible(existing)
        raise fail(409, 'requestId 已用于另一项任务。')
    if operation == 'download': input_url = allowed_url(body.url or '')
    elif operation == 'gallery': input_url = allowed_gallery_url(body.url or '')
    elif operation == 'concat':
        input_url = None; total = 0; amount = 0
        for item in sources or []:
            source, file, path = resolve_source(item['sourceId'], item['sourceFile'])
            if not file['type'].startswith('video/'): raise fail(422, '拼接仅支持视频源文件。')
            amount += path.stat().st_size; total += (source.get('content') or {}).get('duration') or 0
        if amount > 200 * 1024 * 1024: raise fail(422, '拼接输入超过 200 MB 限制。')
        if total > 600000: raise fail(422, '拼接总时长不能超过 10 分钟。')
    else:
        source, _, _ = resolve_source(body.sourceId or '', source_file); input_url = None
        duration = (source.get('content') or {}).get('duration') or 0
        if operation in {'subtitles', 'separate'}:
            features = advanced_features()
            if not features['subtitles' if operation == 'subtitles' else 'separation']: raise fail(503, '该处理组件尚未启用。')
            if duration > 300000: raise fail(422, '字幕和人声分离仅支持 5 分钟以内的媒体。')
            if operation == 'subtitles' and options.get('targetLanguage', 'none') != 'none' and not features['translation']: raise fail(503, '字幕翻译尚未启用。')
        if operation == 'frame' and options.get('at', 0) * 1000 >= duration: raise fail(422, '截帧时间超出视频时长。')
        if operation == 'trim' and options['end'] * 1000 > duration: raise fail(422, '裁剪终点超出视频时长。')
    if QUEUE.full(): raise fail(429, '处理队列已满，请稍后重试。')
    job = {'id': job_id, 'created': time.time(), 'state': 'queued', 'operation': operation, 'sourceId': body.sourceId, 'sourceFile': source_file, 'sources': sources, 'options': options, 'url': input_url, 'files': []}
    try: QUEUE.put_nowait(job['id'])
    except asyncio.QueueFull: raise fail(429, '处理队列已满，请稍后重试。')
    write(job); return visible(job)

@app.get('/v1/jobs/{job_id}')
async def get_job(job_id: str, _: None = Depends(auth)): return visible(read(job_id))

@app.post('/v1/jobs/{job_id}/retry')
async def retry(job_id: str, _: None = Depends(auth)):
    prior = read(job_id)
    if prior.get('operation') == 'upload': raise fail(409, '上传任务不能重试，请重新上传。')
    return await create_job(JobRequest(operation=prior['operation'], sourceId=prior.get('sourceId'), sourceFile=prior.get('sourceFile'), sources=prior.get('sources'), options=prior.get('options') or {}, url=prior.get('url')), _)

@app.api_route('/v1/jobs/{job_id}/files/{name}', methods=['GET','HEAD'])
async def get_file(job_id: str, name: str, request: Request, inline: int = 0, _: None = Depends(auth)):
    job = read(job_id); filename = safe_name(name); item = next((x for x in job.get('files', []) if x['name'] == filename), None)
    path = (FILES / job_id / filename).resolve()
    if not item or job.get('state') != 'saved' or path.parent != (FILES / job_id).resolve() or not path.is_file(): raise fail(404, '文件不可用。')
    headers = {'Content-Type': item['type'], 'Accept-Ranges': 'bytes'}
    range_header = request.headers.get('range')
    if not range_header: return FileResponse(path, headers=headers)
    matched = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header)
    if not matched: return Response(status_code=416)
    size = path.stat().st_size
    if not matched.group(1) and not matched.group(2): return Response(status_code=416, headers={'Content-Range': f'bytes */{size}'})
    if not matched.group(1):
        start = max(0, size - int(matched.group(2))); end = size - 1
    else:
        start = int(matched.group(1)); end = int(matched.group(2) or size - 1)
    if start > end or start >= size: return Response(status_code=416, headers={'Content-Range': f'bytes */{size}'})
    end = min(end, size - 1); headers.update({'Content-Range': f'bytes {start}-{end}/{size}', 'Content-Length': str(end-start+1)})
    if request.method == 'HEAD': return Response(status_code=206, headers=headers)
    def chunks():
        with path.open('rb') as source:
            source.seek(start); remaining = end - start + 1
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk: break
                remaining -= len(chunk); yield chunk
    return StreamingResponse(chunks(), status_code=206, headers=headers)
