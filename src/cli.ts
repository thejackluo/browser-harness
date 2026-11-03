#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from './server.js';
import { MODELS } from './protocol.js';

const home = process.env.BROWSER_HARNESS_HOME ?? join(homedir(), '.browser-harness');
const files = { api: join(home, 'api_key'), bridge: join(home, 'bridge_token') };
const port = Number(process.env.BROWSER_HARNESS_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port between 1024 and 65535.');

function stored(kind: keyof typeof files): string {
  const fromEnv = kind === 'api' ? process.env.BROWSER_HARNESS_API_KEY : process.env.BROWSER_HARNESS_BRIDGE_TOKEN;
  if (fromEnv) return fromEnv;
  if (!existsSync(files[kind])) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(files[kind], randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  chmodSync(files[kind], 0o600);
  return readFileSync(files[kind], 'utf8').trim();
}

function opencodeConfig(): unknown {
  const apiKey = process.env.BROWSER_HARNESS_API_KEY ? '{env:BROWSER_HARNESS_API_KEY}' : `{file:${files.api}}`;
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      'browser-harness': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Browser Harness',
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey },
        models: { 'chatgpt-browser': { name: 'ChatGPT (browser)' }, 'gemini-browser': { name: 'Gemini (browser)' } },
      },
    },
    model: 'browser-harness/chatgpt-browser',
    small_model: 'browser-harness/chatgpt-browser',
  };
}

const command = process.argv[2] ?? 'start';
if (command === 'token') {
  process.stdout.write(`${stored('bridge')}\n`);
} else if (command === 'key') {
  process.stdout.write(`${stored('api')}\n`);
} else if (command === 'opencode') {
  stored('api');
  process.stdout.write(`${JSON.stringify(opencodeConfig(), null, 2)}\n`);
} else if (command === 'start') {
  const gateway = createGateway({ apiKey: stored('api'), bridgeToken: stored('bridge'), extensionId: process.env.BROWSER_HARNESS_EXTENSION_ID, port });
  await gateway.listen();
  console.log([
    `Browser Harness listening at http://127.0.0.1:${port}/v1 (keys and prompts are never logged).`,
    `Models: ${Object.keys(MODELS).join(', ')}`,
    process.env.BROWSER_HARNESS_API_KEY ? 'API key: from BROWSER_HARNESS_API_KEY' : `API key file: ${files.api}  (npm run -s key)`,
    'Pair a tab: open the extension popup there and paste the output of `npm run -s token`.',
    'OpenCode config: `npm run -s opencode`',
  ].join('\n'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void gateway.close(); });
} else {
  console.error('Usage: browser-harness [start | token | key | opencode]');
  process.exit(2);
}
