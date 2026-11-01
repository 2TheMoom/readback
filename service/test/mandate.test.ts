import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { verifyNep413, nep413Hash } from '../src/nep413.ts';
import { verifyMandate, mandateMessage } from '../src/mandate.ts';
import { mandateFrom, signMandate, fakeFetch, newKey } from './helpers.ts';

test('NEP-413 matches near-api-js reference signatures', () => {
  // Public test key and expected signatures from near-api-js test/unit/signers/key_pair_signer.test.ts
  const seed = base58.decode('3FyRtUUMxiNT1g2ST6mbj7W1CN7KfQBbomawC7YG4A1zwHmw2TRsn1Wc8NaFcBCoJDu3zt3znJDSwKQ31oRaKXH7').slice(0, 32);
  const publicKey = 'ed25519:' + base58.encode(ed25519.getPublicKey(seed));
  const nonce = new Uint8Array(Buffer.from('KNV0cOpvJ50D5vfF9pqWom8wo2sliQ4W+Wa7uZ3Uk6Y=', 'base64'));
  const withCb = 'zzZQ/GwAjrZVrTIFlvmmQbDQHllfzrr8urVWHaRt5cPfcXaCSZo35c5LDpPpTKivR6BxLyb3lcPM0FfCW5lcBQ==';
  const noCb = 'NnJgPU1Ql7ccRTITIoOVsIfElmvH1RV7QAT4a9Vh6ShCOnjIzRwxqX54JzoQ/nK02p7VBMI2vJn48rpImIJwAw==';
  assert.equal(Buffer.from(ed25519.sign(nep413Hash('Hello NEAR!', nonce, 'example.near', 'http://localhost:3000'), seed)).toString('base64'), withCb);
  assert.ok(verifyNep413({ publicKey, signature: noCb }, 'Hello NEAR!', nonce, 'example.near'));
  assert.ok(!verifyNep413({ publicKey, signature: noCb }, 'Hello NEAR?', nonce, 'example.near'));
  assert.ok(!verifyNep413({ publicKey, signature: noCb }, 'Hello NEAR!', nonce, 'evil.near'));
});

test('the signed message is the readable mandate, with full addresses and a fingerprint', () => {
  const m = mandateFrom('M1');
  const text = mandateMessage(m);
  assert.match(text, /^Readback mandate M1 for readback-prework\.near\./);
  assert.ok(text.includes(m.payees[0].address), 'full payee address in the message');
  assert.match(text, /up to 300 USDC per payment, with slippage up to 0\.5%/);
  assert.match(text, /Fingerprint: sha256:[0-9a-f]{64}$/);
});

test('a mandate signed by the owner with a full-access key is accepted', async () => {
  const { signed, key } = signMandate(mandateFrom('M1'));
  assert.deepEqual(await verifyMandate(fakeFetch({ nearKeys: { [key.publicKey]: 'FullAccess' } }), signed), { ok: true, reason: 'ok' });
});

test('mandates are refused when anything is off', async () => {
  const { signed, key } = signMandate(mandateFrom('M1'));
  const f = fakeFetch({ nearKeys: { [key.publicKey]: 'FullAccess' } });
  const tampered = structuredClone(signed); tampered.mandate.cap = '999999999999';
  assert.equal((await verifyMandate(f, tampered)).reason, 'bad_signature', 'raised cap after signing');
  const payee = structuredClone(signed); payee.mandate.payees[0].address = '7Gk2fJ9pLmQ3sXvT8bN4cR6yW1zHdE5aKuPoVi2pR8z';
  assert.equal((await verifyMandate(f, payee)).reason, 'bad_signature', 'swapped payee after signing');
  const other = structuredClone(signed); other.signature.accountId = 'someone-else.near';
  assert.equal((await verifyMandate(f, other)).reason, 'signer_is_not_owner');
  assert.equal((await verifyMandate(fakeFetch({ nearKeys: { [key.publicKey]: 'FunctionCall' } }), signed)).reason, 'key_function_call');
  assert.equal((await verifyMandate(fakeFetch({ nearKeys: {} }), signed)).reason, 'key_not_found');
  const stranger = signMandate(mandateFrom('M1'), newKey());
  assert.equal((await verifyMandate(f, stranger.signed)).reason, 'key_not_found', 'valid signature by a key not on the account');
  assert.equal((await verifyMandate(f, undefined as any)).reason, 'missing');
});
