# @deepcraft/plugin-transcribe

A NocoBase plugin that gives AI Employees a `transcribeAudio` tool, plus a matching REST endpoint,
for turning audio into text. Ships with two providers out of the box — OpenAI (`gpt-4o-mini-transcribe`
by default, or `whisper-1`) and a local whisper.cpp server (no API key, no external network call) —
each independently configurable and enable/disable-able; more can be added via a small provider registry.

Transcription doesn't fit NocoBase's LLM chat-provider abstraction (audio in, text out is a
different request/response shape than a chat completion), so it's exposed as an **AI tool**
instead of a model — the AI employee calls it like any other tool and gets the transcript back
as text to reason over.

## Install

Build the plugin (`npm run build`, see below) and copy the resulting `.tgz` from `./dist` into
your NocoBase instance's `storage/plugins/` directory, then enable it from the Plugin Manager UI.

**After installing or updating, restart the NocoBase app** (not just enable the plugin) —
`storage/dist-client/<version>/static/plugins/<package>/` is only synced on app start/restart.
Skipping this causes every client route (including sign-in) to fail with a RequireJS
`Script error for "<package>"` once the plugin is enabled, since its client bundle 404s.

## Configuration

Set these under NocoBase → Settings → Variables and secrets (or as environment variables). All keys
are namespaced under `transcribe_` / `TRANSCRIBE_` so they can't collide with another plugin's own
`openai_*`-style variables.

General, provider-agnostic settings:

| Variable                                | Env var                        | Required | Default   |
| ----------------------------------------- | -------------------------------- | -------- | ----------- |
| Variable `transcribe_default_provider`   | `TRANSCRIBE_DEFAULT_PROVIDER`   | no       | `openai`  |
| Variable `transcribe_default_model`      | `TRANSCRIBE_DEFAULT_MODEL`      | no       | —          |

`transcribe_default_model` is attempted for whichever provider is resolved (see `configStatus`'s
per-provider `defaultModel` above); providers that don't take a model argument (`whisper`) ignore it.

### OpenAI

This is the config for the built-in **OpenAI** provider specifically:

| Variable / Secret                     | Env var                       | Required | Default                    |
| --------------------------------------- | -------------------------------- | -------- | ----------------------------- |
| Secret `transcribe_openai_api_key`    | `TRANSCRIBE_OPENAI_API_KEY`    | yes      | —                            |
| Variable `transcribe_openai_base_url` | `TRANSCRIBE_OPENAI_BASE_URL`   | no       | `https://api.openai.com/v1`  |
| Variable `transcribe_default_model`   | `TRANSCRIBE_DEFAULT_MODEL`     | no       | `gpt-4o-mini-transcribe`     |

`transcribe_openai_base_url` lets you point the provider at a custom OpenAI-compatible server —
Azure OpenAI, a self-hosted proxy (LiteLLM, vLLM, etc.), or any drop-in `/audio/transcriptions`
endpoint. It's a deployment-level setting only (not exposed as an AI-tool argument), so a chat
prompt can't redirect requests to an arbitrary host.

`transcribe_default_model` (the same general setting from above) is what OpenAI actually uses it
for today — set it to e.g. `whisper-1` to switch off `gpt-4o-mini-transcribe`, or override per call
with `"model": "..."` in the request/tool arguments.

### Whisper's own server

The `whisper` provider talks to [whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s
built-in `server` example directly — its own API (`POST /inference`, no `model` field since the
model is fixed at server startup, no auth), not the OpenAI shape. No API key is required.

| Variable                                | Env var                          | Required | Default                   |
| ---------------------------------------- | --------------------------------- | -------- | --------------------------- |
| Variable `transcribe_whisper_base_url`  | `TRANSCRIBE_WHISPER_BASE_URL`    | no       | `http://127.0.0.1:9001`    |
| Variable `transcribe_default_provider`   | set to `whisper` to make it the default | no | `openai` |

Set `transcribe_default_provider` to `whisper` (or pass `"provider": "whisper"` per call/tool
invocation) and, if your server isn't on the default host/port, `transcribe_whisper_base_url`.

**If NocoBase runs in Docker and the whisper server runs on the host** (the common local-dev
setup), `127.0.0.1` inside the container is the container's own loopback, not the host's — the
server needs to be reachable from the container's network. Two ways to fix it:
- Start whisper's server bound to all interfaces (`--host 0.0.0.0` instead of the default
  `127.0.0.1`), then point `transcribe_whisper_base_url` at the Docker bridge gateway IP from
  inside the container (`docker exec <container> ip route | grep default`, or on Docker Desktop,
  `http://host.docker.internal:9001`). If a host firewall (e.g. UFW) blocks the bridge subnet from
  reaching the host-bound port, allow it: `sudo ufw allow from <bridge-subnet> to any port <port> proto tcp`.
