// The guard against the real service (in process, recorded fixtures, fake chain RPCs), and against a
// fake guard API for answers a compromised network or a stale cache could produce.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, type Human } from '../src/guard.ts';
import { readback } from '../../service/src/readback.ts';
import { runEngine } from '../../service/src/engine.ts';
import { load, mandateFrom, signMandate, fakeFetch, WALLET, type FakeChain } from '../../service/test/helpers.ts';

const MINT = { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data_len: 82 };
const URL = 'http://guard.test';

/** The real service, answering through fetch. Call i uses chains[i] (the last one repeats). */
function realService(chains: FakeChain[], mandateId: 'M1' | 'M2' = 'M1', attest?: (input: unknown) => Promise<any>) {
  const { signed, key } = signMandate(mandateFrom(mandateId));
  let calls = 0;
  const f = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const chain = chains[Math.min(calls++, chains.length - 1)];
    const now = () => new Date(Date.parse(body.quote.timestamp) + 30_000);
    const r = await readback(body, { fetch: fakeFetch({ ...chain, nearKeys: { [key.publicKey]: 'FullAccess' } }), now, attest });
    return new Response(JSON.stringify(r), { status: 200 });
  }) as typeof fetch;
  return { signed, fetch: f, calls: () => calls };
}

function signer() {
  const seen: any[] = [];
  return { seen, execute: async (req: any) => { seen.push(req); return 'tx-123'; } };
}

const quote = (name = 'Q_clean') => ({ kind: 'quote' as const, quote: load(`fixtures/quotes/${name}.json`) });

test('CLEARED: the signer runs once, with exactly what was checked', async () => {
  const svc = realService([{ sol: [WALLET, WALLET] }]), s = signer();
  const g = createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch });
  const req = quote();
  const d = await g.pay(req, s.execute);
  assert.equal(d.outcome, 'executed', d.note);
  assert.equal(d.result, 'tx-123');
  assert.equal(s.seen.length, 1);
  assert.deepEqual(s.seen[0].quote, req.quote);
  assert.ok(Object.isFrozen(s.seen[0].quote.quoteRequest), 'the signer gets a frozen copy');
  assert.equal(d.request_hash, g.requestHash(req));
});

test('REFUSED: a lookalike payee never reaches the signer', async () => {
  const svc = realService([{ sol: [WALLET, WALLET] }]), s = signer();
  const g = createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch, askHuman: async () => true });
  const d = await g.pay(quote('Q_lookalike'), s.execute);
  assert.equal(d.outcome, 'refused');
  assert.equal(s.seen.length, 0);
  assert.match(d.note, /^Refused by Readback, not sent: .*lookalike/);
  assert.equal(svc.calls(), 1, 'a human is never asked to override REFUSED');
});

test('HOLD without a human configured: held, not sent', async () => {
  const svc = realService([{ sol: ['down', 'down'] }]), s = signer();
  const d = await createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch }).pay(quote(), s.execute);
  assert.deepEqual([d.outcome, d.reason, s.seen.length], ['held', 'no_human', 0]);
});

test('HOLD: the human sees the sentence, the reasons and the request hash; declining stops it', async () => {
  const svc = realService([{ sol: ['down', 'down'] }]), s = signer();
  let shown = '';
  const g = createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch, askHuman: async (r) => { shown = r.message; return false; } });
  const d = await g.pay(quote(), s.execute);
  assert.deepEqual([d.outcome, d.reason, s.seen.length], ['held', 'human_declined', 0]);
  assert.ok(shown.includes('invoice-bot asks to send 250 USDC from NEAR to Acme (6Uer…CDVZ) on Solana'), shown);
  assert.ok(shown.includes('Full recipient address: 6UerpTi2CzrJR4iiMvNAgDxbfFVgxhs9cPPuuKkhCDVZ'));
  assert.match(shown, /Held because: mint \(rpc_unavailable_or_disagree\)/);
  assert.ok(shown.includes(`Request: sha256:${d.request_hash}`));
});

test('HOLD approved: Readback looks again, then the signer runs', async () => {
  const svc = realService([{ sol: ['down', 'down'] }]), s = signer();
  const d = await createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch, askHuman: async () => true }).pay(quote(), s.execute);
  assert.deepEqual([d.outcome, d.reason, s.seen.length, svc.calls()], ['executed', 'approved_by_human', 1, 2]);
});

