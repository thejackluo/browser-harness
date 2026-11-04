import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { EXTENSION_ID } from '../src/bridge.js';

test('content script accepts its worker without requiring a page URL, rejects other senders', () => {
  type Sender = { id: string; url?: string; tab?: object };
  let listener: (message: unknown, sender: Sender, respond: (value: unknown) => void) => boolean;
  const document = new JSDOM('<main></main>').window.document;
  runInNewContext(readFileSync('build/extension/content.js', 'utf8'), {
    chrome: { runtime: { id: 'own-extension', onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } },
    document,
  });
  let reply: unknown;
  const respond = (value: unknown) => { reply = JSON.parse(JSON.stringify(value)); };
  listener!({ type: 'cancel' }, { id: 'another-extension' }, respond);
  assert.equal(reply, undefined);
  listener!({ type: 'cancel' }, { id: 'own-extension', tab: {} }, respond);
  assert.equal(reply, undefined);
  listener!({ type: 'cancel' }, { id: 'own-extension' }, respond);
  assert.deepEqual(reply, { ok: true });
});

test('extension manifest limits host access and bundles worker as a module', () => {
  const manifest = JSON.parse(readFileSync('build/extension/manifest.json', 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*', 'https://gemini.google.com/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions);
  assert.equal(manifest.background.type, 'module');
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(!manifest.externally_connectable);
  const content = readFileSync('build/extension/content.js', 'utf8');
  assert.doesNotMatch(content, /^import |^export /m);
});

test('manifest key pins the extension ID the gateway trusts', () => {
  const manifest = JSON.parse(readFileSync('build/extension/manifest.json', 'utf8'));
  const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  assert.equal([...hash].map(c => String.fromCharCode(97 + parseInt(c, 16))).join(''), EXTENSION_ID);
});
