// SPIKE 5 (throwaway, pre-hackathon research). Not product code.
// Question: given an address string, which 1Click chains could it belong to? Where are formats ambiguous?
const crypto = require('crypto');
const { keccak_256 } = require('@noble/hashes/sha3');
const { sha256 } = require('@noble/hashes/sha256');
const { ed25519 } = require('@noble/curves/ed25519');

const sha256d = b => sha256(sha256(b));
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const XRP58 = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
function bdec(str, alpha) { let n = 0n; for (const c of str) { const i = alpha.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } for (const c of str) { if (c === alpha[0]) out.unshift(0); else break; } return Uint8Array.from(out); }
function benc(bytes, alpha) { let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = alpha[Number(n % 58n)] + s; n /= 58n; } for (const x of bytes) { if (x === 0) s = alpha[0] + s; else break; } return s; }
function b58check(str, alpha = B58) { const b = bdec(str, alpha); if (!b || b.length < 5) return null; const body = b.slice(0, -4), ck = b.slice(-4), h = sha256d(body); return ck.every((x, i) => x === h[i]) ? body : null; }
function b58checkEnc(body, alpha = B58) { const h = sha256d(body); return benc(Uint8Array.from([...body, ...h.slice(0, 4)]), alpha); }

// bech32 / bech32m (BIP173 / BIP350)
const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(v) { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]; } return c >>> 0; }
function bech32(str) { if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null; str = str.toLowerCase(); const p = str.lastIndexOf('1'); if (p < 1 || p + 7 > str.length) return null; const hrp = str.slice(0, p), data = []; for (const c of str.slice(p + 1)) { const i = CH.indexOf(c); if (i < 0) return null; data.push(i); } const exp = [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)]; const pm = polymod([...exp, ...data]); const variant = pm === 1 ? 'bech32' : pm === 0x2bc830a3 ? 'bech32m' : null; return variant ? { hrp, variant, data: data.slice(0, -6) } : null; }

// Stellar StrKey (G...): base32, version byte 6<<3, CRC16-XModem little endian
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function crc16(b) { let c = 0; for (const x of b) { c ^= x << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c; }
function stellar(s) { if (!/^G[A-Z2-7]{55}$/.test(s)) return false; let bits = '', out = []; for (const c of s) bits += B32.indexOf(c).toString(2).padStart(5, '0'); for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); const body = out.slice(0, 33), ck = out[33] | (out[34] << 8); return out[0] === 48 && crc16(body) === ck; }
function stellarEnc(pub) { const body = [48, ...pub], ck = crc16(body); const all = [...body, ck & 255, ck >> 8]; let bits = all.map(x => x.toString(2).padStart(8, '0')).join(''); let s = ''; for (let i = 0; i < bits.length; i += 5) s += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return s; }

function eip55(a) { const lower = a.slice(2).toLowerCase(); const h = Buffer.from(keccak_256(lower)).toString('hex'); return '0x' + [...lower].map((c, i) => parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c).join(''); }

