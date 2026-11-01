// SPIKE 4 (throwaway, pre-hackathon research). Not product code.
// Question: can we tell whether a Solana-style 32-byte key is a point on ed25519 (has a private key) or off-curve
// (a PDA or random bytes that nobody can ever sign for)? Cross-check a from-scratch check against @noble/curves.
const crypto = require('crypto');
const { ed25519 } = require('@noble/curves/ed25519');
const { sha256 } = require('@noble/hashes/sha256');

const P = 2n ** 255n - 19n;
const mod = a => ((a % P) + P) % P;
function pow(b, e) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; }
const inv = a => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

// RFC 8032 section 5.1.3 decoding, strict (rejects y >= p and x = 0 with sign bit set).
function onCurve(bytes) {
  if (bytes.length !== 32) return false;
  const b = Uint8Array.from(bytes); const sign = b[31] >> 7; b[31] &= 0x7f;
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = y * y % P, u = mod(y2 - 1n), v = mod(D * y2 + 1n);
  let x = u * pow(v, 3n) % P * pow(u * pow(v, 7n), (P - 5n) / 8n) % P;
  const vx2 = v * x % P * x % P;
  if (vx2 === u) { /* ok */ } else if (vx2 === mod(-u)) x = x * SQRT_M1 % P; else return false;
  if (x === 0n && sign === 1) return false;
  return true;
}
function noble(bytes) { try { ed25519.ExtendedPoint.fromHex(bytes); return true; } catch { return false; } }

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58dec(str) { let n = 0n; for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad b58 char ' + c); n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } for (const c of str) { if (c === '1') out.unshift(0); else break; } return Uint8Array.from(out); }
function b58enc(bytes) { let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of bytes) { if (x === 0) s = '1' + s; else break; } return s; }

// 1) random 32-byte strings: both checks must agree
let agree = 0, on = 0; const N = 20000;
for (let i = 0; i < N; i++) { const r = crypto.randomBytes(32); const a = onCurve(r), b = noble(r); if (a === b) agree++; if (a) on++; }
console.log(`random bytes: ${agree}/${N} agree with noble, ${on} on-curve (~50% expected)`);

// 2) real keypair public keys must all be on-curve
let kp = 0; for (let i = 0; i < 2000; i++) { const pub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey()); if (onCurve(pub) && noble(pub)) kp++; }
console.log(`generated keypairs: ${kp}/2000 on-curve (must be 2000)`);

// 3) Solana PDAs must all be off-curve. Real derivation: sha256(seeds || bump || programId || "ProgramDerivedAddress"),
//    take the first bump (255 down) whose hash is off-curve. Example: associated token account for a wallet + USDC mint.
function findPda(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(Buffer.concat([...seeds.map(s => Buffer.from(s)), Buffer.from([bump]), Buffer.from(programId), Buffer.from('ProgramDerivedAddress')]));
    if (!noble(h)) return { address: h, bump };
  }
  throw new Error('no bump');
}
const TOKEN = b58dec('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = b58dec('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const USDC = b58dec('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
let pdaOff = 0; const pdas = [];
for (let i = 0; i < 500; i++) { const wallet = ed25519.getPublicKey(ed25519.utils.randomPrivateKey()); const pda = findPda([wallet, TOKEN, USDC], ATA); if (!onCurve(pda.address)) pdaOff++; if (i < 2) pdas.push(b58enc(pda.address) + ' (bump ' + pda.bump + ')'); }
console.log(`ATA PDAs: ${pdaOff}/500 off-curve by my check (must be 500). Examples: ${pdas.join(', ')}`);

// 4) named fixtures used in the spec's test vectors
const fixtures = {
  'system program 111...1 (all zero bytes)': '11111111111111111111111111111111',
  'USDC mint EPjF...Dt1v': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'token program Tokenkeg...': 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
};
for (const [k, v] of Object.entries(fixtures)) { const b = b58dec(v); console.log(`${k}: len=${b.length} mine=${onCurve(b)} noble=${noble(b)}`); }

// 5) non-canonical y (y >= p): strict decoders reject; note for the spec, Solana's runtime (dalek) may accept these.
const nc = new Uint8Array(32).fill(0xff); nc[31] = 0x7f; nc[0] = 0xed; // y = p exactly
console.log(`non-canonical y=p: mine=${onCurve(nc)} noble=${noble(nc)}`);
