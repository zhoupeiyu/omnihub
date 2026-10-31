from __future__ import annotations

import contextlib
import os
import subprocess
import tempfile
import unittest
import uuid
from email.message import Message
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

os.environ['MEDIA_WORKER_TOKEN'] = 'test-token'
os.environ['MEDIA_WORKER_ROOT'] = tempfile.mkdtemp(prefix='media-gallery-test-')
import app
from PIL import Image
from video_edit import build_command


class Response(BytesIO):
    def __init__(self, data: bytes, content_type: str):
        super().__init__(data); self.headers = Message(); self.headers['Content-Type'] = content_type
    def __enter__(self): return self
    def __exit__(self, *args): self.close()


class GalleryAndEditTests(unittest.TestCase):
    def test_gallery_contract_and_generated_names(self):
        with patch('app.is_public_host', return_value=True):
            self.assertEqual(app.allowed_gallery_url('https://imgur.com/a/F4hz2'), 'https://imgur.com/a/F4hz2')
        for value in ('http://imgur.com/a/F4hz2', 'https://imgur.com/user/example', 'https://127.0.0.1/a/F4hz2'):
            with self.assertRaises(Exception): app.allowed_gallery_url(value)
        raw = BytesIO(); Image.new('RGB', (8, 6), 'blue').save(raw, 'PNG')
        job = {'id': str(uuid.uuid4()), 'url': 'https://imgur.com/a/F4hz2', 'operation': 'gallery'}
        app.init_db()
        with patch('app.is_public_host', return_value=True), patch('app.extract_image_candidates', return_value=['https://i.imgur.com/example.png']), patch('app.public_network_only', return_value=contextlib.nullcontext()), patch('app.build_opener') as opener:
            opener.return_value.open.return_value = Response(raw.getvalue(), 'image/png')
            result = app.run_gallery(job)
        self.assertEqual(result['files'][0]['name'], 'image-01.png')
        self.assertEqual(result['content']['imageCount'], 1)

    def test_edit_uses_closed_filters_and_real_ffmpeg(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); source, output = root / 'source.mp4', root / 'output.mp4'
            subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=12:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(source)], check=True, capture_output=True)
            options = {'aspect': '9:16', 'fit': 'pad', 'rotation': 90, 'speed': 2, 'mute': True, 'volume': 1}
            command = build_command(source, output, options, 20 * 1024 * 1024, 1)
            self.assertNotIn('-af', command); self.assertIn('-an', command); self.assertIn('transpose=clock', ' '.join(command))
            subprocess.run(command, check=True, capture_output=True)
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height,codec_type:format=duration', '-of', 'json', str(output)], check=True, capture_output=True, text=True)
            self.assertIn('720', probe.stdout); self.assertIn('1280', probe.stdout)

    def test_concat_normalizes_landscape_audio_and_portrait_silence(self):
        app.init_db()
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); first, second = root / 'first.mp4', root / 'second.mp4'
            subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:r=12:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:d=1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(first)], check=True, capture_output=True)
            subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x96:r=24:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(second)], check=True, capture_output=True)
            refs = []
            for source in (first, second):
                source_id = str(uuid.uuid4()); folder = app.FILES / source_id; folder.mkdir(mode=0o700)
                target = folder / 'source.mp4'; target.write_bytes(source.read_bytes())
                app.write({'id': source_id, 'created': 0, 'updated': 0, 'state': 'saved', 'operation': 'upload', 'files': [{'name': 'source.mp4', 'type': 'video/mp4', 'bytes': target.stat().st_size}], 'content': {'duration': 1000}})
                refs.append({'sourceId': source_id, 'sourceFile': 'source.mp4'})
            result = app.run_concat({'id': str(uuid.uuid4()), 'sources': refs, 'operation': 'concat'})
            output = app.FILES / result['id'] / 'output.mp4'
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', str(output)], check=True, capture_output=True, text=True)
            self.assertIn('1280', probe.stdout); self.assertIn('720', probe.stdout); self.assertIn('audio', probe.stdout)
            self.assertGreater(float(__import__('json').loads(probe.stdout)['format']['duration']), 1.8)


if __name__ == '__main__':
    unittest.main()
