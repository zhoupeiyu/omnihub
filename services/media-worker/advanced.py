"""Bounded offline subtitle and two-stem processing helpers.

This module deliberately has no HTTP server and never downloads a model.  The
media worker calls it in a short-lived subprocess after it has resolved a
source file under its own storage root.  Keeping the ML imports here means the
memory they allocate is released when that subprocess exits.
"""
from __future__ import annotations

import json
import math
import mimetypes
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

MAX_DURATION_SECONDS = 300
MAX_SEGMENTS = 1200
LANGUAGES = {"auto", "zh", "en"}
TARGETS = {"none", "zh", "en"}


class AdvancedError(RuntimeError):
    pass


def _run(args: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, timeout=timeout, check=True,
                              env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                                   "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1"})
    except subprocess.TimeoutExpired as exc:
        raise AdvancedError("处理超时。") from exc
    except subprocess.CalledProcessError:
        raise AdvancedError("媒体文件无法完成处理。") from None


def _inside(path: Path, root: Path) -> Path:
    value = path.resolve()
    if value.parent != root.resolve() or not value.is_file():
        raise AdvancedError("输出文件不合法。")
    return value


def _duration(path: Path, timeout: int) -> tuple[float, int, int, bool]:
    probe = _run(["ffprobe", "-v", "error", "-show_entries",
                  "format=duration:stream=codec_type,width,height", "-of", "json", str(path)], min(30, timeout))
    try:
        data = json.loads(probe.stdout)
        seconds = float(data.get("format", {}).get("duration") or 0)
        streams = data.get("streams") or []
        video = next((item for item in streams if item.get("codec_type") == "video"), {})
    except (ValueError, TypeError):
        raise AdvancedError("媒体文件无法读取。") from None
    if not math.isfinite(seconds) or seconds <= 0 or seconds > MAX_DURATION_SECONDS:
        raise AdvancedError("字幕和音轨分离仅支持 5 分钟以内的媒体。")
    return seconds, int(video.get("width") or 0), int(video.get("height") or 0), bool(video)


def _fmt(seconds: float, vtt: bool = False) -> str:
    millis = max(0, round(seconds * 1000)); hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000); seconds, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02}{'.' if vtt else ','}{millis:03}"


def _subtitle_text(value: str) -> str:
    return " ".join(str(value).replace("\r", " ").replace("\n", " ").split()).strip()


def _write_subtitles(segments: list[dict[str, Any]], destination: Path) -> tuple[Path, Path, Path]:
    srt, vtt, plain = destination / "subtitles.srt", destination / "subtitles.vtt", destination / "transcript.txt"
    srt_rows, vtt_rows, words = [], ["WEBVTT", ""] , []
    for index, item in enumerate(segments, 1):
        body = _subtitle_text(item["text"])
        if not body: continue
        start, end = float(item["start"]), float(item["end"])
        if not (0 <= start < end <= MAX_DURATION_SECONDS): raise AdvancedError("字幕时间轴无效。")
        srt_rows.extend([str(index), f"{_fmt(start)} --> {_fmt(end)}", body, ""])
        vtt_rows.extend([f"{_fmt(start, True)} --> {_fmt(end, True)}", body, ""])
        words.append(body)
    if not words: raise AdvancedError("没有识别到清晰语音。")
    srt.write_text("\n".join(srt_rows), encoding="utf-8")
    vtt.write_text("\n".join(vtt_rows), encoding="utf-8")
    plain.write_text("\n".join(words) + "\n", encoding="utf-8")
    return srt, vtt, plain


def _transcribe(source: Path, model_dir: Path, language: str, timeout: int) -> tuple[str, list[dict[str, Any]]]:
    if language not in LANGUAGES: raise AdvancedError("识别语言不支持。")
    if not model_dir.is_dir(): raise AdvancedError("字幕模型尚未安装。")
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise AdvancedError("字幕组件尚未安装。") from exc
    # CPU int8 prevents a full float model from occupying the small host.
    try:
        model = WhisperModel(str(model_dir), device="cpu", compute_type="int8", cpu_threads=1, num_workers=1)
        raw, info = model.transcribe(str(source), language=None if language == "auto" else language,
                                     beam_size=1, vad_filter=True, condition_on_previous_text=False)
        segments = []
        for item in raw:
            if len(segments) >= MAX_SEGMENTS: raise AdvancedError("字幕片段过多，请缩短媒体。")
            phrase = _subtitle_text(item.text)
            if phrase and 0 <= item.start < item.end <= MAX_DURATION_SECONDS:
                segments.append({"start": round(float(item.start), 3), "end": round(float(item.end), 3), "text": phrase})
        return str(getattr(info, "language", language)), segments
    except AdvancedError: raise
    except Exception as exc: raise AdvancedError("语音识别未完成，请换一段人声更清晰的媒体。") from exc


