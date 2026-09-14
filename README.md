# pi-ds4

Run [antirez/ds4](https://github.com/antirez/ds4) models locally in Pi. The
extension supports DeepSeek V4 Flash, DeepSeek V4.1 Flash, DeepSeek V4 Pro, and
GLM 5.2.

## Install

```sh
pi install https://github.com/mitsuhiko/pi-ds4
```

Restart Pi or run `/reload`.

## Get started

1. Run `/ds4` and choose **Download model**.
2. Pick a model. DeepSeek V4 Flash Q2 is the smallest option and needs about
   96 GB of RAM.
3. After the download finishes, run `/model` and select the new `ds4/...`
   model.
4. Start chatting.

Downloads report a progress bar with transfer rate and ETA in the status line,
counted from the bytes on disk, so resuming an interrupted download picks up
where it left off. Full output stays in `~/.pi/ds4/log`.

Models are never downloaded automatically. Once installed, they are discovered
on future Pi starts and shown in `/model`. Selecting one starts `ds4-server` on
demand; it stops automatically when no Pi processes are using it.

Use `/ds4` at any time to download another model, view the log, or start and
stop the server manually.

## Models

| Pi model | Model | Recommended RAM |
|---|---|---:|
| `ds4/dsv4-flash-q2` | DeepSeek V4 Flash Q2 imatrix | 96 GB |
| `ds4/dsv4-flash-q2q4` | DeepSeek V4 Flash mixed Q2/Q4 imatrix | 128 GB |
| `ds4/dsv4-flash-q4` | DeepSeek V4 Flash Q4 imatrix | 256 GB |
| `ds4/dsv41-flash-q2` | DeepSeek V4.1 Flash Q2 | 192 GB |
| `ds4/dsv41-flash-q4` | DeepSeek V4.1 Flash Q4 | 512 GB |
| `ds4/dsv4-pro-q2` | DeepSeek V4 Pro Q2 imatrix | 512 GB |
| `ds4/glm52-iq2xxs` | GLM 5.2 IQ2 XXS | 256 GB |
| `ds4/glm52-q2` | GLM 5.2 Q2 | 384 GB |
| `ds4/glm52-q4` | GLM 5.2 Q4 | 512 GB |
| `ds4/glm52-q4-xl` | GLM 5.2 Unsloth Q4 XL | 512 GB |

These are conservative full-residency recommendations. ds4 can also stream
from SSD or run across multiple machines, with different performance tradeoffs.
Signing in to Hugging Face before downloading may improve download speed.

DeepSeek V4.1 Flash needs much more disk than RAM: 341 GiB on disk for Q2 and
483 GiB for Q4, because its Engram tables stay on disk and are read as needed.
Only 152 GiB (Q2) and 294 GiB (Q4) of weights are resident. Keep the GGUF on a
fast local SSD; the Q4 download arrives in two parts that are joined
automatically and needs another 37 GiB of free space while joining. V4.1 runs
on Metal, and on CUDA for text inference. Its GPU duty cycle cannot be
throttled, so `power` is ignored for it.

## Images

DeepSeek V4.1 Flash can read images. Run `/ds4` → **Download model** and pick
the vision encoder (about 0.9 GiB); the next server start adds `--vision` and
the V4.1 models accept image input in Pi. Upstream only supports the V4.1
encoder on Metal, so the option is hidden elsewhere. ds4-server accepts up to
16 inline images per request.

## SSD streaming

When a model's resident weights do not fit in system RAM, the extension starts
`ds4-server` with `--ssd-streaming` and caps the context at 131072 tokens
unless `contextTokens` is set explicitly. Today only the V4.1 models declare a
resident footprint, so this affects them alone. Set `ssdStreaming` to `true` or
`false` to decide it yourself.

## Configuration

Most users do not need any configuration. Optional settings live in
`~/.pi/ds4/settings.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/mitsuhiko/pi-ds4/main/settings.schema.json",
  "protocol": "openai-responses",
  "readyTimeoutMs": 900000
}
```

See [`settings.example.json`](settings.example.json) for all options. Each
setting also has a `DS4_*` environment variable; environment variables take
precedence. Restart Pi or run `/reload` after changing settings.

Set `power` to an integer from 1 to 100 to limit the GPU duty cycle for
DeepSeek models, reducing heat and fan noise. It defaults to 100. GLM 5.2 and
DeepSeek V4.1 always run at full power because upstream does not support
throttling them.

Runtime files, downloaded models, caches, and logs are stored in `~/.pi/ds4`.
Package-managed ds4 checkouts update automatically; explicitly configured or
local development checkouts are left untouched.

## Local development

To use this extension checkout with an existing ds4 checkout:

```sh
./install-pi-extension-local.sh /path/to/antirez-ds4-checkout
```

If `~/.pi/ds4/support` already points elsewhere, rerun with `--force`. Existing
model downloads are preserved when possible.
