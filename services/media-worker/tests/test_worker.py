"""Local worker boundaries plus real FFmpeg/Pillow smoke tests.

Run inside the service image: python -m unittest discover -s tests -v
"""
from __future__ import annotations

import os
import contextlib
import subprocess
import tempfile
import time
import unittest
import uuid
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

os.environ['MEDIA_WORKER_TOKEN'] = 'test-token'
os.environ['MEDIA_WORKER_ROOT'] = tempfile.mkdtemp(prefix='media-worker-test-')
import app
from fastapi.testclient import TestClient


class WorkerContractTests(unittest.TestCase):
    def test_download_accepts_unknown_codecs_and_silent_video(self):
        # Twitter omits codec fields; Instagram also publishes silent videos.
        with tempfile.TemporaryDirectory() as raw:
            clip = Path(raw) / 'clip.mp4'
            subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:d=1', '-pix_fmt', 'yuv420p', str(clip)], check=True, capture_output=True)
            app.init_db()
            for codecs in ({}, {'vcodec': 'h264', 'acodec': 'none'}, {'acodec': 'none'}):
                with self.subTest(codecs=codecs):
                    job = {'id': str(uuid.uuid4()), 'url': 'https://x.com/example/status/123', 'operation': 'download'}
                    info = {'extractor_key': 'Twitter', 'title': 'Direct video', 'formats': [
                        {'url': 'https://video.twimg.com/example.mp4', 'protocol': 'https', 'ext': 'mp4', 'height': 48, **codecs},
                    ]}
                    with patch('app.allowed_url', side_effect=lambda value: value), patch('app.validate_remote_url', side_effect=lambda value: value), patch('app.public_network_only', return_value=contextlib.nullcontext()), patch('yt_dlp.YoutubeDL') as downloader, patch('app.build_opener') as opener:
                        downloader.return_value.__enter__.return_value.extract_info.return_value = info
                        opener.return_value.open.return_value = BytesIO(clip.read_bytes())
                        result = app.run_download(job)
                    self.assertEqual(result['content']['title'], 'Direct video')
                    self.assertTrue(result['content']['hasVideo'])
                    self.assertGreater(result['files'][0]['bytes'], 0)

    def test_rejects_private_and_playlist_urls(self):
        for value in ('http://youtube.com/watch?v=x', 'https://127.0.0.1/x', 'https://youtube.com/playlist?list=x', 'https://youtube.com/live/x'):
            with self.assertRaises(Exception): app.allowed_url(value)

    def test_operation_options_are_whitelisted(self):
        self.assertEqual(app.validate_options('trim', {'start': 1, 'end': 2}), {'start': 1, 'end': 2})
        for bad in ({'argv': '-i /etc/passwd'}, {'quality': 'unsafe'}, {'maxHeight': 666}):
            with self.assertRaises(Exception): app.validate_options('compress', bad)

    def test_advanced_options_and_readiness_require_local_models(self):
        self.assertEqual(app.validate_options('subtitles', {'language': 'zh', 'targetLanguage': 'en', 'burnIn': True}), {'language': 'zh', 'targetLanguage': 'en', 'burnIn': True})
        for operation, options in [('subtitles', {'modelDir': '/tmp/models'}), ('subtitles', {'burnIn': 'true'}), ('subtitles', {'language': []}), ('separate', {'command': 'unsafe'})]:
            with self.subTest(operation=operation, options=options):
                with self.assertRaises(Exception): app.validate_options(operation, options)
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); runner = root / 'runner.py'; runner.touch()
            with patch('app.ADVANCED_MODELS', root), patch('app.ADVANCED_RUNNER', runner), patch.dict(os.environ, {'MEDIA_ADVANCED_ENABLED': 'subtitles,translation,separation'}):
                self.assertFalse(any(app.advanced_features().values()))
                for name in ('faster-whisper-base/model.bin', 'uvr-mdx/UVR-MDX-NET-Inst_HQ_3.onnx', 'argos/en_zh/model/model.bin', 'argos/en_zh/sentencepiece.model', 'argos/zh_en/model/model.bin', 'argos/zh_en/sentencepiece.model'):
                    file = root / name; file.parent.mkdir(parents=True, exist_ok=True); file.touch()
                self.assertTrue(all(app.advanced_features().values()))

    def test_advanced_job_gate_blocks_unconfigured_and_long_media(self):
        app.init_db()
        source = {'content': {'duration': 1000}}
        with TestClient(app.app) as client, patch('app.resolve_source', return_value=(source, None, None)), patch('app.advanced_features', return_value={'subtitles': False, 'translation': False, 'separation': False}) as features:
            headers = {'Authorization': 'Bearer test-token'}
            body = {'operation': 'subtitles', 'sourceId': 'source'}
            self.assertEqual(client.post('/v1/jobs', json=body, headers=headers).status_code, 503)
            features.return_value['subtitles'] = True
            body['options'] = {'targetLanguage': 'en'}
            self.assertEqual(client.post('/v1/jobs', json=body, headers=headers).status_code, 503)
            features.return_value['translation'] = True; source['content']['duration'] = 300001
            self.assertEqual(client.post('/v1/jobs', json=body, headers=headers).status_code, 422)

    def test_image_probe_and_ffmpeg_frame(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            picture = root / 'input.png'
            from PIL import Image
            Image.new('RGB', (48, 32), (240, 10, 30)).save(picture)
            meta = app.media_info(picture, 'image/png')
            self.assertEqual((meta['width'], meta['height']), (48, 32))
            clip = root / 'clip.mp4'; frame = root / 'frame.png'
            subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:d=1', '-pix_fmt', 'yuv420p', str(clip)], check=True, capture_output=True)
            app.ffmpeg(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-ss', '0', '-i', str(clip), '-frames:v', '1', str(frame)])
            self.assertTrue(frame.is_file() and frame.stat().st_size > 100)

    def test_download_contract_requires_no_source(self):
        with self.assertRaises(ValueError): app.JobRequest(operation='download', url='https://youtube.com/watch?v=x', sourceId='source')
        with self.assertRaises(ValueError): app.JobRequest(operation='trim')

    def test_authenticated_upload_validates_bytes_and_supports_range(self):
        from PIL import Image
        output = BytesIO(); Image.new('RGB', (8, 6), 'blue').save(output, 'PNG')
        headers = {'Authorization': 'Bearer test-token', 'Content-Type': 'image/png'}
        with TestClient(app.app) as client:
            self.assertEqual(client.get('/health').status_code, 401)
            bad = client.post('/v1/uploads?name=fake.png', content=b'not an image', headers=headers)
            self.assertEqual(bad.status_code, 415)
            uploaded = client.post('/v1/uploads?name=%E5%B0%8F%E7%8C%AB%F0%9F%90%B1,%E6%B5%8B%E8%AF%95.png', content=output.getvalue(), headers=headers)
            self.assertEqual(uploaded.status_code, 200)
            item = uploaded.json()
            self.assertEqual(item['state'], 'saved')
            self.assertEqual((item['content']['width'], item['content']['height']), (8, 6))
            self.assertEqual(item['input'], '小猫🐱,测试.png')
            self.assertEqual(item['files'][0]['name'], 'source.png')
            file_url = f"/v1/jobs/{item['id']}/files/source.png"
            ranged = client.get(file_url, headers={**headers, 'Range': 'bytes=-8'})
            self.assertEqual(ranged.status_code, 206)
            self.assertEqual(ranged.content, output.getvalue()[-8:])
            self.assertEqual(client.head(file_url, headers=headers).status_code, 200)
            self.assertEqual(client.post(f"/v1/jobs/{item['id']}/retry", headers=headers).status_code, 409)

    def test_network_guard_rejects_private_socket_destination(self):
        import socket
        with app.public_network_only():
            with socket.socket() as connection:
                with self.assertRaises(OSError): connection.connect(('127.0.0.1', 80))

    def test_media_probe_rejects_playlist_despite_video_mime(self):
        with tempfile.TemporaryDirectory() as raw:
            item = Path(raw) / 'fake.mp4'; item.write_text('#EXTM3U\n#EXTINF:1\nhttp://127.0.0.1/a.ts\n')
            with self.assertRaises(Exception): app.media_info(item, 'video/mp4')

    def test_uploaded_video_can_be_compressed_and_fetched(self):
        with tempfile.TemporaryDirectory() as raw:
            clip = Path(raw) / 'clip.mp4'
            subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=12:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(clip)], check=True, capture_output=True)
            headers = {'Authorization': 'Bearer test-token'}
            with TestClient(app.app) as client:
                uploaded = client.post('/v1/uploads?name=clip.mp4', content=clip.read_bytes(), headers={**headers, 'Content-Type': 'video/mp4'})
                self.assertEqual(uploaded.status_code, 200, uploaded.text)
                beyond = client.post('/v1/jobs', json={'operation': 'frame', 'sourceId': uploaded.json()['id'], 'options': {'at': 2}}, headers=headers)
                self.assertEqual(beyond.status_code, 422)
                created = client.post('/v1/jobs', json={'operation': 'compress', 'sourceId': uploaded.json()['id'], 'sourceFile': uploaded.json()['files'][0]['name'], 'options': {'maxHeight': 720}}, headers=headers)
                self.assertEqual(created.status_code, 200, created.text)
                task_id = created.json()['id']; result = None
                for _ in range(50):
                    result = client.get(f'/v1/jobs/{task_id}', headers=headers).json()
                    if result['state'] in {'saved', 'failed'}: break
                    time.sleep(0.1)
                self.assertEqual(result['state'], 'saved', result)
                self.assertTrue(client.get(f'/v1/jobs/{task_id}/files/output.mp4', headers=headers).content)

    def test_uploaded_audio_can_be_trimmed(self):
        with tempfile.TemporaryDirectory() as raw:
            source = Path(raw) / 'sound.wav'
            subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', str(source)], check=True, capture_output=True)
            headers = {'Authorization': 'Bearer test-token'}
            with TestClient(app.app) as client:
                uploaded = client.post('/v1/uploads?name=sound.wav', content=source.read_bytes(), headers={**headers, 'Content-Type': 'audio/wav'}).json()
                created = client.post('/v1/jobs', json={'operation':'trim', 'sourceId':uploaded['id'], 'sourceFile':uploaded['files'][0]['name'], 'options':{'start':0.2,'end':0.8}}, headers=headers).json()
                for _ in range(50):
                    result = client.get('/v1/jobs/' + created['id'], headers=headers).json()
                    if result['state'] in {'saved','failed'}: break
                    time.sleep(0.1)
                self.assertEqual(result['state'], 'saved', result)
                self.assertEqual(result['files'][0]['type'], 'audio/mpeg')
                self.assertLess(result['content']['duration'], 700)

    def test_request_id_is_idempotent_and_rejects_changed_contract(self):
        from PIL import Image
        output = BytesIO(); Image.new('RGB', (4, 4), 'green').save(output, 'PNG')
        headers = {'Authorization': 'Bearer test-token'}
        with TestClient(app.app) as client:
            uploaded = client.post('/v1/uploads?name=picture.png', content=output.getvalue(), headers={**headers, 'Content-Type': 'image/png'}).json()
            request_id = str(uuid.uuid4())
            body = {'operation': 'remove-background', 'sourceId': uploaded['id'], 'sourceFile': uploaded['files'][0]['name'], 'requestId': request_id}
            with patch.object(app, 'run_media', side_effect=RuntimeError('test no model')):
                first = client.post('/v1/jobs', json=body, headers=headers)
                second = client.post('/v1/jobs', json=body, headers=headers)
            self.assertEqual(first.status_code, 200)
            self.assertEqual(second.status_code, 200)
            self.assertEqual(first.json()['id'], request_id)
            self.assertEqual(second.json()['id'], request_id)
            changed = client.post('/v1/jobs', json={**body, 'options': {'format': 'png'}}, headers=headers)
            self.assertEqual(changed.status_code, 409)

    def test_cleanup_preserves_source_of_active_job(self):
        from PIL import Image
        output = BytesIO(); Image.new('RGB', (4, 4), 'green').save(output, 'PNG')
        headers = {'Authorization': 'Bearer test-token', 'Content-Type': 'image/png'}
        with TestClient(app.app) as client:
            source = client.post('/v1/uploads?name=active.png', content=output.getvalue(), headers=headers).json()
            active = {'id': str(uuid.uuid4()), 'created': time.time(), 'state': 'queued', 'operation': 'remove-background', 'sourceId': source['id'], 'files': []}
            app.write(active)
            with patch.object(app, 'CACHE_LIMIT', 1): app.cleanup()
            self.assertEqual(app.read(source['id'])['state'], 'saved')


if __name__ == '__main__':
    unittest.main()
