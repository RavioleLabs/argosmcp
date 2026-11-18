import {
  CompanyConnectors,
  toolsFor,
  configFingerprintForTools,
} from '../../src/company-connectors.js';
import { remoteToolName } from '../../src/remote-definition.js';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject, evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { hash, opaque, Store, Vault } from '../../src/foundation.js';
import { DurableDatabase } from '../../cloudflare/worker.js';
const alpha = '00000000-0000-4000-8000-000000000101',
  beta = '00000000-0000-4000-8000-000000000102';
const user = '00000000-0000-4000-8000-000000000201';
it('serves authenticated API and MCP discovery through the Workers HTTP adapter', async () => {
  const health = await exports.default.fetch('https://alpha.example.test/health');
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ service: 'argosmcp' });
  const session = await exports.default.fetch('https://alpha.example.test/api/session');
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ demo: false, hosted: true, user: null });
  const mcp = await exports.default.fetch('https://alpha.example.test/mcp/slack');
  expect(mcp.status).toBe(401);
  expect(mcp.headers.get('www-authenticate')).toContain('/mcp/slack');
  await mcp.text();
  const metadata = await exports.default.fetch(
    'https://alpha.example.test/.well-known/oauth-protected-resource/mcp/slack',
  );
  expect((await metadata.json()).resource).toBe('https://alpha.example.test/mcp/slack');
});
it('isolates company storage and sessions, retaining data after eviction', async () => {
  const stub = env.WORKSPACES.getByName(alpha),
    token = opaque();
  await runInDurableObject(stub, (_instance, state) => {
    const db = new Store(new DurableDatabase(state.storage));
    db.run(
      'INSERT INTO users VALUES(?,?,?,?)',
      user,
      'google-fixture',
      'owner@alpha.test',
      'Owner',
    );
    db.run('INSERT INTO organizations(id,name) VALUES(?,?)', alpha, 'Alpha');
    db.run('INSERT INTO members VALUES(?,?,?)', alpha, user, 'owner');
    db.run('INSERT INTO sessions VALUES(?,?,?)', hash(token), user, Date.now() + 60000);
  });
  const headers = { Cookie: 'argos_session=' + token };
  let response = await exports.default.fetch('https://alpha.example.test/api/session', { headers });
  expect((await response.json()).user.id).toBe(user);
  response = await exports.default.fetch('https://beta.example.test/api/session', { headers });
  expect((await response.json()).user).toBe(null);
  expect(
    await runInDurableObject(env.WORKSPACES.getByName(beta), (_instance, state) =>
      state.storage.sql.exec('SELECT id FROM users').toArray(),
    ),
  ).toEqual([]);
  await evictDurableObject(stub);
  response = await exports.default.fetch('https://alpha.example.test/api/session', { headers });
  expect((await response.json()).user.id).toBe(user);
});
it('persists vault encryption and enforces SQLite rollback', async () => {
  const stub = env.WORKSPACES.getByName(alpha);
  await runInDurableObject(stub, (_instance, state) => {
    const rollbackUser = crypto.randomUUID();
    const db = new Store(new DurableDatabase(state.storage)),
      vault = new Vault({ v1: Buffer.alloc(32, 7) });
    const sealed = vault.seal({ token: 'private' }, 'alpha:fixture');
    expect(sealed).not.toContain('private');
    state.storage.kv.put('sealed', sealed);
    expect(() =>
      db.db.transaction(() => {
        db.run('INSERT INTO users VALUES(?,?,?,?)', rollbackUser, 'sub', 'u@example.test', 'User');
        throw new Error('rollback');
      })(),
    ).toThrow();
    expect(db.get('SELECT id FROM users WHERE id=?', rollbackUser)).toBeUndefined();
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const sealed = state.storage.kv.get<string>('sealed')!,
      vault = new Vault({ v1: Buffer.alloc(32, 7) });
    expect(vault.open(sealed, 'alpha:fixture')).toEqual({ token: 'private' });
    expect(() => vault.open(sealed, 'beta:fixture')).toThrow();
  });
});
it('runs scheduled maintenance and does not expose demo login in hosted mode', async () => {
  const response = await exports.default.fetch('https://alpha.example.test/api/demo/login', {
    method: 'POST',
    headers: { Origin: 'https://alpha.example.test' },
  });
  expect(response.status).toBe(404);
  await response.text();
  const stub = env.WORKSPACES.getByName(alpha);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(null);
});
it('rejects unprovisioned origins without creating a workspace', async () => {
  const response = await exports.default.fetch('https://unknown.example.test/api/session');
  expect(response.status).toBe(503);
  await response.text();
});
it('verifies signed device requests and rejects replay after object eviction', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { proofMessage } = await import('../../src/device-protocol.js');
  const key = generateKeyPairSync('ed25519'),
    publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const pairResponse = await exports.default.fetch('https://alpha.example.test/api/local/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey, label: 'Cloudflare device test' }),
  });
  expect(pairResponse.status).toBe(200);
  const pair = await pairResponse.json();
  const path = '/api/local/status',
    nonce = opaque(),
    at = Date.now();
  const headers = {
    'Content-Type': 'application/json',
    'x-argos-device': pair.id,
    'x-argos-time': String(at),
    'x-argos-nonce': nonce,
    'x-argos-signature': sign(
      null,
      Buffer.from(proofMessage('https://alpha.example.test', path, pair.id, at, nonce, {})),
      key.privateKey,
    ).toString('base64url'),
  };
  const one = await exports.default.fetch('https://alpha.example.test' + path, {
    method: 'POST',
    headers,
    body: '{}',
  });
  expect(one.status).toBe(200);
  expect(await one.json()).toEqual({ status: 'pending' });
  await evictDurableObject(env.WORKSPACES.getByName(alpha));
  const replay = await exports.default.fetch('https://alpha.example.test' + path, {
    method: 'POST',
    headers,
    body: '{}',
  });
  expect(replay.status).toBe(401);
  await replay.text();
  const other = await exports.default.fetch('https://beta.example.test' + path, {
    method: 'POST',
    headers,
    body: '{}',
  });
  expect(other.status).toBe(401);
  await other.text();
});

