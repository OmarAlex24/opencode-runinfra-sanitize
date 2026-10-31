# opencode-runinfra-sanitize

An [opencode](https://opencode.ai) plugin that keeps long sessions working with [RunInfra](https://runinfra.ai) hosted inference.

RunInfra rejects requests that break a few hard limits, and opencode resends the whole history on every turn, so a long session eventually fails on every message:

| Error from RunInfra | What the plugin does |
|---|---|
| `Hosted inference accepts at most 8 images per request` | Keeps the 6 most recent images. Older ones become a text label with their number, path and a one-line description, so the model can `read` the exact file again if it needs it. |
| `Payload too large. The maximum request body is 3.5 MB` | Caps inline image data at ~2.5 MB, then, if the request is still over ~3 MB, trims the oldest tool outputs (and, if needed, long strings inside old tool-call inputs). The system prompt, your last message and the 10 most recent messages are never touched. Also runs on compaction requests, so oversized sessions can compact again. |
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
| `OPENCODE_RUNINFRA_SANITIZE_DEBUG=1` | Log image counts, trims and real request sizes to `/tmp/runinfra-sanitize.log`. |

Other knobs (`KEEP_IMAGES`, `BUDGET_BYTES`, `BODY_BUDGET`, `KEEP_RECENT_MESSAGES`) are constants at the top of the file.

## Tests

```sh
bun test
```

13 tests with fake messages and a mocked `fetch` (no network, no opencode).

## Caveats

- The opencode v2 plugin API is new and undocumented; a future opencode release may change it.
- The tool-call fix is covered by unit tests only; I never caught a malformed input in a live request. The errors I saw coincided with two opencode servers writing to the same database (opencode's background service plus another client's server), so if you hit that error, check `opencode service status` too.
- Image descriptions are billed pay-as-you-go by RunInfra even on a plan.

## License

MIT
