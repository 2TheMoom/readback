// Break it and Verify: real attacks replayed through the engine (and a stand-in TEE), and a real attestation
// checked step by step, with every tampered field caught.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo, verifyTask, CASES } from '../src/demo.ts';
import { vector } from '../src/vectors.ts';
import { runEngine } from '../src/engine.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'rb-demo-'));
const RECEIPT = { call_id: 'c', task_id: 7, project_id: 'readback.near/readback', wasm_sha256: 'w', input_hash: 'i', output_hash: 'o', task_hash: 't', worker_measurement: 'm', attestation_url: 'u', verify: 'v' };

test('every attack gets the verdict its vector expects, and only the untouched control clears', async () => {
  const demo = createDemo({ dir: dir() });
  for (const c of CASES) {
    const r = (await demo.run(c.id))!;
    assert.equal(r.verdict, vector(c.vector).expect.verdict, c.id);
    assert.equal(r.verdict === 'CLEARED', c.id === 'genuine', c.id);
    assert.ok((r.sentence as any).text.length > 10, c.id);
  }
  const s = demo.summary();
  assert.equal(s.attempts, CASES.length);
  assert.equal(s.breaks, 0);
  assert.equal(await demo.run('no-such-case'), null);
});

test('with the TEE: the receipt rides along, a disagreement refuses, a failure holds, and results are cached', async () => {
  let calls = 0;
  const agree = createDemo({ dir: dir(), attest: async (input) => { calls++; return { ok: true, output: runEngine(input), receipt: RECEIPT }; } });
  const r = (await agree.run('genuine'))!;
  assert.deepEqual([r.verdict, r.checks.enclave, r.receipt?.task_id], ['CLEARED', 'ok', 7]);
  await agree.run('genuine');
  assert.equal(calls, 1, 'a second run within ten minutes reuses the attested result');

  const lie = createDemo({ dir: dir(), attest: async (input) => ({ ok: true, output: { ...runEngine(input), v: 'CLEARED', c: {} }, receipt: RECEIPT }) });
  const l = (await lie.run('lookalike'))!;
  assert.deepEqual([l.verdict, l.checks.enclave, l.receipt], ['REFUSED', 'bad', undefined]);

  const down = createDemo({ dir: dir(), attest: async () => ({ ok: false, reason: 'attestation_unavailable' }) });
  const d = (await down.run('genuine'))!;
  assert.deepEqual([d.verdict, d.checks.enclave, d.why?.enclave], ['HOLD', 'error', 'attestation_unavailable']);
});

// The real record of vector V01's run in the TEE, from the outlayer-verify evidence bundle.
const bundle = JSON.parse(readFileSync(new URL('../../docs/outlayer/bundles/V01-task-1239345.json', import.meta.url), 'utf8'));
const serve = (record: any) => (async (url: any) => (String(url).endsWith('/attestations/1239345') && record ? new Response(JSON.stringify(record)) : new Response('', { status: 404 }))) as typeof fetch;

test('verify: the real V01 record passes every step, including its exact input and output', async () => {
  const r = await verifyTask(serve(bundle.attestation), 1239345);
  assert.equal(r.vector, 'V01');
  assert.deepEqual(r.steps.map((s) => [s.id, s.ok]), [['record', true], ['project', true], ['module', true], ['binding', true], ['measurement', true], ['input', true], ['output', true]]);
  assert.match(r.verify, /^outlayer-verify job 1239345 --api https:\/\/api\.outlayer\.ai$/);
});

test('verify: an edited record fails the step it touches', async () => {
  const failed = async (edit: (a: any) => void) => {
    const a = structuredClone(bundle.attestation); edit(a);
    return (await verifyTask(serve(a), 1239345)).steps.filter((s) => !s.ok).map((s) => s.id);
  };
  assert.deepEqual(await failed((a) => { a.project_id = 'mallory.near/readback'; }), ['project', 'binding']);
  assert.deepEqual(await failed((a) => { a.wasm_hash = '0'.repeat(64); }), ['module', 'binding']);
  assert.deepEqual(await failed((a) => { a.executed_wasm_sha256 = '0'.repeat(64); }), ['module']);
  assert.deepEqual(await failed((a) => { a.output_hash = '0'.repeat(64); }), ['binding', 'output']);
  assert.deepEqual(await failed((a) => { a.worker_measurement = 'ab'.repeat(48); }), ['measurement']);
  assert.deepEqual((await verifyTask(serve(null), 1239345)).steps.map((s) => [s.id, s.ok]), [['record', false]]);
});

test('all 65 vector inputs rebuild to the exact bytes the TEE attested', async () => {
  const { createHash } = await import('node:crypto');
  const { engineInputBytes } = await import('../src/vectors.ts');
  const att = JSON.parse(readFileSync(new URL('../../docs/outlayer/attested-vectors.json', import.meta.url), 'utf8'));
  const off = att.rows.filter((r: any) => createHash('sha256').update(engineInputBytes(vector(r.id))).digest('hex') !== r.input_hash).map((r: any) => r.id);
  assert.deepEqual(off, []);
  assert.equal(att.rows.length, 65);
});

test('a case shown without recording does not count as an attempt', async () => {
  const demo = createDemo({ dir: dir() });
  await demo.run('lookalike', { record: false });
  assert.equal(demo.summary().attempts, 0);
  await demo.run('lookalike');
  assert.equal(demo.summary().attempts, 1);
});
