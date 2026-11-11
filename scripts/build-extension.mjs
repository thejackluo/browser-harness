import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('build/extension', { recursive: true });
await build({ entryPoints: ['extension/background.ts', 'extension/popup.ts'], bundle: true, format: 'esm', target: 'chrome116', outdir: 'build/extension' });
await build({ entryPoints: ['extension/content.ts'], bundle: true, format: 'iife', target: 'chrome116', outdir: 'build/extension' });
for (const file of ['manifest.json', 'popup.html', 'popup.css', 'setup.html']) await copyFile(`extension/${file}`, `build/extension/${file}`);
