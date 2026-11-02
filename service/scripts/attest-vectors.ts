// Runs every test vector through the deployed engine inside OutLayer's TEE and checks each receipt
// (src/outlayer.ts), and that the enclave's output is byte-identical to the native engine's.
//
//   cd engine && RB_DUMP_DIR=<dir> cargo test --test vectors dump_inputs
//   cd service && node scripts/attest-vectors.ts <dir> [V01 V02 ...]
//
// Costs about $0.001 per vector from the payment key. Writes docs/outlayer/attested-vectors.json.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAttested, OUTLAYER_PROJECT, OUTLAYER_WASM_SHA256 } from '../src/outlayer.ts';
import { canonical } from '../src/mandate.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/attest-vectors.ts <dump dir> [vector ids]');
const only = process.argv.slice(3);
const ids = readdirSync(dir).filter((n) => n.endsWith('.in.json')).map((n) => n.slice(0, -'.in.json'.length)).filter((id) => !only.length || only.includes(id)).sort();

const rows: any[] = [];
let failed = 0;
for (const id of ids) {
  const input = JSON.parse(readFileSync(join(dir, `${id}.in.json`), 'utf8'));
  const native = readFileSync(join(dir, `${id}.out.json`), 'utf8');
  const r = await runAttested(fetch, input);
  const same = r.ok && canonical(r.output) === native;
  if (!r.ok || !same) failed++;
  rows.push(r.ok ? { id, verdict: r.output.v, identical_to_native: same, ...r.receipt } : { id, error: r.reason });
  console.log(id.padEnd(5), r.ok ? `${r.output.v.padEnd(8)} ${same ? 'identical' : 'DIFFERS FROM NATIVE'}  task ${r.receipt.task_id}` : `FAILED ${r.reason}`);
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'outlayer', 'attested-vectors.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ recorded: new Date().toISOString(), project: OUTLAYER_PROJECT, wasm_sha256: OUTLAYER_WASM_SHA256, vectors: rows.length, failed, rows }, null, 1) + '\n');
console.log(`\n${rows.length - failed} of ${rows.length} vectors: receipt verified and enclave output identical to native (${out})`);
if (failed) process.exitCode = 1;
