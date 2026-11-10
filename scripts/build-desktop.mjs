import { build } from 'esbuild';
import { mkdir, cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const folder = 'build/desktop';
await mkdir(folder, { recursive: true });
await build({
  entryPoints: { 'native-host': 'src/native-host.ts', cli: 'src/cli.ts' },
  bundle: true, platform: 'node', format: 'esm', target: 'node22', outdir: folder, outExtension: { '.js': '.mjs' },
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: 'import { createRequire as createBundledRequire } from "node:module"; const require = createBundledRequire(import.meta.url);' },
});
await cp('build/extension', join(folder, 'extension'), { recursive: true });
await cp('scripts/windows/first-run.html', join(folder, 'first-run.html'));
await writeFile(join(folder, 'io.browserharness.host.json'), JSON.stringify({
  name: 'io.browserharness.host', description: 'Browser Harness background API helper',
  path: 'BrowserHarnessHost.exe', type: 'stdio', allowed_origins: ['chrome-extension://dhgboignmjemkhkhknadoeagnoaibloh/'],
}, null, 2));

const dependencies = JSON.parse(await readFile('package.json', 'utf8')).dependencies;
const seen = new Set();
const notices = [];
async function license(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const root = join('node_modules', name);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const file of (await readdir(root)).filter(file => /^licen[cs]e(?:\.|$)/i.test(file))) {
    notices.push(`${name}@${metadata.version}\n${await readFile(join(root, file), 'utf8')}`);
  }
  for (const child of Object.keys(metadata.dependencies ?? {})) await license(child);
}
for (const name of Object.keys(dependencies)) await license(name);
await writeFile(join(folder, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n--------------------\n\n'));
