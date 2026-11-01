// Readback guard API.
//   POST /v1/readback  {kind, agent?, quote, intent?, signed_mandate} -> verdict, checks, sentence
//   GET  /v1/health    -> {ok, engine_sha256}
// Binds to 127.0.0.1 unless HOST is set.

import { createServer } from 'node:http';
import { readback } from './readback.ts';
import { engineSha256 } from './engine.ts';

const PORT = Number(process.env.PORT ?? 8787), HOST = process.env.HOST ?? '127.0.0.1';
const ORIGINS = (process.env.READBACK_ORIGINS ?? '').split(',').filter(Boolean);
const MAX_BODY = 256 * 1024;

const server = createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const origin = req.headers.origin;
    if (origin && ORIGINS.includes(origin)) { headers['access-control-allow-origin'] = origin; headers['vary'] = 'origin'; }
    res.writeHead(code, headers);
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin ?? '';
      res.writeHead(204, ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-methods': 'POST, GET', 'access-control-allow-headers': 'content-type' } : {});
      return res.end();
    }
    if (req.method === 'GET' && req.url === '/v1/health') return send(200, { ok: true, engine_sha256: engineSha256() });
    if (req.method === 'POST' && req.url === '/v1/readback') {
      let size = 0; const chunks: Buffer[] = [];
      for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(413, { error: 'body_too_large' }); chunks.push(c as Buffer); }
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'invalid_json' }); }
      return send(200, await readback(body, { fetch }));
    }
    send(404, { error: 'not_found' });
  } catch {
    send(500, { error: 'internal' });
  }
});

server.listen(PORT, HOST, () => console.log(`Readback guard API on http://${HOST}:${PORT} (engine sha256 ${engineSha256().slice(0, 16)}...)`));
