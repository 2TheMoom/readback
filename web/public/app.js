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
  /** What a failed or held check means, in a few words: the note's headline. */
  var FAIL = {
    quote_sig: 'Quote changed after 1Click signed it', payee: 'Not a saved payee', lookalike: 'Looks like a saved payee', amount: 'Over the cap',
    fees: 'High fees', slippage: 'Slippage over your limit', route: 'Not a route you allowed', format: 'Wrong address for this chain',
    curve: 'Nobody can hold this address', contract: 'The destination is a contract', mint: 'The destination is a token address', tag: 'Needs a destination tag',
    intents: 'Something extra in the batch', intent_binding: 'The intent does not match the quote', refund: 'The refund is not yours', timing: 'Not enough time to review',
    enclave: 'The TEE did not confirm it'
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
      var body = x2.ids.map(function (c) { return '<b>' + esc(x2.s === 'error' ? 'Could not confirm: ' + (CHECKS[c] || c).toLowerCase() : FAIL[c] || CHECKS[c] || c) + '.</b>' + esc(why(whyMap[c])) + ' <span class="cid">' + esc(c) + '</span>'; }).join('<br>');
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
    return '<header class="appbar"><div class="wrap"><a class="brand" href="#home">' + mark(30) + '<span>Readback</span></a><nav class="tabs" aria-label="App"><a href="#queue" aria-current="page">Queue' + (pc ? ' <span class="count">' + pc + '</span>' : '') + '</a></nav>' + acct + '</div></header>';
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
    return '<div class="sheet doc"><div class="doc-head"><div class="row"><a class="link backlink" href="#queue">← Queue</a><span class="eyebrow">' + esc(a ? a.agent : h.agent) + ' · ' + esc(ago(a ? a.at : h.created)) + (a ? ' · mandate ' + esc(a.mandate_id) : '') + '</span></div>' + stamp(v) + '</div>' +
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

  /* ---------- site ---------- */
  var GROUPS = [
    ['Who gets paid?', ['payee', 'lookalike']],
    ['How much?', ['amount', 'fees', 'slippage']],
    ['Where does it land?', ['route', 'format', 'curve', 'contract', 'mint', 'tag']],
    ['What else is in it?', ['quote_sig', 'intents', 'intent_binding', 'refund', 'timing', 'enclave']]
  ];
  var CHECK_WHY = {
    payee: 'Money only goes to addresses you saved for this mandate.', lookalike: 'Catches addresses that copy the start and end of one you trust, on every chain, including NEAR names one letter apart.',
    amount: 'An agent cannot pay more per payment than you allowed.', fees: 'Fees are shown and held when they are a large share of the payment.', slippage: 'Stops an agent from accepting a bad price.',
    route: 'The token and chain are on your mandate, and the money really pays out instead of staying inside NEAR Intents under a name anyone could claim.',
    format: 'Many chains share one address format, so a valid-looking address is not enough.', curve: 'Nobody holds a key for an off-curve address; on NEAR the named account must exist.',
    contract: 'A contract may have no way to send funds back.', mint: 'Tokens sent to a token address are usually lost.', tag: 'Some exchange addresses need a destination tag that cannot be sent.',
    quote_sig: '1Click signs every quote. Change the recipient or the amounts afterwards and the signature breaks.', intents: 'A batch can hide add_public_key, which hands over the account.',
    intent_binding: 'The intent you sign must pay exactly the quoted deposit address, token and amount.', refund: 'If a swap fails, the refund must come back to you.',
    timing: 'Short quotes rush you, and a signed intent stays valid for days.', enclave: 'The same check, rerun inside OutLayer\'s TEE, must agree, and comes back with a receipt anyone can verify.'
  };
  var SITE = [['how', 'How it reads'], ['checks', 'Checks'], ['break', 'Break it'], ['verify', 'Verify'], ['developers', 'Developers']];
  /** A real attestation: vector V01 in OutLayer's TEE, proven by outlayer-verify (docs/outlayer). */
  var SAMPLE = { task_id: 1239345, project_id: 'readback.near/readback', wasm_sha256: '89a21ea9327a39899e44d60de66caa6d9ab2845f695ffe5f7489fbdb431e5d69', input_hash: 'b7b8d6289a4b873bdf1f181a1208d452a5bf2344fa4f342443c4ca9df747d076', output_hash: '8cc86b9b155a9268f9aef8a02e1174316df6da073ac9344140ef4d4d8d1b783d' };
  var D = { cases: null, results: {}, sel: null, busy: null, summary: null, examples: {}, verify: { task: String(SAMPLE.task_id), result: null, busy: false } };

  function site(route, body) {
    return '<header class="top"><div class="wrap"><a class="brand" href="#home">' + mark(30) + '<span>Readback</span></a><nav class="nav" aria-label="Site">' + SITE.map(function (l) { return '<a href="#' + l[0] + '"' + (route === l[0] ? ' aria-current="page"' : '') + '>' + l[1] + '</a>'; }).join('') + '</nav><a class="btn solid sm" href="#queue">Open your queue</a></div></header>' +
      body + '<footer class="foot"><div class="wrap row spread"><div class="row">' + mark(22) + '<span>Readback, built for NEAR HACKATHON 2026. Every example on this site is a real signed 1Click quote run through the live engine.</span></div><span class="mono">Fixed rules decide. No model in the verdict path.</span></div></footer>';
  }
  function sec(eyebrow, title, lede, inner) { return '<section class="sec"><div class="wrap"><div class="sec-head"><div class="stack"><span class="eyebrow">' + eyebrow + '</span><h2>' + title + '</h2></div><p>' + lede + '</p></div>' + inner + '</div></section>'; }
  function example(caseId, size) {
    var r = D.examples[caseId];
    if (!r) return '<div class="sheet pad ghost" style="min-height:180px"></div>';
    return readback({ a: r }, 'ex' + caseId.replace(/[^a-z]/g, '')).replace('rb-s xl', 'rb-s ' + (size || 'xl'));
  }
  function phrGrid(full) {
    return '<div class="phr">' + GROUPS.map(function (g) { return '<div class="col"><span class="q">' + g[0] + '</span><ul>' + g[1].map(function (k) { return '<li><b>' + esc(CHECKS[k]) + '</b>' + (full ? esc(CHECK_WHY[k]) + ' <span class="mono muted">' + k + '</span>' : '') + '</li>'; }).join('') + '</ul></div>'; }).join('') + '</div>';
  }
  function sampleReceipt() {
    return '<div class="receipt"><div class="row spread" style="margin-bottom:18px"><span class="eyebrow">Receipt · vector V01</span>' + stamp('CLEARED') + '</div><div class="kv"><span class="k">Ran in</span><span class="v">OutLayer TEE, Intel TDX</span><span class="k">Project</span><span class="v">' + SAMPLE.project_id + '</span><span class="k">Module</span><span class="v">sha256:' + SAMPLE.wasm_sha256.slice(0, 16) + '…</span><span class="k">Input</span><span class="v">sha256:' + SAMPLE.input_hash.slice(0, 16) + '…</span><span class="k">Output</span><span class="v">sha256:' + SAMPLE.output_hash.slice(0, 16) + '…</span></div><div class="row spread" style="margin-top:44px"><span class="mono muted">task ' + SAMPLE.task_id + '</span><a class="link" href="#verify">Verify it</a></div></div>';
  }
  function pageHome() {
    var hero = '<section class="hero"><div class="wrap"><div class="hero-top"><div class="stack" style="gap:22px"><span class="eyebrow">For anyone whose agents move money</span><h1>Every agent payment, <em>read back</em> before it is signed.</h1></div><div class="stack" style="gap:20px"><p>Pilots read a clearance back before they act on it. Readback does that for your agents: each payment becomes one plain sentence, anything that does not match what you allowed is marked, and the verdict comes with a receipt from a TEE.</p><div class="row"><a class="btn solid" href="#queue">Open your queue</a><a class="btn" href="#break">Try to break it</a></div></div></div>' +
      '<div class="sheet pad"><div class="sheet-head"><span class="eyebrow">A real 1Click quote, edited by an attacker · vector V02</span>' + (D.examples.lookalike ? stamp(D.examples.lookalike.verdict) : '') + '</div>' + example('lookalike') + '</div></div></section>';
    var facts = sec('Why this goes wrong', 'Agent payments are easy to get almost right.', 'NEAR Intents lets an agent pay across dozens of chains in one request. The details that decide whether money arrives are the ones nobody reads.',
      '<div class="facts"><div class="fact"><b>3</b><span>days a signed intent stays valid on a live 1Click quote. A long time to regret a signature.</span><small>Readback live runs, Nov 2026</small></div><div class="fact"><b>1</b><span>quote 1Click signed, paying out to a NEAR address nobody can ever hold the key for.</span><small>vector N05, real signed quote</small></div><div class="fact"><b>2 / 3</b><span>times a real model, told the invoice changed, tried to pay 25 USDC instead of 2. Readback held both.</span><small>attack demo, NEAR AI Cloud</small></div><div class="fact"><b>65 / 65</b><span>checks proven to have run, unchanged, inside Intel TDX by OutLayer\'s own verifier.</span><small>outlayer-verify, Nov 2026</small></div></div>');
    var how = sec('How it reads', 'Request in. One sentence out.', 'Readback sits between your agent and its signer. It never holds your keys and never moves funds.',
      '<div class="steps3">' + [['01', 'The agent asks', 'It gets a 1Click quote and the intent to sign, then sends both to Readback before signing.'], ['02', 'Readback reads it', 'Seventeen fixed checks against the mandate you signed, on live chain data from two RPCs, rerun inside a TEE.'], ['03', 'You read one sentence', 'Cleared payments go. Held ones wait for you to approve with your wallet. Refused ones never reach the signer.']].map(function (s) { return '<div class="st"><span>' + s[0] + '</span><h3>' + s[1] + '</h3><p class="muted">' + s[2] + '</p></div>'; }).join('') + '</div><div style="margin-top:28px"><a class="link" href="#how">See the full flow</a></div>');
    var answers = sec('Three answers', 'Cleared. Hold. Refused.', 'The same request always gets the same answer, because fixed rules decide it. No model is in the verdict path.',
      '<div class="answers">' + [['genuine', 'You still sign, and you know exactly what.'], ['cap', 'Nothing malicious, but over a limit you set. It waits for you.'], ['add-key', 'Something in it should never be signed. It never reaches the signer.']].map(function (a) { var r = D.examples[a[0]]; return '<div class="sheet answer">' + (r ? stamp(r.verdict) : '') + (r ? example(a[0], 'md') : '<div class="ghost" style="min-height:120px"></div>') + '<p class="muted" style="font-size:14px">' + a[1] + '</p></div>'; }).join('') + '</div>');
    var phr = sec('Checks', 'Four questions, seventeen checks.', 'Every check guards one part of the sentence. If one fails, the word it guards is marked.', phrGrid(false) + '<div style="margin-top:28px"><a class="link" href="#checks">Read every check</a></div>');
    var proof = '<section class="sec"><div class="wrap"><div class="grid2" style="align-items:center;gap:48px"><div class="stack"><span class="eyebrow">Proof</span><h2>The verdict comes with a receipt.</h2><p class="muted" style="font-size:17.5px">Each check runs again inside OutLayer\'s TEE on Intel TDX. The receipt names the exact module, input and output, and the hardware quote commits to all three, so anyone can check it without trusting us.</p><div><a class="btn" href="#verify">Verify a real receipt</a></div></div>' + sampleReceipt() + '</div></div></section>';
    var s = D.summary;
    var brk = '<section class="sec"><div class="wrap"><div class="sheet pad" style="background:var(--ink);color:var(--sheet);border-color:var(--ink)"><div class="grid2" style="align-items:end;gap:40px"><div class="stack"><span class="eyebrow" style="color:inherit;opacity:.6">Break it</span><h2>Try to get an attack past it.</h2><p style="opacity:.75;font-size:17px">Lookalike addresses, edited quotes, hidden keys, a memo that talks to the checker. Each one is a real signed request, run through the live engine and the TEE while you watch.</p></div><div class="stack" style="gap:18px"><div class="stats" style="border-top-color:currentColor;grid-template-columns:repeat(2,minmax(0,1fr))"><div><b>' + (s ? s.attempts.toLocaleString() : '…') + '</b><span style="color:inherit;opacity:.6">attempts</span></div><div style="border-left-color:rgba(127,127,127,.35);border-top:0;padding-left:16px"><b>' + (s ? s.breaks : '…') + '</b><span style="color:inherit;opacity:.6">attacks cleared</span></div></div><div class="row"><a class="btn inv" href="#break">Start an attempt</a></div></div></div></div></div></section>';
    var faq = sec('Questions', 'Before you ask.', '', [['Can Readback move my money?', 'No. It reads a request and returns a verdict. Your agent signs with its own key, scoped to one contract, and only after Readback clears it or you approve.'],
      ['What if Readback is down?', 'The agent fails closed: no answer, or an answer about a different request or mandate, counts as refused.'],
      ['Could a compromised Readback server approve a payment?', 'No. When you approve a held payment, your agent checks your wallet signature itself, over its own copy of the text, with the key that signed your mandate. The server can delay a payment, never approve one.'],
      ['Does an AI decide the verdict?', 'No. Seventeen fixed rules decide it, the same way every time. The engine is a 214 KB WebAssembly module, and its exact build is what runs in the TEE.'],
      ['What does it not catch?', 'A saved payee whose own keys were stolen, a payment that passes every rule and is still a bad idea, and anything outside the seventeen checks.']].map(function (q) { return '<details class="faq"><summary>' + q[0] + '</summary><p>' + q[1] + '</p></details>'; }).join(''));
    return site('home', hero + facts + how + answers + phr + proof + brk + faq);
  }
  function pageHow() {
    var steps = [['01', 'The owner signs a mandate', 'Payees, cap, chains, slippage, refund address, how long it lasts, and which account the agent pays from. Signed in your NEAR wallet as plain text you can read.'],
      ['02', 'The agent gets its own key', 'A function-call key that can call one method on intents.near and nothing else. It cannot add keys, deploy, or touch your account.'],
      ['03', 'Every payment is read back', 'Before signing, the agent sends the 1Click quote and the intent. Readback checks both against the mandate and live chain data from two independent RPCs.'],
      ['04', 'The TEE checks again', 'The same engine reruns inside OutLayer on Intel TDX. Its verdict must match, and it returns a receipt bound to the module, input and output.'],
      ['05', 'Cleared, held or refused', 'Cleared goes to the signer. Held waits in your queue. Refused never reaches the signer. Anything unexpected counts as refused.'],
      ['06', 'You approve in your wallet', 'A held payment is approved by signing its sentence in your wallet. Your agent verifies that signature itself before it pays.']];
    var grid = function (xs) { return '<div class="steps3">' + xs.map(function (s) { return '<div class="st"><span>' + s[0] + '</span><h3>' + s[1] + '</h3><p class="muted">' + s[2] + '</p></div>'; }).join('') + '</div>'; };
    return site('how', sec('How it reads', 'From payload to sentence.', 'Readback has one job: make what gets signed readable, and say plainly when it does not match what you allowed.', grid(steps.slice(0, 3)) + '<div style="margin-top:40px">' + grid(steps.slice(3)) + '</div>' +
      '<div class="note" style="margin-top:32px">What it does not do: hold your keys, move funds, retry swaps, or judge whether a payment is a good idea.</div>'));
  }
  function pageChecks() {
    return site('checks', sec('Checks', 'Every check, in plain words.', 'Seventeen rules, each guarding one part of the sentence. One failure is enough to mark it. Every one has test vectors built from real signed 1Click quotes.', phrGrid(true) +
      '<div class="sheet pad" style="margin-top:48px"><h3>Not covered</h3><ul class="muted" style="padding-left:20px;margin-top:12px;display:flex;flex-direction:column;gap:8px;font-size:16px"><li>A saved payee whose own keys have been stolen.</li><li>A payment that passes every rule and is still a bad idea.</li><li>How 1Click routes the swap after the deposit. Readback checks what is signed, not how solvers fill it.</li><li>Money already lost. Readback cannot recover anything.</li></ul></div>'));
  }
  function pageBreak() {
    var s = D.summary, cases = D.cases || [], r = D.sel && D.results[D.sel];
    var c = cases.filter(function (x) { return x.id === D.sel; })[0];
    var view = !c ? '<div class="sheet pad stack"><span class="eyebrow">The mandate you are attacking</span><p class="rb-s lg">invoice-bot may pay <span class="tk on ok">Acme</span> up to <span class="tk on ok">300 USDC</span> per payment, on Solana, with slippage under 0.5%. Everything else is held or refused.</p><p class="muted">Pick an attack. Each one is a real signed 1Click request with the attacker\'s edit, run through the live engine' + ' and, when the TEE is on, inside OutLayer.</p></div>'
      : D.busy === c.id ? '<div class="sheet pad"><div class="cm-center">' + '<p class="muted">Running ' + esc(c.name.toLowerCase()) + ' through the engine and the TEE…</p></div></div>'
      : r ? '<div class="sheet pad"><div class="sheet-head"><span class="eyebrow">Your attempt · ' + esc(c.name) + ' · vector ' + esc(r.vector) + '</span>' + stamp(r.verdict) + '</div>' + readback({ a: r }, 'atk') +
        '<div class="verdictline"><p class="vtxt">' + esc(r.verdict === 'REFUSED' ? 'Refused before any signature. Nothing moved.' : r.verdict === 'HOLD' ? 'Held for the owner. Nothing moved unless they approve it.' : 'Cleared. ' + (c.id === 'genuine' ? 'This is the untouched control: it should clear.' : 'An attack cleared. That would be a break.')) + '</p></div>' +
        '<details class="fold"><summary>All ' + Object.keys(r.checks).length + ' checks</summary><div>' + ledger(r) + '</div></details>' +
        '<details class="fold"><summary>Receipt' + (r.receipt ? ' · checked in the TEE' : '') + '</summary><div>' + (r.receipt ? receipt(r) : '<p class="muted">' + esc(r.enclave === 'off' ? 'The TEE is off on this server: this ran in the engine only.' : r.enclave === 'daily_limit' ? 'Today\'s TEE runs are used up: this ran in the engine only.' : 'No verified receipt: ' + why(r.enclave)) + '</p>') + '</div></details></div>'
      : '';
    var log = s ? '<div class="sheet pad"><div class="row spread" style="margin-bottom:8px"><h3>Public log</h3><span class="mono muted">newest first</span></div><div class="log">' + (s.recent.length ? s.recent.map(function (e) { var cc = cases.filter(function (x) { return x.id === e.case; })[0]; return '<div class="l"><span class="mono muted">' + esc(ago(e.at)) + '</span><span>' + esc(cc ? cc.name : e.case) + (e.enclave === 'checked' ? ' <span class="mono muted">TEE ✓</span>' : '') + '</span><span class="word ' + esc(e.verdict) + '">' + esc(e.verdict) + '</span></div>'; }).join('') : '<div class="note">No attempts yet.</div>') + '</div></div>' : '';
    return site('break', '<section class="sec"><div class="wrap"><div class="sec-head"><div class="stack"><span class="eyebrow">Break it</span><h2>Get an attack past Readback.</h2></div><p>Fourteen attacks, each a real signed request with one edit. Only the untouched control should clear. If any attack clears, that is a break, and it shows up in the count below.</p></div>' +
      '<div class="stats" style="margin-bottom:40px"><div><b>' + (s ? s.attempts.toLocaleString() : '…') + '</b><span>attempts</span></div><div><b>' + (s ? (s.by.REFUSED + s.by.HOLD).toLocaleString() : '…') + '</b><span>stopped before signing</span></div><div><b>' + (s ? s.breaks : '…') + '</b><span>attacks cleared</span></div><div><b>17</b><span>checks on every attempt</span></div></div>' +
      '<div class="split"><div class="atk" role="group" aria-label="Attacks">' + cases.map(function (a, i) { return '<button data-act="atk" data-id="' + esc(a.id) + '" aria-pressed="' + (D.sel === a.id) + '"><span class="num">' + (i < 9 ? '0' : '') + (i + 1) + '</span><span><b>' + esc(a.name) + '</b><span class="d">' + esc(a.desc) + '</span></span></button>'; }).join('') + '</div>' +
      '<div class="stack" aria-live="polite">' + view + log + '</div></div></div></section>');
  }
  function pageVerify() {
    var v = D.verify, r = v.result;
    var steps = r ? '<div class="ledger">' + r.steps.map(function (st) { return '<div class="lrow"><span class="sym ' + (st.ok ? 'ok' : 'bad') + '">' + (st.ok ? '✓' : '✕') + '</span><div><div class="n">' + esc(st.label) + '</div><div class="d" style="overflow-wrap:anywhere">' + esc(st.detail) + '</div></div><span class="id">' + esc(st.id) + '</span></div>'; }).join('') + '</div>' +
      '<div class="verdictline">' + (r.steps.every(function (x) { return x.ok; }) ? stamp('CLEARED') + '<p class="vtxt">Every check here passed' + (r.vector ? ', including the exact input and output of test vector ' + esc(r.vector) : '') + '.</p>' : stamp('REFUSED') + '<p class="vtxt">At least one check failed. Do not trust this receipt.</p>') + '</div>' +
      '<div class="stack" style="gap:8px;margin-top:18px"><span class="eyebrow">The last step, on your own machine</span><p class="muted" style="font-size:14px">Intel\'s signature chain and the approved enclave build are checked by OutLayer\'s open-source verifier, with Intel\'s root certificate compiled in.</p><div class="raw wrapit">' + esc(r.verify) + '</div><div class="row"><button class="btn quiet sm" data-act="copy" data-text="' + esc(r.verify) + '">Copy command</button><a class="link" href="https://github.com/out-layer/outlayer-verify" target="_blank" rel="noopener noreferrer">outlayer-verify</a></div></div>' : '';
    return site('verify', sec('Verify', 'Do not take our word for it.', 'Every check that runs in the TEE has a task id. Enter one to see what this server can confirm from the record and the hardware quote, then finish the check on your own machine.',
      '<div class="grid2" style="align-items:start;gap:32px"><div class="sheet pad stack"><div class="field"><label for="vtask">Task id</label><input id="vtask" value="' + esc(v.task) + '" inputmode="numeric" spellcheck="false" autocomplete="off"></div><div class="row"><button class="btn solid" data-act="verify"' + (v.busy ? ' disabled' : '') + '>' + (v.busy ? 'Checking…' : 'Verify') + '</button><span class="mono muted">1239345 is test vector V01</span></div>' + steps + '</div>' +
      '<div class="stack">' + sampleReceipt() + '<div class="sheet pad"><h4>What a pass does not prove</h4><ul class="muted" style="padding-left:20px;margin-top:10px;display:flex;flex-direction:column;gap:8px"><li>It shows which module ran. The module is reproducible from the source: build it and compare the sha256.</li><li>You still trust Intel and whoever approves OutLayer\'s worker builds.</li><li>It proves the check ran, not that the mandate was the right one.</li></ul></div></div></div>'));
  }
  function pageDevelopers() {
    var code = '<span class="k">import</span> { createGuard } <span class="k">from</span> <span class="s">\'readback/agent\'</span>\n\n<span class="k">const</span> guard = createGuard({\n  url: <span class="s">\'https://readback.example\'</span>,\n  agent: <span class="s">\'invoice-bot\'</span>,\n  signedMandate,            <span class="c">// the owner signed it in their wallet</span>\n  askHuman: webHuman({ url, signedMandate }),\n  requireEnclave: <span class="k">true</span>,     <span class="c">// refuse anything the TEE did not check</span>\n})\n\n<span class="k">const</span> d = <span class="k">await</span> guard.pay({ kind: <span class="s">\'intent\'</span>, quote, intent }, sign)\n<span class="c">// sign() runs at most once, only on CLEARED or an approved HOLD,\n// with a frozen copy of exactly what was checked.</span>\nd.outcome   <span class="c">// executed | held | refused | failed</span>\nd.note      <span class="c">// one plain line for the agent\'s model</span>\nd.receipt   <span class="c">// the TEE receipt, when there is one</span>';
    var api = '<span class="k">POST</span> /v1/readback\n{ <span class="s">"kind"</span>: <span class="s">"intent"</span>, <span class="s">"agent"</span>: <span class="s">"invoice-bot"</span>,\n  <span class="s">"quote"</span>: { <span class="c">/* signed 1Click quote */</span> }, <span class="s">"intent"</span>: { <span class="c">/* unsigned */</span> },\n  <span class="s">"signed_mandate"</span>: { <span class="s">"mandate"</span>: {…}, <span class="s">"signature"</span>: {…} } }\n\n<span class="c">// 200</span>\n{ <span class="s">"verdict"</span>: <span class="s">"REFUSED"</span>,\n  <span class="s">"checks"</span>: { <span class="s">"payee"</span>: <span class="s">"bad"</span>, <span class="s">"lookalike"</span>: <span class="s">"bad"</span>, … },\n  <span class="s">"why"</span>: { <span class="s">"lookalike"</span>: <span class="s">"lookalike_of_saved_payee"</span> },\n  <span class="s">"sentence"</span>: { <span class="s">"text"</span>: <span class="s">"invoice-bot asks to send…"</span>, <span class="s">"parts"</span>: […] },\n  <span class="s">"request_hash"</span>: <span class="s">"…"</span>, <span class="s">"mandate_fingerprint"</span>: <span class="s">"…"</span>,\n  <span class="s">"engine_sha256"</span>: <span class="s">"…"</span>, <span class="s">"receipt"</span>: { <span class="s">"task_id"</span>: 1239345, … } }';
    return site('developers', sec('Developers', 'One call before the signature.', 'The guard wraps your agent\'s signer. Readback answers about one exact request, and the guard refuses any answer that is about a different request, a different mandate, or does not add up.',
      '<div class="grid2" style="align-items:start;gap:28px"><div class="stack"><span class="eyebrow" style="color:var(--pen)">Agent side</span><h3>Wrap the signer.</h3><div class="code">' + code + '</div></div><div class="stack"><span class="eyebrow" style="color:var(--pen)">API</span><h3>Or call it directly.</h3><div class="code">' + api + '</div></div></div>' +
      '<div class="sheet pad" style="margin-top:40px"><div class="grid3"><div class="stack" style="gap:6px"><span class="eyebrow">Fails closed</span><p>No answer, a malformed answer or an answer about another request is refused.</p></div><div class="stack" style="gap:6px"><span class="eyebrow">Bound answers</span><p>Every answer carries the request hash and mandate fingerprint, and the guard recomputes both.</p></div><div class="stack" style="gap:6px"><span class="eyebrow">Your own key</span><p>The agent signs with a function-call key scoped to intents.near. Readback never sees it.</p></div></div></div>'));
  }
  async function loadSite(route) {
    try {
      if (route === 'home') {
        ['lookalike', 'genuine', 'cap', 'add-key'].forEach(function (id) { if (!D.examples[id]) api('/v1/demo/run', { case: id, record: false }).then(function (r) { D.examples[id] = r; draw(); }, function () {}); });
      }
      if (route === 'break' && !D.cases) D.cases = (await api('/v1/demo/cases')).cases;
      if (route === 'home' || route === 'break') D.summary = await api('/v1/demo/summary');
    } catch (e) { /* the page still renders without live numbers */ }
    draw();
  }
  async function runAttack(id) {
    D.sel = id; D.busy = id; draw();
    try { D.results[id] = await api('/v1/demo/run', { case: id }); D.summary = await api('/v1/demo/summary'); } catch (e) { D.results[id] = null; }
    D.busy = null; draw();
  }
  async function runVerify() {
    var el = document.getElementById('vtask'), t = (el ? el.value : D.verify.task).trim();
    D.verify.task = t;
    if (!/^\d{1,12}$/.test(t)) { D.verify.result = { steps: [{ id: 'input', label: 'A task id is a number', ok: false, detail: t }], verify: '' }; draw(); return; }
    D.verify.busy = true; draw();
    try { D.verify.result = await api('/v1/verify/' + t); } catch (e) { D.verify.result = { steps: [{ id: 'record', label: 'Could not reach Readback', ok: false, detail: e.message }], verify: '' }; }
    D.verify.busy = false; draw();
  }
  function routeOf() {
    var h = location.hash.slice(1);
    if (h === 'queue' || /^(a|hold)-/.test(h)) return 'queue';
    return SITE.some(function (s) { return s[0] === h; }) ? h : 'home';
  }

  function draw() {
    var root = document.getElementById('root'), modal = document.getElementById('modal');
    var route = routeOf();
    if (route !== 'queue') {
      var pages = { home: pageHome, how: pageHow, checks: pageChecks, break: pageBreak, verify: pageVerify, developers: pageDevelopers };
      root.innerHTML = pages[route](); modal.innerHTML = ''; return;
    }
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
    draw(); if (routeOf() === 'queue') load();
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
    else if (act === 'atk') runAttack(id);
    else if (act === 'verify') runVerify();
    else if (act === 'copy') { navigator.clipboard.writeText(t.getAttribute('data-text')).then(function () { t.textContent = 'Copied'; }); }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && S.modal && !S.modal.busy) { S.modal = null; draw(); }
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'vtask') runVerify();
  });
  window.addEventListener('hashchange', function () { draw(); var r = routeOf(); if (r !== 'queue') { loadSite(r); window.scrollTo(0, 0); } else load(); });
  // Only the queue polls: a redraw elsewhere would wipe what someone is typing.
  setInterval(function () { if (routeOf() === 'queue' && (!S.modal || !S.modal.busy)) load(); }, 3000);
  draw();
  if (routeOf() !== 'queue') loadSite(routeOf());
  initWallet();
})();
