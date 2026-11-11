import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EXTENSION_ORIGIN, NativeDecoder, nativeFrame } from '../src/native.js';
import { createGateway } from '../src/server.js';

test('native framing accepts fragmented/coalesced UTF-8 messages and rejects invalid frames', () => {
  const decoder = new NativeDecoder();
  const frame = nativeFrame({ id: 'a', text: 'café' });
  assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(frame.subarray(2, 7)), []);
  assert.deepEqual(decoder.push(Buffer.concat([frame.subarray(7), nativeFrame({ id: 'b' })])), [{ id: 'a', text: 'café' }, { id: 'b' }]);
  decoder.finish();
  assert.throws(() => new NativeDecoder().push(Buffer.alloc(4)), /size/);
  assert.throws(() => new NativeDecoder().push(Buffer.from([255, 255, 255, 255])), /size/);
  assert.throws(() => new NativeDecoder().push(Buffer.from([1, 0, 0, 0, 123])));
  const partial = new NativeDecoder(); partial.push(frame.subarray(0, 5));
  assert.throws(() => partial.finish(), /Incomplete/);
});

interface Reply { id: string; ok: boolean; code?: string; error?: string; port?: number; baseURL?: string; apiKey?: string }
async function host(t: TestContext, options: { origin?: string; port?: number } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'browser-harness-native-'));
  const launcher = process.platform === 'win32' ? process.env.BROWSER_HARNESS_TEST_LAUNCHER : undefined;
  const child = spawn(launcher ?? process.execPath, [...(launcher ? [] : [resolve(process.env.BROWSER_HARNESS_TEST_ENTRY ?? 'dist/src/native-host.js')]), options.origin ?? EXTENSION_ORIGIN], {
    env: { ...process.env, HOME: home, USERPROFILE: home, BROWSER_HARNESS_HOME: join(home, '.browser-harness'), BROWSER_HARNESS_PORT: String(options.port ?? 0) },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const closed = once(child, 'close');
  const replies = new EventEmitter();
  const decoder = new NativeDecoder();
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  child.stdout.on('data', data => { for (const message of decoder.push(data) as Reply[]) replies.emit(message.id, message); });
  t.after(async () => { child.stdin.end(); await closed; await rm(home, { recursive: true, force: true }); });
  const request = async (value: Record<string, unknown>) => {
    const response = once(replies, value.id as string, { signal: AbortSignal.timeout(30_000) });
    child.stdin.write(nativeFrame(value));
    return (await response)[0] as Reply;
  };
  return { child, closed, home, request, stderr: () => stderr };
}

test('native helper starts an authenticated API, configures OpenCode and stops on Chrome EOF', async t => {
  const h = await host(t);
  const hello = await h.request({ id: 'hello', type: 'hello' });
  assert.equal(hello.ok, true);
  assert.ok(hello.port && hello.port >= 1024);
  assert.equal(hello.baseURL, `http://127.0.0.1:${hello.port}/v1`);
  assert.ok(hello.apiKey && hello.apiKey.length >= 32);
  assert.equal((await fetch(`${hello.baseURL}/models`)).status, 401);
  const status = await fetch(`${hello.baseURL}/status`, { headers: { Authorization: `Bearer ${hello.apiKey}` } });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).browser_connected, false);
  const stored = (await readFile(join(h.home, '.browser-harness', 'api_key'), 'utf8')).trim();
  assert.equal(stored === hello.apiKey, true);
  const again = await h.request({ id: 'again', type: 'hello' });
  assert.equal(again.port, hello.port);
  assert.equal(again.apiKey === hello.apiKey, true);
  assert.equal((await h.request({ id: 'configure', type: 'configure', target: 'opencode' })).ok, true);
  const config = JSON.parse(await readFile(join(h.home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(config.provider['browser-harness'].options.baseURL, hello.baseURL);
  assert.equal(h.stderr(), '');
  h.child.stdin.end();
  assert.equal((await h.closed)[0], 0);
  await assert.rejects(fetch(`http://127.0.0.1:${hello.port}/health`));
});

test('native helper rejects arbitrary actions and targets before provisioning keys', async t => {
  const h = await host(t);
  for (const request of [
    { type: 'exec', command: 'whoami' },
    { type: 'configure', target: 'hermes & whoami' },
    { type: 'hello', target: 'opencode' },
  ]) {
    const response = await h.request({ id: 'invalid', ...request });
    assert.equal(response.ok, false);
    assert.equal(response.code, 'invalid_request');
    assert.equal(response.apiKey, undefined);
  }
  await assert.rejects(stat(join(h.home, '.browser-harness')));
});

test('native helper refuses other extension origins', async t => {
  const h = await host(t, { origin: 'chrome-extension://untrusted/' });
  assert.equal((await h.closed)[0], 1);
  await assert.rejects(stat(join(h.home, '.browser-harness')));
});

test('native helper reports an occupied API port instead of stopping another process', async t => {
  const gateway = createGateway({ apiKey: 'native-test-key-not-a-secret-000000000000000', port: 0 });
  const port = await gateway.listen();
  t.after(() => gateway.close());
  const h = await host(t, { port });
  const response = await h.request({ id: 'hello', type: 'hello' });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'port_in_use');
  assert.equal(response.apiKey, undefined);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
});
