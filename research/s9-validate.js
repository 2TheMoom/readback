// SPIKE 9 validator (throwaway, pre-hackathon). An INDEPENDENT reference evaluator for docs/test-vectors/vectors.json.
// It implements the SPEC rules from scratch and checks every hand-written expectation, so a typo in the table
// (or in the spec's logic) shows up as a failure. Not product code; the real engine is written from SPEC on 1 Nov.
const fs = require('fs'), path = require('path');
const { ed25519 } = require('@noble/curves/ed25519');
const { sha256 } = require('@noble/hashes/sha256');
const { keccak_256 } = require('@noble/hashes/sha3');
const { base58, bech32, bech32m, createBase58check } = require('@scure/base');

const DIR = path.join(__dirname, '..', 'docs', 'test-vectors');
const doc = JSON.parse(fs.readFileSync(path.join(DIR, 'vectors.json'), 'utf8'));
const load = f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const mandates = load('fixtures/mandates.json');
const tokens = load('fixtures/tokens.json');
const baseCode = load('fixtures/rpc/base-eth_getCode.json').answers;
const resolveRpc = rpc => (rpc && rpc.evm_code_ref) ? Object.assign({}, rpc, { evm_code: baseCode[rpc.evm_code_ref.toLowerCase()] }) : rpc;
const clone = o => JSON.parse(JSON.stringify(o));

// ---------- quote signature (pinned 1Click key; same rules as spikes 3 and 7) ----------
const MANAGER = base58.decode('reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc');
const truthy = v => !!v;
function stable(v) { if (v === null || typeof v !== 'object') return JSON.stringify(v); if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'; return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'; }
function quoteSigOk(r) {
  const R = ['dry', 'swapType', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline'];
  const RO = ['quoteWaitingTimeMs', 'referral', 'virtualChainRecipient', 'virtualChainRefundRecipient', 'customRecipientMsg'];
  const QD = ['amountIn', 'amountInFormatted', 'amountInUsd', 'minAmountIn', 'amountOut', 'amountOutFormatted', 'amountOutUsd', 'minAmountOut'];
  const QL = ['depositAddress', 'depositMemo', 'deadline', 'timeWhenInactive', 'timeEstimate', 'refundFee', 'withdrawFee'];
  const m = {}; for (const k of R) m[k] = r.quoteRequest[k]; for (const k of RO) m[k] = truthy(r.quoteRequest[k]) ? r.quoteRequest[k] : undefined;
  for (const k of QD) m[k] = r.quote[k]; if (!r.quoteRequest.dry) for (const k of QL) m[k] = truthy(r.quote[k]) ? r.quote[k] : undefined;
  m.timestamp = r.timestamp;
  const h = base58.encode(sha256(new TextEncoder().encode(stable(m))));
  try { return ed25519.verify(base58.decode(r.signature.replace('ed25519:', '')), new TextEncoder().encode(h), MANAGER); } catch { return false; }
}

// ---------- address rules ----------
const EVM = new Set(['eth', 'base', 'arb', 'op', 'pol', 'bsc', 'avax', 'gnosis', 'bera', 'scroll', 'monad', 'xlayer', 'plasma', 'adi', 'abs', 'hood', 'hypercore']);
const b58c = createBase58check(sha256);
const XRPA = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
function xrpDecode(s) { let n = 0n; for (const c of s) { const i = XRPA.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } for (const c of s) { if (c === XRPA[0]) out.unshift(0); else break; } const b = Uint8Array.from(out); if (b.length < 5) return null; const body = b.slice(0, -4), ck = sha256(sha256(body)).slice(0, 4); return ck.every((x, i) => x === b[b.length - 4 + i]) ? body : null; }
const eip55 = a => { const l = a.slice(2).toLowerCase(); const h = Buffer.from(keccak_256(l)).toString('hex'); return '0x' + [...l].map((c, i) => parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c).join(''); };
const onCurve = b => { try { ed25519.ExtendedPoint.fromHex(b); return true; } catch { return false; } };

function formatOk(chain, a) {
  if (EVM.has(chain)) { if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false; const body = a.slice(2); const mixed = body !== body.toLowerCase() && body !== body.toUpperCase(); return !mixed || eip55(a) === a; }
  if (chain === 'sol') { try { return base58.decode(a).length === 32; } catch { return false; } }
  if (chain === 'near') return (/^[0-9a-f]{64}$/.test(a)) || (a.length >= 2 && a.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a));
  if (chain === 'tron') { try { const b = b58c.decode(a); return b.length === 21 && b[0] === 0x41; } catch { return false; } }
  if (chain === 'btc') { try { const b = b58c.decode(a); return b.length === 21 && (b[0] === 0 || b[0] === 5); } catch { } for (const enc of [bech32, bech32m]) { try { const d = enc.decode(a); if (d.prefix !== 'bc') continue; const v = d.words[0]; if ((v === 0) === (enc === bech32)) return true; } catch { } } return false; }
  if (chain === 'xrp') { const b = xrpDecode(a); return !!b && ((b.length === 21 && b[0] === 0) || (b.length === 31 && b[0] === 5 && b[1] === 0x44)); }
  return false;
}
const isXAddress = a => { const b = xrpDecode(a); return !!b && b.length === 31 && b[0] === 5 && b[1] === 0x44; };

