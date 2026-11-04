import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket } from 'ws';
import { GatewayError } from './errors.js';

export function secretEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Job {
  id: string;
  prompt: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

const uiStages = new Set(['new_chat', 'editor', 'insert', 'send', 'reply']);
export const PROVIDERS = { chatgpt: 'ChatGPT', gemini: 'Gemini' } as const;
export type Provider = keyof typeof PROVIDERS;
export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && Object.hasOwn(PROVIDERS, value);
}
const providerErrors = (label: string): Record<string, string> => ({
  login_required: `Sign into ${label} manually, then pair the tab again.`,
  provider_blocked: `${label} displayed a limit or challenge. Resolve it manually; no retries were made.`,
  provider_error: `${label} replied with an error notice. The tab stays paired; retry the request.`,
  ui_changed: `${label} UI could not be operated safely. Inspect the selected tab.`,
  tab_not_attached: `The extension is not attached to the selected tab. Reload the ${label} tab, then pair again.`,
  browser_busy: 'The selected tab is already running a request.',
  cancelled: 'Browser request was cancelled.',
});

/** Authenticates a new extension socket, then hands it to the bridge for the provider it names. */
export function acceptPeer(socket: WebSocket, token: string, bridges: Record<Provider, BrowserBridge>): void {
  const authTimer = setTimeout(() => socket.close(1008, 'Pairing required'), 5000);
  socket.on('error', () => socket.terminate());
  socket.on('close', () => clearTimeout(authTimer));
  socket.once('message', data => {
    clearTimeout(authTimer);
    let message;
    try { message = JSON.parse(data.toString()); } catch { socket.close(1008, 'Invalid message'); return; }
    const provider = message?.provider ?? 'chatgpt';
    if (!message || typeof message !== 'object' || message.type !== 'hello' || message.protocol !== 1 || !isProvider(provider) ||
      typeof message.token !== 'string' || !secretEquals(message.token, token)) {
      socket.close(1008, 'Pairing rejected'); return;
    }
    bridges[provider].attach(socket);
  });
}

export class BrowserBridge {
  private peer?: WebSocket;
  private active?: Job;
  private queue: Job[] = [];

  constructor(private label = 'ChatGPT', private timeoutMs = 180_000, private maxQueue = 4) {}

  get connected(): boolean { return this.peer?.readyState === WebSocket.OPEN; }
  get queuedRequests(): number { return this.queue.length; }

  attach(socket: WebSocket): void {
    if (this.peer && this.peer.readyState !== WebSocket.CLOSED) { socket.close(1008, `A ${this.label} tab is already paired`); return; }
    this.peer = socket;
    socket.send(JSON.stringify({ type: 'ready', protocol: 1 }));
    this.dispatch();
    socket.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { socket.close(1008, 'Invalid message'); return; }
      if (!message || typeof message !== 'object') { socket.close(1008, 'Invalid message'); return; }
      if (message.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }
      const job = this.active;
      if (this.peer !== socket || !job || message.id !== job.id) return;
      if (message.type === 'result' && typeof message.text === 'string' && message.text.length <= 1_000_000) {
        this.active = undefined;
        job.cleanup();
        job.resolve(message.text);
        this.dispatch();
      } else if (message.type === 'error') {
        const errors = providerErrors(this.label);
        const code = typeof message.code === 'string' && Object.hasOwn(errors, message.code) ? message.code : 'ui_changed';
        const stage = code === 'ui_changed' && uiStages.has(message.stage) ? ` Failed step: ${message.stage}.` : '';
        if (code === 'provider_error') {
          // The reply finished and the adapter saw the provider's own error notice, so the tab is idle and reusable.
          this.active = undefined;
          job.cleanup();
          job.reject(new GatewayError(502, code, errors[code]!));
          this.dispatch();
          return;
        }
        this.disconnect(new GatewayError(502, code, `${errors[code] ?? 'Browser error.'}${stage}`));
      } else {
        this.disconnect(new GatewayError(502, 'invalid_browser_reply', 'Malformed browser response. Pair again.'));
      }
    });
    socket.on('close', () => {
      if (this.peer === socket) this.disconnect(new GatewayError(503, 'browser_disconnected', 'Browser disconnected. Pair again before retrying.'));
    });
  }

  run(prompt: string, signal: AbortSignal): Promise<string> {
    if (!this.connected) return Promise.reject(new GatewayError(503, 'browser_unavailable', `Pair and arm a ${this.label} tab in the extension.`));
    if (signal.aborted) return Promise.reject(new GatewayError(499, 'cancelled', 'Request cancelled.'));
    if (this.queue.length >= this.maxQueue) return Promise.reject(new GatewayError(429, 'queue_full', 'Browser queue is full.'));
    return new Promise((resolve, reject) => {
      const job: Job = { id: randomUUID(), prompt, resolve, reject, cleanup: () => {} };
      const cancel = (error: GatewayError) => {
        if (this.active === job) {
          this.disconnect(error);
        } else {
          this.queue = this.queue.filter(queued => queued !== job);
          job.cleanup();
          reject(error);
        }
      };
      const abort = () => cancel(new GatewayError(499, 'cancelled', 'Request cancelled. Re-pair if generation had started.'));
      const timer = setTimeout(() => cancel(new GatewayError(504, 'browser_timeout', 'Browser deadline exceeded. No automatic retry; inspect the tab before re-pairing.')), this.timeoutMs);
      job.cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      signal.addEventListener('abort', abort, { once: true });
      this.queue.push(job);
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.active || !this.connected) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    this.peer?.send(JSON.stringify({ type: 'run', id: next.id, prompt: next.prompt }));
  }

  disconnect(error = new GatewayError(503, 'gateway_stopped', 'Gateway stopped.')): void {
    const peer = this.peer;
    this.peer = undefined;
    if (peer?.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify({ type: 'cancel' }));
      peer.close(1000, 'Re-pair required');
    }
    const jobs = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = undefined;
    this.queue = [];
    for (const job of jobs) { job.cleanup(); job.reject(error); }
  }
}
