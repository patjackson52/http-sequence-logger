import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { createNetworkLogRelay } from '../web-sdk/dev-relay.mjs';
import { startFixtures } from './fixture-server.mjs';
const local = path => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig(({ command, mode, isPreview }) => {
  const debug = (!isPreview && command === 'serve') || mode === 'capture';
  return {
    root: local('./'), base: './', resolve: { alias: { '#logger': local(debug ? '../web-sdk/src/index.mjs' : '../web-sdk/src/api.mjs'), '#setup': local(debug ? './setup-debug.mjs' : './setup-production.mjs') } },
    server: { host: '127.0.0.1', port: 4180, strictPort: true, fs: { allow: [local('../')] } },
    build: { outDir: debug ? 'dist-debug' : 'dist', emptyOutDir: true, sourcemap: true, target: 'es2022' },
    plugins: [{
      name: 'development-fixtures-and-relay',
      async configureServer(server) {
        const close = await startFixtures(); server.httpServer.once('close', close);
        if (process.env.NETWORK_LOG_CONNECTION) server.middlewares.use(createNetworkLogRelay({ connectionFile: process.env.NETWORK_LOG_CONNECTION, origin: 'http://127.0.0.1:4180' }));
      },
      generateBundle() {
        if (!debug) for (const id of this.getModuleIds()) if (/web-sdk\/(src\/(?!api\.mjs)|dev-relay)|setup-debug/.test(id)) throw new Error(`Development module in production graph: ${id}`);
      },
    }],
  };
});