test('HOLD approved, but the recipient turned out to be a token mint on the second look: refused', async () => {
  const svc = realService([{ sol: ['down', 'down'] }, { sol: [MINT, MINT] }]), s = signer();
  const d = await createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch, askHuman: async () => true }).pay(quote(), s.execute);
  assert.equal(d.outcome, 'refused');
  assert.equal(s.seen.length, 0);
  assert.ok(d.holds.some((h) => h.check === 'mint' && h.why === 'token_mint'));
});

test('only exactly true approves; a throw or a timeout declines', async () => {
  for (const [human, reason] of [
    [async () => 'yes', 'human_declined'], [async () => 1, 'human_declined'], [async () => ({ approve: true }), 'human_declined'],
    [async () => { throw new Error('chat closed'); }, 'human_error'], [() => new Promise(() => {}), 'human_timeout'],
  ] as Array<[Human, string]>) {
    const svc = realService([{ sol: ['down', 'down'] }]), s = signer();
    const d = await createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch, askHuman: human, humanTimeoutMs: 50 }).pay(quote(), s.execute);
    assert.deepEqual([d.outcome, d.reason, s.seen.length], ['held', reason, 0], String(human));
  }
});

test('changing the request while the human is deciding changes nothing that gets signed', async () => {
  const svc = realService([{ sol: ['down', 'down'] }, { sol: [WALLET, WALLET] }]), s = signer();
  const req = quote();
  const original = req.quote.quoteRequest.recipient;
  const g = createGuard({
    url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch,
    askHuman: async () => { req.quote.quoteRequest.recipient = '7Gk2fJ9pLmQ3sXvT8bN4cR6yW1zHdE5aKuPoVi2pR8z'; return true; },
  });
  const d = await g.pay(req, s.execute);
  assert.equal(d.outcome, 'executed');
  assert.equal(s.seen[0].quote.quoteRequest.recipient, original);
  assert.throws(() => { s.seen[0].quote.quoteRequest.recipient = 'x'; }, TypeError);
});

const intentReq = () => ({ kind: 'intent' as const, quote: load('fixtures/quotes/Q_live.json'), intent: load('fixtures/intents/I_live.json') });

test('an intent payment is bound by its hash too, and an approved HOLD signs that intent', async () => {
  const svc = realService([{ sol: [WALLET, WALLET] }]), s = signer();
  const req = intentReq();
  const d = await createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch, askHuman: async () => true }).pay(req, s.execute);
  assert.deepEqual([d.outcome, d.holds.map((h) => h.check)], ['executed', ['fees']], d.note);
  assert.deepEqual(s.seen[0].intent, req.intent);
});

test('a man in the middle shows Readback the genuine intent while the agent signs another: refused', async () => {
  const svc = realService([{ sol: [WALLET, WALLET] }]), s = signer();
  const genuine = intentReq().intent;
  const req = intentReq();
  const msg = JSON.parse(req.intent.intent.payload.message);
  msg.intents[0].receiver_id = 'attacker.near';
  req.intent.intent.payload.message = JSON.stringify(msg);
  const mitm = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    return svc.fetch(url, { ...init, body: JSON.stringify({ ...body, intent: genuine }) });
  }) as typeof fetch;
  const d = await createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: mitm, askHuman: async () => true }).pay(req, s.execute);
  assert.deepEqual([d.outcome, d.reason, s.seen.length], ['refused', 'answer_for_other_request', 0]);
});

test('a signer that throws is reported as failed, not as sent', async () => {
  const svc = realService([{ sol: [WALLET, WALLET] }]);
  const d = await createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch }).pay(quote(), async () => { throw new Error('nonce too low'); });
  assert.deepEqual([d.outcome, d.reason, d.error], ['failed', 'signer_failed', 'nonce too low']);
});

// --- a fake guard API: answers a man in the middle, a stale cache or a buggy server could give ---

function fakeApi(answer: (good: any) => any) {
  const { signed } = signMandate(mandateFrom('M1'));
  const g0 = createGuard({ url: URL, agent: 'invoice-bot', signedMandate: signed });
  const req = quote();
  const good = {
    verdict: 'CLEARED', checks: { quote_sig: 'ok', payee: 'ok' }, sentence: { text: 'invoice-bot asks to send 250 USDC.' },
    request_hash: g0.requestHash(req), mandate_fingerprint: '', engine_sha256: 'e'.repeat(64),
  };
  return { signed, req, fetch: (async () => { const a = answer(good); return a instanceof Response ? a : new Response(JSON.stringify(a)); }) as typeof fetch };
}

