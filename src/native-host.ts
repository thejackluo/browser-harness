import { runNativeHost } from './native.js';

const port = Number(process.env.BROWSER_HARNESS_PORT ?? 4318);
if (!Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535) process.exitCode = 1;
else void runNativeHost(process.stdin, process.stdout, {
  origin: process.argv[2] ?? '', home: process.env.BROWSER_HARNESS_HOME, port,
}).catch(() => { process.stderr.write('Browser Harness helper stopped safely.\n'); process.exitCode = 1; });
