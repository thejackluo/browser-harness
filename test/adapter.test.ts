import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { geminiUi, runChat, uiFor, type AdapterClock } from '../extension/adapter.js';

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

function geminiFixture() {
  const dom = new JSDOM('<side-navigation><a class="side-nav-sparkle-button" aria-label="New chat" href="/app">Gemini</a></side-navigation><main><user-query>old</user-query><model-response><message-content><div class="markdown">old</div></message-content></model-response></main><rich-textarea><div class="ql-editor ql-blank" contenteditable="true" role="textbox" aria-label="Enter a prompt for Gemini"></div></rich-textarea><button aria-label="Send message"></button>');
  const { document } = dom.window;
  dom.window.HTMLElement.prototype.getClientRects = function () { return (this.closest('[hidden]') ? [] : [{}]) as unknown as DOMRectList; };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get(this: HTMLElement) { return this.textContent; } });
  document.execCommand = (_command: string, _ui?: boolean, value?: string) => { (document.activeElement as HTMLElement).textContent = value ?? ''; return true; };
  let now = 0;
  let tick: ((n: number) => void) | undefined;
  let ticks = 0;
  const clock: AdapterClock = { now: () => now, wait: async signal => { signal.throwIfAborted(); now += 250; tick?.(++ticks); } };
  return { document, clock, setTick: (callback: (n: number) => void) => { tick = callback; } };
}

test('selects the Gemini UI by hostname', () => {
  assert.equal(uiFor('gemini.google.com'), geminiUi);
  assert.notEqual(uiFor('chatgpt.com'), geminiUi);
});

test('drives Gemini: new chat, composer insert, waits for stop to clear and text to settle', async () => {
  const f = geminiFixture();
  const { document } = f;
  document.querySelector('a')!.addEventListener('click', e => { e.preventDefault(); document.querySelector('main')!.innerHTML = ''; });
  let response: HTMLElement | undefined;
  document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
    response = document.createElement('model-response');
    response.innerHTML = '<message-content aria-busy="true"><div class="markdown"><p>{"type":"final",</p></div></message-content>';
    document.querySelector('main')!.append(response);
    const stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop response'); document.body.append(stop);
  });
  let doneAt = 0;
  f.setTick(n => {
    if (!response) return;
    if (!doneAt) {
      response.querySelector('.markdown')!.innerHTML = '<p>{"type":"final","content":"gemini"}</p><button>Copy</button>';
      doneAt = n;
    } else if (n === doneAt + 4) {
      response.querySelector('[aria-busy]')!.removeAttribute('aria-busy');
      document.querySelector('button[aria-label="Stop response"]')!.remove();
    }
  });
  const text = await runChat(document, 'hello gemini', new AbortController().signal, f.clock, geminiUi);
  assert.equal(document.querySelector('[role="textbox"]')!.textContent, 'hello gemini');
  assert.equal(JSON.parse(text).content, 'gemini');
});

test('reports Gemini sign-in pages as login_required', async () => {
  const f = geminiFixture();
  const link = f.document.createElement('a'); link.href = 'https://accounts.google.com/ServiceLogin?continue=x'; link.textContent = 'Sign in';
  f.document.body.append(link);
  await assert.rejects(runChat(f.document, 'hello', new AbortController().signal, f.clock, geminiUi), /login_required/);
});

test('reads a Gemini reply rendered as a code block without its header chrome', async () => {
  const f = geminiFixture();
  const { document } = f;
  document.querySelector('a')!.addEventListener('click', e => { e.preventDefault(); document.querySelector('main')!.innerHTML = ''; });
  document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
    const response = document.createElement('model-response');
    response.innerHTML = '<message-content><div class="markdown"><response-element><code-block><div class="code-block-decoration"><span>JSON</span><button aria-label="Copy code"></button></div><pre><code>{"type":"final","content":"block"}</code></pre></code-block></response-element></div></message-content>';
    document.querySelector('main')!.append(response);
  });
  const text = await runChat(document, 'hello', new AbortController().signal, f.clock, geminiUi);
  assert.equal(JSON.parse(text).content, 'block');
});

test('reports a finished Gemini error notice as a retryable provider_error', async () => {
  const f = geminiFixture();
  const { document } = f;
  document.querySelector('a')!.addEventListener('click', e => { e.preventDefault(); document.querySelector('main')!.innerHTML = ''; });
  document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
    const response = document.createElement('model-response');
    response.innerHTML = '<message-content><div class="markdown"><p>Sorry, something went wrong. Please try your request again.</p></div></message-content>';
    document.querySelector('main')!.append(response);
  });
  await assert.rejects(runChat(document, 'hello', new AbortController().signal, f.clock, geminiUi), (error: Error) => error.message === 'provider_error');
});

test('keeps other non-JSON Gemini prose as ui_changed', async () => {
  const f = geminiFixture();
  const { document } = f;
  document.querySelector('a')!.addEventListener('click', e => { e.preventDefault(); document.querySelector('main')!.innerHTML = ''; });
  document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
    const response = document.createElement('model-response');
    response.innerHTML = '<message-content><div class="markdown"><p>Sorry, something went wrong. Here is a workaround.</p></div></message-content>';
    document.querySelector('main')!.append(response);
  });
  await assert.rejects(runChat(document, 'hello', new AbortController().signal, f.clock, geminiUi), /ui_changed:reply/);
});
