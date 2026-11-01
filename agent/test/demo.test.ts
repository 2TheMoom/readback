// The demo agent with fakes for 1Click and NEAR RPC, and the real service in process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { nep413Hash, signIntent } from '../demo/intents.ts';
import { loadOrCreateKey } from '../demo/key.ts';
import { selfCheck } from '../demo/near.ts';
import { startAgent, toUnits } from '../demo/agent.ts';
import { verifyNep413 } from '../../service/src/nep413.ts';
import { readback } from '../../service/src/readback.ts';
import { load, mandateFrom, signMandate, fakeFetch, WALLET } from '../../service/test/helpers.ts';

const SPENDER = 'invoice-bot.readback-prework.near';

test('NEP-413 hash matches near-api-js, and a signed intent verifies for intents.near only', () => {
  const seed = base58.decode('3FyRtUUMxiNT1g2ST6mbj7W1CN7KfQBbomawC7YG4A1zwHmw2TRsn1Wc8NaFcBCoJDu3zt3znJDSwKQ31oRaKXH7').slice(0, 32);
  const nonce = new Uint8Array(Buffer.from('KNV0cOpvJ50D5vfF9pqWom8wo2sliQ4W+Wa7uZ3Uk6Y=', 'base64'));
  assert.equal(Buffer.from(ed25519.sign(nep413Hash('Hello NEAR!', nonce, 'example.near', 'http://localhost:3000'), seed)).toString('base64'),
    'zzZQ/GwAjrZVrTIFlvmmQbDQHllfzrr8urVWHaRt5cPfcXaCSZo35c5LDpPpTKivR6BxLyb3lcPM0FfCW5lcBQ==');
  const key = { secret: seed, publicKey: 'ed25519:' + base58.encode(ed25519.getPublicKey(seed)) };
  const payload = load('fixtures/intents/I_live.json').intent.payload;
  const s = signIntent(payload, key);
  assert.equal(s.payload.message, payload.message);
  assert.ok(verifyNep413({ publicKey: s.public_key, signature: s.signature }, payload.message, new Uint8Array(Buffer.from(payload.nonce, 'base64')), 'intents.near'));
  assert.throws(() => signIntent({ ...payload, recipient: 'evil.near' }, key), /refusing to sign for evil.near/);
});

test('amounts are converted without floating point', () => {
  assert.deepEqual(['2.5', '1', '0.000001', '300', '1.0000001', '0', 'abc', '-1', '1e3'].map((a) => toUnits(a, 6)),
    ['2500000', '1000000', '1', '300000000', null, null, null, null, null]);
});

test('the key file is created outside the repository, reloads the same key, and is refused inside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbkey-'));
  const a = loadOrCreateKey(join(dir, 'k.json')), b = loadOrCreateKey(join(dir, 'k.json'));
  assert.deepEqual([a.created, b.created, a.publicKey === b.publicKey], [true, false, true]);
  assert.throws(() => loadOrCreateKey(join(dirname(fileURLToPath(import.meta.url)), 'k.json')), /inside the repository/);
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ public_key: 'ed25519:11111111111111111111111111111111', private_key: JSON.parse(require_(join(dir, 'k.json'))).private_key }));
  assert.throws(() => loadOrCreateKey(join(dir, 'bad.json')), /does not match/);
});
function require_(p: string) { return (globalThis as any).process.getBuiltinModule('node:fs').readFileSync(p, 'utf8'); }

// --- fakes ---

type Perm = 'FullAccess' | 'missing' | { receiver_id: string; method_names?: string[] };
interface World { perm?: Perm; registered?: boolean; disagree?: boolean; intentEdit?: (msg: any) => void; submitted?: any[] }

/** 1Click and NEAR RPC as the agent sees them. */
function agentFetch(w: World): typeof fetch {
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  return (async (url: any, init: any) => {
    const u = String(url), body = init?.body ? JSON.parse(init.body) : {};
    if (u.endsWith('/v0/quote')) return ok(load('fixtures/quotes/Q_live.json'));
    if (u.endsWith('/v0/generate-intent')) {
      const intent = load('fixtures/intents/I_live.json');
      const msg = JSON.parse(intent.intent.payload.message);
      msg.signer_id = body.signerId;
      w.intentEdit?.(msg);
      intent.intent.payload.message = JSON.stringify(msg);
      return ok(intent);
    }
    if (u.endsWith('/v0/submit-intent')) { (w.submitted ??= []).push(body); return ok({ intentHash: 'hash-1', correlationId: 'c' }); }
    if (body.method === 'query') {
      const p = body.params;
      if (w.disagree && u.includes('drpc')) return ok({ jsonrpc: '2.0', id: 1, result: { permission: 'FullAccess' } });
      if (p.request_type === 'view_access_key') {
        const perm = w.perm ?? { receiver_id: 'intents.near', method_names: ['execute_intents'] };
        if (perm === 'missing') return ok({ jsonrpc: '2.0', id: 1, result: { error: 'access key does not exist while viewing' } });
        if (perm === 'FullAccess') return ok({ jsonrpc: '2.0', id: 1, result: { permission: 'FullAccess' } });
        return ok({ jsonrpc: '2.0', id: 1, result: { permission: { FunctionCall: { receiver_id: perm.receiver_id, method_names: perm.method_names ?? [], allowance: '250000000000000000000000' } } } });
      }
      if (p.request_type === 'call_function') {
        const v = p.method_name === 'has_public_key' ? (w.registered ?? true) : '5000000';
        return ok({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(v))] } });
      }
    }
    throw new Error('unexpected fetch ' + u);
  }) as typeof fetch;
}

