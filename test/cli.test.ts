import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

function fixture(run: (home: string, cli: (command: string, env?: NodeJS.ProcessEnv) => string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'browser-harness-cli-'));
  try {
    run(home, (command, env = {}) => execFileSync(process.execPath, [resolve('dist/src/cli.js'), command], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BROWSER_HARNESS_API_KEY: '',
        BROWSER_HARNESS_BRIDGE_TOKEN: '',
        BROWSER_HARNESS_PORT: '4318',
        BROWSER_HARNESS_HOME: home,
        ...env,
      },
    }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('CLI generates stable keys and file-based OpenCode config', () => fixture((home, cli) => {
  const key = cli('key').trim();
  const bridge = cli('token').trim();
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(key, bridge);
  assert.equal(cli('key').trim(), key);
  const config = JSON.parse(cli('opencode'));
  const provider = config.provider['browser-harness'];
  assert.equal(provider.options.apiKey, `{file:${join(home, 'api_key')}}`);
  assert.equal(provider.options.baseURL, 'http://127.0.0.1:4318/v1');
  assert.deepEqual(Object.keys(provider.models), ['chatgpt-browser', 'gemini-browser']);
  assert.ok(!JSON.stringify(config).includes(key));
}));

test('CLI reuses and rotates Windows helper keys', () => fixture((home, cli) => {
  cli('key');
  writeFileSync(join(home, 'keys.json'), JSON.stringify({ api: 'windows-api', bridge: 'windows-bridge' }));
  assert.equal(cli('key').trim(), 'windows-api');
  assert.equal(cli('token').trim(), 'windows-bridge');
  cli('opencode');
  assert.equal(readFileSync(join(home, 'api_key'), 'utf8'), 'windows-api');
  writeFileSync(join(home, 'keys.json'), JSON.stringify({ api: 'rotated-api', bridge: 'rotated-bridge' }));
  cli('opencode');
  assert.equal(readFileSync(join(home, 'api_key'), 'utf8'), 'rotated-api');
}));

test('Hermes config quotes keys safely and honors endpoint overrides', () => fixture((_home, cli) => {
  const key = 'test: # "quoted"\nnewline';
  const config = cli('hermes', { BROWSER_HARNESS_API_KEY: key, BROWSER_HARNESS_PORT: '4320' });
  assert.ok(config.includes('  provider: custom\n'));
  assert.ok(config.includes('  default: chatgpt-browser\n'));
  assert.ok(config.includes('  base_url: http://127.0.0.1:4320/v1\n'));
  assert.equal(JSON.parse(config.split('  api_key: ')[1]!.trim()), key);
}));

test('Hermes config uses legacy Windows keys; env keys take precedence', () => fixture((home, cli) => {
  writeFileSync(join(home, 'keys.json'), JSON.stringify({ api: 'windows-api', bridge: 'windows-bridge' }));
  assert.ok(cli('hermes').includes('  api_key: "windows-api"\n'));
  const config = JSON.parse(cli('opencode', { BROWSER_HARNESS_API_KEY: 'environment-key' }));
  assert.equal(config.provider['browser-harness'].options.apiKey, '{env:BROWSER_HARNESS_API_KEY}');
}));
