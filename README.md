# Browser Harness

An experimental, local-first **ChatGPT / Gemini browser → OpenAI-compatible agent gateway**.
Use a dedicated, manually logged-in ChatGPT or Gemini tab as the reasoning component of an
existing agent harness, and pick the provider per request with the `model` field. The harness executes tools; this gateway never runs shell
commands or accesses your files on the model's behalf.

```text
Your agent harness
  → authenticated HTTP API at 127.0.0.1:4318/v1
  → separately authenticated WebSocket
  → Chrome extension
  → one dedicated tab per provider (visible UI only)
       model "chatgpt-browser" → chatgpt.com tab
       model "gemini-browser"  → gemini.google.com tab
```

This is an initial implementation, **not a verified substitute for the official
model API**. Automated tests use simulated browser peers and DOM fixtures, not
paid accounts. One live run on a ChatGPT Plus web account (October 2026 UI) passed a
text completion, the `read_project_readme` two-turn tool loop, client cancellation
(generation stopped, tab disarmed) and re-pairing. ChatGPT changes its markup often;
model identity, availability, and quota accounting remain unverified. Gemini (Pro
web account, same month) passed a text completion, the same tool loop and an
OpenCode coding task. Nothing here guarantees unlimited usage,
avoids subscription limits, or exposes the ordinary chat allowance as an official API.

## Current scope

| Feature | Status |
| --- | --- |
| ChatGPT browser text | Live-tested once on a Plus account; markup changes can break it |
| Gemini browser text | Live-tested once on a Pro account; markup changes can break it |
| `GET /v1/models`, `POST /v1/chat/completions` | Implemented subset described below |
| Tool calls | Strict JSON emulation; validated names, arguments, IDs and results |
| OpenCode | Live-tested with OpenCode 1.19.5 on two small coding tasks (see below) |
| Streaming | Buffered SSE after final reply validation, not live token streaming |
| Sessions | Fresh browser chat per request; complete supplied history replayed |
| Provider selection | `chatgpt-browser` or `gemini-browser`; each routes to its own paired tab |
| Model selection | Manually choose in the website; the gateway does not verify the actual model |
| Images, uploads, native image generation, voice | Not implemented; unsupported request shapes rejected |
| Claude, DeepSeek, Grok | Not implemented |
| Paid API/Codex fallback | None |

The code is original; no source from the projects discussed during research has
been copied into this repository.

## Prerequisites

- Node.js 20.18+ (Node 22 recommended), npm, Chrome 116+.
- An account permitted to use the ChatGPT and/or Gemini website in the manner you intend.
- A dedicated Chrome tab that you will not use for other work while armed.

Review applicable provider terms before connecting an account. This project does
not establish permission to automate a service. It has no CAPTCHA solving, private
provider endpoints, stealth features, account rotation, or limit-bypass mechanism.
Stop if your provider does not permit your intended use.

## Setup

```sh
npm ci
npm run build
```

Start the gateway:

```sh
npm start
```

On first start it creates two distinct random secrets, readable only by your user:
`~/.browser-harness/api_key` (for agent harnesses) and `~/.browser-harness/bridge_token`
(for pairing the extension). Delete them to rotate. They are never logged. To use your own
secrets instead, set `BROWSER_HARNESS_API_KEY` and `BROWSER_HARNESS_BRIDGE_TOKEN`
(at least 32 characters each); those take precedence over the files.

```sh
npm run -s token      # bridge token: paste into the extension popup
npm run -s key        # API key: for harnesses that cannot read a file
npm run -s opencode   # ready-to-use OpenCode config for this gateway
```

Windows shortcut: `scripts/windows/setup-and-start.ps1` clones or updates
`%USERPROFILE%\browser-harness`, builds it, starts the gateway, and copies the bridge
token to your clipboard. This helper keeps its own keys in
`%USERPROFILE%\.browser-harness\keys.json` (readable by your user only); delete that file
to rotate them, and passes them to the gateway as environment variables. `scripts/windows/smoke.ps1` runs the smoke test with the stored API key.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\setup-and-start.ps1
```

The server binds to `127.0.0.1` only. `BROWSER_HARNESS_PORT` optionally changes
port 4318.

1. Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**,
   and choose `build/extension` in this repository.
2. Open a dedicated `https://chatgpt.com/` and/or `https://gemini.google.com/app` tab
   and sign in manually. Select the desired model in the website. No provider
   passwords or cookies enter the gateway.
