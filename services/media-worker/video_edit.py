"""Closed-parameter FFmpeg command construction for single-source video edits."""
from __future__ import annotations

from pathlib import Path

ASPECTS = {"original": None, "9:16": (720, 1280), "1:1": (1080, 1080), "16:9": (1280, 720)}


def build_command(source: Path, output: Path, options: dict, max_bytes: int, threads: int) -> list[str]:
    rotation = options["rotation"]
    filters: list[str] = []
    if rotation == 90:
        filters.append("transpose=clock")
    elif rotation == 180:
        filters.extend(("hflip", "vflip"))
    elif rotation == 270:
        filters.append("transpose=cclock")
    target = ASPECTS[options["aspect"]]
    if target:
        width, height = target
        if options["fit"] == "crop":
            filters.append(f"scale={width}:{height}:force_original_aspect_ratio=increase")
            filters.append(f"crop={width}:{height}")
        else:
            filters.append(f"scale={width}:{height}:force_original_aspect_ratio=decrease")
            filters.append(f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black")
    speed = options["speed"]
    if speed != 1:
        filters.append(f"setpts=PTS/{speed:g}")
    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-filter_threads", str(threads),
        "-threads", str(threads), "-protocol_whitelist", "file,pipe", "-i", str(source),
        "-map", "0:v:0", "-threads", str(threads), "-fs", str(max_bytes),
    ]
    if filters:
        command.extend(("-vf", ",".join(filters)))
    if options["mute"]:
        command.append("-an")
    else:
        audio = []
        if options["volume"] != 1:
            audio.append(f"volume={options['volume']:g}")
        if speed != 1:
            audio.append(f"atempo={speed:g}")
        command.extend(("-map", "0:a?"))
        if audio:
            command.extend(("-af", ",".join(audio)))
        command.extend(("-c:a", "aac"))
    command.extend(("-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)))
    return command


def build_concat_command(inputs: list[tuple[Path, float, bool]], output: Path, max_bytes: int, threads: int) -> list[str]:
    """Normalize 2-5 video files to 720p/30fps/stereo AAC and concatenate them."""
    command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-filter_threads", str(threads), "-threads", str(threads)]
    source_indices: list[int] = []
    audio_indices: list[int] = []
    next_index = 0
    for source, duration, has_audio in inputs:
        source_indices.append(next_index)
        command.extend(("-protocol_whitelist", "file,pipe", "-i", str(source)))
        next_index += 1
        if has_audio:
            audio_indices.append(source_indices[-1])
        else:
            command.extend(("-f", "lavfi", "-t", f"{duration:.3f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"))
            audio_indices.append(next_index); next_index += 1
    filters = []
    source_audio_index = 0
    for index, (_, _, has_audio) in enumerate(inputs):
        source_index, audio = source_indices[index], audio_indices[index]
        filters.append(f"[{source_index}:v]fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,setpts=PTS-STARTPTS[v{index}]")
        filters.append(f"[{audio}:a]aresample=48000,asetpts=PTS-STARTPTS[a{index}]")
    joined = "".join(f"[v{i}][a{i}]" for i in range(len(inputs)))
    filters.append(f"{joined}concat=n={len(inputs)}:v=1:a=1[v][a]")
    command.extend(("-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]", "-fs", str(max_bytes), "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", str(output)))
    return command
