export {};

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const port = element<HTMLInputElement>('port');
const token = element<HTMLInputElement>('token');
const manual = element<HTMLInputElement>('manual');
const notice = element('notice');
const saved = await chrome.storage.session.get('port');
if (saved.port) port.value = String(saved.port);

async function refresh(): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: 'status' });
  element('status').textContent = result.status;
  const ready = result.helper.state === 'ready';
  element('helper-status').textContent = ready ? 'Background helper ready — no terminal needed' : result.helper.error || 'Starting your background helper…';
  element('setup').hidden = ready || result.helper.state === 'starting';
  element('connection').hidden = !ready;
  element('base-url').textContent = result.helper.baseURL ?? '';
  element<HTMLButtonElement>('arm').disabled = !ready && !manual.checked;
}
async function action(message: object): Promise<void> {
  notice.textContent = 'Working…';
  try {
    const result = await chrome.runtime.sendMessage(message);
    notice.textContent = result.error || 'Done.';
    await refresh();
  } catch { notice.textContent = 'Could not connect. Click Check again or reopen the extension.'; }
}
document.querySelector('#pair')!.addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await action({ type: 'pair', managed: !manual.checked, port: Number(port.value), tabId: tab?.id, ...(manual.checked && token.value ? { token: token.value } : {}) });
    token.value = '';
  })().catch(() => { notice.textContent = 'Open a ChatGPT tab, then try arming again.'; });
});
manual.addEventListener('change', () => { void refresh(); });
element('disconnect').addEventListener('click', () => { void action({ type: 'disconnect' }); });
element('check-helper').addEventListener('click', () => { void action({ type: 'start_helper' }); });
element('setup-guide').addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') }); });
for (const target of ['opencode', 'hermes']) element(target).addEventListener('click', () => { void action({ type: 'configure', target }); });
element('copy-key').addEventListener('click', () => {
  void (async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'credentials' });
      if (result.error) throw new Error(result.error);
      await navigator.clipboard.writeText(result.apiKey);
      notice.textContent = 'API key copied. Do not share it.';
    } catch { notice.textContent = 'Could not copy the key. Check the helper connection.'; }
  })();
});
await chrome.runtime.sendMessage({ type: 'start_helper' }).catch(() => {});
await refresh();
setInterval(() => { void refresh().catch(() => {}); }, 1000);
