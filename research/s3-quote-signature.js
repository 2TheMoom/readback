// SPIKE 3 (throwaway, pre-hackathon research). Not product code.
// Question: can we verify a 1Click quote signature independently of the SDK, and which fields does it actually protect?
const fs = require('fs');
const { ed25519 } = require('@noble/curves/ed25519');
const { sha256 } = require('@noble/hashes/sha256');
const sdk = require('@defuse-protocol/one-click-sdk-typescript');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58enc(bytes) { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b === 0) s = '1' + s; else break; } return s; }
function b58dec(str) { let n = 0n; for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad b58'); n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } for (const c of str) { if (c === '1') out.unshift(0); else break; } return Uint8Array.from(out); }
// Stable stringify: sorted keys, undefined dropped (matches json-stable-stringify for plain JSON values).
function stable(v) { if (v === null || typeof v !== 'object') return JSON.stringify(v); if (Array.isArray(v)) return '[' + v.map(x => x === undefined ? 'null' : stable(x)).join(',') + ']'; return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'; }

const MANAGER = 'reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';
const REQ_FIELDS = ['dry', 'swapType', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline'];
const REQ_OPT = ['quoteWaitingTimeMs', 'referral', 'virtualChainRecipient', 'virtualChainRefundRecipient', 'customRecipientMsg'];
const Q_DRY = ['amountIn', 'amountInFormatted', 'amountInUsd', 'minAmountIn', 'amountOut', 'amountOutFormatted', 'amountOutUsd', 'minAmountOut'];
const Q_LIVE_OPT = ['depositAddress', 'depositMemo', 'deadline', 'timeWhenInactive', 'timeEstimate', 'refundFee', 'withdrawFee'];

function myVerify(r) {
  const req = {}; for (const k of REQ_FIELDS) req[k] = r.quoteRequest[k]; for (const k of REQ_OPT) req[k] = r.quoteRequest[k] || undefined;
  const q = {}; for (const k of Q_DRY) q[k] = r.quote[k]; if (!r.quoteRequest.dry) for (const k of Q_LIVE_OPT) q[k] = r.quote[k] || undefined;
  const msg = b58enc(sha256(new TextEncoder().encode(stable({ ...req, ...q, timestamp: r.timestamp }))));
  try { return ed25519.verify(b58dec(r.signature.replace('ed25519:', '')), new TextEncoder().encode(msg), b58dec(MANAGER)); } catch { return false; }
}

const live = JSON.parse(fs.readFileSync(__dirname + '/out-quote-dry.json', 'utf8'));
const clone = () => JSON.parse(JSON.stringify(live));
const cases = [
  ['untouched live quote', r => r, true],
  ['recipient swapped', r => { r.quoteRequest.recipient = r.quoteRequest.recipient.slice(0, -1) + 'X'; return r; }, false],
  ['refundTo swapped', r => { r.quoteRequest.refundTo = 'attacker.near'; return r; }, false],
  ['amountOut inflated', r => { r.quote.amountOut = '99999999'; return r; }, false],
  ['minAmountOut lowered', r => { r.quote.minAmountOut = '1'; return r; }, false],
  ['deadline extended', r => { r.quoteRequest.deadline = '2030-01-01T00:00:00.000Z'; return r; }, false],
  ['timestamp changed', r => { r.timestamp = '2026-01-01T00:00:00.000Z'; return r; }, false],
  ['appFees changed (not covered by design)', r => { r.quoteRequest.appFees = [{ recipient: 'attacker.near', fee: 500 }]; return r; }, true],
  ['withdrawFee changed on dry quote (not covered)', r => { r.quote.withdrawFee = '1'; return r; }, true],
  ['signature from other key', r => { r.signature = 'ed25519:' + b58enc(ed25519.sign(new Uint8Array(32), ed25519.utils.randomPrivateKey())); return r; }, false]
];
let pass = 0;
for (const [name, mut, expect] of cases) {
  const r = mut(clone());
  const mine = myVerify(r), theirs = sdk.verifyQuoteSignature(r);
  const ok = mine === expect && theirs === expect;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} mine=${mine} sdk=${theirs} expected=${expect}`);
}
console.log(`\n${pass}/${cases.length} cases agree with expectation, and my verifier matches the SDK on every case.`);
