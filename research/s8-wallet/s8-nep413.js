// SPIKE 8 (throwaway, pre-hackathon research). Not product code. Never copied into the hackathon repo.
// Question: can we verify NEP-413 sign-in signatures ourselves, byte-exact with NEAR's reference, and check the key
// is a full-access key on the account?
const crypto = require('crypto');
const { ed25519 } = require('@noble/curves/ed25519');
const { sha256 } = require('@noble/hashes/sha256');
const { base58 } = require('@scure/base');
const { KeyPair, KeyPairSigner } = require('near-api-js');

// --- independent implementation: hand-written borsh, no borsh library ---
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const str = s => { const u = Buffer.from(s, 'utf8'); return Buffer.concat([u32(u.length), u]); };
function nep413Hash({ message, nonce, recipient, callbackUrl }) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  const opt = callbackUrl == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), str(callbackUrl)]);
  return sha256(Buffer.concat([u32(2147484061), str(message), Buffer.from(nonce), str(recipient), opt]));
}
const keyBytes = pk => { const [t, b] = pk.split(':'); if (t !== 'ed25519') throw new Error('only ed25519'); const k = base58.decode(b); if (k.length !== 32) throw new Error('bad key length'); return k; };
function verifyNep413(signed, payload) {
  try {
    const sig = typeof signed.signature === 'string' ? Buffer.from(signed.signature, 'base64') : Buffer.from(signed.signature);
    if (sig.length !== 64) return false;
    return ed25519.verify(sig, nep413Hash(payload), keyBytes(signed.publicKey));
  } catch { return false; }
}
function signNep413(secret, payload) { const seed = base58.decode(secret.split(':')[1]).slice(0, 32); return ed25519.sign(nep413Hash(payload), seed); }

let pass = 0, total = 0; const ok = (name, cond) => { total++; if (cond) pass++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };

