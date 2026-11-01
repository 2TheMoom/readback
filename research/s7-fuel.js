// SPIKE 7 fuel measurement (throwaway, pre-hackathon research). Not product code.
// Binary-searches the smallest wasmtime fuel budget at which each vector still completes,
// to compare the engine's cost against OutLayer's instruction limits (default 1e9, max 5e11 per the NEAR integration docs).
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const WT = path.join(os.homedir(), '.cargo', 'bin', 'wasmtime');
const targets = { p1: 's7-rust-wasi/target/wasm32-wasip1/release/s7.wasm', p2: 's7-rust-wasi/target/wasm32-wasip2/release/s7.wasm' };

function runs(wasm, input, fuel) {
  const r = spawnSync(WT, ['run', '-W', `fuel=${fuel}`, wasm], { input, encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}
function minFuel(wasm, input) {
  let lo = 1, hi = 1e11;
  if (!runs(wasm, input, hi)) return null;
  while (hi - lo > Math.max(1, lo * 0.001)) { const mid = Math.floor((lo + hi) / 2); if (runs(wasm, input, mid)) hi = mid; else lo = mid; }
  return hi;
}
console.log('wasmtime:', spawnSync(WT, ['--version'], { encoding: 'utf8' }).stdout.trim());
const dir = path.join(__dirname, 's7-inputs');
for (const [name, rel] of Object.entries(targets)) {
  const wasm = path.join(__dirname, rel); const costs = [];
  for (const f of fs.readdirSync(dir).sort()) {
    const input = fs.readFileSync(path.join(dir, f), 'utf8'); const out = runs(wasm, input, 1e11); const fuel = minFuel(wasm, input);
    costs.push(fuel);
    console.log(`${name} ${f.padEnd(28)} verdict=${out ? out.v : 'FAILED'}  fuel=${fuel ? fuel.toLocaleString() : 'n/a'}`);
  }
  const max = Math.max(...costs.filter(Boolean));
  console.log(`${name}: worst case ${max.toLocaleString()} fuel = ${(max / 1e9 * 100).toFixed(3)}% of OutLayer's default 1e9 budget\n`);
}
