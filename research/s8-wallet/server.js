// SPIKE 8 local server (throwaway, pre-hackathon research). Not product code. Never copied into the hackathon repo.
// Serves a sign-in page that uses @hot-labs/near-connect to ask a REAL wallet for a NEP-413 message signature,
// then verifies it server-side: single-use nonce, exact payload, ed25519 signature, full-access key on chain.
// Message signing only: no transaction, no funds. Binds to 127.0.0.1 only.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { ed25519 } = require('@noble/curves/ed25519');
const { sha256 } = require('@noble/hashes/sha256');
const { base58 } = require('@scure/base');

const PORT = 5310, RECIPIENT = 'readback.localhost', MESSAGE = 'Sign in to Readback (local spike). This is not a transaction.';
const RPC = { mainnet: 'https://free.rpc.fastnear.com', testnet: 'https://test.rpc.fastnear.com' };
const nonces = new Map(); // base64 nonce -> { network, expires, used }

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const str = s => { const u = Buffer.from(s, 'utf8'); return Buffer.concat([u32(u.length), u]); };
const nep413Hash = (message, nonce, recipient) => sha256(Buffer.concat([u32(2147484061), str(message), nonce, str(recipient), Buffer.from([0])]));
const decodeSig = s => { if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s, 'base64').length === 64) return Buffer.from(s, 'base64'); try { const b = base58.decode(s.replace(/^ed25519:/, '')); if (b.length === 64) return Buffer.from(b); } catch { } return null; };

async function fullAccess(network, accountId, publicKey) {
  const r = await fetch(RPC[network], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey } }) });
  const j = await r.json();
  // NEAR RPC reports "access key does not exist" INSIDE result (result.error), not as a top-level error.
  if (j.error || !j.result || j.result.error) return { ok: false, why: 'key not found on ' + accountId + ' (' + network + '): ' + String((j.result && j.result.error) || (j.error && j.error.message) || 'no result').slice(0, 120) };
  if (j.result.permission === 'FullAccess') return { ok: true };
  if (j.result.permission && j.result.permission.FunctionCall) return { ok: false, why: 'key is a function-call key, not full access' };
  return { ok: false, why: 'unexpected RPC shape' };
}

async function verify(body) {
  const steps = []; const step = (name, ok, detail) => { steps.push({ name, ok, detail }); return ok; };
  const rec = nonces.get(body.nonce);
  if (!step('Nonce was issued by this server', !!rec)) return steps;
  if (!step('Nonce not used before', !rec.used)) return steps;
  if (!step('Nonce not expired (5 min)', Date.now() < rec.expires)) return steps;
  rec.used = true; // single use even if the rest fails
  if (!step('Signed with an ed25519 key', typeof body.publicKey === 'string' && body.publicKey.startsWith('ed25519:'), body.publicKey)) return steps;
  const sig = decodeSig(String(body.signature || ''));
  if (!step('Signature is 64 bytes', !!sig, sig ? 'encoding understood' : 'could not decode as base64 or base58')) return steps;
  const pk = base58.decode(body.publicKey.slice(8));
  const valid = (() => { try { return ed25519.verify(sig, nep413Hash(MESSAGE, Buffer.from(body.nonce, 'base64'), RECIPIENT), pk); } catch { return false; } })();
  if (!step('Signature covers exactly our message, nonce and recipient', valid)) return steps;
  const fa = await fullAccess(rec.network, String(body.accountId), body.publicKey);
  step('Key is a full-access key on ' + body.accountId + ' (' + rec.network + ')', fa.ok, fa.why || 'confirmed on chain');
  return steps;
}

const send = (res, code, type, data) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(data); };
http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    if (req.method === 'GET' && req.url === '/near-connect.bundle.js') return send(res, 200, 'text/javascript', fs.readFileSync(path.join(__dirname, 'public', 'near-connect.bundle.js')));
    if (req.method === 'POST') {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 10000) return send(res, 413, 'text/plain', 'too large'); }
      const body = JSON.parse(raw || '{}');
      if (req.url === '/nonce') {
        const network = body.network === 'testnet' ? 'testnet' : 'mainnet';
        const n = crypto.randomBytes(32).toString('base64'); nonces.set(n, { network, expires: Date.now() + 5 * 60 * 1000, used: false });
        return send(res, 200, 'application/json', JSON.stringify({ nonce: n, message: MESSAGE, recipient: RECIPIENT, network }));
      }
      if (req.url === '/verify') return send(res, 200, 'application/json', JSON.stringify({ steps: await verify(body) }));
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) { send(res, 500, 'text/plain', 'error: ' + e.message); }
}).listen(PORT, '127.0.0.1', () => console.log(`Readback wallet spike on http://127.0.0.1:${PORT}`));
module.exports = { nep413Hash, verify, nonces, MESSAGE, RECIPIENT };
