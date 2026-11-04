// Readback web app: the owner's queue. Every payment an agent asked Readback about, read back as one sentence
// with the failing words marked, and the payments held for the owner, approved by signing the approval text
// in their own NEAR wallet (NEP-413). Data comes from the Readback server that serves this page (/v1/...).
// Everything a quote can influence is escaped before it reaches the page.
(function () {
  'use strict';

  var CHECKS = {
    quote_sig: 'The quote is genuine', payee: 'Recipient is a saved payee', lookalike: 'Not a lookalike of a saved payee',
    amount: 'Amount is inside the cap', fees: 'Fees are reasonable', slippage: 'Slippage is inside the limit',
    route: 'Asset and chain are allowed', format: 'Address fits the destination chain', curve: 'Someone holds the key for this address',
    contract: 'Destination is not a contract', mint: 'Destination is not a token address', tag: 'No destination tag is needed',
    intents: 'Nothing extra in the batch', intent_binding: 'You sign what was quoted', refund: 'Refunds come back to you',
    timing: 'Enough time to review', enclave: 'Same verdict inside the TEE, with a receipt'
  };
  var WHY = {
    not_a_saved_payee: 'This address is not one of the payees you saved for this mandate.',
    lookalike_of_saved_payee: 'It copies the start and end of a payee you saved. Compare every character.',
    over_cap: 'More than this mandate allows per payment.',
    high_fees: 'The fees are a large share of the payment.',
    over_limit: 'Slippage is above your limit.',
    asset_not_allowed: 'That token or chain is not on this mandate.',
    not_a_payout: 'Funds would stay inside NEAR Intents instead of paying out, where anyone could claim the name.',
    malformed: 'This is not a valid address on that chain.',
    no_private_key: 'No private key exists for this address. Whatever lands there can never be moved.',
    account_does_not_exist: 'That NEAR account does not exist.',
    contract: 'The address has code. A contract may have no way to send funds back.',
    eip7702_delegated: 'This account delegates to contract code (EIP-7702).',
    token_mint: 'That is a token address, not a wallet. Tokens sent there are usually lost.',
    token_contract: 'That is the token contract itself, not a wallet.',
    needs_destination_tag: 'This address needs a destination tag that cannot be sent.',
    not_signed_by_1click: 'The quote was changed after 1Click signed it.',
    intent_does_not_match_quote: 'The intent to be signed does not pay what was quoted.',
    refund_not_yours: 'Refunds would go to an address that is not yours.',
    expired: 'The quote has already expired.',
    too_short_to_review: 'The quote ends too soon to review it.',
    rpc_unavailable_or_disagree: 'The chain could not be read reliably, so this was not confirmed.',
    unreadable_amount: 'The amount could not be read.', unreadable_slippage: 'The slippage could not be read.',
    unreadable_deadline: 'The deadline could not be read.', add_public_key: 'It also adds a key that could sign for your account.',
    enclave_disagrees: 'The TEE reached a different verdict than this server.',
    attestation_unavailable: 'No receipt came back from the TEE in time.'
  };
  var S = { connector: null, wallet: null, walletName: '', owner: null, activity: [], holds: [], filter: 'all', modal: null, msg: '', loaded: false, ready: false };

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function mark(size) { size = size || 28; return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="9" fill="var(--mark-bg)"/><path d="M8.5 11.5h15" stroke="var(--mark-fg)" stroke-width="2.6" stroke-linecap="round"/><path d="M23.5 20.5h-14M13.5 16.5l-4 4 4 4" stroke="var(--mark-ac)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'; }
  function stamp(v) { return '<span class="stamp ' + esc(v) + '"><i></i>' + esc(v) + '</span>'; }
  function ago(iso) { var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : new Date(iso).toLocaleDateString(); }
  function why(code) { return WHY[code] || String(code || '').replace(/_/g, ' '); }
  function headline(v) { return v === 'REFUSED' ? 'Refused. Nothing was signed.' : v === 'HOLD' ? 'Held for you. Nothing is signed unless you approve it.' : 'Cleared. Every part matches what you allowed.'; }
  function b64ToBytes(b) { var s = atob(b), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  async function api(path, body) {
    var r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.reason || j.error || ('HTTP ' + r.status));
    return j;
  }

  /* ---------- data ---------- */
  /**
   * One row per check, newest first. A hold attaches to the newest check of its request (after an approval
   * the guard checks again, which records the same request twice). A hold with no recorded check still shows,
   * so nothing waiting for the owner is ever hidden.
   */
  function items() {
    var used = {}, seen = {};
    // The guard checks a request again after the owner approves it: show the request once, as its newest check.
    var latest = S.activity.filter(function (a) { if (a.request_hash && seen[a.request_hash]) return false; seen[a.request_hash] = true; return true; });
    var list = latest.map(function (a) {
      var h = S.holds.filter(function (y) { return !used[y.id] && y.review && y.review.request_hash === a.request_hash; })[0] || null;
      if (h) used[h.id] = true;
      return { a: a, h: h };
    });
    S.holds.forEach(function (h) { if (!used[h.id]) list.push({ a: null, h: h }); });
    list.sort(function (x, y) {
      var px = x.h && x.h.status === 'pending' ? 1 : 0, py = y.h && y.h.status === 'pending' ? 1 : 0;
      if (px !== py) return py - px;
      return String((y.a || y.h).at || y.h.created).localeCompare(String((x.a || x.h).at || x.h.created));
    });
    return list;
  }
  function idOf(x) { return x.h && x.h.status === 'pending' ? 'hold-' + x.h.id : x.a ? 'a-' + x.a.id : 'hold-' + x.h.id; }
  function verdictOf(x) { return x.a ? x.a.verdict : 'HOLD'; }
  function pending() { return S.holds.filter(function (h) { return h.status === 'pending'; }).length; }
  async function load() {
    if (!S.owner) return;
    try {
      var r = await Promise.all([api('/v1/activity?owner=' + encodeURIComponent(S.owner)), api('/v1/holds?owner=' + encodeURIComponent(S.owner))]);
      S.activity = r[0].activity || []; S.holds = r[1].holds || []; S.loaded = true;
    } catch (e) { S.msg = 'Could not reach Readback: ' + e.message; }
    draw();
  }

  /* ---------- sentence and notes ---------- */
  function readback(x, key) {
    var a = x.a, checks = a ? a.checks || {} : {}, whyMap = a ? a.why || {} : {};
    if (!a || !a.sentence) return '<p class="rb-s xl">' + esc(x.h ? x.h.review.sentence : '') + '</p>';
    var n = 0, notes = [], covered = {}, html = '';
    a.sentence.parts.forEach(function (p) {
      var st = p.status && p.status !== 'ok' ? p.status : null;
      if (!st) { html += p.checks && p.checks.length ? '<span class="tk on ok">' + esc(p.text) + '</span>' : esc(p.text); return; }
      n++;
      var failing = (p.checks || []).filter(function (c) { return checks[c] && checks[c] !== 'ok'; });
      failing.forEach(function (c) { covered[c] = true; });
      notes.push({ n: n, s: st, ids: failing });
      var words = p.text.split(' '), last = words.pop(), head = words.length ? esc(words.join(' ')) + ' ' : '';
      var cls = st === 'error' ? 'warn' : st;
      html += '<span class="tk on ' + cls + (p.text.length > 24 && p.text.indexOf(' ') < 0 ? ' m' : '') + '" aria-describedby="nt-' + key + '-' + n + '">' + head + '<span class="nw" data-n="' + n + '">' + esc(last) + '</span></span>';
    });
    // Checks that fail without a word of their own (the quote signature, the enclave) still get a note.
    Object.keys(checks).forEach(function (c) { if (checks[c] !== 'ok' && !covered[c]) { n++; notes.push({ n: n, s: checks[c], ids: [c], loose: true }); } });
    var notesHtml = notes.length ? '<ol class="notes">' + notes.map(function (x2) {
      var cls = x2.s === 'error' ? 'warn' : x2.s;
      var label = x2.s === 'bad' ? 'Failed: ' : x2.s === 'warn' ? 'Needs your decision: ' : 'Not confirmed: ';
      var body = x2.ids.map(function (c) { return '<b>' + esc(label + (CHECKS[c] || c).toLowerCase()) + '.</b>' + esc(why(whyMap[c])) + ' <span class="cid">' + esc(c) + '</span>'; }).join('<br>');
      return '<li id="nt-' + key + '-' + x2.n + '"><span class="mk ' + cls + '">' + x2.n + '</span><span>' + (body || '<b>Marked.</b>') + '</span></li>';
    }).join('') + '</ol>' : '<ul class="notes clean"><li><span><b>No marks.</b>Every part of this request matches what you allowed.</span></li></ul>';
    return '<div class="rb"><p class="rb-s xl">' + html + '</p>' + notesHtml + '</div>';
  }
  function ledger(a) {
    var c = a.checks || {}, order = { bad: 0, error: 1, warn: 2, ok: 3 };
    var ids = Object.keys(c).sort(function (x, y) { return (order[c[x]] - order[c[y]]) || x.localeCompare(y); });
    return '<div class="ledger">' + ids.map(function (id) {
      var s = c[id], sym = s === 'ok' ? '✓' : s === 'bad' ? '✕' : '!', cls = s === 'error' ? 'warn' : s;
      return '<div class="lrow"><span class="sym ' + cls + '">' + sym + '</span><div><div class="n">' + esc(CHECKS[id] || id) + '</div><div class="d">' + esc(s === 'ok' ? 'Passed' : why((a.why || {})[id])) + '</div></div><span class="id">' + esc(id) + '</span></div>';
    }).join('') + '</div>';
  }

  /* ---------- views ---------- */
  function header() {
    var pc = pending();
    var acct = S.owner
      ? '<div class="acctwrap"><button class="acct-btn" data-act="signout" title="Disconnect"><span class="dot"></span><b>' + esc(S.owner) + '</b><span class="wn">' + esc(S.walletName) + '</span><span aria-hidden="true">×</span></button></div>'
      : '<div class="acctwrap"><button class="btn solid sm" data-act="connect"' + (S.ready ? '' : ' disabled') + '>Sign in</button></div>';
    return '<header class="appbar"><div class="wrap"><a class="brand" href="#">' + mark(30) + '<span>Readback</span></a><nav class="tabs" aria-label="App"><a href="#" aria-current="page">Queue' + (pc ? ' <span class="count">' + pc + '</span>' : '') + '</a></nav>' + acct + '</div></header>';
  }
  function signedOut() {
    return '<main class="app"><div class="sheet pad stack" style="max-width:760px;margin:clamp(24px,8vh,96px) auto;gap:22px"><span class="eyebrow">Your agents\' payments</span>' +
      '<h2>Every payment, read back to you before it is signed.</h2>' +
      '<p class="read" style="font-size:20px;color:var(--ink2)">Sign in with the NEAR account that signed your mandate. You will see each payment your agents asked for as one sentence, with anything wrong marked, and the payments held for you to decide.</p>' +
      '<ul class="cm-facts"><li><b>Signing in signs nothing.</b> Readback only asks your wallet to sign when you approve a held payment, and shows you the exact text first.</li><li><b>Your keys stay in your wallet.</b></li><li><b>Approvals are checked twice.</b> Your agent verifies your signature itself before it pays.</li></ul>' +
      '<div class="row"><button class="btn solid" data-act="connect"' + (S.ready ? '' : ' disabled') + '>Sign in with a NEAR wallet</button>' + (S.msg ? '<span class="mono" style="color:var(--red)">' + esc(S.msg) + '</span>' : '') + '</div></div></main>';
  }
  function strips(list, sel) {
    var f = S.filter;
    var shown = list.filter(function (x) { return f === 'all' ? true : f === 'open' ? x.h && x.h.status === 'pending' : verdictOf(x) === f; });
    return '<div class="queue"><div class="qhead"><h3>Queue</h3><span class="mono muted">' + pending() + ' waiting for you</span></div>' +
      '<div class="filters" role="group" aria-label="Filter">' + [['all', 'All'], ['open', 'Waiting'], ['REFUSED', 'Refused'], ['HOLD', 'Held'], ['CLEARED', 'Cleared']].map(function (c) { return '<button class="chip" data-act="filter" data-id="' + c[0] + '" aria-pressed="' + (f === c[0]) + '">' + c[1] + '</button>'; }).join('') + '</div>' +
      (shown.length ? shown.map(function (x) {
        var v = verdictOf(x), a = x.a, h = x.h, id = idOf(x);
        var whyLine = h && h.status === 'pending' ? 'Waiting for you, ' + esc(Math.max(0, Math.round((Date.parse(h.expires) - Date.now()) / 60000))) + ' min left'
          : h ? 'You ' + (h.status === 'approved' ? 'approved' : h.status === 'refused' ? 'refused' : 'did not answer') + ' this'
          : a && v !== 'CLEARED' ? esc(why((a.why || {})[Object.keys(a.checks || {}).filter(function (k) { return a.checks[k] === 'bad'; })[0] || Object.keys(a.checks || {}).filter(function (k) { return a.checks[k] !== 'ok'; })[0]] || a.reason))
          : 'All checks passed';
        var text = a && a.sentence ? a.sentence.text : h ? h.review.sentence : '';
        return '<a class="strip' + (h && h.status !== 'pending' ? ' done' : '') + '" href="#' + id + '"' + (sel === id ? ' aria-current="true"' : '') + '><span class="bar ' + esc(v) + '"></span><div><div class="who">' + esc(a ? a.agent : h.agent) + ' · ' + esc(ago(a ? a.at : h.created)) + (a && a.receipt ? ' · TEE ✓' : '') + '</div><div class="what">' + esc(text.length > 70 ? text.slice(0, 68) + '…' : text) + '</div><div class="why">' + whyLine + '</div></div><span class="word ' + esc(v) + '">' + esc(v) + '</span></a>';
      }).join('') : '<div class="note">' + (S.loaded ? 'Nothing yet. Payments your agents ask about appear here.' : 'Loading…') + '</div>') + '</div>';
  }
  function receipt(a) {
    if (!a.receipt) return '<p class="muted">' + (a.checks && a.checks.enclave ? 'No verified receipt for this check: ' + esc(why((a.why || {}).enclave)) : 'This check ran on the Readback server only, not in the TEE.') + '</p><div class="kv" style="margin-top:12px"><span class="k">Engine</span><span class="v">sha256:' + esc(a.engine_sha256) + '</span></div>';
    var r = a.receipt;
    return '<div class="kv"><span class="k">Ran in</span><span class="v">OutLayer TEE (Intel TDX), project ' + esc(r.project_id) + '</span><span class="k">Module</span><span class="v">sha256:' + esc(r.wasm_sha256) + '</span><span class="k">Task</span><span class="v">' + esc(r.task_id) + '</span><span class="k">Input</span><span class="v">sha256:' + esc(r.input_hash) + '</span><span class="k">Output</span><span class="v">sha256:' + esc(r.output_hash) + '</span><span class="k">Quote binds</span><span class="v">' + esc(r.task_hash) + '</span></div>' +
      '<div class="stack" style="gap:8px;margin-top:14px"><span class="eyebrow">Check it yourself</span><div class="raw wrapit">outlayer-verify job ' + esc(r.task_id) + ' --api https://api.outlayer.ai</div><div class="row"><button class="btn quiet sm" data-act="copy" data-text="outlayer-verify job ' + esc(r.task_id) + ' --api https://api.outlayer.ai">Copy command</button><a class="link" href="' + esc(r.attestation_url) + '" target="_blank" rel="noopener noreferrer">Attestation record</a></div></div>';
  }
  function actions(x) {
    var h = x.h;
    if (!h) return x.a && x.a.verdict === 'HOLD' ? '<div class="decided"><span class="stamp HOLD"><i></i>Held</span><span>Your agent did not ask you about this one, so it was not sent.</span></div>' : '';
    if (h.status === 'pending') {
      var left = Math.max(0, Math.round((Date.parse(h.expires) - Date.now()) / 60000));
      return '<div class="actions"><span class="msg">Your agent is waiting. ' + left + ' min left to decide.</span><div class="row"><button class="btn quiet" data-act="refuse" data-id="' + esc(h.id) + '">Refuse</button><button class="btn solid" data-act="review" data-id="' + esc(h.id) + '">Read and approve</button></div></div>';
    }
    var label = h.status === 'approved' ? 'You approved this with your wallet. Your agent checked your signature before paying.' : h.status === 'refused' ? 'You refused this. Nothing was signed.' : 'Nobody answered in time, so nothing was signed.';
    return '<div class="decided"><span class="stamp ' + (h.status === 'approved' ? 'CLEARED' : 'REFUSED') + '"><i></i>' + esc(h.status) + '</span><span>' + esc(label) + '</span></div>';
  }
  function detail(x) {
    if (!x) return '<div class="sheet doc"><p class="muted">Select a payment.</p></div>';
    var a = x.a, h = x.h, v = verdictOf(x), key = (a ? a.id : h.id).replace(/[^a-z0-9]/gi, '');
    var recipient = a ? a.recipient : h.review.recipient;
    return '<div class="sheet doc"><div class="doc-head"><div class="row"><a class="link backlink" href="#">← Queue</a><span class="eyebrow">' + esc(a ? a.agent : h.agent) + ' · ' + esc(ago(a ? a.at : h.created)) + (a ? ' · mandate ' + esc(a.mandate_id) : '') + '</span></div>' + stamp(v) + '</div>' +
      readback(x, key) +
      '<div class="verdictline"><p class="vtxt" style="font-size:16px;color:var(--ink)">' + esc(h && h.status === 'pending' ? 'Held for you. Your agent is waiting for your answer.' : headline(v)) + '</p></div>' +
      (recipient ? '<div class="allowed"><span class="eyebrow">Full recipient address</span><div class="mono" style="font-size:14px;margin-top:8px;overflow-wrap:anywhere">' + esc(recipient) + '</div></div>' : '') +
      '<div style="margin-top:28px">' +
      (a ? '<details class="fold"><summary>All ' + Object.keys(a.checks || {}).length + ' checks</summary><div>' + ledger(a) + '</div></details>' : '') +
      (a ? '<details class="fold"' + (a.receipt ? '' : '') + '><summary>Receipt' + (a.receipt ? ' · checked in the TEE' : '') + '</summary><div>' + receipt(a) + '</div></details>' : '') +
      '<details class="fold"><summary>Request</summary><div class="stack" style="gap:8px"><div class="mono muted" style="overflow-wrap:anywhere">request sha256:' + esc(a ? a.request_hash : h.review.request_hash) + '</div>' + (a && a.quote_hash ? '<div class="mono muted" style="overflow-wrap:anywhere">quote ' + esc(a.quote_hash) + '</div>' : '') + '</div></details>' +
      '</div>' + actions(x) + '</div>';
  }
  function reviewModal(h) {
    return '<div class="scrim" data-act="closemodal"><div class="modal" role="dialog" aria-modal="true" aria-label="Approve this payment" style="max-width:620px">' +
      '<span class="eyebrow">Read this before you sign · ' + esc(S.walletName) + '</span>' +
      '<h3>Your wallet will show exactly this text.</h3>' +
      '<div class="raw wrapit" style="font-size:13.5px">' + esc(h.message) + '</div>' +
      '<p class="muted" style="font-size:14px">This is a signed message, not a transaction: it moves nothing by itself. Your agent pays only after it checks this signature against the key that signed your mandate. Signed for <span class="mono">' + esc(h.recipient) + '</span>.</p>' +
      (S.modal.err ? '<p class="mono" style="color:var(--red)">' + esc(S.modal.err) + '</p>' : '') +
      '<div class="row spread"><button class="btn quiet" data-act="closemodal">Cancel</button><button class="btn go" data-act="approve" data-id="' + esc(h.id) + '"' + (S.modal.busy ? ' disabled' : '') + '>' + (S.modal.busy ? 'Waiting for your wallet…' : 'Sign and approve') + '</button></div></div></div>';
  }

  function draw() {
    var root = document.getElementById('root'), modal = document.getElementById('modal');
    if (!S.owner) { root.innerHTML = header() + signedOut(); modal.innerHTML = ''; return; }
    var list = items(), sel = location.hash.slice(1);
    var x = list.filter(function (i) { return idOf(i) === sel || (i.h && 'hold-' + i.h.id === sel) || (i.a && 'a-' + i.a.id === sel); })[0];
    var chosen = x || list[0];
    root.innerHTML = header() + '<main class="app">' + (S.msg ? '<div class="frozen" role="status">' + esc(S.msg) + '</div>' : '') +
      '<div class="split" data-view="' + (x ? 'detail' : 'list') + '">' + strips(list, chosen ? idOf(chosen) : '') + '<div class="detail">' + detail(chosen) + '</div></div></main>';
    var h = S.modal && S.holds.filter(function (y) { return y.id === S.modal.id; })[0];
    modal.innerHTML = h && h.status === 'pending' ? reviewModal(h) : '';
    if (S.modal && (!h || h.status !== 'pending')) S.modal = null;
  }

  /* ---------- wallet ---------- */
  async function initWallet() {
    try {
      var manifest = await (await fetch('manifest.json')).json();
      S.connector = new window.NearConnector({ network: 'mainnet', manifest: manifest, features: { signMessage: true } });
      S.connector.on('wallet:signIn', async function (e) { S.wallet = await S.connector.wallet(); S.walletName = (S.wallet.manifest && S.wallet.manifest.name) || 'your wallet'; S.owner = e.accounts && e.accounts[0] && e.accounts[0].accountId; load(); });
      S.connector.on('wallet:signOut', function () { S.wallet = null; S.owner = null; S.activity = []; S.holds = []; draw(); });
      S.ready = true;
      try { var w = await S.connector.wallet(); var acc = await w.getAccounts(); if (acc && acc[0] && acc[0].accountId) { S.wallet = w; S.walletName = (w.manifest && w.manifest.name) || 'your wallet'; S.owner = acc[0].accountId; } } catch (e) { /* not signed in */ }
    } catch (e) { S.msg = 'The wallet library did not load: ' + e.message; }
    draw(); load();
  }
  async function approve(id) {
    var h = S.holds.filter(function (y) { return y.id === id; })[0];
    if (!h || !S.wallet) return;
    S.modal.busy = true; S.modal.err = ''; draw();
    var signed;
    try { signed = await S.wallet.signMessage({ message: h.message, recipient: h.recipient, nonce: b64ToBytes(h.nonce) }); }
    catch (e) { S.modal.busy = false; S.modal.err = 'Your wallet did not sign: ' + (e.message || e); draw(); return; }
    try {
      await api('/v1/holds/' + encodeURIComponent(id) + '/approve', { publicKey: signed.publicKey, signature: signed.signature, accountId: signed.accountId });
      S.modal = null;
    } catch (e) { S.modal.busy = false; S.modal.err = 'Readback did not accept it: ' + e.message.replace(/_/g, ' '); }
    load();
  }

  /* ---------- events ---------- */
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    if (act === 'closemodal' && t !== ev.target && t.classList.contains('scrim')) return;
    if (act === 'connect' && S.connector) S.connector.connect();
    else if (act === 'signout' && S.wallet) S.connector.disconnect(S.wallet);
    else if (act === 'filter') { S.filter = id; draw(); }
    else if (act === 'review') { S.modal = { id: id, busy: false, err: '' }; draw(); }
    else if (act === 'closemodal') { S.modal = null; draw(); }
    else if (act === 'approve') approve(id);
    else if (act === 'refuse') api('/v1/holds/' + encodeURIComponent(id) + '/refuse', {}).then(load, function (e) { S.msg = e.message; draw(); });
    else if (act === 'copy') { navigator.clipboard.writeText(t.getAttribute('data-text')).then(function () { t.textContent = 'Copied'; }); }
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && S.modal && !S.modal.busy) { S.modal = null; draw(); } });
  window.addEventListener('hashchange', draw);
  setInterval(function () { if (!S.modal || !S.modal.busy) load(); }, 3000);
  draw();
  initWallet();
})();
