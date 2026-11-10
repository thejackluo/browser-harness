import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { acceptPeer, BrowserBridge, EXTENSION_ID, PROVIDERS, secretEquals, type Provider } from './bridge.js';
import { GatewayError } from './errors.js';
import { MODELS, parseReply, prepareRequest, type AssistantMessage, type ModelId } from './protocol.js';

export interface GatewayOptions {
  apiKey: string;
  /** Optional extra pairing secret; the pinned extension origin is always required. */
  bridgeToken?: string;
  port?: number;
  timeoutMs?: number;
  maxQueue?: number;
  extensionId?: string;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new GatewayError(415, 'invalid_content_type', 'Use application/json.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 512_000) throw new GatewayError(413, 'request_too_large', 'Request exceeds 512KB.');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new GatewayError(400, 'invalid_json', 'Request body must be JSON.'); }
}

function completion(response: ServerResponse, model: ModelId, message: AssistantMessage, stream: boolean): void {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const finish = message.tool_calls ? 'tool_calls' : 'stop';
  if (!stream) {
    json(response, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }] });
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const chunk = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  chunk({ role: 'assistant' }, null);
  if (message.tool_calls) chunk({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }, null);
  else chunk({ content: message.content }, null);
  chunk({}, finish);
  response.end('data: [DONE]\n\n');
}

export function createGateway(options: GatewayOptions) {
  if (options.apiKey.length < 32 || (options.bridgeToken !== undefined && (options.bridgeToken.length < 32 || options.apiKey === options.bridgeToken))) {
    throw new Error('Provide distinct API and bridge keys, each at least 32 characters.');
  }
  if (options.extensionId && !/^[a-p]{32}$/.test(options.extensionId)) throw new Error('Invalid extension ID.');
  const bridges = Object.fromEntries(Object.entries(PROVIDERS).map(([id, label]) => [id, new BrowserBridge(label, options.timeoutMs, options.maxQueue)])) as Record<Provider, BrowserBridge>;
  const providerStatus = (provider: Provider) => ({ browser_connected: bridges[provider].connected, queued_requests: bridges[provider].queuedRequests });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2_000_000, perMessageDeflate: false });
  const server = http.createServer(async (request, response) => {
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      const port = (server.address() as { port: number } | null)?.port;
      if (request.headers.host !== `127.0.0.1:${port}`) throw new GatewayError(403, 'invalid_host', 'Use the loopback address 127.0.0.1.');
      if (request.headers.origin !== undefined) throw new GatewayError(403, 'origin_rejected', 'Browser-origin REST requests are disabled.');
      if (request.url === '/health' && request.method === 'GET') { json(response, 200, { ok: true }); return; }
      if (!secretEquals(request.headers.authorization ?? '', `Bearer ${options.apiKey}`)) throw new GatewayError(401, 'invalid_api_key', 'A valid gateway API key is required.');
      if (request.url === '/v1/models' && request.method === 'GET') {
        json(response, 200, { object: 'list', data: Object.keys(MODELS).map(id => ({ id, object: 'model', owned_by: 'local-browser', created: 0 })) }); return;
      }
      if (request.url === '/v1/status' && request.method === 'GET') {
        const all = Object.values(bridges);
        json(response, 200, {
          browser_connected: all.some(bridge => bridge.connected),
          queued_requests: all.reduce((sum, bridge) => sum + bridge.queuedRequests, 0),
          providers: Object.fromEntries((Object.keys(PROVIDERS) as Provider[]).map(id => [id, providerStatus(id)])),
          models: MODELS, model_selection: 'manual_in_browser', capabilities: { text: true, emulated_tool_calls: true, images: false, voice: false, persistent_sessions: false, buffered_sse: true } }); return;
      }
      if (request.url !== '/v1/chat/completions' || request.method !== 'POST') throw new GatewayError(404, 'not_found', 'Unsupported endpoint.');
      const prepared = prepareRequest(await readBody(request));
      const raw = await bridges[MODELS[prepared.request.model]].run(prepared.prompt, controller.signal);
      const message = parseReply(raw, prepared);
      if (!response.destroyed) completion(response, prepared.request.model, message, prepared.request.stream === true);
    } catch (error) {
      if (response.destroyed) return;
      const safe = error instanceof GatewayError ? error : new GatewayError(500, 'internal_error', 'Gateway failed.');
      json(response, safe.status, { error: { message: safe.message, type: safe.code, code: safe.code } });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on('upgrade', (request, socket, head) => {
    const port = (server.address() as { port: number } | null)?.port;
    const origin = request.headers.origin ?? '';
    const originAllowed = origin === `chrome-extension://${options.extensionId ?? EXTENSION_ID}`;
    if (request.url !== '/bridge' || request.headers.host !== `127.0.0.1:${port}` || !originAllowed) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(request, socket, head, peer => acceptPeer(peer, options.bridgeToken, bridges));
  });
  return {
    server,
    bridges,
    bridge: bridges.chatgpt,
    async listen(): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 4318, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return (server.address() as { port: number }).port;
    },
    async close(): Promise<void> {
      for (const bridge of Object.values(bridges)) bridge.disconnect();
      for (const peer of sockets.clients) peer.terminate();
      sockets.close();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
