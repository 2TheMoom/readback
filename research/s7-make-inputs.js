// SPIKE 7 helper (throwaway, pre-hackathon research). Not product code.
// Fetches real signed dry quotes (no funds, no deposit address) for the spec's test vectors, and writes
// {quote, mandate, expect} inputs for the Rust/WASI spike.
const fs = require('fs');
const path = require('path');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'out-fixtures.json'), 'utf8'));
const tokens = JSON.parse(fs.readFileSync(path.join(__dirname, 'out-tokens.json'), 'utf8'));
const from = tokens.find(t => t.blockchain === 'near' && t.symbol === 'USDC');
const to = tokens.find(t => t.blockchain === 'sol' && t.symbol === 'USDC');
const OUT = path.join(__dirname, 's7-inputs'); fs.mkdirSync(OUT, { recursive: true });

const mandate = {
  id: 'M1', agent: 'invoice-bot', dest_chain: 'sol',
  payees: [{ label: 'Acme', chain: 'sol', address: fx.acme }],
  origin_assets: [from.assetId], destination_assets: [to.assetId],
  cap: '300000000', max_slippage_bps: 50, refund_to: ['readback-prework.near']
};

async function quote(over) {
  const body = Object.assign({ dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 50, originAsset: from.assetId, depositType: 'INTENTS', destinationAsset: to.assetId, amount: '250000000', refundTo: 'readback-prework.near', refundType: 'INTENTS', recipient: fx.acme, recipientType: 'DESTINATION_CHAIN', deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString() }, over);
  const r = await fetch('https://1click.chaindefuser.com/v0/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (r.status !== 201) throw new Error('quote failed ' + r.status + ' ' + JSON.stringify(j).slice(0, 200)); return j;
}
const write = (name, q, expect) => fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify({ quote: q, mandate, expect }));

(async () => {
  const base = await quote({});
  write('V01-clean', base, { v: 'CLEARED' });
  write('V02-lookalike', await quote({ recipient: fx.lookalike }), { v: 'REFUSED', bad: ['payee', 'lookalike'] });
  write('V04-offcurve', await quote({ recipient: fx.offCurve }), { v: 'REFUSED', bad: ['payee', 'curve'] });
  write('V10-over-cap', await quote({ amount: '400000000' }), { v: 'HOLD', warn: ['amount'] });
  write('V11-slippage', await quote({ slippageTolerance: 300 }), { v: 'HOLD', warn: ['slippage'] });
  write('V13-refund', await quote({ refundTo: 'attacker.near' }), { v: 'REFUSED', bad: ['refund'] });
  const t07 = JSON.parse(JSON.stringify(base)); t07.quoteRequest.recipient = fx.lookalike;
  write('V07-recipient-edited', t07, { v: 'REFUSED', bad: ['quote_sig', 'payee', 'lookalike'] });
  const t08 = JSON.parse(JSON.stringify(base)); t08.quote.amountOut = '999999999';
  write('V08-amountout-edited', t08, { v: 'REFUSED', bad: ['quote_sig'] });
  const t09 = JSON.parse(JSON.stringify(base)); t09.quoteRequest.appFees = [{ recipient: 'attacker.near', fee: 500 }];
  write('V09-appfees-edited', t09, { v: 'CLEARED' });
  const t12 = JSON.parse(JSON.stringify(base)); t12.quoteRequest.destinationAsset = 'nep141:eth.omft.near';
  write('V12-route-edited', t12, { v: 'REFUSED', bad: ['quote_sig', 'route'] });
  console.log(fs.readdirSync(OUT).join('\n'));
})().catch(e => { console.error(e.message); process.exit(1); });
