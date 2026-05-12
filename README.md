# pi-ds4

Pi provider extension for running [antirez/ds4](https://github.com/antirez/ds4)
as a local DeepSeek V4 Flash model.  The goal here is to see how good the UX
and behavior can be around local models.

The extension registers `ds4/deepseek-v4-flash` and
`ds4/deepseek-v4-flash-q2-imatrix` as models for `/model`, starts `ds4-server`
on demand, downloads/builds the runtime if needed, keeps a per-pi-process lease,
and stops the server via a bundled watchdog when no clients are left.

## Requirements and Behavior

You will need a mac with at least 128GB of RAM.  The default
`ds4/deepseek-v4-flash` model installs the 2-bit quantized model if you have
128GB of RAM and picks the 4-bit quantized model if you have 256GB or more.
Select `ds4/deepseek-v4-flash-q2-imatrix` to use the imatrix-tuned q2 model.

If you are signed into huggingface then your token is used for faster downloads.
The server is compiled/started and models are downloaded automatically on first
use.

## Install

```sh
pi install https://github.com/mitsuhiko/pi-ds4
```

For local development from this checkout, pass the path to an existing ds4 server checkout:

```sh
./install-pi-extension-local.sh /path/to/antirez-ds4-checkout
```

If `~/.pi/ds4/support` already exists and points elsewhere, use `--force` to
move it aside and install a symlink to the checkout you passed. Any existing
`gguf/*.gguf` model files (and resumable `.gguf.part` downloads) are preserved
into the new checkout first, using APFS clone-on-write copies on macOS when
available.

Then restart pi or run `/reload`.

## Runtime layout

Runtime state is kept under `~/.pi/ds4`:

- `support/` — shallow checkout of `https://github.com/antirez/ds4` (`main` by default)
- `kv/` — on-disk KV cache for the default model choice
- `kv-q2-imatrix/` — on-disk KV cache for the q2-imatrix model choice
- `clients/` — active pi process leases
- `log` — build/download/server/watchdog log

The watchdog is bundled in this package (`ds4-watchdog.sh`), not expected to
exist in the ds4 runtime checkout.

## Configuration

Environment overrides:

- `DS4_SUPPORT_REPO`: runtime repo URL (default `https://github.com/antirez/ds4`)
- `DS4_SUPPORT_BRANCH`: runtime branch (default `main`)
- `DS4_RUNTIME_DIR`: use an existing ds4 checkout instead of `~/.pi/ds4/support`
- `DS4_MODEL_QUANT`: force `q2`, `q2-imatrix`, or `q4` for the default model
  choice (otherwise picked from system memory)
- `DS4_READY_TIMEOUT_MS`: server startup timeout
- `DS4_SERVER_BINARY`: custom `ds4-server` binary path

Use `/ds4` inside pi to show the live ds4 log.

## Performance (multi-session pool)

With the session pool and KV caching enabled (`--sessions 4 --kv-disk-dir`),
each pi session gets a stable `X-Session-Id` so ds4-server can route it back to
the same resident backend session across turns. Switching between warm sessions
is a pointer swap instead of a full KV rebuild.

| System prompt | Cold prefill | Pool switch TTFT | Speedup |
|---------------|-------------:|-----------------:|--------:|
| 1K tokens | 3.34s | 0.59s | 5.7x |
| 10K tokens | 42.9s | 0.64s | 67x |
| 25K tokens | 117.8s | 0.83s | 142x |
| 50K tokens | 263.7s | 0.88s | 298x |
| 60K tokens | 487.8s | 1.02s | 477x |

The extension also uses `/v1/warmup` after pi compacts a session. Warmup sends
the post-compaction message history, including the cached tool schema, so
ds4-server can rebuild that session in the background before the user's next
visible request.

Requirements for best cache hits:
- Keep ds4-server running between sessions (the watchdog keeps it alive while
  any pi process holds a lease)
- Send `X-Session-Id` on every request so ds4-server can preserve slot affinity
- Include tool schemas in warmup requests so the warmed prompt matches real
  generation requests

Benchmarked on M4 Max 128GB, DeepSeek V4 Flash IQ2_XXS (81GB).
