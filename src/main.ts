import { Store } from './node-store.js';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { loadVault, insist, type Settings } from './foundation.js';

process.umask(0o077);
const demo = process.env.ARGOS_DEMO === '1';
insist(
  !(demo && process.env.NODE_ENV === 'production'),
  'Demo mode is forbidden in production',
  500,
);
const port = Number(process.env.PORT ?? 4180),
  origin = process.env.ARGOS_ORIGIN ?? `http://127.0.0.1:${port}`;
const url = new URL(origin);
insist(
  url.origin === origin && !url.username && !url.password,
  'ARGOS_ORIGIN must be an origin without trailing slash',
  500,
);
insist(
  url.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
  'Use HTTPS outside loopback',
  500,
);
insist(
  !demo || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
  'Demo is loopback-only',
  500,
);
const settings: Settings = {
  origin,
  demo,
  dataDir: resolve(process.env.ARGOS_DATA_DIR ?? (demo ? '.data/demo' : '.data/live')),
  env: process.env,
  targets: JSON.parse(process.env.ENGRAM_TARGETS_JSON ?? '[]'),
};
insist(
  settings.targets.every(
    (t) =>
      typeof t.id === 'string' &&
      typeof t.url === 'string' &&
      typeof t.tokenEnv === 'string' &&
      typeof t.orgId === 'string' &&
      ['personal', 'team'].includes(t.scope) &&
      typeof t.contextId === 'string',
  ),
  'Invalid Engram target configuration',
  500,
);
// Reusing a URL across namespaces would expose the same upstream corpus across contexts.
insist(
  new Set(settings.targets.map((t) => new URL(t.url).href)).size === settings.targets.length,
  'Each Engram context requires a distinct upstream endpoint',
  500,
);
const store = new Store(resolve(settings.dataDir, 'argosmcp.sqlite')),
  vault = loadVault(settings);
// Interrupted executions stay unknown; writes are never replayed automatically after a restart.
store.run("UPDATE invocations SET status='unknown' WHERE status='executing'");
const { app, connectors } = createApp(store, vault, settings);
const server = app.listen(port, demo ? '127.0.0.1' : (process.env.ARGOS_BIND ?? '127.0.0.1'), () =>
  console.log(`ArgosMCP ${demo ? '(local demonstration)' : ''}: ${origin}`),
);
let sweeping = false;
const sweep = async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await connectors.sweep();
  } catch {
    console.error('Credential maintenance failed; expired grants remain blocked.');
  } finally {
    sweeping = false;
  }
};
const timer = setInterval(() => {
  void sweep();
}, 60_000);
timer.unref();
void sweep();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    clearInterval(timer);
    server.close(() => {
      store.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