3. Open the extension popup **on that tab**. Enter the gateway port and the bridge
   token (`npm run -s token`), then **Pair & arm this tab**. Repeat on the other
   provider's tab if you want both. The API key is a different secret and must not
   be pasted into the extension.
4. The popup should report **Armed** for each paired provider. Keep the tabs open and
   avoid interacting with them while requests run. Each request clicks New chat;
   prior chats are not deleted. Requests are serialized per provider, so ChatGPT and
   Gemini requests can run at the same time.

Optional hardening: copy the installed extension ID from `chrome://extensions`
and set `BROWSER_HARNESS_EXTENSION_ID` before starting the gateway. This restricts
WebSocket pairing to that extension origin as well as requiring the bridge token.

If a request fails with `tab_not_attached`, the tab was opened before the
extension loaded. A `ui_changed` error names the step that failed (`new_chat`,
`editor`, `insert`, `send`, or `reply`), so you can tell which selector needs updating.

After extension installation or reload, refresh the provider tabs to load the content
script. Restart the gateway after source changes and rebuild/reload the extension
after extension changes.

## Connect an agent harness

For clients supporting a configurable OpenAI Chat Completions endpoint:

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:4318/v1` |
| API key | `npm run -s key` (or `BROWSER_HARNESS_API_KEY`) |
| Model | `chatgpt-browser` or `gemini-browser` |

This does **not** claim compatibility with every OpenAI client. Responses API,
Anthropic protocols, native reasoning fields, token counting, and advanced sampling
options are not implemented. Unsupported fields return HTTP 400 rather than being
silently ignored; the only accepted-but-ignored fields are the token ceilings and
`stream_options` listed under the API contract. Disable automatic model/provider
fallback in your harness.

Example (macOS / Linux; keep the gateway running in another terminal):

```sh
curl http://127.0.0.1:4318/v1/chat/completions \
  -H "Authorization: Bearer $(cat ~/.browser-harness/api_key)" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-browser","messages":[{"role":"user","content":"Explain recursion briefly."}]}'
