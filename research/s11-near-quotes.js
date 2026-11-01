// SPIKE 11 (1 Nov 2026). Real signed dry quotes NEAR USDC -> NEAR USDC (no funds, no deposit address) for
// NEAR-destination vectors, plus real view_account answers from two independent NEAR RPCs. Writes the quote
// fixtures Q_near_* and fixtures/rpc/near-view_account.json under docs/test-vectors.
const fs = require('fs'), path = require('path');
const { ed25519 } = require('@noble/curves/ed25519');
const { sha256 } = require('@noble/hashes/sha256');

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const VEC = path.join(__dirname, '..', 'docs', 'test-vectors', 'fixtures');

// A 64-hex implicit account id that is not a point on ed25519: nobody can hold its key.
function offCurveHex() {
  for (let i = 0; ; i++) {
    const b = sha256(new TextEncoder().encode('readback-vectors:near-offcurve:' + i));
    try { ed25519.ExtendedPoint.fromHex(b); } catch { return Buffer.from(b).toString('hex'); }
  }
}

const cases = {
  Q_near_payee: ['alice.near', 'DESTINATION_CHAIN'],
  Q_near_lookalike: ['alise.near', 'DESTINATION_CHAIN'],
  Q_near_lookalike2: ['alicee.near', 'DESTINATION_CHAIN'],
  Q_near_contract: ['aurora', 'DESTINATION_CHAIN'],
  Q_near_offcurve: [offCurveHex(), 'DESTINATION_CHAIN'],
  Q_near_intents_payee: ['alice.near', 'INTENTS'],
  Q_near_intents_missing: ['nonexistent-xyz-123.near', 'INTENTS'],
};
const RPCS = ['https://free.rpc.fastnear.com', 'https://near.drpc.org'];

async function viewAccount(rpc, id) {
  try {
    const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: id } }) });
    const j = await r.json();
    if (j.result && j.result.code_hash) return { code_hash: j.result.code_hash };
    const name = j.error && j.error.cause && j.error.cause.name;
    return name === 'UNKNOWN_ACCOUNT' ? null : { error: String((j.error && j.error.message) || 'no result') };
  } catch (e) { return { error: e.message }; }
}

(async () => {
  const answers = {};
  for (const [name, [recipient, recipientType]] of Object.entries(cases)) {
    const body = { dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 50, originAsset: USDC, depositType: 'INTENTS', destinationAsset: USDC, amount: '250000000', refundTo: 'readback-prework.near', refundType: 'INTENTS', recipient, recipientType, deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
    const r = await fetch('https://1click.chaindefuser.com/v0/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    console.log(name.padEnd(24), recipientType.padEnd(18), recipient.slice(0, 30).padEnd(30), r.status, j.signature ? 'signed' : (j.message || '').slice(0, 60));
    if (r.ok && j.signature) fs.writeFileSync(path.join(VEC, 'quotes', name + '.json'), JSON.stringify(j, null, 1) + '\n');
    answers[recipient] = await Promise.all(RPCS.map((u) => viewAccount(u, recipient)));
  }
  fs.writeFileSync(path.join(VEC, 'rpc', 'near-view_account.json'), JSON.stringify({ recorded: new Date().toISOString(), rpcs: RPCS, answers }, null, 1) + '\n');
  for (const [a, v] of Object.entries(answers)) console.log(a.slice(0, 30).padEnd(30), JSON.stringify(v));
})();
