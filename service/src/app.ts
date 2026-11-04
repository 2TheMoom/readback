// Readback HTTP API and the web app it serves.
//   POST /v1/readback               {kind, agent?, quote, intent?, signed_mandate} -> verdict, checks, sentence
//   GET  /v1/health                 -> {ok, engine_sha256, enclave}
//   GET  /v1/activity?owner=        checks made under that owner's verified mandates, newest first
//   POST /v1/holds                  the agent posts a held payment (agent/src/approval.ts)
//   GET  /v1/holds?owner=           that owner's holds; GET /v1/holds/<id> one hold (the agent polls it)
//   POST /v1/holds/<id>/approve     {publicKey, signature[, accountId]}: the owner's NEP-413 signature
//   POST /v1/holds/<id>/refuse
//   GET  anything else              the web app, from web/public

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { readback } from './readback.ts';
import { engineSha256 } from './engine.ts';
import type { Attested } from './outlayer.ts';
import type { Inbox } from './inbox.ts';
import type { Fetch } from './rpc.ts';

const MAX_BODY = 256 * 1024;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export interface AppOptions {
  fetch: Fetch; inbox: Inbox; attest?: (input: unknown) => Promise<Attested>; enclave?: string | null;
  webDir?: string; origins?: string[];
}

export function createApp(o: AppOptions) {
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
      if (req.method === 'GET' && p === '/v1/health') return send(200, { ok: true, engine_sha256: engineSha256(), enclave: o.enclave ?? null });
      if (req.method === 'POST' && p === '/v1/readback') {
        const b = await body();
        const r = await readback(b, { fetch: o.fetch, attest: o.attest });
        o.inbox.record(b, r);
        return send(200, r);
      }
      if (req.method === 'GET' && p === '/v1/activity') return send(200, { activity: o.inbox.listActivity(url.searchParams.get('owner') ?? '') });
      if (p === '/v1/holds') {
        if (req.method === 'POST') { const r = o.inbox.addHold(await body()); return r.ok ? send(201, { id: r.hold.id, expires: r.hold.expires }) : send(400, { error: r.reason }); }
        if (req.method === 'GET') return send(200, { holds: o.inbox.listHolds(url.searchParams.get('owner') ?? '') });
      }
      const m = /^\/v1\/holds\/([A-Za-z0-9_-]+)(?:\/(approve|refuse))?$/.exec(p);
      if (m) {
        if (req.method === 'GET' && !m[2]) { const h = o.inbox.getHold(m[1]); return h ? send(200, h) : send(404, { error: 'not_found' }); }
        if (req.method === 'POST' && m[2] === 'approve') { const r = await o.inbox.approve(m[1], await body(), o.fetch); return send(r.ok ? 200 : r.reason === 'not_found' ? 404 : 409, r); }
        if (req.method === 'POST' && m[2] === 'refuse') { const r = o.inbox.refuse(m[1]); return send(r.ok ? 200 : r.reason === 'not_found' ? 404 : 409, r); }
      }
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