```

### OpenCode

Generate a config and run OpenCode in a project:

```sh
npm run -s opencode > /path/to/project/opencode.json
cd /path/to/project
opencode run -m browser-harness/gemini-browser "The subtract test fails. Read calc.js, fix the bug, then run npm test."
```

Or copy [`examples/opencode.json`](examples/opencode.json) (or merge it into
`~/.config/opencode/opencode.json`). It reads the API key from
`~/.browser-harness/api_key`; on Windows replace that with the full path
(`{file:C:/Users/<you>/.browser-harness/api_key}`) or `{env:BROWSER_HARNESS_API_KEY}`.
Pick the provider with `-m browser-harness/chatgpt-browser`,
`-m browser-harness/gemini-browser`, `/models` inside OpenCode, or the config's
`model` field.

One live run with OpenCode 1.19.5 used its default `build` agent (read, glob, grep,
apply_patch, bash and other tools) against a paired ChatGPT Plus tab. It fixed a
failing test in about 45 seconds and, in a second task, added a function plus tests
(three parallel reads, a two-file patch, `npm test`) in about 75 seconds. Each
OpenCode step is a separate browser chat with the full history replayed, so long
sessions get slower and use more of your ChatGPT allowance. OpenCode also sends one
extra request per session to generate a title. OpenCode executes the tools and
enforces its own permission settings; the gateway only validates the requested
calls. Use a sandboxed or disposable project.

### A safe first agent task

```sh
npm run smoke                       # ChatGPT
npm run smoke -- gemini-browser     # Gemini
```

The included minimal harness asks the model to call `read_project_readme`, executes
only that fixed, read-only operation locally, sends its result back, then requests
a summary. It does not execute model-supplied file paths or shell commands. This
proves the intended two-turn tool loop when run against your paired browser; it is
not a general-purpose autonomous coding agent.

## API contract

Supported request fields: `model`, `messages`, `stream`, `tools`, `tool_choice`
(`auto`, `none`, `required`), and `parallel_tool_calls`. `max_tokens`,
`max_completion_tokens` and `stream_options` are accepted for harness
compatibility but ignored: the browser reply length cannot be capped and no usage
chunk is emitted. Messages accept roles `system`, `developer`, `user`, `assistant`,
and `tool`, with string content, an array of `{"type":"text"}` parts (joined with
blank lines), or null for assistant tool calls. Assistant `tool_calls` retain function names,
JSON argument strings and unique IDs; tool results must reference a pending ID.
All pending calls must be resolved before continuing. Tool choice defaults to auto.

Tools use OpenAI's `type: "function"` shape. Parameters must be JSON Schema object
schemas, at most 16KB each, using draft-07 or draft 2020-12 (`$schema` may name
either); references, async schemas and IDs are rejected. Descriptions are limited to
16,000 characters. Names
must be unique. Requests are limited to 32 tools, 200 messages, 512KB JSON and a
rendered prompt of 200,000 characters. Unsupported schema keywords fail validation.
Format annotations (such as `format: "email"`) are unsupported and rejected too.

The browser receives a canonical JSON transcript with the full tool history.
Unlike a native API, these role labels are ordinary text in a website user message,
**not privileged system messages**. The model must answer with one complete JSON
envelope containing a per-request nonce and either final text or tool requests.
Prose, fences, examples, extra fields, unknown tools and invalid arguments are
rejected. The gateway never searches arbitrary prose for executable tool calls.
This reduces accidental interpretation; it does not eliminate prompt injection.

At most one request runs at a time, with four waiting slots. The 180-second
deadline includes queue time. On active cancellation, timeout, disconnect or a
browser adapter error, the lease is closed and queued work fails: inspect the tab
and explicitly pair again. No uncertain action is automatically retried. Invalid
model envelopes return 502 without tool execution or a repair retry.

`stream: true` returns standard SSE completion chunks and `[DONE]`, **buffered
until the final reply passes validation**. Errors return JSON before streaming
headers are sent. Clients must tolerate the browser generation delay. Usage/token
counts are omitted because the browser does not expose trustworthy API accounting.

`GET /health` exposes only `{ "ok": true }`. `GET /v1/status` requires the API key
and reports pairing state and capabilities. REST rejects all browser `Origin`
headers, accepts only the exact loopback Host header, and enables no CORS access.

## Security and limitations

- Anyone with your gateway API key can submit prompts and consume your allowance.
  Anyone controlling the armed tab can influence responses. Use only trusted local
  clients; this is not a multi-user or remotely accessible service.
- The bridge token exists in extension service-worker memory only, not content
  scripts or persistent storage. Only the non-secret port is saved in session storage.
  Service-worker/browser restarts may require re-pairing. Heartbeats keep an active
  connection alive on supported Chrome versions.
- The extension has access only to ChatGPT pages, local WebSocket connections,
  session storage, and the active tab. It never requests cookie access or `<all_urls>`.
- Browser limits, challenge pages, login expiry, UI changes, and account settings
  can interrupt requests. Detection is best effort. There is no guarantee of model
  identity or that the provider will account for usage as expected.
- Native website actions cannot be fully controlled by the prompt. Start with
  provider connectors disabled and non-sensitive tasks. Do not send credentials.
- Local malicious software, compromised browser extensions, arbitrary tool schemas
  from untrusted clients, and a compromised provider page are outside this prototype's
  security boundary. Keep actual execution sandboxed and require approval for
  destructive operations, network access, credentials, purchases and publication.
- Fresh chats duplicate transcript context and accumulate website history. Persistent
  sessions, compaction, real token streaming and multimodal artifacts are future work.

## Development and verification

```sh
npm run lint
npm run typecheck
npm test
```

Tests exercise the HTTP gateway against simulated extension peers, complete tool
round trips, strict protocol validation, queue limits, cancellation, deadlines,
pairing failures, host/origin restrictions and ChatGPT-like DOM fixtures. They
require no account, keys, provider requests, or browser launch. They do not establish
live website compatibility. CI runs these checks and an audit of runtime dependencies.

The full development-dependency audit currently flags the
[minimatch amplification advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
through ESLint and TypeScript-ESLint. Runtime dependencies pass `npm audit --omit=dev`.
Do not pass untrusted glob patterns to the development tools. There is no compatible
patched legacy minimatch release in their pinned dependency ranges; do not run
`npm audit fix --force` (its proposed ESLint downgrade is not an appropriate fix).

Manual acceptance before relying on the gateway:

1. Confirm the selected ChatGPT model and record account usage indicators.
2. Pair a dedicated tab and run `npm run smoke` repeatedly.
3. Confirm the two requests used fresh chats and retained tool history correctly.
4. Cancel a request; confirm pairing is revoked and no automatic retry occurs.
5. Check account usage indicators again. Do not infer billing separation from login alone.

Browser-specific selectors live in `extension/adapter.ts`. Keep adapter updates
separate from the protocol and execution boundary; do not add private endpoints
or security/usage-limit bypasses to work around a broken UI.
