// SPIKE 6 (throwaway, pre-hackathon research). Not product code.
// Builds deterministic fixtures for the spec's test vectors, plus one fresh signed dry quote to the fixture payee.
const fs = require('fs');
const { ed25519 } = require('@noble/curves/ed25519');
const { sha256 } = require('@noble/hashes/sha256');
const { base58 } = require('@scure/base');
const onCurve = b => { try { ed25519.ExtendedPoint.fromHex(b); return true; } catch { return false; } };
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const acme = base58.encode(ed25519.getPublicKey(sha256(new TextEncoder().encode('readback-fixture-acme'))));
// lookalike: same first 4 and last 3 characters, one character changed near the end, still a valid on-curve key
let look = null;
for (let pos = acme.length - 4; pos > 4 && !look; pos--) for (const c of A) {
  if (c === acme[pos]) continue; const cand = acme.slice(0, pos) + c + acme.slice(pos + 1);
  let b; try { b = base58.decode(cand); } catch { continue; } if (b.length === 32 && onCurve(b)) { look = cand; break; }
}
const offCurve = '9wQpXhE3tRk2vYfJc7ZaLbN5uD8sMq1GxTe4HnKoQ4mW'; // the old mock address: valid base58, 32 bytes, off-curve
console.log('acme     ', acme, onCurve(base58.decode(acme)));
console.log('lookalike', look, onCurve(base58.decode(look)));
console.log('offcurve ', offCurve, onCurve(base58.decode(offCurve)));

(async () => {
  const BASE = 'https://1click.chaindefuser.com';
  const tokens = JSON.parse(fs.readFileSync(__dirname + '/out-tokens.json', 'utf8'));
  const from = tokens.find(t => t.blockchain === 'near' && t.symbol === 'USDC'), to = tokens.find(t => t.blockchain === 'sol' && t.symbol === 'USDC');
  const quote = async recipient => {
    const body = { dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 50, originAsset: from.assetId, depositType: 'INTENTS', destinationAsset: to.assetId, amount: '250000000', refundTo: 'readback-prework.near', refundType: 'INTENTS', recipient, recipientType: 'DESTINATION_CHAIN', deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
    const r = await fetch(BASE + '/v0/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const good = await quote(acme);
  console.log('quote to acme: HTTP', good.status, 'amountOut', good.json.quote && good.json.quote.amountOutFormatted, 'withdrawFee', good.json.quote && good.json.quote.withdrawFee);
  const off = await quote(offCurve);
  console.log('quote to OFF-CURVE address: HTTP', off.status, off.json.quote ? 'quoted (1Click did not reject it)' : JSON.stringify(off.json).slice(0, 200));
  fs.writeFileSync(__dirname + '/out-fixtures.json', JSON.stringify({ acme, lookalike: look, offCurve, baseQuote: good.json, offCurveQuoteStatus: off.status }, null, 1));
})();
