import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AssistantMessage, Message } from '../src/protocol.js';

const keyFile = join(process.env.BROWSER_HARNESS_HOME ?? join(homedir(), '.browser-harness'), 'api_key');
const key = process.env.BROWSER_HARNESS_API_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');
if (!key) throw new Error('Start the gateway once or set BROWSER_HARNESS_API_KEY.');
const model = process.argv[2] ?? 'chatgpt-browser';
const port = Number(process.env.BROWSER_HARNESS_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid gateway port.');
const tools = [{ type: 'function', function: { name: 'read_project_readme', description: 'Read this project README. Accepts no arguments.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }];
const messages: Message[] = [{ role: 'user', content: 'Use read_project_readme once, then summarize the current implementation limitations in three bullets.' }];

for (let turn = 0; turn < 4; turn++) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, tool_choice: turn === 0 ? 'required' : 'none' }),
    signal: AbortSignal.timeout(190_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  const assistant = body.choices[0].message as AssistantMessage;
  messages.push(assistant);
  if (!assistant.tool_calls) { console.log(assistant.content); process.exit(0); }
  for (const call of assistant.tool_calls) {
    if (call.function.name !== 'read_project_readme' || call.function.arguments !== '{}') throw new Error('Unexpected tool request.');
    const text = await readFile(resolve(import.meta.dirname, '../../README.md'), 'utf8');
    messages.push({ role: 'tool', tool_call_id: call.id, content: text });
  }
}
throw new Error('Smoke task exceeded its turn budget.');
