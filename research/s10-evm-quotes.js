// SPIKE 10 (throwaway, pre-hackathon research). Real signed dry quotes NEAR USDC -> Base USDC (no funds, no deposit
// address) for EVM-destination vectors, plus real eth_getCode answers from two independent public Base RPCs.
const fs = require('fs'), path = require('path');
const { sha256 } = require('@noble/hashes/sha256');
const { keccak_256 } = require('@noble/hashes/sha3');
const t = require('./out-tokens.json');
const from = t.find(x => x.blockchain === 'near' && x.symbol === 'USDC'), to = t.find(x => x.blockchain === 'base' && x.symbol === 'USDC');
const eip55 = hex => { const l = hex.replace(/^0x/, '').toLowerCase(); const h = Buffer.from(keccak_256(l)).toString('hex'); return '0x' + [...l].map((c, i) => parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c).join(''); };
const flipLetter = a => { const i = [...a].findIndex((c, k) => k > 1 && /[a-fA-F]/.test(c)); return a.slice(0, i) + (a[i] === a[i].toUpperCase() ? a[i].toLowerCase() : a[i].toUpperCase()) + a.slice(i + 1); };

const payee = eip55(Buffer.from(sha256(new TextEncoder().encode('readback-vectors:evm-payee'))).subarray(0, 20).toString('hex'));
// address-poisoning lookalike: same first 4 and last 4 hex characters, different middle
const mid = Buffer.from(sha256(new TextEncoder().encode('readback-vectors:evm-poison'))).toString('hex').slice(0, 32);
const lookalike = eip55(payee.slice(2, 6) + mid + payee.slice(-4));
const recipients = {
  E_payee: payee, E_lookalike: lookalike, E_lower: payee.toLowerCase(), E_badsum: flipLetter(payee),
  E_usdc_contract: eip55(to.contractAddress), E_weth: eip55('4200000000000000000000000000000000000006')
};
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
async function getCode(rpc, a) {
  try { const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [a.toLowerCase(), 'latest'] }) }); const j = await r.json(); return j.result !== undefined ? j.result : { error: (j.error && j.error.message) || 'no result' }; }
  catch (e) { return { error: e.message }; }
}
(async () => {
  const out = { payee, lookalike, to: { assetId: to.assetId, contractAddress: to.contractAddress, decimals: to.decimals, symbol: to.symbol, blockchain: to.blockchain }, quotes: {}, code: {} };
  for (const [k, a] of Object.entries(recipients)) {
    const body = { dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 50, originAsset: from.assetId, depositType: 'INTENTS', destinationAsset: to.assetId, amount: '250000000', refundTo: 'readback-prework.near', refundType: 'INTENTS', recipient: a, recipientType: 'DESTINATION_CHAIN', deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
    const r = await fetch('https://1click.chaindefuser.com/v0/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    out.quotes[k] = { status: r.status, response: j };
    const code = await Promise.all(RPCS.map(u => getCode(u, a)));
    out.code[k] = code.map(c => typeof c === 'string' ? (c.length > 80 ? c.slice(0, 80) + '...(' + (c.length - 2) / 2 + ' bytes)' : c) : c);
    out.code_full = out.code_full || {}; out.code_full[k] = code;
    console.log(`${k.padEnd(16)} ${a}  quote HTTP ${r.status}${r.status !== 201 ? ' ' + JSON.stringify(j).slice(0, 140) : ''}  code: ${out.code[k].map(c => typeof c === 'string' ? (c === '0x' ? '0x (none)' : c.slice(0, 14) + '...') : 'ERR ' + c.error).join(' | ')}`);
  }
  fs.writeFileSync(path.join(__dirname, 'out-evm.json'), JSON.stringify(out, null, 1));
})().catch(e => { console.error('ERR', e); process.exit(1); });
