// Minimal static server, localhost only, to open the harness: node test/harness/serve.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const PORT = Number(process.argv[2]) || 5179; // optional port: node test/harness/serve.mjs 5180

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([\\/])+/, '');
  const file = join(ROOT, path || 'test/harness/index.html');
  if (!file.startsWith(ROOT) || !/^(test[\\/]harness|dist)[\\/]/.test(path || 'test/harness/')) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
  } catch {
    res.writeHead(404).end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`harness: http://127.0.0.1:${PORT}/test/harness/index.html`));