function world(w: World = {}) {
  const key = { secret: ed25519.utils.randomPrivateKey(), publicKey: '' };
  key.publicKey = 'ed25519:' + base58.encode(ed25519.getPublicKey(key.secret));
  // The recorded quote refunds to the owner account, so the mandate allows that refund address.
  const m = mandateFrom('M3');
  const { signed, key: ownerKey } = signMandate(m);
  const quoteTs = load('fixtures/quotes/Q_live.json').timestamp;
  const svc = fakeFetch({ sol: [WALLET, WALLET], nearKeys: { [`${m.owner}:${ownerKey.publicKey}`]: 'FullAccess', [`${SPENDER}:${ownerKey.publicKey}`]: 'FullAccess' } });
  const readbackFetch = (async (_u: any, init: any) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify(await readback(body, { fetch: svc, now: () => new Date(Date.parse(quoteTs) + 30_000) })));
  }) as typeof fetch;
  return { key, signed, f: agentFetch(w), readbackFetch, w };
}

test('self-check: the agent will not run with a full-access key, a key for another contract, or an unregistered key', async () => {
  const cases: Array<[World, string[]]> = [
    [{}, []],
    [{ perm: 'FullAccess' }, ['agent_key_has_full_access']],
    [{ perm: { receiver_id: 'usdc.near' } }, ['agent_key_scoped_to_usdc.near']],
    [{ perm: 'missing' }, ['agent_key_not_on_account']],
    [{ registered: false }, ['agent_key_not_registered_in_intents']],
    [{ disagree: true }, ['key_permission_unavailable', 'intents_registration_unavailable']],
  ];
  for (const [w, problems] of cases) {
    const c = await selfCheck(agentFetch(w), SPENDER, 'ed25519:x', 'nep141:usdc');
    assert.deepEqual(c.problems, problems, JSON.stringify(w));
  }
});

test('pay: a held payment the owner approves is signed (the checked intent, by the agent key) but not submitted in a dry run', async () => {
  const { key, signed, f, readbackFetch, w } = world();
  const agent = await startAgent({ key, signedMandate: signed as any, readbackUrl: 'http://x', fetch: f, readbackFetch, askHuman: async () => true });
  assert.ok(agent.ok, JSON.stringify(agent.check));
  const d: any = await agent.pay!('6UerpTi2CzrJR4iiMvNAgDxbfFVgxhs9cPPuuKkhCDVZ', '1');
  assert.equal(d.outcome, 'executed', d.note);
  const s = d.result.signed;
  assert.equal(JSON.parse(s.payload.message).signer_id, SPENDER);
  assert.ok(verifyNep413({ publicKey: s.public_key, signature: s.signature }, s.payload.message, new Uint8Array(Buffer.from(s.payload.nonce, 'base64')), 'intents.near'));
  assert.equal(s.public_key, key.publicKey);
  assert.equal(w.submitted, undefined, 'dry run submits nothing');
});

test('pay --live submits only what Readback allowed; a declined HOLD signs nothing', async () => {
  const yes = world();
  const a = await startAgent({ key: yes.key, signedMandate: yes.signed as any, readbackUrl: 'http://x', fetch: yes.f, readbackFetch: yes.readbackFetch, askHuman: async () => true, live: true });
  const d: any = await a.pay!('6UerpTi2CzrJR4iiMvNAgDxbfFVgxhs9cPPuuKkhCDVZ', '1');
  assert.deepEqual([d.outcome, d.result?.intentHash, yes.w.submitted?.length], ['executed', 'hash-1', 1]);
  assert.equal(yes.w.submitted![0].signedData.payload.recipient, 'intents.near');

  const no = world();
  const b = await startAgent({ key: no.key, signedMandate: no.signed as any, readbackUrl: 'http://x', fetch: no.f, readbackFetch: no.readbackFetch, askHuman: async () => false, live: true });
  const e: any = await b.pay!('6UerpTi2CzrJR4iiMvNAgDxbfFVgxhs9cPPuuKkhCDVZ', '1');
  assert.deepEqual([e.outcome, e.reason, no.w.submitted], ['held', 'human_declined', undefined]);
});

test('pay: an intent that pays someone other than the quote is refused and never signed or submitted', async () => {
  const { key, signed, f, readbackFetch, w } = world({ intentEdit: (msg) => { msg.intents[0].receiver_id = 'attacker.near'; } });
  const agent = await startAgent({ key, signedMandate: signed as any, readbackUrl: 'http://x', fetch: f, readbackFetch, askHuman: async () => true, live: true });
  const d: any = await agent.pay!('6UerpTi2CzrJR4iiMvNAgDxbfFVgxhs9cPPuuKkhCDVZ', '1');
  assert.deepEqual([d.outcome, w.submitted], ['refused', undefined]);
  assert.ok(d.holds.some((h: any) => h.check === 'intent_binding' && h.status === 'bad'));
});

test('a full-access agent key stops the agent before it can pay at all', async () => {
  const { key, signed, f, readbackFetch } = world({ perm: 'FullAccess' });
  const agent = await startAgent({ key, signedMandate: signed as any, readbackUrl: 'http://x', fetch: f, readbackFetch });
  assert.equal(agent.ok, false);
  assert.ok(!('pay' in agent));
});