- Or run NocoBase with `--network host` (Linux only), so it shares the host's network namespace
  and `127.0.0.1:9001` just works.

## AI tool

`transcribeAudio` — accepts exactly one of `audioUrl` (a fetchable URL) or `audioBase64` (inline
base64-encoded audio), plus optional `filename`, `mimeType`, `provider`, `model`, `language`, and
`prompt`. Returns `{ text, provider, model, language }`.

Registered `scope: 'GENERAL'`, so it's automatically available to every AI Employee — nothing to
enable per employee. It does show up (grayed out) in an employee's own "General tools" list; that
control is informational only, see "Per-employee tool access" below for why.

## REST endpoints

All three require `Authorization: Bearer <token>` like any other NocoBase API call. Body fields go
at the **top level** of the JSON payload, not nested under `values` (unlike NocoBase's standard
collection CRUD actions) — this was verified empirically against a running instance, since which
convention a given custom action uses isn't documented.

### `POST /api/transcription:transcribe`

| Field         | Type   | Required | Notes                                                              |
| ------------- | ------ | -------- | ------------------------------------------------------------------- |
| `audioUrl`    | string | one of `audioUrl`/`audioBase64` | A fetchable URL to the audio file (max 25MB after download). |
| `audioBase64` | string | one of `audioUrl`/`audioBase64` | Inline base64-encoded audio bytes (max 25MB decoded).        |
| `filename`    | string | no       | Hint used for the multipart filename sent to the provider, e.g. `"clip.mp3"`. Defaults to the URL's basename or `"audio.mp3"`. |
| `mimeType`    | string | no       | Hint, e.g. `"audio/mpeg"`. Defaults to the response `Content-Type` (URL case) or `"audio/mpeg"` (base64 case). |
| `provider`    | string | no       | `"openai"`, `"whisper"`, or any other registered provider name. Omit to use `transcribe_default_provider`. |
| `model`       | string | no       | Provider-specific model override, e.g. `"whisper-1"`. Omit to use `transcribe_default_model` (OpenAI only — the `whisper` provider ignores this, its model is fixed server-side). |
| `language`    | string | no       | ISO-639-1 hint, e.g. `"en"`.                                       |
| `prompt`      | string | no       | Free-text context to guide transcription (e.g. expected vocabulary/names). |

Provider resolution: `provider` if given, else `transcribe_default_provider` (defaults to `openai`
if that Variable is unset). Whichever provider is resolved is then checked against its
enable/disable state (see below) — a disabled provider is rejected with a clear error, it is
**never** silently swapped for another enabled one, whether it was requested explicitly or reached
via the default.

Response: `{ "data": { "text": "...", "provider": "...", "model": "...", "language": "..." } }`
(`language` only present if known).

Examples:

```sh
TOKEN="<your bearer token>"
BASE="http://127.0.0.1:13000/api"
SAMPLE="https://raw.githubusercontent.com/ggml-org/whisper.cpp/refs/heads/master/samples/jfk.mp3"

# Default provider (whatever transcribe_default_provider resolves to)
curl -s "$BASE/transcription:transcribe" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"audioUrl\":\"$SAMPLE\"}"

# Explicit provider
curl -s "$BASE/transcription:transcribe" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"provider\":\"whisper\",\"audioUrl\":\"$SAMPLE\"}"

# Inline base64 audio instead of a URL
curl -s "$BASE/transcription:transcribe" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"audioBase64\":\"$(base64 -w0 clip.mp3)\",\"filename\":\"clip.mp3\",\"mimeType\":\"audio/mpeg\"}"

# With language hint and a prompt for expected vocabulary
curl -s "$BASE/transcription:transcribe" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"audioUrl\":\"$SAMPLE\",\"language\":\"en\",\"prompt\":\"Speaker names: Kennedy.\"}"
```

Error responses (all `{ "errors": [{ "message": "..." }] }`):
- Neither/both of `audioUrl`/`audioBase64` given → `"Provide exactly one of \`audioUrl\` or \`audioBase64\`."`
- Resolved provider is disabled → `"Transcription provider \"openai\" is disabled. Enable it in Settings → Transcription, or choose a different provider."`
- Unknown `provider` name → `"Unknown transcription provider \"bogus\". Available providers: openai, whisper."`
- `audioUrl` unreachable → `"Failed to fetch audioUrl (404 Not Found)."` (or a network-level message like `ECONNREFUSED`/`ENOTFOUND`)

### `GET /api/transcription:configStatus`

No body. Response:

```json
{
  "data": {
    "configured": true,
    "defaultProvider": "whisper",
    "defaultModel": "gpt-4o-mini-transcribe",
    "message": null,
    "providers": {
      "openai": { "configured": true, "enabled": true, "defaultModel": "gpt-4o-mini-transcribe" },
      "whisper": { "configured": true, "enabled": true, "defaultModel": null }
    }
  }
}
```

