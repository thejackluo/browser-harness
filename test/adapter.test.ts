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

test('fails closed when the fresh-chat selector is missing from an existing conversation', async () => {
  const f = fixture(); f.document.querySelector('a')!.remove(); f.assistant('old conversation');
  await assert.rejects(runChat(f.document, 'hello', new AbortController().signal, f.clock), /ui_changed:new_chat/);
});

test('uses an already-fresh chat when the new-chat control is hidden', async () => {
  const f = fixture(); f.document.querySelector('a')!.remove();
  f.document.querySelector('button')!.addEventListener('click', () => f.assistant('{"type":"final","content":"done"}'));
  assert.equal(JSON.parse(await runChat(f.document, 'hello', new AbortController().signal, f.clock)).content, 'done');
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
  let stops = 0;
  stop.addEventListener('click', () => { stops++; });
  await assert.rejects(runChat(f.document, 'hello', new AbortController().signal, f.clock), /browser_busy/);
  assert.equal(stops, 0);
});

for (const failure of ['timeout', 'challenge', 'abort'] as const) {
  test(`stops its own generation after ${failure} before reporting failure`, async () => {
    const f = fixture();
    const controller = new AbortController();
    let stops = 0;
    f.document.querySelector('a')!.addEventListener('click', e => e.preventDefault());
    f.document.querySelector('button')!.addEventListener('click', () => {
      const stop = f.document.createElement('button');
      stop.dataset.testid = 'stop-button';
      stop.addEventListener('click', () => { stops++; stop.remove(); });
      f.document.body.append(stop);
    });
    if (failure === 'challenge') f.setTick(() => {
      const alert = f.document.createElement('div');
      alert.setAttribute('role', 'alert');
      alert.textContent = 'Usage limit reached';
      f.document.body.append(alert);
    });
    if (failure === 'abort') f.setTick(() => controller.abort());
    const code = { timeout: 'ui_changed', challenge: 'provider_blocked', abort: 'cancelled' }[failure];
    await assert.rejects(runChat(f.document, 'hello', controller.signal, f.clock), new RegExp(code));
    assert.equal(stops, 1);
    assert.equal(f.document.querySelector('[data-testid="stop-button"]'), null);
  });
}

test('honors cancellation before changing a tab', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(runChat(f.document, 'hello', controller.signal, f.clock), /cancelled/);
});

test('operates the current ChatGPT composer and turn markup', async () => {
  const dom = new JSDOM('<nav><button aria-label="New chat" type="button"></button></nav><div data-chatgpt-search-unit-key="old:1:assistant" hidden><div data-markdown-copy="contents">old</div></div><form><div aria-label="Ask ChatGPT" contenteditable="true" role="textbox"></div><button aria-label="Send" type="button"></button></form>');
  const { document } = dom.window;
  dom.window.HTMLElement.prototype.getClientRects = function () { return (this.closest('[hidden]') ? [] : [{}]) as unknown as DOMRectList; };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get(this: HTMLElement) { return this.textContent; } });
  document.execCommand = (_command: string, _ui?: boolean, value?: string) => { (document.activeElement as HTMLElement).textContent = value ?? ''; return true; };
  let now = 0;
  let ticks = 0;
  let turn: HTMLElement | undefined;
  const clock: AdapterClock = { now: () => now, wait: async signal => {
    signal.throwIfAborted(); now += 250; ticks++;
    if (ticks === 6) {
      turn!.setAttribute('data-talvt-turn-state', 'complete');
      document.querySelector('form button[aria-label="Stop"]')?.remove();
    }
  } };
  document.querySelector<HTMLElement>('[aria-label="Send"]')!.addEventListener('click', () => {
    turn = document.createElement('div');
    turn.setAttribute('data-talvt-turn-state', 'in_progress');
    turn.innerHTML = '<div data-chatgpt-search-unit-key="new:1:assistant"><h4>ChatGPT said:</h4><div data-markdown-copy="contents"><p>{"type":"final","content":"done"}</p></div></div>';
    document.body.append(turn);
    const stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop'); document.querySelector('form')!.append(stop);
  });
  const text = await runChat(document, 'hello', new AbortController().signal, clock);
  assert.equal(document.querySelector('[role="textbox"]')!.textContent, 'hello');
  assert.equal(JSON.parse(text).content, 'done');
  assert.ok(ticks >= 13);
});
