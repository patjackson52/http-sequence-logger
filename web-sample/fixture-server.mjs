// Public-domain-style demonstration data only. This is NOT an OAuth server.
import { createServer } from 'node:http';
export async function startFixtures({ frontendOrigin = 'http://127.0.0.1:4180', authPort = 4181, appPort = 4182 } = {}) {
  const servers = [];
  const start = async (port, kind) => {
    const server = createServer((req, res) => {
      void handle(req, res).catch(() => { if (!res.destroyed) res.destroy(); });
    });
    async function handle(req, res) {
      if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); res.end(); return; }
      const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
      const allowed = req.headers.origin === frontendOrigin;
      if (allowed && path !== '/opaque') { res.setHeader('Access-Control-Allow-Origin', frontendOrigin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); }
      if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); res.end(); return; }
      let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) { res.writeHead(413); res.end(); return; } }
      const send = (code, value) => { if (res.destroyed) return; res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Demo-Server': kind }); res.end(JSON.stringify(value)); };
      if (path === '/slow') { setTimeout(() => send(200, { delayed: true }), 500); return; }
      if (path === '/invalid-json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{invalid'); return; }
      if (path === '/challenge') send(200, { challenge_id: 'demo-challenge', expires_in: 60 });
      else if (path === '/proof') send(200, { proof: 'local-demo-proof', verified: true });
      else if (path === '/token' || path === '/refresh') send(200, { access_token: 'DEMO_TOKEN_DO_NOT_SHIP', expires_in: 60 });
      else if (path === '/profile') req.headers.authorization === 'Bearer expired' ? send(401, { error: 'expired_demo_token' }) : send(200, { id: 7, display_name: 'Demo Person' });
      else send(200, { service: kind, path, ok: true });
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    servers.push(server);
  };
  try { await start(authPort, 'Auth service'); await start(appPort, 'App service'); }
  catch (error) { for (const s of servers) s.close(); throw error; }
  return () => { for (const s of servers) s.close(); };
}
