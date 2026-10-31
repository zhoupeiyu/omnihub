"""Fetch one bounded, data-only snapshot; never execute upstream JavaScript."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--directory', required=True)
parser.add_argument('--current', default='')
args = parser.parse_args()
directory = Path(args.directory).resolve()
directory.mkdir(parents=True, exist_ok=True, mode=0o700)

def request(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={
        'User-Agent': 'OmniHub-Private-Reference-Sync/1.0', 'Accept': 'application/vnd.github+json'
    }), timeout=45)

with request('https://api.github.com/repos/sleepy-zone/ai-ref-library-cn/commits/main') as response:
    raw = response.read(1_000_001)
    if len(raw) > 1_000_000:
        raise ValueError('commit_response_too_large')
    commit = json.loads(raw)['sha']
if not re.fullmatch('[a-f0-9]{40}', commit):
    raise ValueError('invalid_commit')
target = directory / commit
if target.joinpath('complete.json').is_file():
    print(json.dumps({'commit': commit, 'snapshot': str(target), 'unchanged': commit == args.current}))
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix='reference-', dir=directory) as temporary:
    scratch = Path(temporary)
    archive_path = scratch / 'source.tar.gz'
    with request(f'https://api.github.com/repos/sleepy-zone/ai-ref-library-cn/tarball/{commit}') as response, archive_path.open('wb') as output:
        size = 0
        while chunk := response.read(128 * 1024):
            size += len(chunk)
            if size > 200 * 1024 ** 2:
                raise ValueError('snapshot_download_limit')
            output.write(chunk)
    extracted = scratch / 'data-only'
    extracted.mkdir(mode=0o700)
    expanded, files, seen = 0, 0, set()
    with tarfile.open(archive_path, 'r:gz') as archive:
        for member in archive:
            parts = member.name.split('/', 1)
            if len(parts) != 2:
                continue
            relative = parts[1]
            if not re.fullmatch(r'(data/(face|pose|costume)\.js|thumbs/[A-Za-z0-9_-]{1,100}\.webp)', relative):
                continue
            if not member.isfile() or member.issym() or member.islnk() or relative in seen or member.size > 8 * 1024 ** 2:
                raise ValueError('invalid_snapshot_entry')
            seen.add(relative)
            expanded += member.size
            files += 1
            if expanded > 512 * 1024 ** 2 or files > 60003:
                raise ValueError('snapshot_expansion_limit')
            destination = extracted / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with archive.extractfile(member) as source, destination.open('xb') as output:
                shutil.copyfileobj(source, output)
            destination.chmod(0o600)
    for kind in ['face', 'pose', 'costume']:
        if not (extracted / f'data/{kind}.js').is_file():
            raise ValueError('incomplete_snapshot')
    (extracted / 'complete.json').write_text(json.dumps({'commit': commit, 'files': files, 'bytes': expanded}))
    os.rename(extracted, target)
print(json.dumps({'commit': commit, 'snapshot': str(target), 'unchanged': False}))
