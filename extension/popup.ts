export {};

const status = document.querySelector<HTMLElement>('#status')!;
const port = document.querySelector<HTMLInputElement>('#port')!;
const token = document.querySelector<HTMLInputElement>('#token')!;
const saved = await chrome.storage.session.get('port');
if (saved.port) port.value = String(saved.port);

async function refresh(): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: 'status' });
  status.textContent = result.status;
}
document.querySelector('#pair')!.addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.runtime.sendMessage({ type: 'pair', port: Number(port.value), token: token.value, tabId: tab?.id });
    token.value = '';
    if (result.error) status.textContent = result.error;
    else await refresh();
  })().catch(() => { status.textContent = 'Pairing failed. Reload the extension and try again.'; });
});
document.querySelector('#disconnect')!.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'disconnect' }).then(refresh);
});
await refresh();
setInterval(() => { void refresh(); }, 1000);
