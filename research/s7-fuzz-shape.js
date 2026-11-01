// SPIKE 7 shape fuzz (throwaway, pre-hackathon research). Not product code.
// The engine must answer every input with a verdict, never crash, and never CLEAR a broken quote.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { WASI } = require('wasi');
const wasmModule = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, 's7-rust-wasi/target/wasm32-wasip1/release/s7.wasm')));
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 's7-inputs/V01-clean.json'), 'utf8'));
const inFile = path.join(os.tmpdir(), 's7-fs-in.json'), outFile = path.join(os.tmpdir(), 's7-fs-out.json');
function runRaw(text) {
  fs.writeFileSync(inFile, text);
  const i = fs.openSync(inFile, 'r'), o = fs.openSync(outFile, 'w');
  const w = new WASI({ version: 'preview1', args: [], env: {}, stdin: i, stdout: o, stderr: fs.openSync(os.devNull, 'w'), returnOnExit: true });
  let crashed = false; try { w.start(new WebAssembly.Instance(wasmModule, w.getImportObject())); } catch { crashed = true; }
  fs.closeSync(i); fs.closeSync(o);
  const raw = fs.readFileSync(outFile, 'utf8'); let out = null; try { out = JSON.parse(raw); } catch { }
  return { crashed, out };
}
const weird = [null, true, false, 0, -1, 1e308, '', 'x', [], {}, [1, 2], { a: 1 }, '😀'.repeat(50), 'a'.repeat(5000)];
const paths = [['quote'], ['mandate'], ['quote', 'quoteRequest'], ['quote', 'quote'], ['quote', 'signature'], ['quote', 'timestamp'], ['quote', 'quoteRequest', 'recipient'], ['quote', 'quoteRequest', 'slippageTolerance'], ['quote', 'quote', 'amountIn'], ['mandate', 'payees'], ['mandate', 'cap'], ['mandate', 'refund_to'], ['mandate', 'dest_chain'], ['mandate', 'payees', 0, 'address']];
function setPath(o, p, v) { let x = o; for (let i = 0; i < p.length - 1; i++) { if (x == null || typeof x !== 'object') return; x = x[p[i]]; } if (x && typeof x === 'object') { if (v === undefined) delete x[p[p.length - 1]]; else x[p[p.length - 1]] = v; } }

let crashes = 0, noVerdict = 0, clearedBroken = 0; const N = Number(process.argv[2] || 1500);
const raws = ['', 'null', '[]', '{', '{"quote":1}', 'garbage', '\u0000\u0001', '{"quote":{},"mandate":{}}'];
for (const t of raws) { const r = runRaw(t); if (r.crashed) crashes++; if (!r.out || !r.out.v) noVerdict++; if (r.out && r.out.v === 'CLEARED') clearedBroken++; }
for (let t = 0; t < N; t++) {
  const inp = JSON.parse(JSON.stringify(base)); const n = 1 + crypto.randomInt(3);
  for (let j = 0; j < n; j++) { const p = paths[crypto.randomInt(paths.length)]; setPath(inp, p, crypto.randomInt(5) === 0 ? undefined : weird[crypto.randomInt(weird.length)]); }
  const r = runRaw(JSON.stringify(inp));
  if (r.crashed) crashes++; if (!r.out || !r.out.v) noVerdict++;
  if (r.out && r.out.v === 'CLEARED' && JSON.stringify(inp.quote) !== JSON.stringify(base.quote)) clearedBroken++;
}
console.log(`${N + raws.length} malformed inputs: crashes=${crashes}, missing verdict=${noVerdict}, CLEARED a modified quote=${clearedBroken}`);
