import { NATIVE_HOST, type NativeConnection } from '../src/native-protocol.js';

interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
export class NativeHelper {
  private peer?: chrome.runtime.Port;
  private pending = new Map<string, Pending>();
  private connection?: NativeConnection;
  private starting?: Promise<NativeConnection>;
  private state: 'starting' | 'ready' | 'missing' | 'error' = 'starting';
  private error = '';

  constructor(private runtime: Pick<typeof chrome.runtime, 'connectNative' | 'lastError'> = chrome.runtime) {}

  summary() { return { state: this.state, error: this.error, baseURL: this.connection?.baseURL }; }

  private async request(type: 'hello' | 'configure', target?: 'opencode' | 'hermes'): Promise<Record<string, unknown>> {
    if (!this.peer) {
      const peer = this.runtime.connectNative(NATIVE_HOST);
      this.peer = peer;
      peer.onMessage.addListener(value => {
        if (!value || typeof value.id !== 'string') return;
        const request = this.pending.get(value.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(value.id);
        if (value.ok === true) request.resolve(value);
        else request.reject(new Error(typeof value.error === 'string' ? value.error.slice(0, 500) : 'Helper request failed.'));
      });
      peer.onDisconnect.addListener(() => {
        if (this.peer !== peer) return;
        const missing = /not found|not registered/i.test(this.runtime.lastError?.message ?? '');
        this.state = missing ? 'missing' : 'error';
        this.error = missing ? 'Install the Windows helper once, then click Check again.' : 'The helper stopped. Click Check again to reconnect.';
        this.peer = undefined;
        this.connection = undefined;
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(this.error)); }
        this.pending.clear();
      });
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The helper did not respond. Reinstall it and try again.')); }, 70_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.peer!.postMessage({ id, type, ...(target ? { target } : {}) }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('The helper is not connected. Click Check again.')); }
    });
  }

  start(): Promise<NativeConnection> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.starting) return this.starting;
    this.state = 'starting';
    this.error = '';
    this.starting = this.request('hello').then(value => {
      const { port, baseURL, apiKey } = value;
      if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535 || baseURL !== `http://127.0.0.1:${port}/v1` || typeof apiKey !== 'string' || apiKey.length < 32 || apiKey.length > 1024) throw new Error('The helper returned invalid connection information. Reinstall it.');
      this.connection = { port: port as number, baseURL: baseURL as string, apiKey };
      this.state = 'ready';
      return this.connection;
    }).catch(error => {
      if (this.state !== 'missing') this.state = 'error';
      this.error = error.message;
      throw error;
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async configure(target: 'opencode' | 'hermes'): Promise<void> {
    await this.start();
    await this.request('configure', target);
  }
}
