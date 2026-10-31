"""Pure boundary tests for the short-lived advanced media runner."""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys
sys.path.insert(0, str(Path(__file__).parents[1]))
import advanced


class AdvancedTests(unittest.TestCase):
    def test_subtitle_files_preserve_real_times(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            srt, vtt, text = advanced._write_subtitles([
                {"start": 1.125, "end": 2.5, "text": " hello\n world "},
                {"start": 3.0, "end": 4.999, "text": "第二句"},
            ], root)
            self.assertIn('00:00:01,125 --> 00:00:02,500', srt.read_text())
            self.assertIn('00:00:03.000 --> 00:00:04.999', vtt.read_text())
            self.assertEqual(text.read_text(), 'hello world\n第二句\n')

    def test_subtitle_rejects_empty_or_bad_timeline(self):
        with tempfile.TemporaryDirectory() as raw:
            with self.assertRaises(advanced.AdvancedError): advanced._write_subtitles([], Path(raw))
            with self.assertRaises(advanced.AdvancedError): advanced._write_subtitles([{"start": 3, "end": 2, "text": "x"}], Path(raw))

    def test_run_subtitles_contract_uses_asr_times_not_uniform_times(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); source = root / 'sample.wav'; destination = root / 'out'
            subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', str(source)], check=True, capture_output=True)
            segments = [{"start": .2, "end": 1.9, "text": "first"}, {"start": 2.1, "end": 3.7, "text": "second"}]
            with patch.object(advanced, '_transcribe', return_value=('en', segments)):
                result = advanced.run('subtitles', source, destination, {'language':'auto', 'targetLanguage':'none'}, 10_000_000, 30)
            self.assertEqual(result['subtitles']['segments'], segments)
            self.assertEqual([item['name'] for item in result['files']], ['subtitles.srt','subtitles.vtt','transcript.txt'])
            self.assertTrue((destination / 'subtitles.srt').is_file())

    def test_run_rejects_large_input_and_unknown_operation(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); source = root / 'bad.wav'; source.write_bytes(b'x')
            with self.assertRaises(advanced.AdvancedError): advanced.run('subtitles', source, root/'out', {}, 0, 10)
            with patch.object(advanced, '_duration', return_value=(1,0,0,False)):
                with self.assertRaises(advanced.AdvancedError): advanced.run('bad', source, root/'out2', {}, 20, 10)

    def test_translate_requires_installed_offline_pair(self):
        with self.assertRaises(advanced.AdvancedError): advanced._translate([{'start':0,'end':1,'text':'hi'}], 'fr', 'zh')

    def test_runner_never_returns_traceback(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('advanced_runner', Path(__file__).parents[1] / 'advanced-runner.py')
        advanced_runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(advanced_runner)
        with patch('sys.stdin') as stdin, patch('sys.stdout') as stdout:
            stdin.buffer.read.return_value = b'{not-json'
            self.assertEqual(advanced_runner.main(), 2)
            payload = json.loads(stdout.write.call_args.args[0])
            self.assertFalse(payload['ok']); self.assertNotIn('traceback', payload['error'].lower())


if __name__ == '__main__': unittest.main()
