// chatgpt-codex-orchestrator: fake tunnel-client for the BrainLocal lifecycle test.
// Reads FAKE_TUNNEL_HEALTH_ADDR (host:port), serves /healthz and /readyz, and stays
// alive until SIGTERM. Ignores the `run` subcommand / profile args (test only).
import http from 'node:http';

const addr = process.env.FAKE_TUNNEL_HEALTH_ADDR || '127.0.0.1:8085';
const idx = addr.lastIndexOf(':');
const host = addr.slice(0, idx);
const port = Number(addr.slice(idx + 1));

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok' })); return; }
  if (req.url === '/readyz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ready' })); return; }
  res.writeHead(404); res.end();
});

server.listen(port, host, () => { process.stdout.write('FAKE_TUNNEL_READY ' + addr + '\n'); });
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => {}, 1 << 30);
