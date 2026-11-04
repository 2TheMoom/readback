// Sign-in and who may read what: an owner's queue is readable only after a wallet signature from a full-access
// key on that account, every nonce works once, and a sign-in signature can never approve a payment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { createApp } from '../src/app.ts';
import { createInbox } from '../src/inbox.ts';
import { createSessions, signInText } from '../src/session.ts';
import { nep413Hash } from '../src/nep413.ts';
import { approvalText, APPROVAL_RECIPIENT } from '../../agent/src/approval.ts';
import { newKey, fakeFetch } from './helpers.ts';

const owner = newKey(), stranger = newKey(), fc = newKey();
const chain = fakeFetch({ nearKeys: { [`olumi15.near:${owner.publicKey}`]: 'FullAccess', [`olumi15.near:${fc.publicKey}`]: 'FunctionCall', [`mallory.near:${stranger.publicKey}`]: 'FullAccess' } });
const sign = (k: ReturnType<typeof newKey>, msg: string, nonce: string, rec = APPROVAL_RECIPIENT) => Buffer.from(ed25519.sign(nep413Hash(msg, new Uint8Array(Buffer.from(nonce, 'base64')), rec), k.secret)).toString('base64');

async function serve(opts: { rateLimit?: number } = {}) {
  const inbox = createInbox(mkdtempSync(join(tmpdir(), 'rb-sess-')));
  const server = createServer(createApp({ fetch: chain, inbox, sessions: createSessions(), rateLimit: opts.rateLimit }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const signIn = async (account: string, key: ReturnType<typeof newKey>, edit = (m: string) => m) => {
    const c = await (await fetch(`${url}/v1/session/challenge?account=${account}`)).json();
    return fetch(`${url}/v1/session`, { method: 'POST', body: JSON.stringify({ accountId: account, publicKey: key.publicKey, signature: sign(key, edit(c.message), c.nonce), nonce: c.nonce }) });
  };
  return { url, server, inbox, signIn };
}

test('the queue needs a sign-in, and shows only the signed-in account', async () => {
  const { url, server, inbox, signIn } = await serve();
  try {
    inbox.record({ kind: 'quote', quote: {}, signed_mandate: { mandate: { owner: 'olumi15.near', agent: 'a', id: 'R1' } } } as any, { verdict: 'HOLD', checks: {}, evaluated_at: '', engine_sha256: 'e', mandate_fingerprint: 'f' });
    assert.equal((await fetch(`${url}/v1/activity?owner=olumi15.near`)).status, 401);
    assert.equal((await fetch(`${url}/v1/holds?owner=olumi15.near`)).status, 401);
    const r = await signIn('olumi15.near', owner);
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const c = cookie.split(';')[0];
    assert.equal((await (await fetch(`${url}/v1/activity?owner=someone-else.near`, { headers: { cookie: c } })).json()).activity.length, 1, 'the owner parameter is ignored: it is always the signed-in account');
    assert.deepEqual(await (await fetch(`${url}/v1/session`, { headers: { cookie: c } })).json(), { account: 'olumi15.near' });
    await fetch(`${url}/v1/session/out`, { method: 'POST', headers: { cookie: c } });
    assert.equal((await fetch(`${url}/v1/activity`, { headers: { cookie: c } })).status, 401);
  } finally { server.close(); }
});

test('a sign-in needs the exact text, a fresh nonce and a full-access key on that account', async () => {
  const { url, server, signIn } = await serve();
  try {
    assert.equal((await signIn('olumi15.near', owner, (m) => m + ' ')).status, 401);
    assert.equal((await signIn('olumi15.near', stranger)).status, 401, 'a key from another account');
    assert.equal((await signIn('olumi15.near', fc)).status, 401, 'a function-call key');
    // A nonce works once.
    const c = await (await fetch(`${url}/v1/session/challenge?account=olumi15.near`)).json();
    const body = JSON.stringify({ accountId: 'olumi15.near', publicKey: owner.publicKey, signature: sign(owner, c.message, c.nonce), nonce: c.nonce });
    assert.equal((await fetch(`${url}/v1/session`, { method: 'POST', body })).status, 200);
    assert.equal((await fetch(`${url}/v1/session`, { method: 'POST', body })).status, 401);
    // A nonce the server never issued.
    const n = randomBytes(32).toString('base64');
    assert.equal((await fetch(`${url}/v1/session`, { method: 'POST', body: JSON.stringify({ accountId: 'olumi15.near', publicKey: owner.publicKey, signature: sign(owner, c.message, n), nonce: n }) })).status, 401);
  } finally { server.close(); }
});

test('only the signed-in owner can refuse a hold', async () => {
  const { url, server, inbox, signIn } = await serve();
  try {
    const nonce = randomBytes(32).toString('base64');
    const h = { id: 'h_' + randomBytes(9).toString('base64url'), owner: 'olumi15.near', agent: 'invoice-bot', review: { sentence: 's', holds: [], request_hash: 'ab'.repeat(32), message: '' } as any };
    assert.ok(inbox.addHold({ ...h, nonce, message: approvalText(h), recipient: APPROVAL_RECIPIENT }).ok);
    assert.equal((await fetch(`${url}/v1/holds/${h.id}/refuse`, { method: 'POST' })).status, 403);
    const mallory = (await signIn('mallory.near', stranger)).headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`${url}/v1/holds/${h.id}/refuse`, { method: 'POST', headers: { cookie: mallory } })).status, 403);
    const mine = (await signIn('olumi15.near', owner)).headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`${url}/v1/holds/${h.id}/refuse`, { method: 'POST', headers: { cookie: mine } })).status, 200);
  } finally { server.close(); }
});

test('the sign-in text can never pass as an approval', () => {
  const t = signInText('olumi15.near', 'https://readback.example');
  assert.ok(!t.startsWith('Readback: approve'));
  assert.ok(t.includes('It is not a transaction'));
});

test('costly endpoints are rate limited per client; the agent polling its hold is not', async () => {
  const { url, server } = await serve({ rateLimit: 3 });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${url}/v1/session/challenge?account=olumi15.near`)).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${url}/v1/holds/h_abcdefghijkl`)).status, 404);
  } finally { server.close(); }
});