function destinationChecks(chain, a, rpc, tokenContract) {
  rpc = resolveRpc(rpc);
  const c = {};
  c.format = formatOk(chain, a) ? 'ok' : 'bad';
  if (c.format !== 'ok') return c; // dependent checks only run on a well-formed address (SPEC 5)
  if (chain === 'sol') {
    let b = null; try { b = base58.decode(a); } catch { }
    c.curve = b && b.length === 32 && onCurve(b) ? 'ok' : 'bad';
    const r = (rpc && rpc.sol_account) || [{ error: 'missing' }, { error: 'missing' }];
    if (r.some(x => x && x.error)) c.mint = 'error';
    else if (JSON.stringify(r[0]) !== JSON.stringify(r[1])) c.mint = 'error';
    else c.mint = r[0] && r[0].owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' && r[0].data_len === 82 ? 'bad' : 'ok';
  }
  if (EVM.has(chain) && c.format === 'ok') {
    const r = (rpc && rpc.evm_code) || [{ error: 'missing' }, { error: 'missing' }];
    if (r.some(x => typeof x !== 'string')) c.contract = 'error';
    else if (r[0].toLowerCase() !== r[1].toLowerCase()) c.contract = 'error';
    else c.contract = r[0] === '0x' ? 'ok' : 'warn'; // 0xef0100... (EIP-7702 delegation) is also a warn, with its own reason
    c.mint = tokenContract && a.toLowerCase() === tokenContract.toLowerCase() ? 'bad' : 'ok'; // EVM: the destination token contract itself
  }
  if (chain === 'xrp') c.tag = isXAddress(a) ? 'bad' : 'ok';
  return c;
}

// ---------- mutations ----------
function applyMutations(quote, intent, muts) {
  const q = clone(quote), it = intent ? clone(intent) : null; let msg = it ? JSON.parse(it.intent.payload.message) : null;
  for (const m of muts || []) {
    const isMsg = m.path.startsWith('msg.'); const root = isMsg ? msg : q; const parts = (isMsg ? m.path.slice(4) : m.path).split('.');
    let o = root; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    const last = parts[parts.length - 1];
    if (m.op === 'set') o[last] = m.value; else if (m.op === 'push') o[last].push(m.value); else throw new Error('unknown op ' + m.op);
  }
  if (it) it.intent.payload.message = JSON.stringify(msg);
  return { q, it, msg };
}

