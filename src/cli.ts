import { createGateway } from './server.js';

const port = Number(process.env.BROWSER_HARNESS_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port between 1024 and 65535.');
const gateway = createGateway({
  apiKey: process.env.BROWSER_HARNESS_API_KEY ?? '',
  bridgeToken: process.env.BROWSER_HARNESS_BRIDGE_TOKEN ?? '',
  extensionId: process.env.BROWSER_HARNESS_EXTENSION_ID,
  port,
});
await gateway.listen();
console.log(`Browser Harness listening at http://127.0.0.1:${port}/v1 (keys and prompts are never logged).`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void gateway.close(); });
