import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, chmod } from 'node:fs/promises';
import { endianness, homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { createGateway } from './server.js';
import { EXTENSION_ID } from './bridge.js';

export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
const MAX_FRAME = 16_384;
const execute = promisify(execFile);

export function nativeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (!body.length || body.length > MAX_FRAME) throw new Error('Invalid native message size.');
  const header = Buffer.alloc(4);
  if (endianness() === 'LE') header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export class NativeDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: unknown[] = [];
    while (this.buffered.length >= 4) {
      const size = endianness() === 'LE' ? this.buffered.readUInt32LE() : this.buffered.readUInt32BE();
      if (!size || size > MAX_FRAME) throw new Error('Invalid native message size.');
      if (this.buffered.length < size + 4) break;
      messages.push(JSON.parse(this.buffered.subarray(4, size + 4).toString('utf8')));
      this.buffered = this.buffered.subarray(size + 4);
    }
    return messages;
  }

  finish(): void {
    if (this.buffered.length) throw new Error('Incomplete native message.');
  }
}

interface NativeOptions { origin: string; home?: string; port?: number }
class NativeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export async function runNativeHost(input: Readable, output: Writable, options: NativeOptions): Promise<void> {
  if (options.origin !== EXTENSION_ORIGIN) throw new Error('Untrusted extension origin.');
  const home = options.home ?? join(homedir(), '.browser-harness');
  const cli = join(import.meta.dirname, existsSync(join(import.meta.dirname, 'cli.mjs')) ? 'cli.mjs' : 'cli.js');
  const controller = new AbortController();
  const environment = { ...process.env, BROWSER_HARNESS_HOME: home, BROWSER_HARNESS_API_KEY: '', BROWSER_HARNESS_PORT: String(options.port || 4318) };
  let gateway: ReturnType<typeof createGateway> | undefined;
  let connection: { port: number; baseURL: string; apiKey: string } | undefined;
  const runCli = async (args: string[]) => (await execute(process.execPath, [cli, ...args], {
    env: environment, windowsHide: true, timeout: 60_000, maxBuffer: 64_000, signal: controller.signal,
  })).stdout.trim();
  const start = async () => {
    if (connection) return connection;
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    let sid: string | undefined;
    if (process.platform === 'win32') {
      const result = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10_000 });
      sid = /S-1-[\d-]+/.exec(result.stdout)?.[0];
      if (!sid) throw new Error('Could not identify current user.');
      await execute('icacls.exe', [home, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true, timeout: 10_000 });
    }
    const apiKey = await runCli(['key']);
    if (sid) await execute('icacls.exe', [join(home, 'api_key'), '/inheritance:r', '/grant:r', `*${sid}:F`], { windowsHide: true, timeout: 10_000 });
    gateway = createGateway({ apiKey, port: options.port ?? 4318 });
    try {
      const port = await gateway.listen();
      environment.BROWSER_HARNESS_PORT = String(port);
      connection = { port, baseURL: `http://127.0.0.1:${port}/v1`, apiKey };
    } catch (error) {
      await gateway.close();
      gateway = undefined;
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new NativeError('port_in_use', 'Stop your old Browser Harness terminal window once, then try again.');
      throw error;
    }
    return connection;
  };
  const handle = async (value: unknown) => {
    const message = value as Record<string, unknown> | null;
    const id = typeof message?.id === 'string' && message.id.length <= 64 ? message.id : '';
    try {
      if (!message || Array.isArray(message) || !id || Object.keys(message).some(key => !['id', 'type', 'target'].includes(key))) throw new NativeError('invalid_request', 'Unsupported helper request.');
      if (message.type !== 'hello' && message.type !== 'configure') throw new NativeError('invalid_request', 'Unsupported helper request.');
      if (message.type === 'hello' && message.target !== undefined) throw new NativeError('invalid_request', 'Unsupported helper request.');
      if (message.type === 'configure' && !['opencode', 'hermes'].includes(message.target as string)) throw new NativeError('invalid_request', 'Choose OpenCode or Hermes.');
      const info = await start();
      if (message.type === 'hello') output.write(nativeFrame({ id, ok: true, ...info }));
      else {
        try { await runCli(['setup', message.target as string]); }
        catch { throw new NativeError('setup_failed', `Could not configure ${message.target === 'hermes' ? 'Hermes' : 'OpenCode'}. Make sure it is installed and its configuration is writable.`); }
        output.write(nativeFrame({ id, ok: true }));
      }
    } catch (error) {
      const safe = error instanceof NativeError ? error : new NativeError('helper_failed', 'The helper could not start. Reinstall it or check for an older gateway already running.');
      if (!controller.signal.aborted) output.write(nativeFrame({ id, ok: false, code: safe.code, error: safe.message }));
    }
  };
  const decoder = new NativeDecoder();
  const stop = () => { controller.abort(); input.destroy(); };
  input.once('end', stop);
  output.once('error', stop);
  let pending = 0;
  let work = Promise.resolve();
  try {
    for await (const data of input) {
      for (const value of decoder.push(Buffer.from(data))) {
        if (++pending > 8) throw new Error('Too many native requests.');
        work = work.then(() => handle(value)).finally(() => { pending--; });
      }
    }
    decoder.finish();
    await work;
  } finally {
    controller.abort();
    input.removeListener('end', stop);
    output.removeListener('error', stop);
    await work.catch(() => {});
    await gateway?.close();
  }
}
