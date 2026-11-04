#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGateway } from './server.js';
import { MODELS } from './protocol.js';

const home = process.env.BROWSER_HARNESS_HOME ?? join(homedir(), '.browser-harness');
const apiKeyFile = join(home, 'api_key');
const port = Number(process.env.BROWSER_HARNESS_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port between 1024 and 65535.');
const baseURL = `http://127.0.0.1:${port}/v1`;
const extensionFolder = resolve(import.meta.dirname, '../../build/extension');
const opencodeDir = join(homedir(), '.config', 'opencode');
const hermesInstall = 'Install Hermes first: `iex (irm https://hermes-agent.nousresearch.com/install.ps1)` on Windows, `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash` elsewhere.';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The key written by scripts/windows/setup-and-start.ps1 wins, so configs match the gateway it started. */
function legacyApiKey(): string | undefined {
  try {
    const keys = JSON.parse(readFileSync(join(home, 'keys.json'), 'utf8'));
    return typeof keys.api === 'string' && keys.api ? keys.api : undefined;
  } catch { return undefined; }
}

/** The API key file that harness configs reference; created on first use. */
function storedApiKey(): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const legacy = legacyApiKey();
  if (legacy) writeFileSync(apiKeyFile, legacy, { mode: 0o600 });
  else if (!existsSync(apiKeyFile)) writeFileSync(apiKeyFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  chmodSync(apiKeyFile, 0o600);
  return readFileSync(apiKeyFile, 'utf8').trim();
}

function apiKey(): string {
  return process.env.BROWSER_HARNESS_API_KEY || storedApiKey();
}

function opencodeProvider(useFile: boolean) {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'Browser Harness',
    options: { baseURL, apiKey: useFile ? `{file:${apiKeyFile}}` : '{env:BROWSER_HARNESS_API_KEY}' },
    models: { 'chatgpt-browser': { name: 'ChatGPT (browser)' }, 'gemini-browser': { name: 'Gemini (browser)' } },
  };
}

function opencodeConfig(useFile: boolean) {
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: { 'browser-harness': opencodeProvider(useFile) },
    model: 'browser-harness/chatgpt-browser',
    small_model: 'browser-harness/chatgpt-browser',
  };
}

/** Adds or refreshes only the browser-harness provider in the user's global OpenCode config. */
function setupOpencode(): void {
  storedApiKey();
  const file = join(opencodeDir, 'opencode.json');
  if (!existsSync(file) && existsSync(join(opencodeDir, 'opencode.jsonc'))) {
    fail(`OpenCode uses ${join(opencodeDir, 'opencode.jsonc')}; merge in the output of \`npm run -s opencode\` by hand.`);
  }
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { config = JSON.parse(readFileSync(file, 'utf8')); } catch { config = undefined as never; }
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail(`${file} is not plain JSON; merge in the output of \`npm run -s opencode\` by hand.`);
  }
  const ours = opencodeConfig(true);
  const providers = config.provider && typeof config.provider === 'object' ? config.provider : {};
  config = { $schema: ours.$schema, model: ours.model, small_model: ours.small_model, ...config, provider: { ...providers, 'browser-harness': ours.provider['browser-harness'] } };
  mkdirSync(opencodeDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`OpenCode: added the browser-harness provider to ${file}.`);
  console.log('Try: opencode run -m browser-harness/chatgpt-browser "Say hello"');
}

/** Runs the installed Hermes CLI; Windows launchers may be .cmd/.exe shims, so go through cmd there. */
function hermes(args: string[]): string {
  const options = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], timeout: 60_000 };
  return process.platform === 'win32'
    ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `hermes ${args.join(' ')}`], options)
    : execFileSync('hermes', args, options);
}

function setupHermes(): void {
  const settings: [string, string][] = [['model.provider', 'custom'], ['model.default', 'chatgpt-browser'], ['model.base_url', baseURL], ['model.api_key', apiKey()]];
  for (const [key, value] of settings) {
    try { hermes(['config', 'set', key, value]); } catch { fail(`Could not run \`hermes config set ${key}\`. ${hermesInstall}`); }
  }
  console.log('Hermes: now uses Browser Harness (default model chatgpt-browser).');
  console.log('Try: hermes chat   (switch with `/model custom:gemini-browser`)');
}