(async () => {
  // 1) NEAR's own reference vectors (near-api-js test/unit/signers/key_pair_signer.test.ts)
  // Public test key published in near-api-js's own test suite (test/unit/signers/key_pair_signer.test.ts). Not a secret.
  const SK = 'ed25519:3FyRtUUMxiNT1g2ST6mbj7W1CN7KfQBbomawC7YG4A1zwHmw2TRsn1Wc8NaFcBCoJDu3zt3znJDSwKQ31oRaKXH7';
  const nonce = new Uint8Array(Buffer.from('KNV0cOpvJ50D5vfF9pqWom8wo2sliQ4W+Wa7uZ3Uk6Y=', 'base64'));
  const v1 = { message: 'Hello NEAR!', recipient: 'example.near', nonce, callbackUrl: 'http://localhost:3000' };
  const v2 = { message: 'Hello NEAR!', recipient: 'example.near', nonce };
  ok('reference vector 1 (with callbackUrl): my signature is byte-identical', Buffer.from(signNep413(SK, v1)).toString('base64') === 'zzZQ/GwAjrZVrTIFlvmmQbDQHllfzrr8urVWHaRt5cPfcXaCSZo35c5LDpPpTKivR6BxLyb3lcPM0FfCW5lcBQ==');
  ok('reference vector 2 (no callbackUrl): my signature is byte-identical', Buffer.from(signNep413(SK, v2)).toString('base64') === 'NnJgPU1Ql7ccRTITIoOVsIfElmvH1RV7QAT4a9Vh6ShCOnjIzRwxqX54JzoQ/nK02p7VBMI2vJn48rpImIJwAw==');
  const pub = KeyPair.fromString(SK).getPublicKey().toString();
  ok('my verifier accepts reference vector 1', verifyNep413({ publicKey: pub, signature: 'zzZQ/GwAjrZVrTIFlvmmQbDQHllfzrr8urVWHaRt5cPfcXaCSZo35c5LDpPpTKivR6BxLyb3lcPM0FfCW5lcBQ==' }, v1));

  // 2) differential: near-api-js signs, my verifier checks, and my signer must produce identical bytes
  const pieces = ['a', 'Z', ' ', '"', '\\', '\n', '\u0000', 'é', ' ', '中', '😀', '<script>'];
  let agree = 0; const N = 500;
  for (let i = 0; i < N; i++) {
    const kp = KeyPair.fromRandom('ed25519'); const signer = new KeyPairSigner(kp);
    let msg = ''; for (let k = 0, n = crypto.randomInt(40); k < n; k++) msg += pieces[crypto.randomInt(pieces.length)];
    const p = { message: msg, recipient: 'readback.example', nonce: new Uint8Array(crypto.randomBytes(32)), callbackUrl: crypto.randomInt(2) ? 'https://readback.example/cb' : undefined };
    const theirs = await signer.signNep413Message('alice.near', p);
    const mine = signNep413(kp.toString(), p);
    if (Buffer.from(theirs.signature).equals(Buffer.from(mine)) && verifyNep413({ publicKey: theirs.publicKey.toString(), signature: theirs.signature }, p)) agree++;
  }
  ok(`differential vs near-api-js: ${agree}/${N} identical signatures and verified`, agree === N);

  // 3) tampering must fail
  const kp = KeyPair.fromRandom('ed25519'); const signer = new KeyPairSigner(kp);
  const base = { message: 'Sign in to Readback', recipient: 'readback.example', nonce: new Uint8Array(crypto.randomBytes(32)), callbackUrl: undefined };
  const s = await signer.signNep413Message('alice.near', base); const good = { publicKey: s.publicKey.toString(), signature: s.signature };
  ok('untouched sign-in verifies', verifyNep413(good, base));
  ok('different message rejected', !verifyNep413(good, { ...base, message: 'Sign in to Readback!' }));
  ok('different recipient rejected (phishing site reusing a signature)', !verifyNep413(good, { ...base, recipient: 'readback.evil' }));
  ok('different nonce rejected (replay)', !verifyNep413(good, { ...base, nonce: new Uint8Array(crypto.randomBytes(32)) }));
  ok('callbackUrl added rejected', !verifyNep413(good, { ...base, callbackUrl: 'https://x' }));
  ok('other public key rejected', !verifyNep413({ ...good, publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString() }, base));
  ok('truncated signature rejected', !verifyNep413({ ...good, signature: Buffer.from(s.signature).subarray(0, 63) }, base));
  ok('non-ed25519 key type rejected', !verifyNep413({ ...good, publicKey: 'secp256k1:' + base58.encode(new Uint8Array(33)) }, base));
  let threw = false; try { nep413Hash({ ...base, nonce: new Uint8Array(31) }); } catch { threw = true; }
  ok('31-byte nonce refused', threw);

  // 4) full-access key check against mainnet (read-only RPC). The NEP requires a full-access key; it does not say
  //    the verifier must check it, but without the check a function-call key could sign people in.
  const RPC = 'https://free.rpc.fastnear.com';
  const rpc = async (params) => { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params }) }); return r.json(); };
  const list = await rpc({ request_type: 'view_access_key_list', finality: 'final', account_id: 'relay.aurora' });
  const keys = (list.result && list.result.keys) || [];
  const fa = keys.find(k => k.access_key.permission === 'FullAccess'), fc = keys.find(k => k.access_key.permission !== 'FullAccess');
  console.log(`relay.aurora on mainnet: ${keys.length} keys (${keys.filter(k => k.access_key.permission === 'FullAccess').length} full access)`);
  async function isFullAccess(accountId, publicKey) { const r = await rpc({ request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey }); return !!(r.result && r.result.permission === 'FullAccess'); }
  if (fa) ok('full-access key classified as FullAccess', await isFullAccess('relay.aurora', fa.public_key));
  if (fc) ok('function-call key classified as NOT full access', !(await isFullAccess('relay.aurora', fc.public_key)));
  ok('random key on a real account classified as NOT full access', !(await isFullAccess('relay.aurora', KeyPair.fromRandom('ed25519').getPublicKey().toString())));
  ok('key on a nonexistent account classified as NOT full access', !(await isFullAccess('readback-does-not-exist-' + Date.now() + '.near', fa ? fa.public_key : pub)));

  console.log(`\n${pass}/${total} passed`);
})().catch(e => { console.error('ERR', e); process.exit(1); });
