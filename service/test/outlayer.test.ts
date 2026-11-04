// OutLayer receipts: a real mainnet attestation must verify, and every tampered part of it must not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkAttestation, taskHash, quoteFields, runAttested } from '../src/outlayer.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/outlayer-V01.json', import.meta.url), 'utf8'));
const sent = JSON.stringify(fx.input);
const copy = () => structuredClone(fx.attestation);

test('the real V01 attestation verifies against the bytes sent and received', () => {
  assert.equal(checkAttestation(fx.attestation, sent, fx.output), null);
  assert.ok(quoteFields(fx.attestation.tdx_quote)!.report_data.startsWith(taskHash(fx.attestation)));
});

test('a different input, output or module is caught', () => {
  assert.equal(checkAttestation(fx.attestation, sent.replace('"CLEARED"', '"x"').replace('2026', '2027'), fx.output), 'input_hash_mismatch');
  assert.equal(checkAttestation(fx.attestation, sent, { ...fx.output, v: 'HOLD' }), 'output_hash_mismatch');
  const a = copy(); a.wasm_hash = a.executed_wasm_sha256 = '0'.repeat(64);
  assert.equal(checkAttestation(a, sent, fx.output), 'wrong_module');
  const b = copy(); b.executed_wasm_sha256 = '0'.repeat(64);
  assert.equal(checkAttestation(b, sent, fx.output), 'wrong_module');
  const c = copy(); c.project_id = 'someone.near/readback';
  assert.equal(checkAttestation(c, sent, fx.output), 'wrong_project');
});

test('a record edited after the quote was signed is caught', () => {
  for (const edit of [(a: any) => { a.timestamp += 1; }, (a: any) => { a.caller_account_id = 'attacker.near'; }, (a: any) => { a.task_id += 1; }, (a: any) => { a.attached_usd = '5'; }]) {
    const a = copy(); edit(a);
    assert.equal(checkAttestation(a, sent, fx.output), 'quote_not_bound_to_task');
  }
  const m = copy(); m.worker_measurement = 'ab'.repeat(48);
  assert.equal(checkAttestation(m, sent, fx.output), 'measurement_mismatch');
});

test('a quote from another call, or not a TDX quote, is caught', () => {
  const q = Buffer.from(fx.attestation.tdx_quote, 'base64');
  q[48 + 520] ^= 1;
  const a = copy(); a.tdx_quote = q.toString('base64');
  assert.equal(checkAttestation(a, sent, fx.output), 'quote_not_bound_to_task');
  const b = copy(); b.tdx_quote = Buffer.alloc(700).toString('base64');
  assert.equal(checkAttestation(b, sent, fx.output), 'bad_quote');
});

const fakeOutlayer = (attestation: () => Response) => (async (url: any) =>
  String(url).includes('/call/')
    ? new Response(JSON.stringify({ call_id: fx.call_id, status: 'completed', output: fx.output }))
    : attestation()) as typeof fetch;

test('runAttested returns the receipt, and fails closed on every missing piece', async () => {
  const ok = await runAttested(fakeOutlayer(() => new Response(JSON.stringify(fx.attestation))), fx.input, { key: 'k' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.receipt.task_id, fx.attestation.task_id);
  assert.deepEqual(await runAttested(fetch, fx.input, { key: null }), { ok: false, reason: 'no_payment_key' });
  assert.deepEqual(await runAttested(fakeOutlayer(() => new Response('', { status: 404 })), fx.input, { key: 'k', attestationWaitMs: 0 }), { ok: false, reason: 'attestation_unavailable' });
  const other = { ...fx.attestation, call_id: 'another' };
  assert.deepEqual(await runAttested(fakeOutlayer(() => new Response(JSON.stringify(other))), fx.input, { key: 'k' }), { ok: false, reason: 'attestation_for_another_call' });
  const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  assert.deepEqual(await runAttested(down, fx.input, { key: 'k' }), { ok: false, reason: 'call_unreachable' });
});

test('a new check accepts only the current build: a receipt from the earlier module is refused', () => {
  const old = JSON.parse(readFileSync(new URL('../../docs/outlayer/bundles/V01-task-1239345.json', import.meta.url), 'utf8')).attestation;
  assert.equal(old.wasm_hash, '89a21ea9327a39899e44d60de66caa6d9ab2845f695ffe5f7489fbdb431e5d69');
  assert.equal(checkAttestation({ ...old, executed_wasm_sha256: old.wasm_hash }, sent, fx.output), 'wrong_module');
});
