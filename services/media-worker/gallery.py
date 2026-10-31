"""Public, metadata-only gallery-dl extraction with no configuration loading."""
from __future__ import annotations

import threading
from typing import Any
from urllib.parse import urlparse

_LOCK = threading.Lock()


def is_available() -> bool:
    try:
        from gallery_dl import config, exception, extractor, job
        return all((callable(config.clear), callable(config.set), callable(extractor.find), hasattr(exception, "StopExtraction"), hasattr(job, "DataJob")))
    except (ImportError, AttributeError):
        return False


def extract_image_candidates(url: str, limit: int) -> list[str]:
    """Return direct image URLs; gallery-dl never writes media bytes here."""
    from gallery_dl import config, exception, extractor, job

    class BoundedDataJob(job.DataJob):
        def handle_url(self, image_url: str, metadata: dict[str, Any]) -> None:
            super().handle_url(image_url, metadata)
            if len(self.data_urls) >= limit:
                raise exception.StopExtraction()

    with _LOCK:
        config.clear()  # never read /etc or user gallery-dl configuration
        config.set(("extractor",), "timeout", 15)
        config.set(("extractor",), "retries", 0)
        config.set(("extractor",), "sleep-request", 0)
        found = extractor.find(url)
        if not found:
            raise RuntimeError("该公开图库链接不受支持。")
        result = BoundedDataJob(found, file=None, ensure_ascii=True)
        result.run()
        if result.exception:
            raise RuntimeError("图库元数据读取失败。")
        values = []
        for item in result.data_urls:
            parsed = urlparse(item) if isinstance(item, str) else None
            if parsed and parsed.scheme == "https" and parsed.hostname == "i.imgur.com" and not parsed.username and not parsed.password and parsed.port is None:
                values.append(item)
            if len(values) >= limit:
                break
        return values