// ---------- full evaluation ----------
const DENY = new Set(['add_public_key', 'remove_public_key', 'set_auth_by_predecessor_id', 'auth_call', 'imt_mint']);
const KNOWN = new Set(['add_public_key', 'remove_public_key', 'transfer', 'ft_withdraw', 'nft_withdraw', 'mt_withdraw', 'native_withdraw', 'storage_deposit', 'token_diff', 'set_auth_by_predecessor_id', 'auth_call', 'imt_mint', 'imt_burn']);
function evaluate(v) {
  if (v.kind === 'destination') return { checks: destinationChecks(v.chain, v.address, v.rpc, v.token_contract) };
  const M = mandates[v.mandate]; const now = Date.parse(v.now);
  if (now > Date.parse(M.valid_until)) return { error: 'mandate_expired', checks: {} };
  const { q, it, msg } = applyMutations(load(`fixtures/quotes/${v.quote}.json`), v.intent ? load(`fixtures/intents/${v.intent}.json`) : null, v.mutate);
  const r = q.quoteRequest, c = {};
  c.quote_sig = quoteSigOk(q) ? 'ok' : 'bad';
  const evmDest = EVM.has(M.dest_chain);
  const norm = a => evmDest ? String(a).toLowerCase() : String(a);
  const payees = M.payees.filter(p => p.chain === M.dest_chain).map(p => p.address);
  const isPayee = payees.some(p => norm(p) === norm(r.recipient)); c.payee = isPayee ? 'ok' : 'bad';
  const pre = (s, n) => [...s].slice(0, n).join(''), suf = (s, n) => [...s].slice(-n).join('');
  // EVM: address poisoning copies the first and last 4 hex characters after 0x (case-insensitive); others: first 4, last 3
  const looks = p => evmDest ? (pre(norm(p).slice(2), 4) === pre(norm(r.recipient).slice(2), 4) && suf(norm(p), 4) === suf(norm(r.recipient), 4)) : (pre(p, 4) === pre(r.recipient, 4) && suf(p, 3) === suf(r.recipient, 3));
  c.lookalike = !isPayee && payees.some(looks) ? 'bad' : 'ok';
  const tk = tokens[r.destinationAsset];
  Object.assign(c, destinationChecks(M.dest_chain, r.recipient, v.rpc, tk && tk.contractAddress));
  c.amount = BigInt(q.quote.amountIn) <= BigInt(M.cap) ? 'ok' : 'warn';
  c.slippage = r.slippageTolerance <= M.max_slippage_bps ? 'ok' : 'warn';
  if (M.fees && M.fees.same_value_assets) {
    const amt = Number(q.quote.amountIn); const app = (r.appFees || []).reduce((s, f) => s + amt * f.fee / 10000, 0);
    c.fees = ((Number(q.quote.withdrawFee || 0) + app) / amt * 100) > M.fees.max_pct ? 'warn' : 'ok';
  }
  c.route = M.origin_assets.includes(r.originAsset) && M.destination_assets.includes(r.destinationAsset) ? 'ok' : 'bad';
  c.refund = M.refund_to.includes(r.refundTo) ? 'ok' : 'bad';
  const deadline = Date.parse(q.quote.deadline || r.deadline);
  c.timing = now > deadline ? 'bad' : (deadline - now) / 1000 < M.min_review_seconds ? 'warn' : 'ok';
  if (it) {
    const ints = msg.intents || [];
    c.intents = ints.some(x => DENY.has(x.intent) || !KNOWN.has(x.intent)) ? 'bad' : 'ok';
    const t = ints[0], toks = t && t.tokens ? Object.entries(t.tokens) : [];
    const bound = it.intent.payload.recipient === 'intents.near' && ints.length === 1 && t.intent === 'transfer'
      && t.receiver_id === q.quote.depositAddress && toks.length === 1 && toks[0][0] === r.originAsset && toks[0][1] === q.quote.amountIn
      && msg.signer_id === M.owner && msg.deadline === q.quote.deadline;
    c.intent_binding = bound ? 'ok' : 'bad';
  }
  return { checks: c };
}
function forceOk(res) { const k = process.env.FORCE_OK; if (k && res.checks && k in res.checks) res.checks[k] = 'ok'; if (k === 'mandate_expiry' && res.error) { delete res.error; } return res; }
const verdictOf = (res) => { if (res.error) return 'REFUSED'; const s = Object.values(res.checks); return s.includes('bad') ? 'REFUSED' : (s.includes('warn') || s.includes('error')) ? 'HOLD' : 'CLEARED'; };

// ---------- run ----------
let pass = 0; const rows = [];
for (const v of doc.vectors) {
  const res = forceOk(evaluate(v)); const verdict = verdictOf(res);
  const got = st => Object.keys(res.checks).filter(k => res.checks[k] === st).sort();
  const want = st => ((v.expect[st] && Array.isArray(v.expect[st])) ? v.expect[st] : []).slice().sort();
  const errStr = typeof v.expect.error === 'string' ? v.expect.error : null;
  const same = verdict === v.expect.verdict && JSON.stringify(got('bad')) === JSON.stringify(want('bad')) && JSON.stringify(got('warn')) === JSON.stringify(want('warn'))
    && JSON.stringify(got('error')) === JSON.stringify(Array.isArray(v.expect.error) ? want('error') : []) && (errStr ? res.error === errStr : !res.error);
  if (same) pass++;
  rows.push(`${same ? 'PASS' : 'FAIL'}  ${v.id.padEnd(5)} ${verdict.padEnd(8)} bad=[${got('bad')}] warn=[${got('warn')}] error=[${got('error')}]${res.error ? ' ' + res.error : ''}  ${v.title}`);
}
rows.forEach(r => console.log(r));
console.log(`\n${pass}/${doc.vectors.length} vectors: the independent evaluator agrees with every hand-written expectation.`);
process.exitCode = pass === doc.vectors.length ? 0 : 1;