it('persists company connector review and policies in Durable Object SQLite', async () => {
  const stub = env.WORKSPACES.getByName(alpha),
    connectorId = await runInDurableObject(stub, (_instance, state) => {
      const store = new Store(new DurableDatabase(state.storage)),
        uid = crypto.randomUUID();
      store.run('INSERT OR IGNORE INTO organizations(id,name) VALUES(?,?)', alpha, 'Alpha');
      store.run(
        'INSERT INTO users VALUES(?,?,?,?)',
        uid,
        null,
        'catalog@example.test',
        'Catalog owner',
      );
      store.run("INSERT INTO members VALUES(?,?,'owner')", alpha, uid);
      const p = { orgId: alpha, userId: uid },
        registry = new CompanyConnectors(store);
      const d = registry.create(p, {
        name: 'Custom CRM',
        config: { endpoint: 'https://mcp.example.com/mcp', auth: 'none' },
      });
      const manifest = [
        {
          name: 'search',
          description: 'Search',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ];
      registry.discover(p, d.id, d.fingerprint, manifest);
      registry.publish(p, d.id, {
        enabled: true,
        names: ['search'],
        candidateHash: configFingerprintForTools(manifest),
      });
      expect(
        toolsFor(store, alpha)[remoteToolName(d.id, 'search')].schema.parse({
          arguments: { query: 'test' },
        }),
      ).toEqual({ arguments: { query: 'test' } });
      expect(toolsFor(store, beta)[remoteToolName(d.id, 'search')]).toBeUndefined();
      return d.id;
    });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const store = new Store(new DurableDatabase(state.storage));
    expect(
      store.get('SELECT status FROM company_connectors WHERE id=?', connectorId),
    ).toMatchObject({ status: 'enabled' });
  });
});
