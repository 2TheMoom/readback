// The test vectors (docs/test-vectors) as engine inputs: real signed 1Click quotes and intents, recorded chain
// answers and the edits each attack makes. The tests check every one; the web app replays them (Break it) and
// re-derives their exact bytes to check an attestation (Verify).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from './mandate.ts';
import { buildSentence, type Sentence } from './sentence.ts';
import type { EngineOutput } from './engine.ts';
import type { TokenMap } from './tokens.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'test-vectors');
const load = (rel: string) => JSON.parse(readFileSync(join(DIR, rel), 'utf8'));

let cache: { doc: any; mandates: any; tokens: any; code: any } | null = null;
function fixtures() {
  if (!cache) cache = { doc: load('vectors.json'), mandates: load('fixtures/mandates.json'), tokens: load('fixtures/tokens.json'), code: load('fixtures/rpc/base-eth_getCode.json').answers };
  return cache;
}
export const vectors = (): any[] => fixtures().doc.vectors;
export const vector = (id: string): any => vectors().find((v) => v.id === id) ?? null;

/** Apply a vector's `set` / `push` edits. Paths start at the quote; `msg.` paths edit the intent's message. */
export function mutate(quote: any, intent: any, muts: any[] = []) {
  const msg = intent ? JSON.parse(intent.intent.payload.message) : null;
  for (const m of muts) {
    const isMsg = m.path.startsWith('msg.');
    const parts = (isMsg ? m.path.slice(4) : m.path).split('.');
    let node = isMsg ? msg : quote;
    for (const p of parts.slice(0, -1)) node = node[p];
    const last = parts[parts.length - 1];
    if (m.op === 'set') node[last] = m.value; else node[last].push(m.value);
  }
  // Re-serialised with sorted keys, as serde_json does in the Rust tests, so the bytes match what ran in the TEE.
  if (intent) intent.intent.payload.message = canonical(msg);
}

/** The engine input for one vector, built the same way as engine/tests/vectors.rs. */
export function engineInput(v: any): any {
  const f = fixtures();
  const rpc = v.rpc === undefined ? null : { ...v.rpc };
  if (rpc?.evm_code_ref) rpc.evm_code = f.code[String(rpc.evm_code_ref).toLowerCase()];
  if (v.kind === 'destination') return { kind: 'destination', chain: v.chain, address: v.address, token_contract: v.token_contract ?? null, rpc };
  const quote = load(`fixtures/quotes/${v.quote}.json`), intent = v.intent ? load(`fixtures/intents/${v.intent}.json`) : null;
  mutate(quote, intent, v.mutate);
  return { kind: v.kind, now: v.now, mandate: f.mandates[v.mandate], quote, intent, tokens: f.tokens, rpc };
}

/** The bytes the engine was given when a vector ran in the enclave: sorted keys, compact (as serde_json writes them). */
export const engineInputBytes = (v: any) => canonical(engineInput(v));

/** The sentence a person reads for a vector's request. A bare destination check has no quote, so it gets a short one. */
export function vectorSentence(v: any, input: any, out: EngineOutput): Sentence {
  if (input.kind === 'destination') {
    const st = Object.values(out.c).includes('bad') ? 'bad' : Object.values(out.c).some((s) => s !== 'ok') ? 'warn' : 'ok';
    return { text: `Pay to ${input.address} on ${input.chain}.`, parts: [{ text: 'Pay to ' }, { text: input.address, checks: Object.keys(out.c), status: st as any }, { text: ` on ${input.chain}.` }] };
  }
  const tokens: TokenMap = Object.fromEntries(Object.entries(fixtures().tokens).map(([id, t]: [string, any]) => [id, { assetId: id, ...t }]));
  return buildSentence(input.mandate.agent, input.quote, input.intent, out, tokens, input.mandate.payees);
}
