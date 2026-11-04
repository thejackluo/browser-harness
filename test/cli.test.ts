import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

interface Fixture { home: string; keys: string; cli: (args: string[], env?: NodeJS.ProcessEnv) => string; run: (args: string[], env?: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string } }

function fixture(body: (f: Fixture) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'browser-harness-cli-'));
  const keys = join(home, '.browser-harness');
  const env = (extra: NodeJS.ProcessEnv) => ({
    ...process.env, HOME: home, USERPROFILE: home, BROWSER_HARNESS_HOME: keys, BROWSER_HARNESS_API_KEY: '', BROWSER_HARNESS_PORT: '4318', ...extra,
  });
  const cli = resolve('dist/src/cli.js');
  try {
    body({
      home, keys,
      cli: (args, extra = {}) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: env(extra) }),
      run: (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: env(extra) }),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('CLI generates a stable key and file-based OpenCode config', () => fixture(({ keys, cli }) => {
  const key = cli(['key']).trim();
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(cli(['key']).trim(), key);
  const config = JSON.parse(cli(['opencode']));
  const provider = config.provider['browser-harness'];
  assert.equal(provider.options.apiKey, `{file:${join(keys, 'api_key')}}`);
  assert.equal(provider.options.baseURL, 'http://127.0.0.1:4318/v1');
  assert.deepEqual(Object.keys(provider.models), ['chatgpt-browser', 'gemini-browser']);
  assert.ok(!JSON.stringify(config).includes(key));
}));

test('CLI reuses and rotates the Windows helper key', () => fixture(({ keys, cli }) => {
  cli(['key']);
  writeFileSync(join(keys, 'keys.json'), JSON.stringify({ api: 'windows-api', bridge: 'legacy-bridge' }));
  assert.equal(cli(['key']).trim(), 'windows-api');
  writeFileSync(join(keys, 'keys.json'), JSON.stringify({ api: 'rotated-api' }));
  cli(['opencode']);
  assert.equal(readFileSync(join(keys, 'api_key'), 'utf8'), 'rotated-api');
}));

test('Hermes snippet quotes keys safely and honors endpoint overrides', () => fixture(({ cli }) => {
  const key = 'test: # "quoted"\nnewline';
  const config = cli(['hermes'], { BROWSER_HARNESS_API_KEY: key, BROWSER_HARNESS_PORT: '4320' });
  assert.ok(config.includes('  provider: custom\n'));
  assert.ok(config.includes('  base_url: http://127.0.0.1:4320/v1\n'));
  assert.equal(JSON.parse(config.split('  api_key: ')[1]!.trim()), key);
}));

test('setup opencode adds its provider and keeps the rest of an existing config', () => fixture(({ home, keys, cli }) => {
  const file = join(home, '.config', 'opencode', 'opencode.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ model: 'anthropic/claude', provider: { other: { name: 'Other' } }, theme: 'dark' }));
  cli(['setup', 'opencode']);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(config.model, 'anthropic/claude');
  assert.equal(config.theme, 'dark');
  assert.equal(config.provider.other.name, 'Other');
  assert.equal(config.provider['browser-harness'].options.apiKey, `{file:${join(keys, 'api_key')}}`);
  const once = readFileSync(file, 'utf8');
  cli(['setup', 'opencode']);
  assert.equal(readFileSync(file, 'utf8'), once);
}));

test('setup opencode references a differing environment key instead of the file', () => fixture(({ home, cli }) => {
  cli(['setup', 'opencode'], { BROWSER_HARNESS_API_KEY: 'env-key-differs' });
  const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(config.provider['browser-harness'].options.apiKey, '{env:BROWSER_HARNESS_API_KEY}');
}));

test('setup opencode creates a fresh config and refuses to edit JSONC or invalid JSON', () => fixture(({ home, run }) => {
  const dir = join(home, '.config', 'opencode');
  assert.equal(run(['setup', 'opencode']).status, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8')).model, 'browser-harness/chatgpt-browser');
  writeFileSync(join(dir, 'opencode.json'), '{ // comment\n}');
  const invalid = run(['setup', 'opencode']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /not plain JSON/);
  assert.equal(readFileSync(join(dir, 'opencode.json'), 'utf8'), '{ // comment\n}');
  rmSync(join(dir, 'opencode.json'));
  writeFileSync(join(dir, 'opencode.jsonc'), '{}');
  assert.match(run(['setup', 'opencode']).stderr, /opencode\.jsonc/);
  assert.match(run(['doctor'], { BROWSER_HARNESS_PORT: '45998', PATH: dirname(process.execPath) }).stdout, /OpenCode uses opencode\.jsonc/);
}));

test('setup hermes writes the custom endpoint through the Hermes CLI', { skip: process.platform === 'win32' }, () => fixture(({ home, cli }) => {
  const bin = join(home, 'bin');
  const log = join(home, 'hermes.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'hermes'), `#!/bin/sh\necho "$@" >> "${log}"\n`);
  chmodSync(join(bin, 'hermes'), 0o755);
  cli(['setup', 'hermes'], { PATH: `${bin}:${process.env.PATH}`, BROWSER_HARNESS_API_KEY: 'k'.repeat(40) });
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    'config set model.provider custom',
    'config set model.default chatgpt-browser',
    'config set model.base_url http://127.0.0.1:4318/v1',
    `config set model.api_key ${'k'.repeat(40)}`,
  ]);
}));

test('setup hermes refuses keys that cmd could interpret', () => fixture(({ run }) => {
  const result = run(['setup', 'hermes'], { BROWSER_HARNESS_API_KEY: `${'k'.repeat(40)}&calc` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsafe/);
}));

test('doctor explains how to start a missing gateway and fails', () => fixture(({ run }) => {
  const result = run(['doctor'], { BROWSER_HARNESS_PORT: '45999', PATH: dirname(process.execPath) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[!!\] No gateway at http:\/\/127\.0\.0\.1:45999\/v1/);
  assert.match(result.stdout, /npm run setup -- opencode/);
  assert.match(result.stdout, /Hermes Agent not found/);
}));
