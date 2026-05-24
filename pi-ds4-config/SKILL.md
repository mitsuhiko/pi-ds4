---
name: pi-ds4-config
description: Reconfigure pi-ds4/ds4 local DeepSeek V4 Flash by editing ~/.pi/ds4/settings.json. Use when the user asks how to configure, reconfigure, change settings, switch model quant/protocol/runtime, or debug pi-ds4 configuration.
---

# pi-ds4 configuration

To reconfigure pi-ds4/ds4, edit `~/.pi/ds4/settings.json` (create it if missing). Do not edit other runtime state files in `~/.pi/ds4` unless explicitly debugging.

The file is a JSON object. Environment variables override it. Keys can be env names (`DS4_READY_TIMEOUT_MS`), camelCase without `DS4_` (`readyTimeoutMs`), or lower snake_case (`ready_timeout_ms`). Use `settings.schema.json` / `settings.example.json` from the pi-ds4 package for validation/examples.

Minimal example:

```json
{
  "$schema": "https://raw.githubusercontent.com/mitsuhiko/pi-ds4/main/settings.schema.json",
  "protocol": "openai-responses",
  "modelQuant": "q2-imatrix",
  "power": 50,
  "readyTimeoutMs": 900000
}
```

Power example (quieter, cooler):

```json
{
  "$schema": "https://raw.githubusercontent.com/mitsuhiko/pi-ds4/main/settings.schema.json",
  "protocol": "openai-responses",
  "power": 50
}
```

Common settings:

- `protocol`: `openai` (default), `openai-responses`, or `anthropic`
- `modelQuant`: force `q2`, `q2-imatrix`, or `q4` for `ds4/deepseek-v4-flash`
- `power`: GPU duty cycle percentage 1..100 (default 100). Lower values reduce heat/fan noise. Passed as `--power N`.
- `readyTimeoutMs`: server startup timeout in ms
- `runtimeDir`: existing antirez/ds4 checkout instead of `~/.pi/ds4/support`
- `supportRepo` / `supportBranch`: runtime checkout source
- `serverBinary` / `watchdogScript`: custom executable/script paths
- `apiKey`: token Pi sends to the local provider (default `dsv4-local`)

After editing, run `/reload` or restart pi. Use `/ds4` to inspect the live ds4 log.
