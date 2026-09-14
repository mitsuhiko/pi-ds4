---
name: pi-ds4-config
description: Reconfigure pi-ds4 for local DeepSeek V4 Flash, DeepSeek V4.1 Flash, DeepSeek V4 Pro, and GLM 5.2 models. Use when the user asks how to configure, download models, change protocol/runtime settings, or debug pi-ds4.
---

# pi-ds4 configuration

To reconfigure pi-ds4/ds4, edit `~/.pi/ds4/settings.json` (create it if missing). Do not edit other runtime state files in `~/.pi/ds4` unless explicitly debugging.

The file is a JSON object. Environment variables override it. Keys can be env names (`DS4_READY_TIMEOUT_MS`), camelCase without `DS4_` (`readyTimeoutMs`), or lower snake_case (`ready_timeout_ms`). Use `settings.schema.json` / `settings.example.json` from the pi-ds4 package for validation/examples.

Minimal example:

```json
{
  "$schema": "https://raw.githubusercontent.com/mitsuhiko/pi-ds4/main/settings.schema.json",
  "protocol": "openai-responses",
  "contextTokens": 393216,
  "readyTimeoutMs": 900000
}
```

Common settings:

- `protocol`: `openai`, `openai-responses` (default), or `anthropic`
- `contextTokens`: ds4/Pi context ceiling (default `393216`; GLM models use their lower supported limit)
- `power`: DeepSeek GPU duty-cycle target from `1` to `100` (default `100`). Lower values reduce heat and fan noise. GLM 5.2 and DeepSeek V4.1 always run at `100` because upstream does not support throttling them.
- `ssdStreaming`: `auto` (default), `true`, or `false`. In `auto` the server gets `--ssd-streaming` when a model's resident weights exceed 90% of system RAM; only DeepSeek V4.1 declares such a footprint today (152 GiB for Q2, 294 GiB for Q4, with Engram tables staying on disk). Streaming models also cap the context at 131072 tokens unless `contextTokens` is set explicitly.
- `autoUpdate`: fast-forward the package-managed ds4 checkout before use (default `true`; local/external checkouts are untouched)
- `readyTimeoutMs`: server startup timeout in ms
- `runtimeDir`: existing antirez/ds4 checkout instead of `~/.pi/ds4/support`
- `supportRepo` / `supportBranch`: runtime checkout source
- `serverBinary` / `watchdogScript`: custom executable/script paths
- `apiKey`: token Pi sends to the local provider (default `dsv4-local`)

`DS4_GGUF_DIR` is an environment-only upstream ds4 option for storing downloaded GGUF files outside the runtime checkout. It is not a `settings.json` key.

Download progress is measured from the requested growing files in the download directory (including their matching hashed files under the Hugging Face downloader's `.cache/huggingface/download` directory, which print nothing when piped) and compared against the exact sizes in `download_model.sh`'s `artifact_identity()` where upstream declares them. If progress looks stuck, check `~/.pi/ds4/log` for the raw downloader output.

After editing, run `/reload` or restart Pi. Models are never downloaded automatically. Use `/ds4` to download an explicit DeepSeek V4 Flash, DeepSeek V4.1 Flash, DeepSeek V4 Pro, or GLM 5.2 variant and to view the log or control the server. Existing and completed downloads are discovered and registered automatically in Pi's model catalogue.

DeepSeek V4.1 Flash (`dsv41-flash-q2`, `dsv41-flash-q4`) needs 341 GiB and 483 GiB of disk respectively; the Q4 download arrives in two parts that are joined automatically and needs another 37 GiB free while joining. It runs on Metal, and on CUDA for text only. V4 Flash vision encoders and DSpark files are not compatible with it.

Images: download the V4.1 vision encoder from the same `/ds4` menu (about 0.9 GiB, target `ds41f-vision`). When it is present, ds4-server is started with `--vision` and the V4.1 models advertise image input. The menu entry only appears on macOS because upstream rejects the V4.1 encoder outside Metal. Changing the encoder state restarts the server on the next request.
