// Readback HTTP API and the web app it serves.
//   POST /v1/readback               {kind, agent?, quote, intent?, signed_mandate} -> verdict, checks, sentence
//   GET  /v1/health                 -> {ok, engine_sha256, enclave}
//   GET  /v1/session/challenge?account=   nonce and exact text for the wallet to sign; POST /v1/session signs in
//   GET  /v1/activity               the signed-in owner's checks, newest first
//   POST /v1/holds                  the agent posts a held payment (agent/src/approval.ts)
//   GET  /v1/holds                  the signed-in owner's holds; GET /v1/holds/<id> one hold (the agent polls it)
//   POST /v1/holds/<id>/approve     {publicKey, signature[, accountId]}: the owner's NEP-413 signature
//   POST /v1/holds/<id>/refuse
//   GET  /v1/demo/cases             Break it: the attacks on offer; POST /v1/demo/run {case} replays one
//   GET  /v1/demo/summary           every attempt so far, by verdict
//   GET  /v1/verify/<task id>       checks one OutLayer attestation (src/demo.ts verifyTask)
//   GET  anything else              the web app, from web/public

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { readback } from './readback.ts';
import { engineSha256 } from './engine.ts';
import type { Attested } from './outlayer.ts';
import type { Inbox } from './inbox.ts';
import { verifyTask, type createDemo } from './demo.ts';
import type { Fetch } from './rpc.ts';
import { COOKIE, signInText, type Sessions } from './session.ts';

const MAX_BODY = 256 * 1024;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export interface AppOptions {
  fetch: Fetch; inbox: Inbox; demo?: ReturnType<typeof createDemo>; attest?: (input: unknown) => Promise<Attested>; enclave?: string | null;
  webDir?: string; origins?: string[]; sessions: Sessions;
  /** Public address of the site, signed into the sign-in text; defaults to the request's own host. */
  site?: string;
  /** Requests per minute per client on the endpoints that cost something (checks, TEE runs, RPC reads, sign-ins). */
  rateLimit?: number; trustProxy?: boolean;
}

/** A fixed one-minute window per client. In memory: one server process. */
function limiter(perMinute: number) {
  const seen = new Map<string, { n: number; reset: number }>();
  return (key: string) => {
    const t = Date.now(), e = seen.get(key);
    if (!e || e.reset < t) { if (seen.size > 50_000) seen.clear(); seen.set(key, { n: 1, reset: t + 60_000 }); return true; }
    return ++e.n <= perMinute;
  };
}

