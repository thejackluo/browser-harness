export type UiStage = 'new_chat' | 'editor' | 'insert' | 'send' | 'reply';
export class BrowserError extends Error {
  constructor(public code: 'login_required' | 'provider_blocked' | 'provider_error' | 'ui_changed' | 'browser_busy' | 'cancelled', public stage?: UiStage) { super(stage ? `${code}:${stage}` : code); }
}

export interface AdapterClock {
  now: () => number;
  wait: (signal: AbortSignal) => Promise<void>;
}
const clock: AdapterClock = {
  now: () => Date.now(),
  wait: signal => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 250);
    const abort = () => { clearTimeout(timer); reject(new BrowserError('cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }),
};

function visible(element: Element): boolean {
  const html = element as HTMLElement;
  return !html.hidden && html.getAttribute('aria-hidden') !== 'true' && html.getClientRects().length > 0;
}
function find<T extends HTMLElement>(document: Document, selectors: string): T | undefined {
  return [...document.querySelectorAll<T>(selectors)].find(visible);
}
export interface ProviderUi {
  editor: string;
  send: string;
  stop: string;
  newChat: (document: Document) => HTMLElement | undefined;
  messageCount: (document: Document) => number;
  assistantText: (document: Document) => string;
  submittedText?: (document: Document) => string;
  generating: (document: Document) => boolean;
  loggedOut: (document: Document) => boolean;
  /** A finished reply that is the provider's own error notice, not model output. */
  errorReply?: (text: string) => boolean;
}

function lastText(document: Document, turns: string, body: string, strip: string): string {
  const last = [...document.querySelectorAll(turns)].filter(visible).at(-1);
  const markdown = last && [...last.querySelectorAll(body)].filter(visible).at(-1);
  if (!markdown) return '';
  const copy = markdown.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(strip).forEach(el => el.remove());
  return (copy.textContent ?? '').trim();
}

export const chatgptUi: ProviderUi = {
  editor: '#prompt-textarea, form div[contenteditable="true"][role="textbox"]',
  send: 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], form button[aria-label="Send"]',
  stop: '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], form button[aria-label="Stop"]',
  newChat: document => find(document, 'a[data-testid="create-new-chat-button"], button[data-testid="create-new-chat-button"], a[href="/"][aria-label*="New chat"], a[href="/"][data-discover], button[aria-label="New chat"]') ??
    [...document.querySelectorAll<HTMLElement>('nav button')].find(el => visible(el) && el.textContent?.trim() === 'New chat'),
  messageCount: document => [...document.querySelectorAll('[data-message-author-role], [data-chatgpt-search-unit-key]')].filter(visible).length,
  assistantText: document => lastText(document, '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"]', '.markdown, [data-markdown-copy="contents"]', 'button, svg, [aria-hidden="true"]'),
  submittedText: document => ([...document.querySelectorAll('[data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"]')].filter(visible).at(-1)?.textContent ?? '').trim(),
  generating: document => document.querySelector('[data-talvt-turn-state="in_progress"]') !== null,
  loggedOut: document => find(document, 'a[href*="/auth/login"], button[data-testid="login-button"]') !== undefined,
};

export const geminiUi: ProviderUi = {
  editor: 'rich-textarea div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"][role="textbox"]',
  send: 'button[aria-label="Send message"], button.send-button',
  stop: 'button[aria-label="Stop response"], button.send-button.stop',
  newChat: document => find(document, 'a[aria-label="New chat"], button[aria-label="New chat"]'),
  messageCount: document => [...document.querySelectorAll('user-query, model-response')].filter(visible).length,
  // Code-block headers ("JSON", copy/download buttons) and screen-reader labels are UI chrome, not reply text.
  assistantText: document => lastText(document, 'model-response', 'message-content .markdown', 'button, svg, [aria-hidden="true"], .cdk-visually-hidden, .code-block-decoration, .attachment-container'),
  // Gemini leaves aria-busy set on finished replies in background tabs, so only the stop control is trusted.
  generating: () => false,
  errorReply: text => /^Sorry, something went wrong\.(?: Please try (?:your request )?again\.)?$/i.test(text),
  loggedOut: document => find(document, 'a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/v3/signin"], a[aria-label="Sign in"]') !== undefined,
};

export function uiFor(hostname: string): ProviderUi {
  return hostname === 'gemini.google.com' ? geminiUi : chatgptUi;
}

function normalize(text: string): string {
  return text.replaceAll('\r\n', '\n').replace(/\n+/g, '\n').trim();
}
function editorText(editor: HTMLElement): string {
  if (editor.tagName === 'TEXTAREA') return (editor as HTMLTextAreaElement).value;
  // innerText includes layout-only line breaks, including inside long JSON strings and URLs.
  const copy = editor.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  copy.querySelectorAll('p, div, li').forEach(block => { block.prepend('\n'); block.append('\n'); });
  return copy.textContent ?? '';
}
function blocked(document: Document, ui: ProviderUi): void {
  const alerts = [...document.querySelectorAll('[role="alert"], [role="dialog"]')].filter(visible).map(el => el.textContent ?? '').join(' ');
  if (/verify you are human|unusual activity|usage limit|reached.*limit|too many requests|try again later/i.test(alerts)) throw new BrowserError('provider_blocked');
  if (ui.loggedOut(document)) throw new BrowserError('login_required');
}

export async function runChat(document: Document, prompt: string, signal: AbortSignal, time: AdapterClock = clock, ui: ProviderUi = chatgptUi): Promise<string> {
  const stopped = () => !find(document, ui.stop) && !ui.generating(document);
  const check = () => { if (signal.aborted) throw new BrowserError('cancelled'); blocked(document, ui); };
  check();
  if (!stopped()) throw new BrowserError('browser_busy');
  const newChat = ui.newChat(document);
  const fresh = ui.messageCount(document) === 0 && find(document, ui.editor);
  if (newChat) newChat.click();
  else if (!fresh) throw new BrowserError('ui_changed', 'new_chat');
  const resetDeadline = time.now() + 15_000;
  let editor: HTMLElement | undefined;
  let resetEditor: HTMLElement | undefined;
  let resetSince = time.now();
  while (time.now() < resetDeadline) {
    check();
    const candidate = find<HTMLElement>(document, ui.editor);
    if (!candidate || ui.messageCount(document) !== 0 || !stopped() || candidate !== resetEditor) resetSince = time.now();
    resetEditor = candidate;
    if (candidate && ui.messageCount(document) === 0 && stopped() && time.now() - resetSince >= 500) { editor = candidate; break; }
    await time.wait(signal);
  }
  if (!editor) throw new BrowserError('ui_changed', 'editor');
  editor.focus();
  if (editor.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(document.defaultView!.HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) throw new BrowserError('ui_changed', 'insert');
    setter.call(editor, prompt);
    editor.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
  } else {
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!document.execCommand('insertText', false, prompt)) throw new BrowserError('ui_changed', 'insert');
  }
  const checkInserted = () => {
    if (find(document, ui.editor) !== editor || normalize(editorText(editor)) !== normalize(prompt)) throw new BrowserError('ui_changed', 'insert');
  };
  const insertDeadline = time.now() + 500;
  while (true) {
    check();
    checkInserted();
    if (time.now() >= insertDeadline) break;
    // Let the website commit its composer state before its Send handler reads it.
    await time.wait(signal);
  }
  const sendDeadline = time.now() + 5000;
  let sent = false;
  while (time.now() < sendDeadline) {
    check();
    checkInserted();
    const send = find<HTMLButtonElement>(document, ui.send);
    if (send && !send.disabled) { send.click(); sent = true; break; }
    await time.wait(signal);
  }
  if (!sent) throw new BrowserError('ui_changed', 'send');
  const deadline = time.now() + 170_000;
  let previous = '';
  let stableSince = time.now();
  try {
    const nonce = ui.submittedText ? /"nonce":"([^"]+)"/.exec(prompt)?.[1] : undefined;
    if (nonce) {
      const submittedDeadline = time.now() + 5000;
      while (true) {
        check();
        const submitted = ui.submittedText!(document);
        if (submitted.includes(nonce)) break;
        if (submitted || time.now() >= submittedDeadline) throw new BrowserError('ui_changed', 'send');
        await time.wait(signal);
      }
    }
    while (time.now() < deadline) {
      check();
      const text = ui.assistantText(document);
      if (text !== previous || !stopped()) { previous = text; stableSince = time.now(); }
      // Only a complete protocol object can finish, never a thinking/status paragraph.
      let complete = false;
      try { const parsed = JSON.parse(text); complete = parsed !== null && typeof parsed === 'object'; } catch { /* Still generating or a malformed final reply. */ }
      if (text && stopped() && time.now() - stableSince >= 2000) {
        if (!complete) throw ui.errorReply?.(text) ? new BrowserError('provider_error') : new BrowserError('ui_changed', 'reply');
        return text;
      }
      await time.wait(signal);
    }
    throw new BrowserError('ui_changed', 'reply');
  } catch (error) {
    stopChat(document, ui);
    throw error;
  }
}

export function stopChat(document: Document, ui: ProviderUi = chatgptUi): void {
  find(document, ui.stop)?.click();
}
