import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

function demoPacksPlugin(): Plugin {
  const store = new Map<string, { pack: unknown; replies: Map<string, unknown> }>();
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (c) => { data += String(c); });
      req.on('end', () => resolve(data));
    });
  const attach = (middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void }) => {
    middlewares.use(async (req, res, next) => {
      const url = req.url ?? '';
      if (!url.startsWith('/__demo_packs/')) return next();
      const rest = url.slice('/__demo_packs/'.length).split('?')[0];
      const [rawId, sub] = rest.split('/');
      const packId = decodeURIComponent(rawId ?? '');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && !sub) {
        const pack = JSON.parse(await readBody(req));
        store.set(packId, { pack, replies: new Map() });
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'GET' && !sub) {
        const entry = store.get(packId);
        if (!entry) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ pack: entry.pack, replies: [...entry.replies.values()] }));
        return;
      }
      if (req.method === 'POST' && sub === 'replies') {
        const entry = store.get(packId);
        if (!entry) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        const reply = JSON.parse(await readBody(req)) as { alertId: string };
        entry.replies.set(reply.alertId, reply);
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      next();
    });
  };
  return {
    name: 'zenith-demo-packs',
    configureServer(server) { attach(server.middlewares); },
    configurePreviewServer(server) { attach(server.middlewares); },
  };
}

export default defineConfig({
  plugins: [react(), demoPacksPlugin()],
  test: { environment: 'node', include: ['src/**/*.test.ts', 'extension/**/*.test.ts'] },
});
