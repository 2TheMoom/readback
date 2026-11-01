// End to end through the service (engine, mandate, RPC facts, sentence) with recorded fixtures and a
// fake network that answers like the real APIs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readback } from '../src/readback.ts';
import { resetTokenCache } from '../src/tokens.ts';
import { load, mandateFrom, signMandate, fakeFetch, WALLET } from './helpers.ts';

const at = (q: any) => () => new Date(Date.parse(q.timestamp) + 30_000);

async function run(quoteName: string, mandateId: 'M1' | 'M2', chain: Parameters<typeof fakeFetch>[0], edit?: (q: any) => void, kind: 'quote' | 'intent' = 'quote', intent?: any) {
  resetTokenCache();
  const quote = load(`fixtures/quotes/${quoteName}.json`);
  edit?.(quote);
  const { signed, key } = signMandate(mandateFrom(mandateId));
  const f = fakeFetch({ ...chain, nearKeys: { [key.publicKey]: 'FullAccess', ...chain.nearKeys } });
  return readback({ kind, agent: 'invoice-bot', quote, intent, signed_mandate: signed }, { fetch: f, now: at(quote) });
}

test('a clean payment is CLEARED and read back as one sentence', async () => {
  const r = await run('Q_clean', 'M1', { sol: [WALLET, WALLET] });
  assert.equal(r.verdict, 'CLEARED', JSON.stringify(r.checks));
  assert.equal(r.sentence!.text, 'invoice-bot asks to send 250 USDC from NEAR to Acme (6Uer…CDVZ) on Solana, with any refund going to read…near.');
  assert.ok(r.sentence!.parts.every((p) => !p.status || p.status === 'ok'));
  assert.match(r.engine_sha256, /^[0-9a-f]{64}$/);
  assert.match(r.mandate_fingerprint!, /^[0-9a-f]{64}$/);
});

test('a lookalike recipient is REFUSED and the address is the marked word', async () => {
  const r = await run('Q_lookalike', 'M1', { sol: [WALLET, WALLET] });
  assert.equal(r.verdict, 'REFUSED');
  const marked = r.sentence!.parts.filter((p) => p.status === 'bad');
  assert.deepEqual(marked.map((p) => p.text), ['6UerpTi2CzrJR4iiMvNAgDxbfFVgxhs9cPPuuKkh6DVZ']);
  assert.ok(marked[0].checks!.includes('lookalike'));
});

test('a recipient edited after 1Click signed is REFUSED (quote signature)', async () => {
  const r = await run('Q_clean', 'M1', { sol: [WALLET, WALLET] }, (q) => { q.quoteRequest.recipient = '7Gk2fJ9pLmQ3sXvT8bN4cR6yW1zHdE5aKuPoVi2pR8z'; });
  assert.equal(r.verdict, 'REFUSED');
  assert.equal(r.checks.quote_sig, 'bad');
});

test('RPC trouble holds the payment instead of clearing it', async () => {
  const down = await run('Q_clean', 'M1', { sol: ['down', 'down'] });
  assert.equal(down.verdict, 'HOLD');
  assert.equal(down.checks.mint, 'error');
  const disagree = await run('Q_clean', 'M1', { sol: [WALLET, null] });
  assert.equal(disagree.verdict, 'HOLD');
});

test('an EVM lookalike on Base is REFUSED with real recorded contract code', async () => {
  const code = load('fixtures/rpc/base-eth_getCode.json').answers;
  const q = load('fixtures/quotes/Q_base_lookalike.json');
  const answers = code[q.quoteRequest.recipient.toLowerCase()];
  const r = await run('Q_base_lookalike', 'M2', { evm: answers });
  assert.equal(r.verdict, 'REFUSED');
  assert.equal(r.checks.lookalike, 'bad');
});

test('a hidden add_public_key in the intent is REFUSED and named in the sentence', async () => {
  const intent = load('fixtures/intents/I_live.json');
  const msg = JSON.parse(intent.intent.payload.message);
  msg.intents.push({ intent: 'add_public_key', public_key: 'ed25519:9Fq2example7Lk3exampleXXXXXXXXXXXXXXXXXXXX' });
  intent.intent.payload.message = JSON.stringify(msg);
  const r = await run('Q_live', 'M1', { sol: [WALLET, WALLET] }, undefined, 'intent', intent);
  assert.equal(r.verdict, 'REFUSED');
  assert.equal(r.checks.intents, 'bad');
  assert.match(r.sentence!.text, /and to add a new key that can sign for your account/);
});

test('without a valid owner mandate nothing is evaluated', async () => {
  resetTokenCache();
  const quote = load('fixtures/quotes/Q_clean.json');
  const { signed } = signMandate(mandateFrom('M1'));
  signed.mandate.cap = '999999999999';
  const r = await readback({ kind: 'quote', quote, signed_mandate: signed }, { fetch: fakeFetch({ sol: [WALLET, WALLET] }), now: at(quote) });
  assert.equal(r.verdict, 'REFUSED');
  assert.equal(r.reason, 'mandate_bad_signature');
});

test('a mandate for a chain Readback does not pay out on is refused, not held forever', async () => {
  resetTokenCache();
  const quote = load('fixtures/quotes/Q_base_payee.json');
  const { signed, key } = signMandate({ ...mandateFrom('M2'), dest_chain: 'op' });
  const r = await readback({ kind: 'quote', quote, signed_mandate: signed }, { fetch: fakeFetch({ nearKeys: { [key.publicKey]: 'FullAccess' } }), now: at(quote) });
  assert.deepEqual([r.verdict, r.reason], ['REFUSED', 'unsupported_chain']);
});

const WALLET_NEAR = { code_hash: '11111111111111111111111111111111' };

test('NEAR payout to a saved payee that exists is CLEARED and names the payee', async () => {
  const r = await run('Q_near_payee', 'M4', { near: [WALLET_NEAR, WALLET_NEAR] });
  assert.equal(r.verdict, 'CLEARED', JSON.stringify(r.checks));
  assert.match(r.sentence!.text, /send 250 USDC from NEAR to Alice \(alice\.near\) on NEAR/);
  assert.deepEqual(r.facts, { near_account: [WALLET_NEAR, WALLET_NEAR] });
});

test('NEAR: a lookalike name, a missing name kept inside intents.near, an off-curve id', async () => {
  const look = await run('Q_near_lookalike', 'M4', { near: [WALLET_NEAR, WALLET_NEAR] });
  assert.deepEqual([look.verdict, look.checks.lookalike], ['REFUSED', 'bad']);
  const missing = await run('Q_near_intents_missing', 'M4', { near: [null, null] });
  assert.deepEqual([missing.verdict, missing.checks.route, missing.checks.curve, missing.why?.curve], ['REFUSED', 'bad', 'bad', 'account_does_not_exist']);
  const off = await run('Q_near_offcurve', 'M4', { near: [null, null] });
  assert.deepEqual([off.verdict, off.checks.curve], ['REFUSED', 'bad']);
});

test('NEAR: an RPC that is down holds the payment', async () => {
  const r = await run('Q_near_payee', 'M4', { near: [WALLET_NEAR, 'down'] });
  assert.deepEqual([r.verdict, r.checks.contract, r.checks.curve], ['HOLD', 'error', 'error']);
});
