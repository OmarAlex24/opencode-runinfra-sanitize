# opencode-runinfra-sanitize

An [opencode](https://opencode.ai) plugin that keeps long sessions working with [RunInfra](https://runinfra.ai) hosted inference.

RunInfra rejects requests that break a few hard limits, and opencode resends the whole history on every turn, so a long session eventually fails on every message:

| Error from RunInfra | What the plugin does |
|---|---|
| `Hosted inference accepts at most 8 images per request` | Never sends more than 8 images. When a 9th arrives, the oldest ones become a text label with their number, path and a one-line description (down to 4 kept), so the model can `read` the exact file again if it needs it. |
| `Payload too large. The maximum request body is 3.5 MB` | Caps inline image data at ~2.5 MB, then, if the request is still over ~3 MB, trims the oldest tool outputs (and, if needed, long strings inside old tool-call inputs) down to ~2 MB. The system prompt, your last message and the 10 most recent messages are never touched. Also runs on compaction requests, so oversized sessions can compact again. |
| `tool_calls[0].function.arguments must be a JSON object` | Turns any tool-call input that isn't a plain object into one. |

Nothing is removed from your stored session: the plugin only rewrites the request on its way to RunInfra, and only for the `runinfra` provider.

## Image labels

Every image gets a stable number by order of first appearance:

```
[imagen 9 · /tmp/shot-menu.png · Context menu open on the sidebar]
[imagen 2 omitida · /tmp/model-picker.png · Model picker listing three models · vuelve a leer ese archivo con read si la necesitas]
```

Images with no file on disk (pasted attachments, data URIs) are saved once to `$XDG_CACHE_HOME/opencode-runinfra/<session>/imagen-NN.<ext>` so they can be re-read too.

Descriptions are generated once per image (cached by content hash) with the cheapest RunInfra model that accepts images, picked from `GET /v1/models` (`input_modalities` + `pricing`, refreshed every 24 h). Cost is around $0.0001 per image. If description fails, the label keeps just the number and path. Labels and descriptions are in Spanish; edit `CAPTION_PROMPT`, `OUTPUT_NOTE` and the label text in the file to change that.

## Prompt caching

RunInfra [caches prompts](https://runinfra.ai/docs/cookbook/prompt-caching.md) by prefix: it reuses the longest byte-identical start of a previous request, and everything after the first difference is billed uncached (about 10× the cached price). Any trim near the start of the history breaks that prefix, so the plugin trims in batches instead of a little every turn:

| What | Trigger | Trims down to |
|---|---|---|
| Inline images | more than 8 (`IMAGES_MAX`, RunInfra's hard cap, counting the images in the current request) | the 4 newest (`IMAGES_LOW`), but never fewer than the images new in this request (max 8) |
| Inline image data | more than ~2.5 MB of base64 (`INLINE_HIGH`) | ~1.5 MB (`INLINE_LOW`) |
| Message history | more than ~3.0 MB (`BODY_HIGH`) | ~2.0 MB (`BODY_LOW`) |

Each decision is saved per session in `$XDG_CACHE_HOME/opencode-runinfra/<session>/index.json` (which images were dropped, which tool calls had their output or input trimmed, and each image's number, path and description). The following requests repeat exactly the same trims, byte for byte, and only append until a threshold is crossed again. Those sets only grow, and trimming is deterministic (same input gives the same bytes). A dropped image that the model reads again counts as a new image, so it shows up.

Measured in isolated sessions (same script, back to back, `deepseek-v4-1-flash`, turns that `cat` 44 KB files):

| | Old (trim until it fits) | New (batches) |
|---|---|---|
| 10 requests after crossing 3 MB | 57% of prompt tokens cached (443k uncached) | 98% cached (18k uncached) |
| Whole 28-request session | 71% cached | 91% cached |
| Request size after crossing | stays at ~3.05 MB | drops to 2.04 MB, then grows |

With images (`glm-5-3-flash`, one new image per turn), the old 6-image rule broke the prefix on every request that added an image from the 7th on (~50% cached each time). The new one breaks it once, on the 9th, and is back at ~94% on the next. Cache retention is best effort on RunInfra's side, so expect some noise.

The trade-off: after a batch the model sees fewer images (4 instead of up to 8) and less old tool output (history drops to ~2 MB instead of ~3 MB) than strictly needed, and the batch request itself is mostly uncached.

## Install

Requires opencode 2.x (tested with 2.2.5; it uses the v2 plugin API, `ctx.session.hook`).

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/OmarAlex24/opencode-runinfra-sanitize/main/plugins/runinfra-sanitize.ts \
  -o ~/.config/opencode/plugins/runinfra-sanitize.ts
```

opencode loads every `.ts` file in that folder; no config entry or dependencies are needed. It reads RunInfra's base URL and API key from your existing `runinfra` provider config. Check it loaded with:

```sh
grep 'loading plugin' ~/.local/share/opencode/log/opencode.log | tail -1
```

(`opencode plugin list` only lists package plugins, so it will say "No plugins found".)

### Recommended: lower the context limit

RunInfra's limit is in bytes, not tokens. In practice ~600k tokens of history already went over 3.5 MB, so if your config declares a 1M-token context, opencode won't auto-compact in time. Set something like this for each RunInfra model:

```jsonc
"limit": { "context": 400000, "output": 131072 }
```

## Options

| Environment variable | Effect |
|---|---|
| `OPENCODE_RUNINFRA_CAPTION_MODEL` | Force the model used for image descriptions. |
| `OPENCODE_RUNINFRA_SANITIZE_DEBUG=1` | Log image counts, trims, real request sizes, whether the prefix changed since the previous request of the session, and RunInfra's `cached_tokens` to `/tmp/runinfra-sanitize.log`. |
| `OPENCODE_RUNINFRA_SANITIZE_LOG` | Write that debug log somewhere else. |

Other knobs (`IMAGES_MAX`, `IMAGES_LOW`, `INLINE_HIGH`, `INLINE_LOW`, `BODY_HIGH`, `BODY_LOW`, `KEEP_RECENT_MESSAGES`) are constants at the top of the file.

## Tests

```sh
bun test
```

19 tests with fake messages (no network, no opencode).

## Caveats

- The opencode v2 plugin API is new and undocumented; a future opencode release may change it.
- The tool-call fix is covered by unit tests only; I never caught a malformed input in a live request. The errors I saw coincided with two opencode servers writing to the same database (opencode's background service plus another client's server), so if you hit that error, check `opencode service status` too.
- Image descriptions are billed pay-as-you-go by RunInfra even on a plan.
- The trim state lives in `$XDG_CACHE_HOME/opencode-runinfra/`. Deleting it mid-session makes the next request re-decide from scratch (one cache miss, and image labels may renumber).
- With `OPENCODE_RUNINFRA_SANITIZE_DEBUG=1` the plugin also hooks `http.request`/`http.response` (to log sizes and `cached_tokens`) and keeps a copy of each session's last request body in the cache folder. Leave it off in normal use.

## License

MIT
