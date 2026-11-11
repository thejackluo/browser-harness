import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { NativeHelper } from '../extension/native.js';
import { NATIVE_HOST } from '../src/native-protocol.js';

const apiKey = 'extension-test-key-not-a-secret-000000000000';
const connection = { port: 4318, baseURL: 'http://127.0.0.1:4318/v1', apiKey };
function runtime() {
  let receive: (value: unknown) => void;
  let disconnect: () => void;
  let missing = false;
  let connects = 0;
  const messages: Record<string, unknown>[] = [];
  let result: Record<string, unknown> = connection;
  const mock = {
    get lastError() { return missing ? { message: 'Specified native messaging host not found.' } : undefined; },
    connectNative(name: string) {
      assert.equal(name, NATIVE_HOST);
      connects++;
      if (missing) queueMicrotask(() => disconnect());
      return {
        onMessage: { addListener: (fn: typeof receive) => { receive = fn; } },
        onDisconnect: { addListener: (fn: typeof disconnect) => { disconnect = fn; } },
        postMessage(message: Record<string, unknown>) {
          messages.push(message);
          if (!missing) queueMicrotask(() => receive({ id: message.id, ok: true, ...(message.type === 'hello' ? result : {}) }));
        },
      } as unknown as chrome.runtime.Port;
    },
  };
  return { mock, messages, connects: () => connects, setMissing: (value: boolean) => { missing = value; }, setResult: (value: Record<string, unknown>) => { result = value; }, disconnect: () => disconnect() };
}

test('extension starts one helper, hides credentials in status and sends only bounded configuration actions', async () => {
  const r = runtime();
  const helper = new NativeHelper(r.mock);
  const [first, second] = await Promise.all([helper.start(), helper.start()]);
  assert.equal(first.apiKey, apiKey);
  assert.equal(second.port, first.port);
  assert.equal(r.connects(), 1);
  assert.equal(r.messages.length, 1);
  assert.equal(JSON.stringify(helper.summary()).includes(apiKey), false);
  await helper.configure('opencode');
  assert.equal(r.messages[1]?.type, 'configure');
  assert.equal(r.messages[1]?.target, 'opencode');
  assert.equal(JSON.stringify(r.messages).includes(apiKey), false);
  r.disconnect();
  assert.equal(helper.summary().state, 'error');
  await helper.start();
  assert.equal(r.connects(), 2);
});

test('missing helper shows setup and retries only on an explicit later start', async () => {
  const r = runtime(); r.setMissing(true);
  const helper = new NativeHelper(r.mock);
  await assert.rejects(helper.start(), /Install the Windows helper/);
  assert.equal(helper.summary().state, 'missing');
  assert.equal(r.connects(), 1);
  r.setMissing(false);
  await helper.start();
  assert.equal(helper.summary().state, 'ready');
  assert.equal(r.connects(), 2);
});

for (const invalid of [{ baseURL: 'https://evil.example/v1' }, { port: 80 }, { apiKey: 'short' }]) {
  test(`helper connection rejects invalid ${Object.keys(invalid)[0]}`, async () => {
    const r = runtime(); r.setResult({ ...connection, ...invalid });
    const helper = new NativeHelper(r.mock);
    await assert.rejects(helper.start(), /invalid connection/);
    assert.equal(helper.summary().state, 'error');
  });
}

test('synchronous native API errors become recoverable setup errors', async () => {
  const helper = new NativeHelper({ lastError: undefined, connectNative: () => { throw new Error('Permission unavailable'); } });
  await assert.rejects(helper.start(), /Permission unavailable/);
  assert.equal(helper.summary().state, 'error');
});

test('background exposes API credentials and configuration only to its own popup', async () => {
  const r = runtime();
  let listener: (message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean;
  const popup = 'chrome-extension://own-extension/popup.html';
  runInNewContext(readFileSync('build/extension/background.js', 'utf8'), {
    chrome: { runtime: { ...r.mock, id: 'own-extension', getURL: () => popup, onStartup: { addListener() {} }, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } } },
    crypto: { randomUUID }, setTimeout, clearTimeout, WebSocket: { OPEN: 1 },
  });
  await new Promise(resolve => setImmediate(resolve));
  let reply: unknown;
  const respond = (value: unknown) => { reply = JSON.parse(JSON.stringify(value)); };
  for (const sender of [{ id: 'other-extension', url: popup }, { id: 'own-extension', url: 'https://chatgpt.com/', tab: {} }]) {
    assert.equal(listener!({ type: 'credentials' }, sender, respond), false);
    assert.equal(reply, undefined);
    assert.equal(listener!({ type: 'configure', target: 'hermes' }, sender, respond), false);
  }
  listener!({ type: 'status' }, { id: 'own-extension', url: popup }, respond);
  assert.equal(JSON.stringify(reply).includes(apiKey), false);
  listener!({ type: 'credentials' }, { id: 'own-extension', url: popup }, respond);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((reply as { apiKey: string }).apiKey, apiKey);
  listener!({ type: 'configure', target: 'exec' }, { id: 'own-extension', url: popup }, respond);
  await new Promise(resolve => setImmediate(resolve));
  assert.match((reply as { error: string }).error, /Choose OpenCode or Hermes/);
  assert.equal(r.messages.length, 1);
});
