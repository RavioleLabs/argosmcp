// Isolated UI fixture: no keychain access, real provider tokens, or external tool calls.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { LocalStorage } from '../dist/local/storage.js';
import { LocalRuntime } from '../dist/local/runtime.js';
import { createLocalApp } from '../dist/local/app.js';
import { id, hash, canonical } from '../dist/foundation.js';
const dir = mkdtempSync(join(tmpdir(), 'argos-ui-')),
  storage = new LocalStorage(dir, randomBytes(32));
const key = generateKeyPairSync('ed25519'),
  p = {
    id: id(),
    origin: 'https://raviolelabs.argosnode.ai',
    deviceId: id(),
    privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    label: 'Preview Mac',
    fingerprint: 'preview',
    pairUrl: 'https://raviolelabs.argosnode.ai',
    identity: {
      orgId: id(),
      userId: id(),
      name: 'RavioleLabs · UI preview',
      email: 'preview@example.test',
    },
    connections: [
      {
        id: id(),
        provider: 'slack',
        label: 'Slack · Product team',
        clientId: 'fixture',
        expiresAt: Date.now() + 86400000,
        status: 'active',
        autoRead: false,
        credentials: { access_token: 'preview-never-used' },
      },
    ],
  };
storage.save(p);
const runtime = new LocalRuntime(storage, async () => {
  throw new Error('Preview: external requests disabled');
});
const action = {
  id: id(),
  orgId: p.identity.orgId,
  userId: p.identity.userId,
  grantId: null,
  connectionId: p.connections[0].id,
  tool: 'slack_send_message',
  args: { channel: 'C_PRODUCT', text: 'The Argos connector is ready for review.' },
  expiresAt: Date.now() + 900000,
  agent: 'Claude · Preview',
  status: 'pending',
};
action.digest = hash(
  canonical({
    org: action.orgId,
    user: action.userId,
    grant: null,
    connectionId: action.connectionId,
    tool: action.tool,
    args: action.args,
  }),
);
runtime.snapshots.set(p.id, { status: 'active', actions: [action] });
const { app, url } = createLocalApp(runtime, 'http://localhost:4218', 'desktop/ui');
const server = app.listen(4218, '127.0.0.1', () => {
  writeFileSync('/private/tmp/argos-preview-url', url, { mode: 0o600 });
  console.log('Isolated UI preview ready on port 4218.');
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () =>
    server.close(() => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    }),
  );
