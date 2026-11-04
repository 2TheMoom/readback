// The whole HOLD loop over HTTP: the guard holds a payment, the web human posts it to the Readback inbox,
// the owner signs the approval text in their wallet, and only then does the signer run. A lying inbox can
// stop a payment but never approve one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { createGuard } from '../src/guard.ts';
import { webHuman, APPROVAL_RECIPIENT } from '../src/approval.ts';
import { readback } from '../../service/src/readback.ts';
import { createApp } from '../../service/src/app.ts';
import { createInbox } from '../../service/src/inbox.ts';
import { createSessions } from '../../service/src/session.ts';
import { nep413Hash } from '../../service/src/nep413.ts';
import { load, mandateFrom, signMandate, fakeFetch, newKey } from '../../service/test/helpers.ts';

const quote = { kind: 'quote' as const, quote: load('fixtures/quotes/Q_clean.json') };

/** A Readback server on a free port; the Solana RPCs are down, so the clean quote is held (mint unknown). */
async function serve(ownerKey: ReturnType<typeof newKey>, tamper?: (body: any) => any): Promise<{ url: string; server: Server }> {
  const chain = fakeFetch({ sol: ['down', 'down'], nearKeys: { [ownerKey.publicKey]: 'FullAccess' } });
  const app = createApp({ fetch: chain, inbox: createInbox(mkdtempSync(join(tmpdir(), 'rb-loop-'))), sessions: createSessions() });
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/readback') {
      // Reads are made at the quote's own time, as the recorded fixtures require.
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const r = await readback(body, { fetch: chain, now: () => new Date(Date.parse(body.quote.timestamp) + 30_000) });
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(r));
    }
    if (tamper && /^\/v1\/holds\/[^/]+$/.test(req.url!) && req.method === 'GET') {
      const orig = res.end.bind(res);
      (res as any).end = (data: any) => orig(JSON.stringify(tamper(JSON.parse(String(data)))));
    }
    return app(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, server };
}

