// The owner's inbox: what is recorded, which holds are accepted, and which approvals count.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { createInbox } from '../src/inbox.ts';
import { nep413Hash } from '../src/nep413.ts';
import { approvalText, APPROVAL_RECIPIENT } from '../../agent/src/approval.ts';
import { newKey, fakeFetch } from './helpers.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'rb-inbox-'));
const REVIEW = { sentence: 'invoice-bot asks to send 25 USDC from NEAR to Abu on Base (0x095e…abc5) on Base.', holds: [{ check: 'amount', status: 'warn', why: 'over_cap' }], request_hash: 'ab'.repeat(32), recipient: '0x095e759bAf96B062696FA6A89040C81214a1abc5', message: 'x' };

function hold(id = 'h_' + randomBytes(9).toString('base64url')) {
  const nonce = randomBytes(32);
  const h = { id, owner: 'olumi15.near', agent: 'invoice-bot', review: REVIEW };
  return { body: { ...h, nonce: nonce.toString('base64'), message: approvalText(h), recipient: APPROVAL_RECIPIENT }, nonce, message: approvalText(h) };
}
const sign = (key: ReturnType<typeof newKey>, message: string, nonce: Uint8Array, recipient = APPROVAL_RECIPIENT) =>
  ({ publicKey: key.publicKey, signature: Buffer.from(ed25519.sign(nep413Hash(message, nonce, recipient), key.secret)).toString('base64') });

test('activity is recorded only for requests whose mandate verified', () => {
  const inbox = createInbox(dir());
  const req: any = { kind: 'quote', agent: 'invoice-bot', quote: { quoteRequest: { recipient: '0xabc' } }, signed_mandate: { mandate: { owner: 'olumi15.near', agent: 'invoice-bot', id: 'R1' } } };
  assert.equal(inbox.record(req, { verdict: 'REFUSED', checks: {}, reason: 'mandate_bad_signature', evaluated_at: '', engine_sha256: 'e' }), null);
  assert.ok(inbox.record(req, { verdict: 'CLEARED', checks: { payee: 'ok' }, evaluated_at: '', engine_sha256: 'e', mandate_fingerprint: 'f' }));
  assert.equal(inbox.listActivity('olumi15.near').length, 1);
  assert.equal(inbox.listActivity('someone.near').length, 0);
});

test('a hold is accepted only with the exact approval text, a 32-byte nonce and the approval recipient', () => {
  const inbox = createInbox(dir());
  const h = hold();
  assert.equal(inbox.addHold({ ...h.body, message: h.message + ' ' }).ok, false);
  assert.equal(inbox.addHold({ ...h.body, recipient: 'evil.app' }).ok, false);
  assert.equal(inbox.addHold({ ...h.body, nonce: 'AAAA' }).ok, false);
  assert.equal(inbox.addHold({ ...h.body, id: 'nope' }).ok, false);
  assert.equal(inbox.addHold(h.body).ok, true);
  assert.deepEqual(inbox.addHold(h.body), { ok: false, reason: 'duplicate' });
});

test('an approval counts only as the owner full-access signature over this hold', async () => {
  const inbox = createInbox(dir());
  const owner = newKey(), stranger = newKey(), fc = newKey();
  const f = fakeFetch({ nearKeys: { [owner.publicKey]: 'FullAccess', [fc.publicKey]: 'FunctionCall' } });
  const h = hold(); inbox.addHold(h.body);
  assert.equal((await inbox.approve(h.body.id, sign(owner, h.message + '!', h.nonce), f)).reason, 'bad_signature');
  assert.equal((await inbox.approve(h.body.id, sign(owner, h.message, randomBytes(32)), f)).reason, 'bad_signature');
  assert.equal((await inbox.approve(h.body.id, sign(owner, h.message, h.nonce, 'other.app'), f)).reason, 'bad_signature');
  assert.equal((await inbox.approve(h.body.id, { ...sign(owner, h.message, h.nonce), accountId: 'mallory.near' }, f)).reason, 'signer_is_not_owner');
  assert.match((await inbox.approve(h.body.id, sign(stranger, h.message, h.nonce), f)).reason, /^key_/);
  assert.equal((await inbox.approve(h.body.id, sign(fc, h.message, h.nonce), f)).reason, 'key_function_call');
  assert.equal(inbox.getHold(h.body.id)!.status, 'pending');
  assert.equal((await inbox.approve(h.body.id, sign(owner, h.message, h.nonce), f)).ok, true);
  assert.equal(inbox.getHold(h.body.id)!.status, 'approved');
  assert.equal((await inbox.approve(h.body.id, sign(owner, h.message, h.nonce), f)).reason, 'approved');
  assert.equal(inbox.refuse(h.body.id).reason, 'approved');
});

test('holds expire after ten minutes and can then be neither approved nor refused', async () => {
  let t = Date.parse('2026-11-03T12:00:00Z');
  const inbox = createInbox(dir(), () => t);
  const owner = newKey(), f = fakeFetch({ nearKeys: { [owner.publicKey]: 'FullAccess' } });
  const a = hold(), b = hold(); inbox.addHold(a.body); inbox.addHold(b.body);
  assert.equal(inbox.refuse(a.body.id).ok, true);
  t += 10 * 60_000 + 1;
  assert.equal(inbox.getHold(b.body.id)!.status, 'expired');
  assert.equal((await inbox.approve(b.body.id, sign(owner, b.message, b.nonce), f)).reason, 'expired');
  assert.equal(inbox.listHolds('olumi15.near').map((h) => h.status).sort().join(','), 'expired,refused');
});

test('holds and activity survive a restart', () => {
  const d = dir();
  const one = createInbox(d), h = hold();
  one.addHold(h.body);
  one.record({ kind: 'quote', quote: {}, signed_mandate: { mandate: { owner: 'olumi15.near', agent: 'a', id: 'R1' } } } as any, { verdict: 'HOLD', checks: {}, evaluated_at: '', engine_sha256: 'e', mandate_fingerprint: 'f' });
  const two = createInbox(d);
  assert.equal(two.getHold(h.body.id)!.status, 'pending');
  assert.equal(two.listActivity('olumi15.near').length, 1);
});
