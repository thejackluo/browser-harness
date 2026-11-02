import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';

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
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  assert.equal(manifest.background.type, 'module');
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(!manifest.externally_connectable);
  const content = readFileSync('build/extension/content.js', 'utf8');
  assert.doesNotMatch(content, /^import |^export /m);
});
