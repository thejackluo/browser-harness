export type UiStage = 'new_chat' | 'editor' | 'insert' | 'send' | 'reply';
export class BrowserError extends Error {
  constructor(public code: 'login_required' | 'provider_blocked' | 'ui_changed' | 'browser_busy' | 'cancelled', public stage?: UiStage) { super(stage ? `${code}:${stage}` : code); }
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
const EDITOR = '#prompt-textarea, form div[contenteditable="true"][role="textbox"]';
const NEW_CHAT = 'a[data-testid="create-new-chat-button"], button[data-testid="create-new-chat-button"], a[href="/"][aria-label*="New chat"], a[href="/"][data-discover], button[aria-label="New chat"]';
const SEND = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], form button[aria-label="Send"]';
function newChatButton(document: Document): HTMLElement | undefined {
  return find(document, NEW_CHAT) ??
    [...document.querySelectorAll<HTMLElement>('nav button')].find(el => visible(el) && el.textContent?.trim() === 'New chat');
}
const STOP = '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], form button[aria-label="Stop"]';
const MESSAGE = '[data-message-author-role], [data-chatgpt-search-unit-key]';
const ASSISTANT = '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"]';
function messageCount(document: Document): number {
  return [...document.querySelectorAll(MESSAGE)].filter(visible).length;
}
function normalize(text: string): string {
  return text.replaceAll('\r\n', '\n').replace(/\n+/g, '\n').trim();
}
function blocked(document: Document): void {
  const alerts = [...document.querySelectorAll('[role="alert"], [role="dialog"]')].filter(visible).map(el => el.textContent ?? '').join(' ');
  if (/verify you are human|unusual activity|usage limit|reached.*limit|too many requests|try again later/i.test(alerts)) throw new BrowserError('provider_blocked');
  if (find(document, 'a[href*="/auth/login"], button[data-testid="login-button"]')) throw new BrowserError('login_required');
}
function assistantText(document: Document): string {
  const messages = [...document.querySelectorAll(ASSISTANT)].filter(visible);
  const last = messages.at(-1);
  if (!last) return '';
  const markdown = [...last.querySelectorAll('.markdown, [data-markdown-copy="contents"]')].filter(visible).at(-1);
  if (!markdown) return '';
  const copy = markdown.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('button, svg, [aria-hidden="true"]').forEach(el => el.remove());
  return (copy.textContent ?? '').trim();
}
function stopped(document: Document): boolean {
  return !find(document, STOP) && !document.querySelector('[data-talvt-turn-state="in_progress"]');
}

export async function runChat(document: Document, prompt: string, signal: AbortSignal, time: AdapterClock = clock): Promise<string> {
  const check = () => { if (signal.aborted) throw new BrowserError('cancelled'); blocked(document); };
  check();
  if (!stopped(document)) throw new BrowserError('browser_busy');
  const newChat = newChatButton(document);
  const fresh = messageCount(document) === 0 && find(document, EDITOR);
  if (newChat) newChat.click();
  else if (!fresh) throw new BrowserError('ui_changed', 'new_chat');
  const resetDeadline = time.now() + 15_000;
  let editor: HTMLElement | undefined;
  while (time.now() < resetDeadline) {
    check();
    editor = find(document, EDITOR);
    if (editor && messageCount(document) === 0 && stopped(document)) break;
    editor = undefined;
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
  const inserted = editor.tagName === 'TEXTAREA' ? (editor as HTMLTextAreaElement).value : editor.innerText;
  if (normalize(inserted) !== normalize(prompt)) throw new BrowserError('ui_changed', 'insert');
  const sendDeadline = time.now() + 5000;
  let sent = false;
  while (time.now() < sendDeadline) {
    check();
    const send = find<HTMLButtonElement>(document, SEND);
    if (send && !send.disabled) { send.click(); sent = true; break; }
    await time.wait(signal);
  }
  if (!sent) throw new BrowserError('ui_changed', 'send');
  const deadline = time.now() + 170_000;
  let previous = '';
  let stableSince = time.now();
  try {
    while (time.now() < deadline) {
      check();
      const text = assistantText(document);
      if (text !== previous || !stopped(document)) { previous = text; stableSince = time.now(); }
      // Only a complete protocol object can finish, never a thinking/status paragraph.
      let complete = false;
      try { const parsed = JSON.parse(text); complete = parsed !== null && typeof parsed === 'object'; } catch { /* Still generating or a malformed final reply. */ }
      if (text && stopped(document) && time.now() - stableSince >= 2000) {
        if (!complete) throw new BrowserError('ui_changed', 'reply');
        return text;
      }
      await time.wait(signal);
    }
    throw new BrowserError('ui_changed', 'reply');
  } catch (error) {
    stopChat(document);
    throw error;
  }
}

export function stopChat(document: Document): void {
  find(document, STOP)?.click();
}
