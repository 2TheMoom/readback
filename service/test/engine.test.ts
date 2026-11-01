// The service runs the WASI engine: every test vector must give its expected verdict through it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEngine } from '../src/engine.ts';
import { load } from './helpers.ts';

function mutate(quote: any, intent: any, muts: any[]) {
  const msg = intent ? JSON.parse(intent.intent.payload.message) : null;
  for (const m of muts ?? []) {
    const isMsg = m.path.startsWith('msg.');
    const parts = (isMsg ? m.path.slice(4) : m.path).split('.');
    let node = isMsg ? msg : quote;
    for (const p of parts.slice(0, -1)) node = node[p];
    const last = parts[parts.length - 1];
    if (m.op === 'set') node[last] = m.value; else node[last].push(m.value);
  }
  if (intent) intent.intent.payload.message = JSON.stringify(msg);
}

test('every test vector gives its expected verdict through the WASI engine', () => {
  const doc = load('vectors.json'), mandates = load('fixtures/mandates.json'), tokens = load('fixtures/tokens.json');
  const code = load('fixtures/rpc/base-eth_getCode.json').answers;
  const failures: string[] = [];
  for (const v of doc.vectors) {
    const rpc = { ...v.rpc };
    if (rpc.evm_code_ref) rpc.evm_code = code[rpc.evm_code_ref.toLowerCase()];
    let input: any;
    if (v.kind === 'destination') input = { kind: 'destination', chain: v.chain, address: v.address, token_contract: v.token_contract, rpc };
    else {
      const quote = load(`fixtures/quotes/${v.quote}.json`), intent = v.intent ? load(`fixtures/intents/${v.intent}.json`) : null;
      mutate(quote, intent, v.mutate);
      input = { kind: v.kind, now: v.now, mandate: mandates[v.mandate], quote, intent, tokens, rpc };
    }
    const out = runEngine(input);
    const nonOk = (s: string) => Object.keys(out.c).filter((k) => out.c[k] === s).sort();
    const want = (k: string) => (Array.isArray(v.expect[k]) ? [...v.expect[k]].sort() : []);
    const same = out.v === v.expect.verdict && JSON.stringify(nonOk('bad')) === JSON.stringify(want('bad'))
      && JSON.stringify(nonOk('warn')) === JSON.stringify(want('warn')) && JSON.stringify(nonOk('error')) === JSON.stringify(want('error'))
      && (out.err ?? null) === (typeof v.expect.error === 'string' ? v.expect.error : null);
    if (!same) failures.push(`${v.id}: got ${out.v} ${JSON.stringify(out.c)} ${out.err ?? ''}`);
  }
  assert.deepEqual(failures, [], `${failures.length} of ${doc.vectors.length} failed`);
});

test('unrunnable input is refused, never cleared', () => {
  assert.equal(runEngine('not an object').v, 'REFUSED');
  assert.equal(runEngine({ kind: 'nope' }).v, 'REFUSED');
});