`configured`/`message` at the top level describe the *resolved default* provider specifically
(convenience for the settings page); everything under `providers.<name>` describes each provider
individually. `defaultModel` is `transcribe_default_model` if set, else that provider's own built-in
default, else `null` for a provider that ignores the model field entirely (`whisper`'s model is
fixed server-side, not request-selectable). `configured` is `false` plus a `message` naming the
missing Secret/Variable if its API key isn't set (not applicable to providers with
`requiresApiKey: false`, like `whisper`).

```sh
curl -s "$BASE/transcription:configStatus" -H "Authorization: Bearer $TOKEN"
```

### `POST /api/transcription:setProviderEnabled`

| Field      | Type    | Required | Notes                                  |
| ---------- | ------- | -------- | ---------------------------------------- |
| `provider` | string  | yes      | Must be a registered provider name.       |
| `enabled`  | boolean | yes      | `true` or `false` (JSON boolean, not a string). |

```sh
curl -s "$BASE/transcription:setProviderEnabled" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"provider":"openai","enabled":false}'
# => {"data":{"provider":"openai","enabled":false}}
```

Writes `transcribe_<provider>_enabled` as a NocoBase Variable (durable — survives restarts) and
takes effect on the very next `transcribe` call, no restart needed. See "Enabling/disabling
providers" below for how this interacts with provider resolution.

## Settings page

Once enabled, a "Transcription" entry appears in the plugin's settings (Settings → Transcription),
showing the default provider/model, whether a usable API key is configured (and if not, the exact
Secret/Variable name still missing), and a switch per provider to enable/disable it.

## Enabling/disabling providers

Each provider (`openai`, `whisper`, ...) can be turned on/off from the settings page, or via
`POST /api/transcription:setProviderEnabled`. This is a real, live-effective toggle — unlike the
per-employee tool toggle explored and reverted earlier (see below, "Per-employee tool access"),
provider enablement is checked
fresh inside `transcribeAudio()` on every call, not snapshotted anywhere, so it takes effect
immediately. It's stored as a NocoBase Variable (`transcribe_<provider>_enabled`, via the
`environmentVariables` collection — the same durable store as the rest of this plugin's config),
defaulting to enabled when unset. Calling a disabled provider (directly, or as the resolved default)
throws a clear error naming the provider and pointing back to this settings page.

## Per-employee tool access

There's no supported per-employee, per-tool toggle — that's a deliberate scope decision, not a
missing feature. `transcribeAudio` is registered `scope: 'GENERAL'`, meaning it's shared by every
AI Employee. NocoBase's own AI Employee "Tools" tab shows an Ask/Allow control per General tool,
but it's hardcoded `disabled` in `@nocobase/plugin-ai`'s client bundle, and even if it weren't,
regular chat conversations never populate the `skillSettings` NocoBase's own tool filter depends on
(`ai-employee.js`'s `getAIEmployeeTools()` only filters when `conversation.options.skillSettings` is
set, which NocoBase's chat UI doesn't do — that field is only populated by workflow-triggered
employee tasks, a different code path). Writing to `aiEmployees.skillSettings.tools` directly (which
an earlier version of this plugin did) has no effect on ordinary chat as a result.

The one real, working lever is the plugin itself: **Settings → Plugin manager → Transcribe →
enable/disable**. That's all-or-nothing across every AI Employee, but it's the only toggle that
actually changes tool availability in regular chat today.

## Adding a provider

Implement `TranscriptionProvider` (see `src/server/providers/types.ts`) in a new file under
`src/server/providers/`, and register it in `src/server/providers/registry.ts`. Its API key and
base URL will automatically be readable from `transcribe_<provider>_api_key` /
`transcribe_<provider>_base_url` (or the `TRANSCRIBE_<PROVIDER>_*` env vars) — `services/config.ts`
already handles that generically for any provider name.

## Build

```sh
npm i -g @nocobase/cli                     # provides the `nb` CLI
just build-plugin plugin-transcribe        # → dist/deepcraft-plugin-transcribe-<version>.tgz
```

The first run downloads a pinned NocoBase source tree into `./app`, builds the
plugin against it, and packs `./dist/*.tgz`. Later runs reuse the tree.

CI: `.github/workflows/plugin-release.yml` runs the same recipe on every push to
`main` that touches this directory, and replaces the GitHub release named by the
`version` in `package.json`.

## Dev loop

```sh
mkdir -p app && cd app
nb init --skip-ui
ln -s ../.. plugins/@deepcraft/plugin-transcribe
nb plugin enable @deepcraft/plugin-transcribe
yarn dev
```
