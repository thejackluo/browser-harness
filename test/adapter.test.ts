import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { runChat, type AdapterClock } from '../extension/adapter.js';

function fixture() {
  const dom = new JSDOM('<a data-testid="create-new-chat-button" href="/">New chat</a><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>');
  const { document } = dom.window;
  dom.window.HTMLElement.prototype.getClientRects = function () { return (this.hidden ? [] : [{}]) as unknown as DOMRectList; };
  let now = 0;
  let tick: (() => void) | undefined;
  const clock: AdapterClock = { now: () => now, wait: async signal => { signal.throwIfAborted(); now += 250; tick?.(); } };
  const assistant = (text: string) => {
    document.querySelector('[data-message-author-role="assistant"]')?.remove();
    const message = document.createElement('div');
    message.dataset.messageAuthorRole = 'assistant';
    const markdown = document.createElement('div');
    markdown.className = 'markdown';
    markdown.textContent = text;
    message.append(markdown);
    document.body.append(message);
  };
  return { document, clock, assistant, setTick: (callback: () => void) => { tick = callback; } };
}

test('resets the tab, inserts a prompt and waits for a stable final response', async () => {
  const f = fixture();
  f.assistant('old conversation');
  f.document.querySelector('a')!.addEventListener('click', e => { e.preventDefault(); f.document.querySelector('[data-message-author-role]')?.remove(); });
  let sent = false;
  f.document.querySelector('button')!.addEventListener('click', () => { sent = true; f.assistant('{"type":"final","content":"done"}'); });
  const text = await runChat(f.document, 'test prompt', new AbortController().signal, f.clock);
  assert.equal(sent, true);
  assert.equal(f.document.querySelector('textarea')!.value, 'test prompt');
  assert.equal(JSON.parse(text).content, 'done');
});

test('does not accept stable text while the stop control is visible', async () => {
  const f = fixture();
  let ticks = 0;
  f.document.querySelector('a')!.addEventListener('click', e => e.preventDefault());
  f.document.querySelector('button')!.addEventListener('click', () => {
    f.assistant('{"type":"final","content":"done"}');
    const stop = f.document.createElement('button'); stop.dataset.testid = 'stop-button'; f.document.body.append(stop);
  });
  f.setTick(() => { ticks++; if (ticks === 15) f.document.querySelector('[data-testid="stop-button"]')?.remove(); });
  await runChat(f.document, 'hello', new AbortController().signal, f.clock);
  assert.ok(ticks >= 22);
});

test('fails closed when the fresh-chat selector is missing', async () => {
  const f = fixture(); f.document.querySelector('a')!.remove();
  await assert.rejects(runChat(f.document, 'hello', new AbortController().signal, f.clock), /ui_changed/);
});

test('stops on visible provider challenges rather than attempting a bypass', async () => {
  const f = fixture();
  const alert = f.document.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = 'Verify you are human'; f.document.body.append(alert);
  await assert.rejects(runChat(f.document, 'hello', new AbortController().signal, f.clock), /provider_blocked/);
});

test('does not mistake conversation text for a provider challenge', async () => {
  const f = fixture(); f.assistant('Explain the words usage limit');
  f.document.querySelector('a')!.addEventListener('click', e => { e.preventDefault(); f.document.querySelector('[data-message-author-role]')?.remove(); });
  f.document.querySelector('button')!.addEventListener('click', () => f.assistant('{"type":"final","content":"done"}'));
  await runChat(f.document, 'hello', new AbortController().signal, f.clock);
});

test('refuses to submit while the user already has a generation running', async () => {
  const f = fixture(); const stop = f.document.createElement('button'); stop.dataset.testid = 'stop-button'; f.document.body.append(stop);
  await assert.rejects(runChat(f.document, 'hello', new AbortController().signal, f.clock), /browser_busy/);
});

test('honors cancellation before changing a tab', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(runChat(f.document, 'hello', controller.signal, f.clock), /cancelled/);
});
