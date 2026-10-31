# Advanced offline-media notices

## Gallery collection

- `gallery-dl==1.32.18` is GPL-2.0-only, as declared by its upstream PyPI
  metadata and Codeberg source. This service uses it only to obtain public
  image metadata; the worker's guarded HTTP client downloads image bytes.

- `faster-whisper` and `Systran/faster-whisper-base` are MIT licensed. The
  worker uses the multilingual `base` CTranslate2 export on CPU INT8, with VAD
  and original ASR timestamps. It does not claim word-level alignment.
- The Argos OpenNMT/CTranslate2 English-to-Chinese and Chinese-to-English
  packages are consumed directly through CTranslate2 and SentencePiece. This
  avoids Argos's optional stanza/Torch runtime; translation remains unavailable
  until the administrator has installed and verified those package files. The
  upstream index records package/version but not a package license or checksum;
  `prepare-advanced-models.py` pins the two reviewed v1.9 bytes and rejects a
  mismatch. Do not describe the translation weights themselves as MIT merely
  because the Argos runtime is MIT.
- `audio-separator` and Ultimate Vocal Remover are MIT licensed. It is a
  separate second-stage image because CPU Torch has materially higher RAM use.
  The deployed
  `UVR-MDX-NET-Inst_HQ_3.onnx` model must retain the UVR credit described by its
  upstream project. GitHub's UVR release asset does not publish an integrity
  digest, so the preparation script keeps separation disabled until a reviewed
  SHA256 is recorded; it never downloads that model unchecked.
- No customer media, subtitle text, or task identifiers are sent to a cloud API.
