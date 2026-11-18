// Disposable local-only ZAP target. No real keychain, account, provider or data volume.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../src/node-store.js';
import { Vault } from '../src/foundation.js';
import { createApp, seedDemo, DEMO_ORG, DEMO_USER } from '../src/app.js';

process.umask(0o077);
const origin = 'http://localhost:4288';
const store = new Store(),
  vault = new Vault({ v1: randomBytes(32) });
seedDemo(store, vault);
const { app, auth } = createApp(store, vault, { origin, demo: true, dataDir: '', env: {} });
// Defense against accidental upstream execution if demo fixtures change.
globalThis.fetch = async () => {
  throw new Error('Outbound network disabled in security fixture');
};
let cookie = '';
auth.issueSession(
  {
    cookie: (name: string, value: string) => {
      cookie = name + '=' + value;
    },
  } as any,
  DEMO_USER,
);
mkdirSync('.data/security-audit/zap', { recursive: true, mode: 0o700 });
const paths: Record<string, unknown> = {};
for (const path of [
  '/health',
  '/api/session',
  `/api/org/${DEMO_ORG}/state`,
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource/mcp',
]) {
  paths[path] = { get: { responses: { '200': { description: 'Response' } } } };
}
for (const [path, example] of [
  [`/api/org/${DEMO_ORG}/teams`, { name: 'Security fixture' }],
  [
    `/api/org/${DEMO_ORG}/invoke`,
    {
      connectionId: '00000000-0000-4000-8000-000000000000',
      tool: 'slack_history',
      args: { channel: 'C_TEST' },
      idempotencyKey: 'security-fixture',
    },
  ],
] as const) {
  paths[path] = {
    post: {
      requestBody: { content: { 'application/json': { schema: { type: 'object' }, example } } },
      responses: { '200': { description: 'Response' } },
    },
  };
}
writeFileSync(
  '.data/security-audit/zap/openapi.json',
  JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Argos disposable security fixture', version: '1' },
    servers: [{ url: 'http://host.docker.internal:4288' }],
    paths,
  }),
);
const properties = [
  'scanner.threadPerHost=1',
  'scanner.delayInMs=300',
  'scanner.maxScanDurationInMins=2',
  ...[
    ['Cookie', cookie],
    ['Origin', origin],
    ['Host', 'localhost:4288'],
  ].flatMap(([name, value], i) => [
    `replacer.full_list(${i}).description=fixture-${name}`,
    `replacer.full_list(${i}).enabled=true`,
    `replacer.full_list(${i}).matchtype=REQ_HEADER`,
    `replacer.full_list(${i}).matchstr=${name}`,
    `replacer.full_list(${i}).regex=false`,
    `replacer.full_list(${i}).replacement=${value}`,
  ]),
];
writeFileSync('.data/security-audit/zap/fixture.properties', properties.join('\n'));
const server = createServer(app).listen(4288, '127.0.0.1', () =>
  console.log('Disposable security fixture ready on loopback port 4288. Outbound fetch disabled.'),
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => {
      store.db.close();
      process.exit(0);
    });
  });
