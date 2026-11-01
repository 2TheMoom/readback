// SPIKE 7 runner (throwaway, pre-hackathon research). Not product code.
// Runs the Rust WASI P1 module on every input via Node's WASI, and compares it with an independent JS implementation.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WASI } = require('wasi');
const { ed25519 } = require('@noble/curves/ed25519');
const sdk = require('@defuse-protocol/one-click-sdk-typescript');
const { base58 } = require('@scure/base');

const WASM = path.join(__dirname, 's7-rust-wasi', 'target', 'wasm32-wasip1', 'release', 's7.wasm');
const wasmModule = new WebAssembly.Module(fs.readFileSync(WASM));

function runWasm(inputFile) {
  const outFile = path.join(os.tmpdir(), 's7-out-' + process.pid + '.json');
  const inFd = fs.openSync(inputFile, 'r'), outFd = fs.openSync(outFile, 'w');
  const wasi = new WASI({ version: 'preview1', args: [], env: {}, stdin: inFd, stdout: outFd, stderr: 2, returnOnExit: true });
  const inst = new WebAssembly.Instance(wasmModule, wasi.getImportObject());
  const t0 = process.hrtime.bigint(); wasi.start(inst); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  fs.closeSync(inFd); fs.closeSync(outFd);
  const raw = fs.readFileSync(outFile, 'utf8'); fs.unlinkSync(outFile);
  return { out: JSON.parse(raw), bytes: Buffer.byteLength(raw), ms };
}

// Independent reference: official SDK for the signature, @noble for the curve, plain JS for the rest.
function reference({ quote: r, mandate: m }) {
  const c = {}; const q = r.quoteRequest;
  c.quote_sig = sdk.verifyQuoteSignature(r) ? 'ok' : 'bad';
  const payees = m.payees.filter(p => p.chain === m.dest_chain).map(p => p.address);
  const isPayee = payees.includes(q.recipient); c.payee = isPayee ? 'ok' : 'bad';
  c.lookalike = !isPayee && payees.some(p => p.slice(0, 4) === q.recipient.slice(0, 4) && p.slice(-3) === q.recipient.slice(-3)) ? 'bad' : 'ok';
  if (m.dest_chain === 'sol') { let on = false; try { const b = base58.decode(q.recipient); on = b.length === 32 && (ed25519.ExtendedPoint.fromHex(b), true); } catch { on = false; } c.curve = on ? 'ok' : 'bad'; }
  c.amount = BigInt(r.quote.amountIn) <= BigInt(m.cap) ? 'ok' : 'warn';
  c.slippage = q.slippageTolerance <= m.max_slippage_bps ? 'ok' : 'warn';
  c.route = m.origin_assets.includes(q.originAsset) && m.destination_assets.includes(q.destinationAsset) ? 'ok' : 'bad';
  c.refund = m.refund_to.includes(q.refundTo) ? 'ok' : 'bad';
  const vals = Object.values(c); const v = vals.includes('bad') ? 'REFUSED' : vals.includes('warn') ? 'HOLD' : 'CLEARED';
  return { v, c, qh: sdk.quoteHash(r) };
}

const dir = path.join(__dirname, 's7-inputs'); let pass = 0, total = 0;
for (const f of fs.readdirSync(dir).sort()) {
  const file = path.join(dir, f); const inp = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { out, bytes, ms } = runWasm(file); const ref = reference(inp);
  const sameAsRef = JSON.stringify(out.c) === JSON.stringify(Object.fromEntries(Object.keys(out.c).map(k => [k, ref.c[k]]))) && out.v === ref.v && out.qh === ref.qh;
  const e = inp.expect; const bad = Object.keys(out.c).filter(k => out.c[k] === 'bad'), warn = Object.keys(out.c).filter(k => out.c[k] === 'warn');
  const meetsSpec = out.v === e.v && JSON.stringify((e.bad || []).sort()) === JSON.stringify(bad.sort()) && JSON.stringify((e.warn || []).sort()) === JSON.stringify(warn.sort());
  total++; if (sameAsRef && meetsSpec && bytes <= 900) pass++;
  console.log(`${(sameAsRef && meetsSpec && bytes <= 900) ? 'PASS' : 'FAIL'}  ${f.padEnd(28)} ${out.v.padEnd(8)} bad=[${bad}] warn=[${warn}]  ${bytes}B ${ms.toFixed(1)}ms  matchesJS=${sameAsRef} matchesSpec=${meetsSpec}`);
}
console.log(`\n${pass}/${total} vectors: Rust/WASI output matches the independent JS reference, the spec's expected verdict, and fits in 900 bytes.`);