const EVM = ['eth', 'arb', 'base', 'op', 'pol', 'bsc', 'avax', 'gnosis', 'bera', 'scroll', 'monad', 'xlayer', 'plasma', 'adi', 'abs', 'hood', 'hypercore'];
function classify(a) {
  const c = [], notes = [];
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) {
    const mixed = a.slice(2) !== a.slice(2).toLowerCase() && a.slice(2) !== a.slice(2).toUpperCase();
    if (mixed && eip55(a) !== a) notes.push('EIP-55 checksum FAILS (likely a typo)'); else c.push(...EVM, 'near(eth-implicit)');
    if (!mixed) notes.push('no checksum to verify (all one case)');
  }
  if (/^0x[0-9a-f]{64}$/i.test(a)) c.push('aptos', 'sui', 'movement', 'starknet');
  if (/^0x[0-9a-f]{1,63}$/i.test(a) && !/^0x[0-9a-fA-F]{40}$/.test(a)) c.push('starknet(short)');
  if (/^[0-9a-f]{64}$/.test(a)) c.push('near(implicit)');
  if (/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a) && a.length >= 2 && a.length <= 64 && /\./.test(a)) c.push('near(named)');
  const sol = bdec(a, B58); if (sol && sol.length === 32 && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) { c.push('sol'); try { ed25519.ExtendedPoint.fromHex(sol); } catch { notes.push('sol: OFF-CURVE (no private key)'); } }
  const bc = b58check(a);
  if (bc && bc.length === 21) {
    const v = bc[0];
    if (v === 0x00) c.push('btc', 'bch(legacy)');
    if (v === 0x05) c.push('btc', 'bch(legacy)', 'ltc(old P2SH)');
    if (v === 0x30) c.push('ltc'); if (v === 0x32) c.push('ltc');
    if (v === 0x1e) c.push('doge'); if (v === 0x16) c.push('doge');
    if (v === 0x41) c.push('tron');
    if (v === 0x4c || v === 0x10) c.push('dash');
  }
  if (bc && bc.length === 22 && bc[0] === 0x1c && (bc[1] === 0xb8 || bc[1] === 0xbd)) c.push('zec(transparent)');
  const xr = b58check(a, XRP58); if (xr && xr.length === 21 && xr[0] === 0 && a[0] === 'r') c.push('xrp');
  const be = bech32(a); if (be) { if (be.hrp === 'bc') c.push('btc'); if (be.hrp === 'ltc') c.push('ltc'); if (be.hrp === 'addr') c.push('cardano'); if (be.hrp === 'aleo') c.push('aleo'); if (be.hrp === 'bitcoincash') c.push('bch'); }
  if (stellar(a)) c.push('stellar');
  return { candidates: [...new Set(c)], notes };
}

// ---- vectors: well-known public examples + programmatically generated valid addresses + one-char mutations
const rnd = n => crypto.randomBytes(n);
const evm = eip55('0x' + rnd(20).toString('hex'));
const solKey = (() => { const pk = ed25519.getPublicKey(ed25519.utils.randomPrivateKey()); return benc(pk, B58); })();
const tron = b58checkEnc(Uint8Array.from([0x41, ...rnd(20)]));
const doge = b58checkEnc(Uint8Array.from([0x1e, ...rnd(20)]));
const { bech32: B32LIB } = require('@scure/base');
const segwit = B32LIB.encode('bc', [0, ...B32LIB.toWords(rnd(20))]);
const flipLetter = a => { const i = [...a].findIndex((c, k) => k > 1 && /[a-fA-F]/.test(c)); return a.slice(0, i) + (a[i] === a[i].toUpperCase() ? a[i].toLowerCase() : a[i].toUpperCase()) + a.slice(i + 1); };
const xlm = stellarEnc(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
const vectors = [
  ['BTC genesis (P2PKH)', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
  ['Segwit v0 (generated via @scure/base)', segwit],
  ['Segwit one char changed', segwit.slice(0, -1) + (segwit.slice(-1) === 'q' ? 'p' : 'q')],
  ['BIP350 taproot example', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'],
  ['XRP genesis', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
  ['EVM (EIP-55, generated)', evm],
  ['EVM one letter case flipped', flipLetter(evm)],
  ['EVM all lowercase', evm.toLowerCase()],
  ['Solana wallet (generated)', solKey],
  ['Solana ATA PDA (from spike 4)', '4PCPBzcbtfQexu966NXQ8RMy1zuyTpND7VXxDeUmRweh'],
  ['USDC mint', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  ['Tron (generated)', tron],
  ['Tron one char changed', tron.slice(0, -1) + (tron.slice(-1) === 'A' ? 'B' : 'A')],
  ['Dogecoin (generated)', doge],
  ['Stellar (generated)', xlm],
  ['NEAR named', 'alice.near'],
  ['NEAR implicit', rnd(32).toString('hex')],
  ['Aptos/Sui-style 0x64', '0x' + rnd(32).toString('hex')]
];
for (const [name, a] of vectors) { const r = classify(a); console.log(`${name.padEnd(30)} ${(r.candidates.join(', ') || 'NO MATCH').padEnd(60)} ${r.notes.join('; ')}`); }