test('answers that are not about this request, or do not add up, are refused', async () => {
  const { createHash } = await import('node:crypto');
  const { canonical } = await import('../src/guard.ts');
  const cases: Array<[string, (g: any) => any, object?]> = [
    ['answer_for_other_request', (g) => ({ ...g, request_hash: 'f'.repeat(64) })],
    ['answer_for_other_mandate', (g) => ({ ...g, mandate_fingerprint: 'f'.repeat(64) })],
    ['inconsistent_answer', (g) => ({ ...g, checks: { quote_sig: 'ok', payee: 'bad' } })],
    ['inconsistent_answer', (g) => ({ ...g, checks: {} })],
    ['inconsistent_answer', (g) => ({ ...g, verdict: 'HOLD', checks: { quote_sig: 'ok' } })],
    ['guard_bad_answer', (g) => ({ ...g, verdict: 'APPROVED' })],
    ['guard_bad_answer', (g) => ({ ...g, sentence: undefined })],
    ['guard_bad_answer', () => null],
    ['guard_http_500', () => new Response('boom', { status: 500 })],
    ['guard_unreachable', () => new Response('<html>', { status: 200 })],
    ['guard_unreachable', () => { throw new TypeError('fetch failed'); }],
    ['engine_not_pinned', (g) => g, { engines: ['a'.repeat(64)] }],
  ];
  for (const [reason, answer, extra] of cases) {
    const api = fakeApi((g) => answer({ ...g, mandate_fingerprint: g.mandate_fingerprint || createHash('sha256').update(canonical(api.signed.mandate)).digest('hex') }));
    const s = signer();
    const d = await createGuard({ url: URL, agent: 'invoice-bot', signedMandate: api.signed, fetch: api.fetch, askHuman: async () => true, ...extra }).pay(api.req, s.execute);
    assert.deepEqual([d.outcome, d.reason, s.seen.length], ['refused', reason, 0], reason);
  }
  // control: the well-formed answer does clear, so the cases above fail for the stated reason only
  const api = fakeApi((g) => ({ ...g, mandate_fingerprint: createHash('sha256').update(canonical(api.signed.mandate)).digest('hex') }));
  const s = signer();
  const d = await createGuard({ url: URL, agent: 'invoice-bot', signedMandate: api.signed, fetch: api.fetch, engines: ['e'.repeat(64)] }).pay(api.req, s.execute);
  assert.deepEqual([d.outcome, s.seen.length], ['executed', 1]);
});

test('a HOLD that gains a new reason after approval is refused', async () => {
  const { createHash } = await import('node:crypto');
  const { canonical } = await import('../src/guard.ts');
  let n = 0;
  const api = fakeApi((g) => ({
    ...g, verdict: 'HOLD', mandate_fingerprint: createHash('sha256').update(canonical(api.signed.mandate)).digest('hex'),
    checks: n++ === 0 ? { quote_sig: 'ok', fees: 'warn' } : { quote_sig: 'ok', fees: 'warn', timing: 'warn' },
  }));
  const s = signer();
  const d = await createGuard({ url: URL, agent: 'invoice-bot', signedMandate: api.signed, fetch: api.fetch, askHuman: async () => true }).pay(api.req, s.execute);
  assert.deepEqual([d.outcome, d.reason, s.seen.length], ['refused', 'changed_since_approval', 0]);
});

// --- EVM: Base, with eth_getCode answers recorded from two real Base RPCs ---

const baseCode = (addr: string) => load('fixtures/rpc/base-eth_getCode.json').answers[addr.toLowerCase()];
const baseQuote = (name: string) => { const q = quote(name); return { req: q, code: baseCode(q.quote.quoteRequest.recipient) }; };

test('Base: paying a saved payee with no contract code clears; the signer runs', async () => {
  const { req, code } = baseQuote('Q_base_payee');
  const svc = realService([{ evm: code }], 'M2'), s = signer();
  const d = await createGuard({ url: URL, agent: 'payroll-agent', signedMandate: svc.signed, fetch: svc.fetch }).pay(req, s.execute);
  assert.deepEqual([d.outcome, s.seen.length], ['executed', 1], d.note);
  assert.ok(d.sentence!.includes('to Dana, payroll (0xF412…6128) on Base'), d.sentence);
});