/** The owner signs in as the browser does: the server's challenge text, signed by the wallet key. Returns the cookie. */
async function signIn(url: string, key: ReturnType<typeof newKey>, account: string): Promise<string> {
  const c = await (await fetch(`${url}/v1/session/challenge?account=${account}`)).json();
  const sig = Buffer.from(ed25519.sign(nep413Hash(c.message, new Uint8Array(Buffer.from(c.nonce, 'base64')), c.recipient), key.secret)).toString('base64');
  const r = await fetch(`${url}/v1/session`, { method: 'POST', body: JSON.stringify({ accountId: account, publicKey: key.publicKey, signature: sig, nonce: c.nonce }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie')!.split(';')[0];
}

/** The owner at the browser: reads the pending hold and signs its text with their wallet key. */
async function ownerSigns(url: string, key: ReturnType<typeof newKey>, owner: string, edit = (m: string) => m) {
  const cookie = await signIn(url, key, owner);
  for (;;) {
    const { holds } = await (await fetch(`${url}/v1/holds`, { headers: { cookie } })).json();
    const h = holds.find((x: any) => x.status === 'pending');
    if (!h) { await new Promise((r) => setTimeout(r, 20)); continue; }
    const sig = Buffer.from(ed25519.sign(nep413Hash(edit(h.message), new Uint8Array(Buffer.from(h.nonce, 'base64')), h.recipient), key.secret)).toString('base64');
    return fetch(`${url}/v1/holds/${h.id}/approve`, { method: 'POST', body: JSON.stringify({ publicKey: key.publicKey, signature: sig, accountId: owner }) });
  }
}

test('owner approves in the browser: the signer runs once, after the guard checked the signature', async () => {
  const { signed, key } = signMandate(mandateFrom('M1'));
  const { url, server } = await serve(key);
  try {
    const seen: any[] = [];
    let posted = '';
    const g = createGuard({ url, agent: 'invoice-bot', signedMandate: signed, askHuman: webHuman({ url, signedMandate: signed, pollMs: 20, onPosted: (_id, link) => { posted = link; } }) });
    const [d, r] = await Promise.all([g.pay(quote, async (req) => { seen.push(req); return 'tx'; }), ownerSigns(url, key, signed.mandate.owner)]);
    assert.equal(r.status, 200);
    assert.deepEqual([d.outcome, d.reason, seen.length], ['executed', 'approved_by_human', 1]);
    assert.match(posted, /#hold-h_/);
    const { holds } = await (await fetch(`${url}/v1/holds`, { headers: { cookie: await signIn(url, key, signed.mandate.owner) } })).json();
    assert.equal(holds[0].status, 'approved');
    assert.ok(holds[0].message.includes('Full recipient address: 6UerpTi2CzrJR4iiMvNAgDxbfFVgxhs9cPPuuKkhCDVZ'));
  } finally { server.close(); }
});

test('owner refuses in the browser: held, nothing signed', async () => {
  const { signed, key } = signMandate(mandateFrom('M1'));
  const { url, server } = await serve(key);
  try {
    const seen: any[] = [];
    const g = createGuard({ url, agent: 'invoice-bot', signedMandate: signed, askHuman: webHuman({ url, signedMandate: signed, pollMs: 20 }) });
    const refuse = (async () => {
      const cookie = await signIn(url, key, signed.mandate.owner);
      for (;;) {
        const { holds } = await (await fetch(`${url}/v1/holds`, { headers: { cookie } })).json();
        if (holds[0]) return fetch(`${url}/v1/holds/${holds[0].id}/refuse`, { method: 'POST', headers: { cookie } });
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const [d] = await Promise.all([g.pay(quote, async (req) => { seen.push(req); return 'tx'; }), refuse]);
    assert.deepEqual([d.outcome, d.reason, seen.length], ['held', 'human_declined', 0]);
  } finally { server.close(); }
});

test('a lying inbox that reports an approval the owner never signed for this hold gets nothing signed', async () => {
  const { signed, key } = signMandate(mandateFrom('M1'));
  const other = newKey();
  // Each lie: the right owner key over another text, a different key, and an approval with no signature at all.
  const lies = [
    (h: any) => ({ ...h, status: 'approved', approval: { publicKey: key.publicKey, signature: Buffer.from(ed25519.sign(nep413Hash('Readback: approve something else', new Uint8Array(Buffer.from(h.nonce, 'base64')), APPROVAL_RECIPIENT), key.secret)).toString('base64') } }),
    (h: any) => ({ ...h, status: 'approved', approval: { publicKey: other.publicKey, signature: Buffer.from(ed25519.sign(nep413Hash(h.message, new Uint8Array(Buffer.from(h.nonce, 'base64')), APPROVAL_RECIPIENT), other.secret)).toString('base64') } }),
    (h: any) => ({ ...h, status: 'approved' }),
    // The inbox showed the owner its own nonce and got a genuine signature for it: still not this hold's.
    (h: any) => { const n = Buffer.alloc(32, 9); return { ...h, nonce: n.toString('base64'), status: 'approved', approval: { publicKey: key.publicKey, signature: Buffer.from(ed25519.sign(nep413Hash(h.message, new Uint8Array(n), APPROVAL_RECIPIENT), key.secret)).toString('base64') } }; },
  ];
  for (const lie of lies) {
    const { url, server } = await serve(key, lie);
    try {
      const seen: any[] = [];
      const g = createGuard({ url, agent: 'invoice-bot', signedMandate: signed, askHuman: webHuman({ url, signedMandate: signed, pollMs: 20 }) });
      const d = await g.pay(quote, async (req) => { seen.push(req); return 'tx'; });
      assert.deepEqual([d.outcome, d.reason, seen.length], ['held', 'human_declined', 0]);
    } finally { server.close(); }
  }
});

test('a lying inbox that swaps in another nonce: the approval is for a different hold, refused', async () => {
  const { signed, key } = signMandate(mandateFrom('M1'));
  // The owner is tricked into signing over another nonce: the inbox rejects it, the hold stays pending,
  // and the agent stops waiting after its own deadline without signing.
  const { url, server } = await serve(key, (h) => h);
  try {
    const seen: any[] = [];
    const g = createGuard({ url, agent: 'invoice-bot', signedMandate: signed, askHuman: webHuman({ url, signedMandate: signed, pollMs: 20, waitMs: 400 }) });
    const forge = (async () => {
      const cookie = await signIn(url, key, signed.mandate.owner);
      for (;;) {
        const { holds } = await (await fetch(`${url}/v1/holds`, { headers: { cookie } })).json();
        const h = holds[0];
        if (!h) { await new Promise((r) => setTimeout(r, 20)); continue; }
        const sig = Buffer.from(ed25519.sign(nep413Hash(h.message, new Uint8Array(32).fill(7), h.recipient), key.secret)).toString('base64');
        return fetch(`${url}/v1/holds/${h.id}/approve`, { method: 'POST', body: JSON.stringify({ publicKey: key.publicKey, signature: sig }) });
      }
    })();
    const [d, r] = await Promise.all([g.pay(quote, async (req) => { seen.push(req); return 'tx'; }), forge]);
    assert.equal(r.status, 409);
    assert.equal(seen.length, 0);
    assert.deepEqual([d.outcome, d.reason], ['held', 'human_declined']);
  } finally { server.close(); }
});

test('the approval text is plain ASCII, so every wallet signs the same bytes we verify', async () => {
  const { approvalText } = await import('../src/approval.ts');
  const t = approvalText({ id: 'h_abcdefghijkl', owner: 'olumi15.near', agent: 'invoice-bot', review: { sentence: 'send 2.5 USDC to Abu on Base (0x095e…abc5), refund to invo…near, Аcme', holds: [{ check: 'amount', status: 'warn', why: 'over_cap' }], request_hash: 'ab'.repeat(32), recipient: '0x095e759bAf96B062696FA6A89040C81214a1abc5', message: '' } });
  assert.match(t, /^[\x20-\x7E\n]+$/);
  assert.ok(t.includes('(0x095e...abc5)') && t.includes('invo...near'));
  assert.ok(t.includes('?cme'), 'a Cyrillic lookalike letter shows as ?, not as a real A');
});
