import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { terminalHuman } from '../src/human.ts';

const review = { sentence: 's', holds: [], request_hash: 'h', message: 'Readback is holding a payment for you.' };
const ask = (feed: (i: PassThrough) => void) => {
  const input = new PassThrough(), output = new PassThrough();
  let shown = ''; output.on('data', (c) => { shown += c; });
  const p = terminalHuman(input, output)(review);
  feed(input);
  return p.then((v) => ({ v, shown }));
};

test('only the exact word APPROVE approves', async () => {
  assert.equal((await ask((i) => i.write('APPROVE\n'))).v, true);
  assert.equal((await ask((i) => i.write('yes\n'))).v, false);
  assert.equal((await ask((i) => i.write('approve\n'))).v, false);
});

test('closed input (nobody there) declines at once, and the human saw the review first', async () => {
  const r = await ask((i) => i.end());
  assert.equal(r.v, false);
  assert.match(r.shown, /Readback is holding a payment for you\./);
  assert.match(r.shown, /no answer: declined/);
});
