import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createGateway } from '../src/server.js';

const apiKey = 'test-api-key-not-a-secret-000000000000000';
const bridgeToken = 'test-bridge-token-not-a-secret-000000000';
const origin = `chrome-extension://${'a'.repeat(32)}`;
const request = { model: 'chatgpt-browser', messages: [{ role: 'user', content: 'Hello' }] };
async function setup(t: TestContext, options: { timeoutMs?: number; maxQueue?: number } = {}) {
  const gateway = createGateway({ apiKey, bridgeToken, port: 0, ...options });
  const port = await gateway.listen();
  t.after(() => gateway.close());
  const url = `http://127.0.0.1:${port}`;
  const post = (body: unknown = request, signal?: AbortSignal) => fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const pair = async (token = bridgeToken, provider?: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin });
    await once(socket, 'open');
    const ready = once(socket, token === bridgeToken ? 'message' : 'close');
    socket.send(JSON.stringify({ type: 'hello', protocol: 1, token, ...(provider ? { provider } : {}) }));
    await ready;
    return socket;
  };
  return { gateway, url, post, pair, port };
}
function answer(socket: WebSocket, job: { id: string; prompt: string }, content = 'Hello') {
  const nonce = /"nonce":"([^"]+)"/.exec(job.prompt)?.[1];
  socket.send(JSON.stringify({ type: 'result', id: job.id, text: JSON.stringify({ nonce, type: 'final', content }) }));
}

test('requires separate strong keys', () => {
  assert.throws(() => createGateway({ apiKey: 'x', bridgeToken: 'y' }));
  assert.throws(() => createGateway({ apiKey, bridgeToken: apiKey }));
});

