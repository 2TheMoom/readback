// SPIKE 2 (throwaway, pre-hackathon research). Not product code.
// Question: what does a real 1Click quote look like, unauthenticated, as a dry run (no deposit address, no funds)?
const fs = require('fs');
const BASE = 'https://1click.chaindefuser.com';

(async () => {
  const tokens = await (await fetch(BASE + '/v0/tokens')).json();
  console.log('tokens:', tokens.length);
  const chains = [...new Set(tokens.map(t => t.blockchain))].sort();
  console.log('chains (' + chains.length + '):', chains.join(', '));
  const pick = (chain, sym) => tokens.find(t => t.blockchain === chain && t.symbol === sym);
  const from = pick('near', 'USDC'), to = pick('sol', 'USDC');
  console.log('from:', from && from.assetId, '| to:', to && to.assetId);
  fs.writeFileSync(__dirname + '/out-tokens.json', JSON.stringify(tokens, null, 1));

  // Dry quote: per the spec, dry=true returns no depositAddress, deadline or timeWhenInactive.
  const body = {
    dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 50,
    originAsset: from.assetId, depositType: 'INTENTS', destinationAsset: to.assetId,
    amount: '10000000', // 10 USDC, 6 decimals
    refundTo: 'readback-prework.near', refundType: 'INTENTS',
    recipient: '9wQpXhE3tRk2vYfJc7ZaLbN5uD8sMq1GxTe4HnKoQ4mW', recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  };
  const res = await fetch(BASE + '/v0/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  console.log('\nquote HTTP', res.status);
  console.log(text.slice(0, 2500));
  fs.writeFileSync(__dirname + '/out-quote-dry.json', text);
})().catch(e => { console.error('ERR', e); process.exit(1); });
