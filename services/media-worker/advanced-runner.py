"""JSON-lines boundary for :mod:`advanced`, intended for one job per process."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from advanced import AdvancedError, run


def main() -> int:
    try:
        request = json.loads(sys.stdin.buffer.read())
        if not isinstance(request, dict): raise ValueError
        result = run(str(request["operation"]), Path(request["input_path"]), Path(request["out_dir"]),
                     request.get("options") if isinstance(request.get("options"), dict) else {},
                     int(request.get("max_bytes", 100 * 1024 * 1024)), int(request.get("timeout", 600)))
        sys.stdout.write(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except (KeyError, ValueError, TypeError):
        sys.stdout.write(json.dumps({"ok": False, "error": "高级媒体请求不正确。"}, ensure_ascii=False)); return 2
    except AdvancedError as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)); return 1


if __name__ == "__main__": raise SystemExit(main())
