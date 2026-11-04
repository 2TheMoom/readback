// Pins the NEAR wallets the web app offers. Each wallet's executor (code near-connect runs in a sandboxed
// iframe on our page, at the moment the owner approves a payment) is served from web/public/wallets/, so it
// can only change when it is re-pinned and reviewed. Meteor's "latest" executor changed between 2026-11-01 and
// 2026-11-04, which is why nothing here follows a live URL.
//
//   node scripts/pin-wallets.ts            download each executor and refuse any whose sha256 is not in wallets.lock.json
//   node scripts/pin-wallets.ts --update   re-pin from the official list (review what changed before committing)
//
// The executors are third-party code under their own licenses, so only their hashes are committed. Only
// wallets that can sign NEP-413 messages are offered: an approval is a signed message.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json';
/** Meteor, tested end to end, and Intear (web wallet, a 14 KB executor read in full: it talks only to
 * wallet.intear.tech and its logout bridge). MyNearWallet was dropped on 2026-11-04: it is in limited mode, "sending, staking and
 * app approvals have ended", though near-connect still lists it. Each wallet offered is code trusted on the
 * approval page and needs its own live test. */
const OFFER = ['meteor-wallet', 'intear-wallet'];

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = join(HERE, '..', 'public');
const LOCK = join(HERE, '..', 'wallets.lock.json');
const UPDATE = process.argv.includes('--update');
const pinned: any = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : null;
if (!UPDATE && !pinned) throw new Error('no wallets.lock.json: run with --update to pin');
// The official entries are kept in the lock, so a plain run fetches nothing but the executors themselves.
const official: any = UPDATE ? await (await fetch(SOURCE)).json() : pinned.manifest;
mkdirSync(join(PUB, 'wallets'), { recursive: true });

const lock: any[] = [], wallets: any[] = [];
for (const id of UPDATE ? OFFER : pinned.wallets.map((x: any) => x.id)) {
  const w = official.wallets.find((x: any) => x.id === id);
  if (!w) throw new Error(`${id} is no longer in the official list`);
  if (!w.features?.signMessage) throw new Error(`${id} no longer signs messages`);
  const want = UPDATE ? null : pinned.wallets.find((x: any) => x.id === id);
  const r = await fetch(want ? want.source : w.executor);
  if (!r.ok) throw new Error(`${id}: executor ${r.status}`);
  const code = Buffer.from(await r.arrayBuffer());
  const sha256 = createHash('sha256').update(code).digest('hex');
  if (want && sha256 !== want.sha256) throw new Error(`${id}: the executor changed (sha256 ${sha256}, pinned ${want.sha256}). Review it, then run with --update.`);
  writeFileSync(join(PUB, 'wallets', `${id}.js`), code);
  lock.push({ id, source: w.executor, sha256, bytes: code.length });
  // The version is part of near-connect's cache key; tying it to the hash makes a re-pin replace stale code.
  wallets.push({ ...w, executor: `/wallets/${id}.js`, version: `${w.version}+${sha256.slice(0, 12)}` });
  console.log(`${id.padEnd(16)} ${String(code.length).padStart(8)} B  sha256 ${sha256}`);
}

writeFileSync(join(PUB, 'manifest.json'), JSON.stringify({ ...official, wallets }, null, 1) + '\n');
if (UPDATE) {
  const manifest = { ...official, wallets: official.wallets.filter((x: any) => OFFER.includes(x.id)) };
  writeFileSync(LOCK, JSON.stringify({ source: SOURCE, pinned: new Date().toISOString(), wallets: lock, manifest }, null, 1) + '\n');
}
console.log(`\n${wallets.length} wallets ${UPDATE ? 'pinned: review what changed before committing' : 'downloaded, every sha256 matches wallets.lock.json'}.`);
