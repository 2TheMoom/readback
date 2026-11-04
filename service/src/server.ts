// Readback server: the guard API, the owner's inbox and the web app (routes in src/app.ts).
// Binds to 127.0.0.1 unless HOST is set: reads are not authenticated yet (see src/inbox.ts).
// READBACK_OUTLAYER=on also runs every request in OutLayer's TEE and adds the enclave check and its receipt
// (src/outlayer.ts); it needs the CLI's saved payment key.

import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineSha256 } from './engine.ts';
import { runAttested, paymentKey, OUTLAYER_PROJECT } from './outlayer.ts';
import { createInbox } from './inbox.ts';
import { createApp } from './app.ts';

const PORT = Number(process.env.PORT ?? 8787), HOST = process.env.HOST ?? '127.0.0.1';
const ENCLAVE = process.env.READBACK_OUTLAYER === 'on';
if (ENCLAVE && !paymentKey()) throw new Error('READBACK_OUTLAYER=on but no OutLayer payment key was found (outlayer keys create)');

const app = createApp({
  fetch, inbox: createInbox(),
  attest: ENCLAVE ? (input: unknown) => runAttested(fetch, input) : undefined, enclave: ENCLAVE ? OUTLAYER_PROJECT : null,
  webDir: process.env.READBACK_WEB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'public'),
  origins: (process.env.READBACK_ORIGINS ?? '').split(',').filter(Boolean),
});
createServer(app).listen(PORT, HOST, () => console.log(`Readback on http://${HOST}:${PORT} (engine sha256 ${engineSha256().slice(0, 16)}..., enclave ${ENCLAVE ? OUTLAYER_PROJECT : 'off'})`));