async function doctor(): Promise<void> {
  let healthy = true;
  const report = (state: 'ok' | 'fix' | 'optional', text: string, fix?: string) => {
    console.log(`${{ ok: '[ok]', fix: '[!!]', optional: '[--]' }[state]} ${text}${state !== 'ok' && fix ? `\n     -> ${fix}` : ''}`);
    if (state === 'fix') healthy = false;
  };
  let providers: Record<string, { browser_connected?: boolean }> | undefined;
  try {
    const response = await fetch(`${baseURL}/status`, { headers: { Authorization: `Bearer ${apiKey()}` }, signal: AbortSignal.timeout(3000) });
    if (response.status === 401) report('fix', 'The gateway is running but rejects this API key.', 'Restart it the same way you started it so both use the same keys.');
    else {
      providers = ((await response.json()) as { providers?: typeof providers }).providers ?? {};
      report('ok', `Gateway running at ${baseURL}`);
    }
  } catch {
    report('fix', `No gateway at ${baseURL}.`, 'Start it: `npm start` here, or double-click the Browser Harness desktop shortcut on Windows.');
  }
  if (providers) {
    const tabs = [['chatgpt', 'ChatGPT', 'https://chatgpt.com'], ['gemini', 'Gemini', 'https://gemini.google.com/app']] as const;
    const armed = tabs.filter(([id]) => providers[id]?.browser_connected === true);
    for (const [id, label, url] of tabs) {
      if (armed.some(([armedId]) => armedId === id)) report('ok', `${label} tab armed`);
      else report(armed.length ? 'optional' : 'fix', `${label} tab not armed.`, `Open ${url}, click the Browser Harness extension, then "Arm this tab". First time: chrome://extensions -> Developer mode -> Load unpacked -> ${extensionFolder}`);
    }
  }
  let opencode: { provider?: Record<string, { options?: { baseURL?: string } }> } | undefined;
  try { opencode = JSON.parse(readFileSync(join(opencodeDir, 'opencode.json'), 'utf8')); } catch { /* Missing or not plain JSON. */ }
  if (opencode?.provider?.['browser-harness']?.options?.baseURL === baseURL) report('ok', 'OpenCode configured (browser-harness/chatgpt-browser, browser-harness/gemini-browser)');
  else if (existsSync(join(opencodeDir, 'opencode.jsonc'))) report('optional', 'OpenCode uses opencode.jsonc, which setup does not edit.', `Merge the output of \`npm run -s opencode\` into ${join(opencodeDir, 'opencode.jsonc')}.`);
  else report('optional', 'OpenCode is not configured for Browser Harness.', '`npm run setup -- opencode`');
  let hermesURL: string | undefined;
  try { hermesURL = hermes(['config', 'get', 'model.base_url']).trim(); } catch { /* Not installed. */ }
  if (hermesURL === undefined) report('optional', 'Hermes Agent not found (optional).', hermesInstall);
  else if (hermesURL === baseURL) report('ok', 'Hermes configured (custom endpoint)');
  else report('optional', 'Hermes is not using Browser Harness.', '`npm run setup -- hermes`');
  process.exitCode = healthy ? 0 : 1;
}

const command = process.argv[2] ?? 'start';
if (command === 'key') {
  process.stdout.write(`${apiKey()}\n`);
} else if (command === 'opencode') {
  storedApiKey();
  process.stdout.write(`${JSON.stringify(opencodeConfig(!process.env.BROWSER_HARNESS_API_KEY), null, 2)}\n`);
} else if (command === 'hermes') {
  process.stdout.write([
    '# Merge into the model: section of your Hermes config.yaml (or run `npm run setup -- hermes`).',
    'model:',
    '  provider: custom',
    '  default: chatgpt-browser',
    `  base_url: ${baseURL}`,
    `  api_key: ${JSON.stringify(apiKey())}`,
    '',
  ].join('\n'));
} else if (command === 'setup') {
  const target = process.argv[3];
  if (target === 'opencode') setupOpencode();
  else if (target === 'hermes') setupHermes();
  else fail('Usage: npm run setup -- opencode | hermes');
} else if (command === 'doctor') {
  await doctor();
} else if (command === 'start') {
  const gateway = createGateway({ apiKey: apiKey(), bridgeToken: process.env.BROWSER_HARNESS_BRIDGE_TOKEN || undefined, extensionId: process.env.BROWSER_HARNESS_EXTENSION_ID, port });
  await gateway.listen();
  console.log([
    `Browser Harness listening at ${baseURL} (keys and prompts are never logged).`,
    `Models: ${Object.keys(MODELS).join(', ')}`,
    process.env.BROWSER_HARNESS_API_KEY ? 'API key: from BROWSER_HARNESS_API_KEY' : `API key file: ${apiKeyFile}  (npm run -s key)`,
    'Arm a tab: open ChatGPT or Gemini, click the Browser Harness extension, then "Arm this tab".',
    'Connect harnesses: `npm run setup -- opencode`, `npm run setup -- hermes`. Check everything: `npm run doctor`.',
  ].join('\n'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void gateway.close(); });
} else {
  fail('Usage: browser-harness [start | key | opencode | hermes | setup <opencode|hermes> | doctor]');
}
