# OmniHub media worker

The worker is deliberately a loopback-only, bearer-authenticated sidecar. It stores only validated uploads and its own outputs beneath `MEDIA_WORKER_ROOT`; neither local paths nor shell parameters are accepted from HTTP.

`rembg==2.0.86` is MIT licensed. The image pins the lightweight `u2netp.onnx` file linked by rembg and checks SHA-256 `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8` at build time. The upstream U-2-Net repository is Apache-2.0; the rembg release asset does not state a separate model-weight license, so confirm redistribution terms before publishing the image outside the project. The BRIA model is never selected. `yt-dlp==2026.10.26` is fixed to the official PyPI release. The downloader accepts only public single-work URLs from the allowlist, rejects non-public DNS/socket destinations and redirects, disables proxies, and downloads direct HTTPS media files. Some works only offer segmented or protected streams and will fail safely.

Build and test inside this directory:

```sh
docker build -t omnihub-media-worker:test .
docker run --rm --entrypoint python omnihub-media-worker:test -m unittest discover -s tests -v
```

Set `MEDIA_WORKER_TOKEN` before starting `docker compose -f compose.yml up -d --build`. The gateway must pass the same value in `Authorization: Bearer …`.