test('protects API, origins and host headers; reports actual capabilities', async t => {
  const { url, port } = await setup(t);
  assert.equal((await fetch(`${url}/v1/models`)).status, 401);
  const headers = { Authorization: `Bearer ${apiKey}` };
  assert.equal((await fetch(`${url}/v1/models`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${url}/v1/models`, { headers: { ...headers, Origin: '' } })).status, 403);
  const body = await (await fetch(`${url}/v1/status`, { headers })).json();
  assert.equal(body.providers.chatgpt.browser_connected, false);
  assert.equal(body.providers.gemini.browser_connected, false);
  assert.equal(body.capabilities.images, false);
  await new Promise<void>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/health', headers: { Host: 'evil.example' } }, response => {
      assert.equal(response.statusCode, 403); response.resume(); resolve();
    }).on('error', reject);
  });
});

test('rejects unpaired requests and wrong bridge tokens', async t => {
  const { post, pair, gateway } = await setup(t);
  assert.equal((await post()).status, 503);
  const socket = await pair('wrong');
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.equal(gateway.bridge.connected, false);
});

test('rejects web-origin WebSocket connections', async t => {
  const { port } = await setup(t);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: 'https://evil.example' });
  await new Promise<void>(resolve => socket.on('error', error => { assert.match(error.message, /403/); resolve(); }));
});

test('returns completions and buffered SSE using a paired browser', async t => {
  const { post, pair } = await setup(t);
  const socket = await pair();
  socket.on('message', data => { const job = JSON.parse(data.toString()); if (job.type === 'run') answer(socket, job); });
  const response = await post();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Hello');
  const stream = await post({ ...request, stream: true });
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await stream.text();
  assert.match(text, /chat.completion.chunk/);
  assert.match(text, /\[DONE\]/);
});

test('preserves a multi-step tool loop through the HTTP API', async t => {
  const { post, pair } = await setup(t);
  const socket = await pair();
  let turns = 0;
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }];
  socket.on('message', data => {
    const job = JSON.parse(data.toString());
    if (job.type !== 'run') return;
    turns++;
    if (turns === 1) {
      const nonce = /"nonce":"([^"]+)"/.exec(job.prompt)?.[1];
      socket.send(JSON.stringify({ type: 'result', id: job.id, text: JSON.stringify({ nonce, type: 'tool_calls', tool_calls: [{ name: 'read_file', arguments: { path: 'README.md' } }] }) }));
    } else {
      assert.match(job.prompt, /tool_call_id/);
      assert.match(job.prompt, /safe fixture contents/);
      answer(socket, job, 'Read it');
    }
  });
  const first = await (await post({ ...request, tools })).json();
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  const assistant = first.choices[0].message;
  const second = await (await post({ ...request, tools, messages: [...request.messages, assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'safe fixture contents' }] })).json();
  assert.equal(second.choices[0].message.content, 'Read it');
  assert.equal(turns, 2);
});

test('does not retry malformed model output or accept stale results', async t => {
  const { post, pair } = await setup(t);
  const socket = await pair();
  let runs = 0;
  socket.on('message', data => {
    const job = JSON.parse(data.toString());
    if (job.type !== 'run') return;
    runs++;
    answer(socket, { ...job, id: 'stale-id' }, 'wrong');
    socket.send(JSON.stringify({ type: 'result', id: job.id, text: 'Here is an example tool call: {}' }));
  });
  const response = await post();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'invalid_browser_reply');
  assert.equal(runs, 1);
});

test('serializes jobs and rejects a full queue', async t => {
  const { post, pair, url } = await setup(t, { maxQueue: 1 });
  const socket = await pair();
  const nextRun = once(socket, 'message');
  const first = post();
  const [data] = await nextRun;
  const queued = post();
  const deadline = Date.now() + 2000;
  while (true) {
    const status = await (await fetch(`${url}/v1/status`, { headers: { Authorization: `Bearer ${apiKey}` } })).json();
    if (status.queued_requests === 1) break;
    assert.ok(Date.now() < deadline, 'queued request should reach server');
    await new Promise(resolve => setImmediate(resolve));
  }
  const third = await post();
  assert.equal(third.status, 429);
  const secondRun = once(socket, 'message');
  answer(socket, JSON.parse(data.toString()));
  const [second] = await secondRun;
  answer(socket, JSON.parse(second.toString()));
  assert.equal((await first).status, 200);
  assert.equal((await queued).status, 200);
});

test('times out and disarms instead of retrying an uncertain generation', async t => {
  const { post, pair, gateway } = await setup(t, { timeoutMs: 40 });
  await pair();
  const response = await post();
  assert.equal(response.status, 504);
  assert.equal(gateway.bridge.connected, false);
  assert.equal((await post()).status, 503);
});

test('client cancellation closes the browser lease', async t => {
  const { post, pair, gateway } = await setup(t);
  const socket = await pair();
  const started = once(socket, 'message');
  const closed = once(socket, 'close');
  const controller = new AbortController();
  const response = post(request, controller.signal);
  const rejected = assert.rejects(response, /abort/i);
  await started;
  controller.abort();
  await rejected;
  await closed;
  assert.equal(gateway.bridge.connected, false);
});

test('provider errors expose no raw page data and disarm the bridge', async t => {
  const { post, pair, gateway } = await setup(t);
  const socket = await pair();
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'run') socket.send(JSON.stringify({ type: 'error', id: message.id, code: 'provider_blocked', text: 'private page data' }));
  });
  const response = await post();
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('private page data'));
  assert.equal(gateway.bridge.connected, false);
});

test('provider error notices fail one request but keep the tab paired', async t => {
  const { post, pair, gateway } = await setup(t);
  const socket = await pair();
  let runs = 0;
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'run') return;
    if (++runs === 1) socket.send(JSON.stringify({ type: 'error', id: message.id, code: 'provider_error' }));
    else answer(socket, message, 'recovered');
  });
  const failed = await post();
  assert.equal(failed.status, 502);
  assert.match(await failed.text(), /retry the request/);
  assert.equal(gateway.bridge.connected, true);
  const recovered = await post();
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).choices[0].message.content, 'recovered');
});

for (const [code, stage, expected] of [['ui_changed', 'new_chat', /Failed step: new_chat\./], ['ui_changed', '<script>', /Inspect the selected tab\."/], ['tab_not_attached', undefined, /Reload the ChatGPT tab/]] as const) {
  test(`reports ${code} ${stage ?? ''} with an allowlisted hint`, async t => {
    const { post, pair } = await setup(t);
    const socket = await pair();
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'run') socket.send(JSON.stringify({ type: 'error', id: message.id, code, stage }));
    });
    const response = await post();
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.match(body, expected);
    assert.ok(!body.includes('<script>'));
  });
}

test('lists both models and routes each to its own paired provider tab', async t => {
  const { url, post, pair, gateway, port } = await setup(t);
  const models = await (await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } })).json();
  assert.deepEqual(models.data.map((m: { id: string }) => m.id), ['chatgpt-browser', 'gemini-browser']);
  const gemini = await pair(bridgeToken, 'gemini');
  gemini.on('message', data => { const job = JSON.parse(data.toString()); if (job.type === 'run') answer(gemini, job, 'from gemini'); });
  assert.equal(gateway.bridges.gemini.connected, true);
  assert.equal(gateway.bridges.chatgpt.connected, false);
  const unpaired = await post();
  assert.equal(unpaired.status, 503);
  assert.match((await unpaired.json()).error.message, /ChatGPT tab/);
  const response = await post({ ...request, model: 'gemini-browser' });
  const body = await response.json();
  assert.equal(body.model, 'gemini-browser');
  assert.equal(body.choices[0].message.content, 'from gemini');
  const chatgpt = await pair();
  chatgpt.on('message', data => { const job = JSON.parse(data.toString()); if (job.type === 'run') answer(chatgpt, job, 'from chatgpt'); });
  assert.equal((await (await post()).json()).choices[0].message.content, 'from chatgpt');
  const second = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin });
  await once(second, 'open');
  const rejected = once(second, 'close');
  second.send(JSON.stringify({ type: 'hello', protocol: 1, token: bridgeToken, provider: 'gemini' }));
  await rejected;
  assert.equal(gateway.bridges.gemini.connected, true);
});

test('rejects unknown models and providers', async t => {
  const { post, port } = await setup(t);
  assert.equal((await post({ ...request, model: 'claude-browser' })).status, 400);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin });
  await once(socket, 'open');
  const closed = once(socket, 'close');
  socket.send(JSON.stringify({ type: 'hello', protocol: 1, token: bridgeToken, provider: 'claude' }));
  await closed;
});
