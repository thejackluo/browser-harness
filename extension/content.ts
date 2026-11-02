import { BrowserError, runChat, stopChat } from './adapter.js';

let active: { id: string; controller: AbortController } | undefined;
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
  if (message.type === 'cancel') {
    active?.controller.abort();
    stopChat(document);
    respond({ ok: true });
    return false;
  }
  if (message.type !== 'run' || typeof message.id !== 'string' || typeof message.prompt !== 'string' || message.prompt.length > 200_000) return false;
  if (active) { respond({ type: 'error', id: message.id, code: 'browser_busy' }); return false; }
  const controller = new AbortController();
  active = { id: message.id, controller };
  void runChat(document, message.prompt, controller.signal)
    .then(text => respond({ type: 'result', id: message.id, text }))
    .catch(error => respond({ type: 'error', id: message.id, code: error instanceof BrowserError ? error.code : 'ui_changed' }))
    .finally(() => { active = undefined; });
  return true;
});
