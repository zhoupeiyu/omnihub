"""Fetch checksum-pinned advanced media models outside request handling."""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import stat
import subprocess
import sys
import zipfile
from pathlib import Path

WHISPER_REVISION = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"
HF_BASE = f"https://huggingface.co/Systran/faster-whisper-base/resolve/{WHISPER_REVISION}"
WHISPER = {
    "model.bin": "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9",
    "config.json": "56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a",
    "tokenizer.json": "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab",
    "vocabulary.txt": "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913",
}

# Argos's official package index fixes these at 1.9, but omits digests.  These
# hashes were cross-checked against immutable Xet objects of the same packages.
ARGOS = {
    "en_zh": ("https://data.argosopentech.com/argospm/v1/translate-en_zh-1_9.argosmodel", "433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab"),
    "zh_en": ("https://data.argosopentech.com/argospm/v1/translate-zh_en-1_9.argosmodel", "62e7af5a3a48b530e47b7b3e5c78c2de79073ecd815750d2bf3ab35b4a67da2d"),
}

# GitHub's release asset API publishes no content digest. This SHA256 was
# computed from the named 66,759,214-byte release asset and retained here so
# future installs reject a changed release object.
UVR_URL = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx"
UVR_SHA256 = "317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc"
UVR_DATA_REVISION = "3826b05b570dbd4fbedbc807758803b35348ba1b"
UVR_DATA_BASE = f"https://raw.githubusercontent.com/TRvlvr/application_data/{UVR_DATA_REVISION}"
UVR_METADATA = {
    "download_checks.json": (f"{UVR_DATA_BASE}/filelists/download_checks.json", "d3622e1fa19c161d3cf704927711b453d593a3f1eb0f2e0838c3136907935151"),
    "vr_model_data.json": (f"{UVR_DATA_BASE}/vr_model_data/model_data_new.json", "6a2021b9aa355c10f845b68c73944d47bd9e1fdf37b8a584b14ce8f88b09bb2f"),
    "mdx_model_data.upstream.json": (f"{UVR_DATA_BASE}/mdx_model_data/model_data_new.json", "1aca8f9bcc57233bc714029663a9ec2345d9c7721f91e5e08f46392a879c6a9a"),
}
UVR_MODEL_MD5 = "81452e3891782d67b1ce7fd05d6ac757"
UVR_MODEL_DATA = {"compensate": 1.022, "mdx_dim_f_set": 3072, "mdx_dim_t_set": 8,
                  "mdx_n_fft_scale_set": 6144, "primary_stem": "Instrumental"}


def sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def checked_download(url: str, target: Path, expected: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and sha256(target) == expected:
        return
    partial = target.with_suffix(target.suffix + ".part")
    command = ["curl", "--fail", "--location", "--proto", "=https", "--tlsv1.2", "--retry", "4", "--retry-all-errors", "--connect-timeout", "20"]
    if partial.exists() and partial.stat().st_size:
        command.extend(["--continue-at", "-"])
    command.extend(["--output", str(partial), url])
    subprocess.run(command, check=True, stdin=subprocess.DEVNULL)
    actual = sha256(partial)
    if actual != expected:
        raise RuntimeError(f"checksum mismatch for {target.name}: {actual}")
    os.replace(partial, target)


def readonly_tree(root: Path) -> None:
    for item in root.rglob("*"):
        if item.is_symlink():
            raise RuntimeError(f"model tree contains a symlink: {item.name}")
        item.chmod(0o444 if item.is_file() else 0o555)
    root.chmod(0o555)


def replace_tree(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise RuntimeError(f"refusing to overwrite existing model directory: {target}")
    replacement = target.with_name(target.name + ".next")
    if replacement.exists(): shutil.rmtree(replacement)
    shutil.copytree(source, replacement)
    readonly_tree(replacement)
    os.replace(replacement, target)


def safe_extract(package: Path, destination: Path) -> None:
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    base = destination.resolve()
    with zipfile.ZipFile(package) as archive:
        for member in archive.infolist():
            candidate = (destination / member.filename).resolve()
            if candidate != base and base not in candidate.parents:
                raise RuntimeError("translation package contains an unsafe path")
            if stat.S_ISLNK(member.external_attr >> 16):
                raise RuntimeError("translation package contains a symlink")
        archive.extractall(destination)


def install_whisper(models: Path, scratch: Path) -> None:
    installed = models / "faster-whisper-base"
    if installed.is_dir() and all((installed / name).is_file() and sha256(installed / name) == expected for name, expected in WHISPER.items()):
        return
    if installed.exists(): raise RuntimeError(f"existing whisper model failed verification: {installed}")
    staged = scratch / "faster-whisper-base"
    for name, expected in WHISPER.items(): checked_download(f"{HF_BASE}/{name}", staged / name, expected)
    replace_tree(staged, installed)


def install_argos(models: Path, scratch: Path) -> None:
    for name, (url, expected) in ARGOS.items():
        installed = models / "argos" / name
        marker = installed / ".omnihub-package-sha256"
        if marker.is_file() and marker.read_text(encoding="ascii").strip() == expected and (installed / "model" / "model.bin").is_file() and (installed / "sentencepiece.model").is_file():
            continue
        if installed.exists(): raise RuntimeError(f"existing translation package failed verification: {installed}")
        package, extracted = scratch / f"translate-{name}-1_9.argosmodel", scratch / name
        checked_download(url, package, expected); safe_extract(package, extracted)
        if not (extracted / "model" / "model.bin").is_file() or not (extracted / "sentencepiece.model").is_file():
            raise RuntimeError(f"translation package {name} has an unexpected layout")
        (extracted / ".omnihub-package-sha256").write_text(expected + "\n", encoding="ascii")
        replace_tree(extracted, installed)


def install_uvr(models: Path, scratch: Path) -> None:
    installed, staged = models / "uvr-mdx", scratch / "uvr-mdx"
    if (installed / "UVR-MDX-NET-Inst_HQ_3.onnx").is_file() and sha256(installed / "UVR-MDX-NET-Inst_HQ_3.onnx") == UVR_SHA256:
        return
    if installed.exists(): raise RuntimeError(f"existing UVR model failed verification: {installed}")
    checked_download(UVR_URL, staged / "UVR-MDX-NET-Inst_HQ_3.onnx", UVR_SHA256)
    # audio-separator otherwise fetches these mutable `main` branch files from
    # inside load_model(). Preseed the exact files it looks for before mounting
    # this directory read-only, so separation has no request-time network path.
    for name, (url, expected) in UVR_METADATA.items():
        checked_download(url, staged / name, expected)
    # The release object has a different MD5 from the historical UVR table's
    # entry for this filename. Add the reviewed architecture tuple for its
    # actual MD5 while retaining the pinned upstream table beside it.
    import json
    upstream = json.loads((staged / "mdx_model_data.upstream.json").read_text(encoding="utf-8"))
    upstream[UVR_MODEL_MD5] = UVR_MODEL_DATA
    (staged / "mdx_model_data.json").write_text(json.dumps(upstream, separators=(",", ":")), encoding="utf-8")
    replace_tree(staged, installed)


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare verified offline advanced-media model inputs.")
    parser.add_argument("--models", type=Path, default=Path("/opt/omnihub-media-worker/models/advanced"))
    parser.add_argument("--only", choices=("all", "whisper", "argos", "uvr"), default="all")
    args = parser.parse_args(); models = args.models.resolve(); models.mkdir(mode=0o755, parents=True, exist_ok=True)
    scratch = models.parent / ".advanced-model-downloads"; scratch.mkdir(mode=0o700, exist_ok=True)
    if args.only in {"all", "whisper"}: install_whisper(models, scratch)
    if args.only in {"all", "argos"}: install_argos(models, scratch)
    if args.only in {"all", "uvr"}: install_uvr(models, scratch)
    print("advanced model preparation completed")


if __name__ == "__main__":
    try: main()
    except (OSError, RuntimeError, subprocess.CalledProcessError, zipfile.BadZipFile) as exc:
        print(f"advanced model preparation failed: {exc}", file=sys.stderr); raise SystemExit(1)
