// SPIKE 7 differential fuzz (throwaway, pre-hackathon research). Not product code.
// Does the Rust module's canonical JSON + hash match the official SDK byte for byte on hostile field values?
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { WASI } = require('wasi');
const sdk = require('@defuse-protocol/one-click-sdk-typescript');
const wasmModule = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, 's7-rust-wasi/target/wasm32-wasip1/release/s7.wasm')));
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 's7-inputs/V01-clean.json'), 'utf8'));
const inFile = path.join(os.tmpdir(), 's7-fz-in.json'), outFile = path.join(os.tmpdir(), 's7-fz-out.json');

function runWasm(obj) {
  fs.writeFileSync(inFile, JSON.stringify(obj));
  const i = fs.openSync(inFile, 'r'), o = fs.openSync(outFile, 'w');
  const w = new WASI({ version: 'preview1', args: [], env: {}, stdin: i, stdout: o, stderr: 2, returnOnExit: true });
  w.start(new WebAssembly.Instance(wasmModule, w.getImportObject())); fs.closeSync(i); fs.closeSync(o);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}
const pieces = ['a', 'Z', '0', ' ', '"', '\\', '/', '\n', '\t', '\r', '\b', '\f', '\u0000', '\u0007', '\u001f', '\u007f', 'é', ' ', ' ', '中', '😀', '<', '>', '&', "'", '​', '﻿'];
const rstr = () => { let s = ''; const n = 1 + crypto.randomInt(24); for (let k = 0; k < n; k++) s += pieces[crypto.randomInt(pieces.length)]; return s; };
const nums = [0, 1, -1, 50, 50.5, 1e21, 1e-7, 123456789012, 0.1, 9007199254740991, 1.5e300];
const strFields = ['recipient', 'refundTo', 'originAsset', 'destinationAsset', 'amount', 'deadline', 'referral', 'customRecipientMsg', 'virtualChainRecipient'];
const qFields = ['amountIn', 'amountOutFormatted', 'amountInUsd', 'minAmountOut'];

let same = 0, diff = 0; const examples = [];
const N = Number(process.argv[2] || 2000);
for (let t = 0; t < N; t++) {
  const inp = JSON.parse(JSON.stringify(base));
  const r = inp.quote;
  const k = 1 + crypto.randomInt(3);
  for (let j = 0; j < k; j++) {
    const roll = crypto.randomInt(4);
    if (roll === 0) r.quoteRequest[strFields[crypto.randomInt(strFields.length)]] = rstr();
    else if (roll === 1) r.quote[qFields[crypto.randomInt(qFields.length)]] = rstr();
    else if (roll === 2) r.quoteRequest.slippageTolerance = nums[crypto.randomInt(nums.length)];
    else r.quoteRequest.quoteWaitingTimeMs = nums[crypto.randomInt(nums.length)];
  }
  const ours = runWasm(inp).qh, theirs = sdk.quoteHash(r);
  if (ours === theirs) same++; else { diff++; if (examples.length < 5) examples.push(JSON.stringify({ req: r.quoteRequest, q: r.quote }).slice(0, 300)); }
}
console.log(`${same}/${N} identical hashes, ${diff} differ`);
examples.forEach(e => console.log('DIFF:', e));