export function createApp(o: AppOptions) {
  const allow = limiter(o.rateLimit ?? 30);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const send = (code: number, body: unknown) => {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      const origin = req.headers.origin;
      if (origin && o.origins?.includes(origin)) { headers['access-control-allow-origin'] = origin; headers['vary'] = 'origin'; }
      res.writeHead(code, headers);
      res.end(JSON.stringify(body));
    };
    const body = async (): Promise<any> => {
      let size = 0; const chunks: Buffer[] = [];
      for await (const c of req) { size += c.length; if (size > MAX_BODY) throw Object.assign(new Error('too large'), { code: 413 }); chunks.push(c as Buffer); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('invalid json'), { code: 400 }); }
    };
    try {
      if (req.method === 'OPTIONS') {
        const origin = req.headers.origin ?? '';
        res.writeHead(204, o.origins?.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-methods': 'POST, GET', 'access-control-allow-headers': 'content-type' } : {});
        return res.end();
      }
      const p = url.pathname;
      const client = (o.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';
      const costly = req.method === 'POST' || p.startsWith('/v1/verify/') || p === '/v1/session/challenge';
      if (costly && p.startsWith('/v1/') && !/^\/v1\/holds\/[^/]+$/.test(p) && !allow(client)) return send(429, { error: 'rate_limited' });
      const site = o.site ?? `${o.trustProxy && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`;
      const owner = o.sessions.accountOf(req.headers.cookie);
      if (req.method === 'GET' && p === '/v1/health') return send(200, { ok: true, engine_sha256: engineSha256(), enclave: o.enclave ?? null });
      if (req.method === 'POST' && p === '/v1/readback') {
        const b = await body();
        const r = await readback(b, { fetch: o.fetch, attest: o.attest });
        o.inbox.record(b, r);
        return send(200, r);
      }
      if (req.method === 'GET' && p === '/v1/session/challenge') {
        const account = url.searchParams.get('account') ?? '';
        if (!/^[a-z0-9._-]{2,64}$/.test(account)) return send(400, { error: 'bad_account' });
        return send(200, { ...o.sessions.challenge(), message: signInText(account, site) });
      }
      if (req.method === 'POST' && p === '/v1/session') {
        const r = await o.sessions.signIn(o.fetch, await body(), site);
        if (!r.ok) return send(401, { error: r.reason });
        res.setHeader('set-cookie', `${COOKIE}=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${o.sessions.ttlSeconds}${site.startsWith('https:') ? '; Secure' : ''}`);
        return send(200, { account: r.account });
      }
      if (req.method === 'GET' && p === '/v1/session') return send(200, { account: owner });
      if (req.method === 'POST' && p === '/v1/session/out') { o.sessions.signOut(req.headers.cookie); res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); return send(200, { account: null }); }
      if (req.method === 'GET' && p === '/v1/activity') return owner ? send(200, { activity: o.inbox.listActivity(owner) }) : send(401, { error: 'sign_in' });
      if (p === '/v1/holds') {
        if (req.method === 'POST') { const r = o.inbox.addHold(await body()); return r.ok ? send(201, { id: r.hold.id, expires: r.hold.expires }) : send(400, { error: r.reason }); }
        if (req.method === 'GET') return owner ? send(200, { holds: o.inbox.listHolds(owner) }) : send(401, { error: 'sign_in' });
      }
      const m = /^\/v1\/holds\/([A-Za-z0-9_-]+)(?:\/(approve|refuse))?$/.exec(p);
      if (m) {
        if (req.method === 'GET' && !m[2]) { const h = o.inbox.getHold(m[1]); return h ? send(200, h) : send(404, { error: 'not_found' }); }
        if (req.method === 'POST' && m[2] === 'approve') { const r = await o.inbox.approve(m[1], await body(), o.fetch); return send(r.ok ? 200 : r.reason === 'not_found' ? 404 : 409, r); }
        if (req.method === 'POST' && m[2] === 'refuse') {
          if (!owner || o.inbox.getHold(m[1])?.owner !== owner) return send(403, { error: 'sign_in_as_owner' });
          const r = o.inbox.refuse(m[1]); return send(r.ok ? 200 : r.reason === 'not_found' ? 404 : 409, r); }
      }
      if (o.demo && req.method === 'GET' && p === '/v1/demo/cases') return send(200, { cases: o.demo.cases.map(({ id, name, desc }) => ({ id, name, desc })) });
      if (o.demo && req.method === 'GET' && p === '/v1/demo/summary') return send(200, o.demo.summary());
      if (o.demo && req.method === 'POST' && p === '/v1/demo/run') { const b = await body(); const r = await o.demo.run(String(b?.case ?? ''), { record: b?.record !== false }); return r ? send(200, r) : send(404, { error: 'no_such_case' }); }
      const vt = /^\/v1\/verify\/(\d{1,12})$/.exec(p);
      if (req.method === 'GET' && vt) return send(200, await verifyTask(o.fetch, Number(vt[1])));
      if (p.startsWith('/v1/')) return send(404, { error: 'not_found' });
      if (req.method === 'GET' && o.webDir) return serveStatic(o.webDir, p, res);
      send(404, { error: 'not_found' });
    } catch (e: any) {
      send(e?.code === 413 ? 413 : e?.code === 400 ? 400 : 500, { error: e?.code === 413 ? 'body_too_large' : e?.code === 400 ? 'invalid_json' : 'internal' });
    }
  };
}

async function serveStatic(dir: string, path: string, res: ServerResponse) {
  const rel = normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^[/\\]+/, '');
  const file = join(dir, rel);
  if (!file.startsWith(join(dir) + sep) || rel.includes('..')) { res.writeHead(404); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
      // The approval page must never be framed (a framed page can be overlaid to trick a signature).
      'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY',
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end();
  }
}
