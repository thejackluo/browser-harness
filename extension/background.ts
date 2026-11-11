import { NativeHelper } from './native.js';

const helper = new NativeHelper();
void helper.start().catch(() => {});
chrome.runtime.onStartup.addListener(() => { void helper.start().catch(() => {}); });

const ORIGINS = { 'https://chatgpt.com': 'chatgpt', 'https://gemini.google.com': 'gemini' } as const;
type Provider = typeof ORIGINS[keyof typeof ORIGINS];
interface Session {
  socket?: WebSocket;
  tabId?: number;
  heartbeat?: ReturnType<typeof setInterval>;
  status: string;
  busy: boolean;
}
const sessions: Record<Provider, Session> = {
  chatgpt: { status: 'Disconnected', busy: false },
  gemini: { status: 'Disconnected', busy: false },
};
const ARMED = 'Armed — requests create fresh chats in this tab';

async function cancel(session: Session): Promise<void> {
  if (session.tabId !== undefined && session.busy) await chrome.tabs.sendMessage(session.tabId, { type: 'cancel' }).catch(() => {});
}

function providerFor(url: string | undefined): Provider | undefined {
  if (!url) return undefined;
  const origin = new URL(url).origin;
  return Object.hasOwn(ORIGINS, origin) ? ORIGINS[origin as keyof typeof ORIGINS] : undefined;
}

async function pair(port: number, token: string, selectedTab: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Enter a gateway port between 1024 and 65535.');
  if (token && token.length < 32) throw new Error('A bridge token is only needed if you set one; leave it empty otherwise.');
  const tab = await chrome.tabs.get(selectedTab);
  const provider = providerFor(tab.url);
  if (!provider) throw new Error('Open a ChatGPT or Gemini tab, then click the extension.');
  const session = sessions[provider];
  if (session.socket || session.busy) throw new Error('Disconnect and wait for the previous request to stop first.');
  session.tabId = selectedTab;
  await chrome.storage.session.set({ port });
  const peer = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  session.socket = peer;
  session.status = 'Connecting';
  peer.onopen = () => { peer.send(JSON.stringify({ type: 'hello', protocol: 1, provider, ...(token ? { token } : {}) })); };
  peer.onerror = () => { session.status = 'Gateway not reachable. Start it (npm start or the desktop shortcut), then click Arm again.'; };
  peer.onclose = () => {
    if (session.socket !== peer) return;
    clearInterval(session.heartbeat);
    session.socket = undefined;
    session.status = 'Disconnected — inspect tab before re-pairing';
    void cancel(session);
  };
  peer.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { peer.close(); return; }
    if (message.type === 'ready') {
      session.status = ARMED;
      session.heartbeat = setInterval(() => { if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'ping' })); }, 20_000);
    } else if (message.type === 'cancel') {
      void cancel(session);
    } else if (message.type === 'run') {
      const tabId = session.tabId;
      if (session.busy || typeof message.id !== 'string' || typeof message.prompt !== 'string' || tabId === undefined) { peer.close(); return; }
      session.busy = true;
      session.status = 'Running — do not interact with the armed tab';
      void chrome.tabs.sendMessage(tabId, message)
        .then(result => {
          if (session.socket === peer && peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify(result ?? { type: 'error', id: message.id, code: 'ui_changed' }));
            session.status = ARMED;
          }
        })
        .catch(() => { if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'error', id: message.id, code: 'tab_not_attached' })); })
        .finally(() => { session.busy = false; });
    }
  };
}

function summary(session: Session) {
  return { status: session.status, connected: session.socket?.readyState === WebSocket.OPEN, busy: session.busy };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  if (message.type === 'status') {
    const providers = { chatgpt: summary(sessions.chatgpt), gemini: summary(sessions.gemini) };
    const any = Object.values(providers);
    respond({ status: `ChatGPT: ${providers.chatgpt.status}\nGemini: ${providers.gemini.status}`, connected: any.some(p => p.connected), busy: any.some(p => p.busy), providers, helper: helper.summary() });
    return false;
  }
  if (message.type === 'start_helper' || message.type === 'credentials' || message.type === 'configure') {
    void (async () => {
      if (message.type === 'configure') {
        if (message.target !== 'opencode' && message.target !== 'hermes') throw new Error('Choose OpenCode or Hermes.');
        await helper.configure(message.target);
        respond({ ok: true });
      } else {
        const info = await helper.start();
        respond(message.type === 'credentials' ? { ok: true, baseURL: info.baseURL, apiKey: info.apiKey } : { ok: true });
      }
    })().catch(error => respond({ error: error.message }));
    return true;
  }
  if (message.type === 'disconnect') {
    for (const [id, session] of Object.entries(sessions)) {
      if (message.provider !== undefined && message.provider !== id) continue;
      session.socket?.close();
      void cancel(session);
    }
    respond({ ok: true });
    return false;
  }
  if (message.type === 'pair' && (message.token === undefined || typeof message.token === 'string') && typeof message.tabId === 'number') {
    void (async () => {
      const port = message.managed === true ? (await helper.start()).port : message.port;
      await pair(port, message.token ?? '', message.tabId);
    })().then(() => respond({ ok: true })).catch(error => respond({ error: error.message }));
    return true;
  }
  return false;
});