def _translate(segments: list[dict[str, Any]], source: str, target: str) -> list[dict[str, Any]]:
    if target == "none" or target == source: return segments
    if target not in TARGETS or source not in {"zh", "en"}: raise AdvancedError("当前仅支持中英文离线翻译。")
    package = Path(os.getenv("ARGOS_PACKAGES_DIR", os.getenv("ADVANCED_ARGOS_MODELS", "/models/advanced/argos"))) / f"{source}_{target}"
    try:
        import ctranslate2
        import sentencepiece as spm
        model, tokenizer = package / "model", package / "sentencepiece.model"
        if not model.is_dir() or not tokenizer.is_file(): raise LookupError
        processor = spm.SentencePieceProcessor(model_file=str(tokenizer))
        engine = ctranslate2.Translator(str(model), device="cpu", inter_threads=1, intra_threads=1,
                                       compute_type="int8")
    except Exception as exc:
        raise AdvancedError("对应的离线翻译包尚未安装。") from exc
    translated = []
    for item in segments:
        tokens = processor.encode(item["text"], out_type=str)
        result = engine.translate_batch([tokens], beam_size=1, max_batch_size=1, batch_type="examples")
        value = _subtitle_text(processor.decode(result[0].hypotheses[0])) if result and result[0].hypotheses else ''
        translated.append({**item, "text": value or item["text"]})
    return translated


def _file(path: Path, label: str, kind: str = "output") -> dict[str, Any]:
    size = path.stat().st_size
    if not size: raise AdvancedError("输出文件为空。")
    return {"name": path.name, "type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            "bytes": size, "label": label, "kind": kind}


def _burn(source: Path, srt: Path, destination: Path, timeout: int) -> Path:
    output = destination / "subtitled.mp4"
    # Paths are generated by us inside one temp directory.  FFmpeg receives argv,
    # never a shell string; apostrophes/backslashes are escaped for filter syntax.
    escaped = str(srt).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    _run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(source),
          "-vf", f"subtitles='{escaped}'", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25",
          "-c:a", "aac", "-movflags", "+faststart", str(output)], timeout)
    return _inside(output, destination)


def _separate(source: Path, destination: Path, model_dir: Path, timeout: int) -> tuple[Path, Path]:
    model = model_dir / "UVR-MDX-NET-Inst_HQ_3.onnx"
    if not model.is_file(): raise AdvancedError("人声分离模型尚未安装。")
    try:
        from audio_separator.separator import Separator
    except ImportError as exc: raise AdvancedError("人声分离组件尚未安装。") from exc
    with tempfile.TemporaryDirectory(dir=destination, prefix="separate-") as temp:
        work = Path(temp)
        try:
            separator = Separator(output_dir=str(work), output_format="MP3", model_file_dir=str(model_dir),
                                  normalization_threshold=0.9, output_single_stem=None)
            separator.load_model(model_filename=model.name)
            names = separator.separate(str(source))
        except Exception as exc: raise AdvancedError("人声分离未完成，请换一段较短的音频。") from exc
        outputs = [_inside((work / Path(name).name), work) for name in names]
        vocals = next((path for path in outputs if "vocal" in path.name.lower()), None)
        instrumental = next((path for path in outputs if any(x in path.name.lower() for x in ("instrument", "inst", "no_vocal"))), None)
        if not vocals or not instrumental: raise AdvancedError("人声分离没有返回完整的两条音轨。")
        final_vocals, final_instrumental = destination / "vocals.mp3", destination / "instrumental.mp3"
        shutil.copyfile(vocals, final_vocals); shutil.copyfile(instrumental, final_instrumental)
    return _inside(final_vocals, destination), _inside(final_instrumental, destination)


def run(operation: str, input_path: str | Path, out_dir: str | Path, options: dict[str, Any], max_bytes: int, timeout: int) -> dict[str, Any]:
    source, destination = Path(input_path).resolve(), Path(out_dir).resolve()
    if not source.is_file() or source.stat().st_size <= 0 or source.stat().st_size > max_bytes: raise AdvancedError("输入文件不合法或超过限制。")
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(destination.iterdir()): raise AdvancedError("输出目录必须为空。")
    duration, width, height, has_video = _duration(source, timeout)
    content = {"duration": round(duration * 1000), "width": width, "height": height, "hasVideo": has_video}
    if operation == "subtitles":
        language, target = options.get("language", "auto"), options.get("targetLanguage", "none")
        model_dir = Path(options.get("modelDir", "/models/faster-whisper-base"))
        detected, segments = _transcribe(source, model_dir, language, timeout)
        final_language = target if target != "none" else detected
        segments = _translate(segments, detected, target)
        srt, vtt, plain = _write_subtitles(segments, destination)
        files = [_file(srt, "字幕 SRT"), _file(vtt, "字幕 VTT"), _file(plain, "转写文本")]
        if options.get("burnIn"):
            if not has_video: raise AdvancedError("烧录字幕需要视频文件。")
            files.append(_file(_burn(source, srt, destination, timeout), "带字幕视频"))
        return {"files": files, "content": content, "subtitles": {"language": final_language, "segments": segments}}
    if operation == "separate":
        if duration > MAX_DURATION_SECONDS: raise AdvancedError("人声分离仅支持 5 分钟以内的媒体。")
        model_dir = Path(options.get("modelDir", "/models/uvr-mdx"))
        vocals, instrumental = _separate(source, destination, model_dir, timeout)
        return {"files": [_file(vocals, "人声"), _file(instrumental, "伴奏")], "content": content}
    raise AdvancedError("不支持这个高级媒体操作。")