test('Base: an address-poisoning lookalike of the payee is refused', async () => {
  const { req, code } = baseQuote('Q_base_lookalike');
  const svc = realService([{ evm: code }], 'M2'), s = signer();
  const d = await createGuard({ url: URL, agent: 'payroll-agent', signedMandate: svc.signed, fetch: svc.fetch, askHuman: async () => true }).pay(req, s.execute);
  assert.deepEqual([d.outcome, s.seen.length], ['refused', 0]);
  assert.ok(d.holds.some((h) => h.check === 'lookalike' && h.status === 'bad'));
});

test('Base: a saved payee that is a contract is held, and the human gets the full 0x address', async () => {
  const { req, code } = baseQuote('Q_base_weth');
  const svc = realService([{ evm: code }], 'M2'), s = signer();
  let shown = '';
  const d = await createGuard({ url: URL, agent: 'payroll-agent', signedMandate: svc.signed, fetch: svc.fetch, askHuman: async (r) => { shown = r.message; return false; } }).pay(req, s.execute);
  assert.deepEqual([d.outcome, d.reason, s.seen.length], ['held', 'human_declined', 0]);
  assert.ok(d.holds.some((h) => h.check === 'contract'), JSON.stringify(d.holds));
  assert.ok(shown.includes('Full recipient address: 0x4200000000000000000000000000000000000006'));
});

test('Base: two RPCs disagreeing about contract code hold the payment', async () => {
  const { req } = baseQuote('Q_base_payee');
  const svc = realService([{ evm: ['0x', '0x6080604052'] }], 'M2'), s = signer();
  const d = await createGuard({ url: URL, agent: 'payroll-agent', signedMandate: svc.signed, fetch: svc.fetch }).pay(req, s.execute);
  assert.deepEqual([d.outcome, d.reason, s.seen.length], ['held', 'no_human', 0]);
  assert.ok(d.holds.some((h) => h.check === 'contract' && h.status === 'error'));
});

const RECEIPT = { call_id: 'c1', task_id: 1239282, project_id: 'readback.near/readback', wasm_sha256: '89a2', verify: 'outlayer-verify job 1239282 --network mainnet' };
const enclaveAgrees = async (input: unknown) => ({ ok: true, output: runEngine(input), receipt: RECEIPT });

test('requireEnclave: an answer the enclave did not check is refused before the signer', async () => {
  const svc = realService([{ sol: [WALLET, WALLET] }]), s = signer();
  const g = createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch, requireEnclave: true });
  const d = await g.pay(quote(), s.execute);
  assert.equal(d.outcome, 'refused');
  assert.equal(d.reason, 'enclave_not_checked');
  assert.equal(s.seen.length, 0);
});

test('requireEnclave: a CLEARED answer with a receipt runs the signer and hands the receipt back', async () => {
  const svc = realService([{ sol: [WALLET, WALLET] }], 'M1', enclaveAgrees), s = signer();
  const g = createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch, requireEnclave: true });
  const d = await g.pay(quote(), s.execute);
  assert.equal(d.outcome, 'executed', d.note);
  assert.equal(d.receipt?.task_id, RECEIPT.task_id);
  assert.equal(s.seen.length, 1);
});

test('requireEnclave: no receipt from the enclave holds the payment', async () => {
  const svc = realService([{ sol: [WALLET, WALLET] }], 'M1', async () => ({ ok: false, reason: 'attestation_unavailable' })), s = signer();
  const g = createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: svc.fetch, requireEnclave: true });
  const d = await g.pay(quote(), s.execute);
  assert.equal(d.outcome, 'held');
  assert.deepEqual(d.holds, [{ check: 'enclave', status: 'error', why: 'attestation_unavailable' }]);
  assert.equal(s.seen.length, 0);
});

test('requireEnclave: a CLEARED answer whose receipt was stripped on the way is refused', async () => {
  const svc = realService([{ sol: [WALLET, WALLET] }], 'M1', enclaveAgrees), s = signer();
  const strip = (async (u: any, i: any) => { const r: any = await (await svc.fetch(u, i)).json(); delete r.receipt; return new Response(JSON.stringify(r)); }) as typeof fetch;
  const g = createGuard({ url: URL, agent: 'invoice-bot', signedMandate: svc.signed, fetch: strip, requireEnclave: true });
  const d = await g.pay(quote(), s.execute);
  assert.equal(d.outcome, 'refused');
  assert.equal(d.reason, 'no_receipt');
  assert.equal(s.seen.length, 0);
});
