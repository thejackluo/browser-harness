export {};

let socket: WebSocket | undefined;
let tabId: number | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let status = 'Disconnected';
let busy = false;

async function cancel(): Promise<void> {
  if (tabId !== undefined && busy) await chrome.tabs.sendMessage(tabId, { type: 'cancel' }).catch(() => {});
}

async function pair(port: number, token: string, selectedTab: number): Promise<void> {
  if (socket || busy) throw new Error('Disconnect and wait for the previous request to stop first.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || token.length < 32) throw new Error('Enter the gateway port and bridge token (not API key).');
  const tab = await chrome.tabs.get(selectedTab);
  if (!tab.url || new URL(tab.url).origin !== 'https://chatgpt.com') throw new Error('Open a ChatGPT tab, then click the extension.');
  tabId = selectedTab;
  await chrome.storage.session.set({ port });
  const peer = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  socket = peer;
  status = 'Connecting';
  peer.onopen = () => { peer.send(JSON.stringify({ type: 'hello', protocol: 1, token })); };
  peer.onerror = () => { status = 'Connection failed. Check the gateway and pair again.'; };
  peer.onclose = () => {
    if (socket !== peer) return;
    clearInterval(heartbeat);
    socket = undefined;
    status = 'Disconnected — inspect tab before re-pairing';
    void cancel();
  };
  peer.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { peer.close(); return; }
    if (message.type === 'ready') {
      status = 'Armed — requests create fresh chats in this tab';
      heartbeat = setInterval(() => { if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'ping' })); }, 20_000);
    } else if (message.type === 'cancel') {
      void cancel();
    } else if (message.type === 'run') {
      if (busy || typeof message.id !== 'string' || typeof message.prompt !== 'string' || tabId === undefined) { peer.close(); return; }
      busy = true;
      status = 'Running — do not interact with the armed tab';
      void chrome.tabs.sendMessage(tabId, message)
        .then(result => {
          if (socket === peer && peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify(result ?? { type: 'error', id: message.id, code: 'ui_changed' }));
            status = 'Armed — requests create fresh chats in this tab';
          }
        })
        .catch(() => { if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'error', id: message.id, code: 'tab_not_attached' })); })
        .finally(() => { busy = false; });
    }
  };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  if (message.type === 'status') { respond({ status, connected: socket?.readyState === WebSocket.OPEN, busy }); return false; }
  if (message.type === 'disconnect') { socket?.close(); void cancel(); respond({ ok: true }); return false; }
  if (message.type === 'pair' && typeof message.token === 'string' && typeof message.tabId === 'number') {
    void pair(message.port, message.token, message.tabId).then(() => respond({ ok: true })).catch(error => respond({ error: error.message }));
    return true;
  }
  return false;
});
