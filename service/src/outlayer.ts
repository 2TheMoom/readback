// Runs the engine a second time inside OutLayer's TEE (Intel TDX) and checks the attestation it returns, so a
// verdict carries a receipt: this exact module turned this exact input into this exact output, in an enclave.
//
// What is checked here, from the record and the quote's own bytes: the module hash is the pinned build, the
// input and output hashes are those of the bytes sent and received, the quote's report_data is the task hash
// over all of those fields (format: github.com/out-layer/outlayer-verify, crates/verify-core/src/preimage.rs),
// and the quote's RTMR3 is the worker measurement the record names. What is NOT checked here: the quote's
// Intel signature chain and whether that measurement is an approved worker build. `outlayer-verify job
// <task_id> --network mainnet` checks both; the receipt carries the task id for it.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonical } from './mandate.ts';
import type { Fetch } from './rpc.ts';
import type { EngineOutput } from './engine.ts';

export const OUTLAYER_API = 'https://api.outlayer.ai';
/** The project and the build it must run: engine/target/wasm32-wasip2/release/readback-check.wasm. */
export const OUTLAYER_PROJECT = process.env.READBACK_OUTLAYER_PROJECT ?? 'readback.near/readback';
export const OUTLAYER_WASM_SHA256 = process.env.READBACK_OUTLAYER_WASM ?? '89a21ea9327a39899e44d60de66caa6d9ab2845f695ffe5f7489fbdb431e5d69';

export interface Receipt {
  call_id: string; task_id: number; project_id: string; wasm_sha256: string;
  input_hash: string; output_hash: string; task_hash: string; worker_measurement: string;
  attestation_url: string; verify: string;
}
export type Attested = { ok: true; output: EngineOutput; receipt: Receipt } | { ok: false; reason: string };

const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * The payment key: READBACK_OUTLAYER_PAYMENT_KEY (a hosting secret), else the one the OutLayer CLI saved
 * (`outlayer keys create`). Read at call time and never logged.
 */
export function paymentKey(): string | null {
  const [owner] = OUTLAYER_PROJECT.split('/');
  const fromEnv = process.env.READBACK_OUTLAYER_PAYMENT_KEY?.trim();
  if (fromEnv) return /^[a-z0-9._-]+:\d+:[A-Za-z0-9_-]+$/.test(fromEnv) && fromEnv.startsWith(`${owner}:`) ? fromEnv : null;
  const nonce = process.env.READBACK_OUTLAYER_NONCE ?? '1';
  try {
    const keys = JSON.parse(readFileSync(join(homedir(), '.outlayer', 'mainnet', 'payment-keys.json'), 'utf8'));
    const k = keys[`mainnet:${owner}:payment-key:${nonce}`];
    return typeof k === 'string' && k.startsWith(`${owner}:${nonce}:`) ? k : null;
  } catch {
    return null;
  }
}

/** The 32 bytes the worker puts at the start of report_data: sha256 over the record's fields, V1 format. */
export function taskHash(a: any): string {
  const h = createHash('sha256');
  const str = (v: unknown) => { if (v !== null && v !== undefined) h.update(Buffer.from(String(v), 'utf8')); };
  const i64 = (v: unknown) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v as number)); h.update(b); };
  str(a.task_type); i64(a.task_id);
  for (const f of ['repo_url', 'commit_hash', 'build_target', 'wasm_hash', 'input_hash']) str(a[f]);
  str(a.output_hash);
  if (a.block_height !== null && a.block_height !== undefined) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(a.block_height)); h.update(b); }
  for (const f of ['caller_account_id', 'project_id', 'secrets_ref']) str(a[f]);
  i64(a.timestamp); str(a.attached_usd);
  return h.digest('hex');
}

/** report_data and RTMR3 from a TDX v4 quote: header 48 bytes, then the TD report body (584 bytes). */
export function quoteFields(b64: string): { report_data: string; rtmr3: string } | null {
  const q = Buffer.from(b64, 'base64');
  if (q.length < 48 + 584 || q.readUInt16LE(0) !== 4 || q.readUInt32LE(4) !== 0x81) return null;
  const body = q.subarray(48, 48 + 584);
  return { report_data: body.subarray(520, 584).toString('hex'), rtmr3: body.subarray(472, 520).toString('hex') };
}

/** Every check on one attestation record against what was sent and received. Returns the first failure. */
export function checkAttestation(a: any, sentInput: string, output: unknown): string | null {
  if (a?.project_id !== OUTLAYER_PROJECT) return 'wrong_project';
  if (a.wasm_hash !== OUTLAYER_WASM_SHA256 || a.executed_wasm_sha256 !== OUTLAYER_WASM_SHA256) return 'wrong_module';
  if (a.input_hash !== sha256(sentInput)) return 'input_hash_mismatch';
  if (a.output_hash !== sha256(canonical(output))) return 'output_hash_mismatch';
  const q = typeof a.tdx_quote === 'string' ? quoteFields(a.tdx_quote) : null;
  if (!q) return 'bad_quote';
  if (!q.report_data.startsWith(taskHash(a)) || !/^0{64}$/.test(q.report_data.slice(64))) return 'quote_not_bound_to_task';
  if (q.rtmr3 !== a.worker_measurement) return 'measurement_mismatch';
  return null;
}

/** Run one engine input in OutLayer and verify the receipt. Never throws; any failure is {ok: false}. */
export async function runAttested(f: Fetch, input: unknown, opts: { key?: string | null; attestationWaitMs?: number } = {}): Promise<Attested> {
  const key = opts.key === undefined ? paymentKey() : opts.key;
  if (!key) return { ok: false, reason: 'no_payment_key' };
  const sent = JSON.stringify(input);
  let res: any;
  try {
    const r = await f(`${OUTLAYER_API}/call/${OUTLAYER_PROJECT}`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Payment-Key': key }, body: `{"input":${sent}}`, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return { ok: false, reason: `call_http_${r.status}` };
    res = await r.json();
  } catch {
    return { ok: false, reason: 'call_unreachable' };
  }
  if (res?.status !== 'completed' || !res.output || typeof res.call_id !== 'string') return { ok: false, reason: `call_${res?.status ?? 'bad_response'}` };

  // The record appears a moment after the call returns.
  const url = `${OUTLAYER_API}/attestations/by-call/${encodeURIComponent(res.call_id)}`;
  let a: any = null;
  for (const end = Date.now() + (opts.attestationWaitMs ?? 20_000); ; await new Promise((r) => setTimeout(r, 1000))) {
    try {
      const r = await f(url, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) { a = await r.json(); break; }
    } catch { /* retry until the deadline */ }
    if (Date.now() > end) return { ok: false, reason: 'attestation_unavailable' };
  }
  if (a.call_id !== res.call_id) return { ok: false, reason: 'attestation_for_another_call' };
  const bad = checkAttestation(a, sent, res.output);
  if (bad) return { ok: false, reason: bad };
  return {
    ok: true, output: res.output as EngineOutput,
    receipt: {
      call_id: res.call_id, task_id: a.task_id, project_id: a.project_id, wasm_sha256: a.wasm_hash,
      input_hash: a.input_hash, output_hash: a.output_hash, task_hash: taskHash(a), worker_measurement: a.worker_measurement,
      attestation_url: url, verify: `outlayer-verify job ${a.task_id} --network mainnet`,
    },
  };
}
