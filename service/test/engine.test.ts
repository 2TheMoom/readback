// The service runs the WASI engine: every test vector must give its expected verdict through it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEngine } from '../src/engine.ts';
import { load } from './helpers.ts';
import { engineInput } from '../src/vectors.ts';

test('every test vector gives its expected verdict through the WASI engine', () => {
  const doc = load('vectors.json');
  const failures: string[] = [];
  for (const v of doc.vectors) {
    const input = engineInput(v);
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
