// Readback server: the guard API, the owner's inbox and the web app (routes in src/app.ts).
//
// Environment:
//   PORT, HOST                       default 8787 on 127.0.0.1
//   READBACK_OUTLAYER=on             also run every check in OutLayer's TEE (src/outlayer.ts); needs a payment key,
//                                    READBACK_OUTLAYER_PAYMENT_KEY or the OutLayer CLI's saved one
//   READBACK_TEE_DAILY               TEE runs per UTC day across the whole server (default 500): the key pays
//                                    for each one, and anyone can sign a mandate of their own
//   READBACK_SITE                    public address, signed into the sign-in text (default: the request's host)
//   READBACK_TRUST_PROXY=1           behind a proxy (Railway): take the client from X-Forwarded-For
//   READBACK_DATA_DIR                where the inbox and the Break it log live (default ~/.readback/data)

import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineSha256 } from './engine.ts';
import { runAttested, paymentKey, OUTLAYER_PROJECT, type Attested } from './outlayer.ts';
import { createInbox } from './inbox.ts';
import { createSessions } from './session.ts';
import { createApp } from './app.ts';
import { createDemo } from './demo.ts';

const PORT = Number(process.env.PORT ?? 8787), HOST = process.env.HOST ?? '127.0.0.1';
const ENCLAVE = process.env.READBACK_OUTLAYER === 'on';
if (ENCLAVE && !paymentKey()) throw new Error('READBACK_OUTLAYER=on but no OutLayer payment key was found (READBACK_OUTLAYER_PAYMENT_KEY, or outlayer keys create)');

/** One daily budget for every TEE run on this server. Past it, checks still run, held for want of a receipt. */
function budgeted(perDay: number) {
  let day = '', used = 0;
  return async (input: unknown): Promise<Attested> => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) { day = today; used = 0; }
    if (used >= perDay) return { ok: false, reason: 'daily_tee_budget' };
    used++;
    return runAttested(fetch, input);
  };
}
const attest = ENCLAVE ? budgeted(Number(process.env.READBACK_TEE_DAILY ?? 500)) : undefined;

const app = createApp({
  fetch, inbox: createInbox(), demo: createDemo({ attest }), attest, enclave: ENCLAVE ? OUTLAYER_PROJECT : null,
  sessions: createSessions(), site: process.env.READBACK_SITE, trustProxy: process.env.READBACK_TRUST_PROXY === '1',
  webDir: process.env.READBACK_WEB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'public'),
  origins: (process.env.READBACK_ORIGINS ?? '').split(',').filter(Boolean),
});
createServer(app).listen(PORT, HOST, () => console.log(`Readback on http://${HOST}:${PORT} (engine sha256 ${engineSha256().slice(0, 16)}..., enclave ${ENCLAVE ? OUTLAYER_PROJECT : 'off'})`));
