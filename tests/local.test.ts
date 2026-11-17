import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/node-store.js';
import { Vault, id, hash, opaque, canonical, type Principal } from '../src/foundation.js';
import { createApp } from '../src/app.js';
import { proofMessage, type Device } from '../src/device-protocol.js';
import { remote } from '../src/local/remote.js';
import { LocalStorage, type Profile, type LocalConnection } from '../src/local/storage.js';
import { LocalRuntime } from '../src/local/runtime.js';
import { createLocalApp } from '../src/local/app.js';
import { authorizeURL, exchange, newAttempt, redactResult } from '../src/local/providers.js';
let server: Server,
  store: Store,
  app: ReturnType<typeof createApp>,
  origin: string,
  p: Principal,
  d: Device,
  profile: Profile,
  local: LocalStorage,
  runtime: LocalRuntime,
  dir: string;
const execute = vi.fn(async (c: any, _t: any, _a: any, dispatch: any) => {
  await dispatch();
  return {
    ok: true,
    access_token: c.credentials.access_token,
    nested: 'contains ' + c.credentials.access_token,
  };
});
beforeEach(async () => {
  execute.mockClear();
  store = new Store();
  const vault = new Vault({ v1: randomBytes(32) });
  server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + (server.address() as any).port;
  app = createApp(store, vault, { origin, demo: true, dataDir: '', env: {}, targets: [] });
  server.on('request', app.app);
  p = { orgId: id(), userId: id() };
  store.run('INSERT INTO users VALUES(?,?,?,?)', p.userId, null, 'user@example.test', 'User');
  store.run('INSERT INTO organizations(id,name) VALUES(?,?)', p.orgId, 'Example');
  store.run("INSERT INTO members VALUES(?,?,'owner')", p.orgId, p.userId);
  const keys = generateKeyPairSync('ed25519'),
    publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const pair = app.devices.pair(publicKey, 'Fixture Mac');
  app.devices.approve(p, pair.id, pair.fingerprint);
  d = store.get<Device>('SELECT * FROM devices WHERE id=?', pair.id)!;
  profile = {
    id: id(),
    deviceId: d.id,
    origin,
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
    label: 'Fixture Mac',
    fingerprint: pair.fingerprint,
    pairUrl: pair.url,
    identity: { ...p, name: 'Example', email: 'user@example.test' },
    connections: [],
  };
  dir = mkdtempSync(join(tmpdir(), 'argos-local-test-'));
  local = new LocalStorage(dir, randomBytes(32));
  local.save(profile);
  runtime = new LocalRuntime(local, remote, execute);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  store.db.close();
  local.close();
  rmSync(dir, { recursive: true, force: true });
});
async function connect() {
  const c: LocalConnection = {
    id: id(),
    provider: 'slack',
    label: 'Personal Slack',
    clientId: 'client',
    credentials: {
      access_token: 'very-secret-local-access-token',
      refresh_token: 'very-secret-local-refresh-token',
    },
    expiresAt: Date.now() + 86400000,
    status: 'active',
    autoRead: false,
  };
  await runtime.register(profile, c);
  return c;
}
async function action() {
  const c = await connect();
  const r = await app.gateway.invoke(
    p,
    c.id,
    'slack_send_message',
    { channel: 'C1', text: 'Hello' },
    id(),
  );
  return { c, r };
}
it('keeps provider secrets out of registration, snapshots and server database', async () => {
  await connect();
  await runtime.snapshot(profile);
  expect(store.get<any>('SELECT secret FROM connections')!.secret).toBeNull();
  expect(JSON.stringify(await remote(profile, '/api/local/status'))).not.toContain('very-secret');
  expect(JSON.stringify(runtime.state())).not.toContain('very-secret');
  expect(readFileSync(join(dir, 'connector.sqlite')).includes(Buffer.from('very-secret'))).toBe(
    false,
  );
});
it('approves locally, dispatches exactly once, returns a redacted result through Argos', async () => {
  const { r } = await action();
  expect(r.status).toBe('pending');
  expect(execute).not.toHaveBeenCalled();
  await runtime.snapshot(profile);
  const a = runtime.snapshots.get(profile.id)!.actions[0];
  await runtime.decide(profile.id, r.id, a.digest, true);
  expect(execute).toHaveBeenCalledTimes(1);
  const result = app.gateway.read(p, r.id);
  expect(result.status).toBe('completed');
  expect(JSON.stringify(result)).not.toContain('very-secret');
  await expect(runtime.decide(profile.id, r.id, a.digest, true)).rejects.toThrow();
});
it('denies from the local app without invoking a provider', async () => {
  const { r } = await action();
  await runtime.snapshot(profile);
  const a = runtime.snapshots.get(profile.id)!.actions[0];
  await runtime.decide(profile.id, r.id, a.digest, false);
  expect(app.gateway.read(p, r.id).status).toBe('rejected');
  expect(execute).not.toHaveBeenCalled();
});
it('requires local confirmation for writes even after dashboard approval', async () => {
  const { r } = await action();
  await app.gateway.decide(p, r.id, true);
  await runtime.tick();
  expect(execute).not.toHaveBeenCalled();
  expect(app.gateway.read(p, r.id).status).toBe('approved');
});
it('only automatically executes reads after explicit local delegation and company allow', async () => {
  const c = await connect();
  c.autoRead = true;
  local.save(profile);
  store.run("INSERT INTO organization_policies VALUES(?,?,'allow')", p.orgId, 'slack_history');
  const r = await app.gateway.invoke(p, c.id, 'slack_history', { channel: 'C1' }, id());
  await runtime.tick();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(app.gateway.read(p, r.id).status).toBe('completed');
});
it('rejects changed arguments and cross-company payloads locally', async () => {
  await action();
  await runtime.snapshot(profile);
  const a = runtime.snapshots.get(profile.id)!.actions[0];
  expect(() =>
    runtime.validate(profile, { ...a, args: { ...a.args, text: 'Different' } }),
  ).toThrow();
  expect(() => runtime.validate(profile, { ...a, orgId: id() })).toThrow();
});
it('rechecks enterprise policy immediately before dispatch', async () => {
  const { r } = await action();
  await app.gateway.decide(p, r.id, true);
  const row = store.get<any>('SELECT * FROM invocations WHERE id=?', r.id);
  store.run("INSERT INTO organization_policies VALUES(?,?,'block')", p.orgId, 'slack_send_message');
  await expect(
    remote(profile, '/api/local/claim', { id: r.id, digest: row.digest }),
  ).rejects.toThrow();
  expect(store.get<any>('SELECT status FROM invocations WHERE id=?', r.id).status).toBe('approved');
});
it('does not dispatch after device or grant revocation', async () => {
  const { c } = await action();
  const g = app.auth.createGrant(p, 'test', 'Agent', [c.id]);
  const r = await app.gateway.invoke(
    { ...p, grantId: g.id },
    c.id,
    'slack_send_message',
    { channel: 'C1', text: 'second' },
    id(),
  );
  await app.gateway.decide(p, r.id, true);
  store.run('UPDATE grants SET revoked=1 WHERE id=?', g.id);
  const digest = store.get<any>('SELECT digest FROM invocations WHERE id=?', r.id).digest;
  await expect(remote(profile, '/api/local/claim', { id: r.id, digest })).rejects.toThrow();
  store.run("UPDATE devices SET status='revoked' WHERE id=?", d.id);
  await expect(
    app.gateway.invoke(p, c.id, 'slack_history', { channel: 'C1' }, id()),
  ).rejects.toThrow(/device/);
});
it('requires the exact paired device even for the same user', async () => {
  const { r } = await action();
  await app.gateway.decide(p, r.id, true);
  const keys = generateKeyPairSync('ed25519'),
    pair = app.devices.pair(
      keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      'Other',
    );
  app.devices.approve(p, pair.id, pair.fingerprint);
  const other = store.get<Device>('SELECT * FROM devices WHERE id=?', pair.id)!;
  const digest = store.get<any>('SELECT digest FROM invocations WHERE id=?', r.id).digest;
  expect(() => app.devices.claim(other, r.id, digest)).toThrow(/device/);
});
it('rejects request replay and signatures for another body or origin', async () => {
  const path = '/api/local/status',
    nonce = opaque(),
    at = Date.now(),
    headers = {
      'Content-Type': 'application/json',
      'x-argos-device': d.id,
      'x-argos-time': String(at),
      'x-argos-nonce': nonce,
      'x-argos-signature': sign(
        null,
        Buffer.from(proofMessage(origin, path, d.id, at, nonce, {})),
        profile.privateKey,
      ).toString('base64url'),
    };
  const one = await fetch(origin + path, { method: 'POST', headers, body: '{}' });
  expect(one.status).toBe(200);
  await one.text();
  const two = await fetch(origin + path, { method: 'POST', headers, body: '{}' });
  expect(two.status).toBe(401);
  await two.text();
  const changed = await fetch(origin + path, { method: 'POST', headers, body: '{"x":1}' });
  expect(changed.status).toBe(401);
  await changed.text();
  const bad = { ...profile, origin: origin.replace('127.0.0.1', 'localhost') };
  await expect(remote(bad, path)).rejects.toThrow();
});
it('does not accept raw OAuth tokens in a connection registration', async () => {
  await expect(
    remote(profile, '/api/local/connections', {
      id: id(),
      provider: 'slack',
      label: 'x',
      access_token: 'secret',
    }),
  ).rejects.toThrow();
  expect(store.all('SELECT * FROM connections')).toHaveLength(0);
});
it('rejects stale or cross-context pairing and duplicate approvals', () => {
  expect(() => app.devices.approve(p, d.id, profile.fingerprint)).toThrow();
  const pair = app.devices.pair(profile.publicKey, 'Other');
  expect(() => app.devices.approve(p, pair.id, 'incorrect')).toThrow();
});
it('cannot submit an outcome without the claimed execution receipt', async () => {
  const { r } = await action();
  await expect(
    remote(profile, '/api/local/complete', {
      id: r.id,
      receipt: 'invented',
      status: 'completed',
      result: 'fake',
    }),
  ).rejects.toThrow();
});
it('atomically claims an action only once and checks approval expiration', async () => {
  const { r } = await action();
  await app.gateway.decide(p, r.id, true);
  const digest = store.get<any>('SELECT digest FROM invocations WHERE id=?', r.id).digest;
  const results = await Promise.allSettled([
    remote(profile, '/api/local/claim', { id: r.id, digest }),
    remote(profile, '/api/local/claim', { id: r.id, digest }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
});
it('preserves unknown status after an ambiguous provider failure and never retries', async () => {
  const { r } = await action();
  await runtime.snapshot(profile);
  const a = runtime.snapshots.get(profile.id)!.actions[0];
  execute.mockImplementationOnce(async (_c, _t, _a, dispatch) => {
    await dispatch();
    throw new Error('lost response');
  });
  await runtime.decide(profile.id, r.id, a.digest, true);
  expect(app.gateway.read(p, r.id).status).toBe('unknown');
  await runtime.tick();
  expect(execute).toHaveBeenCalledTimes(1);
});
it('blocks dispatch when the workspace is unavailable', async () => {
  const { r } = await action();
  await app.gateway.decide(p, r.id, true);
  await runtime.snapshot(profile);
  const a = runtime.snapshots.get(profile.id)!.actions[0];
  const offline = new LocalRuntime(
    local,
    async () => {
      throw new Error('offline');
    },
    execute,
  );
  await offline.execute(profile, a, true);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(store.get<any>('SELECT status FROM invocations WHERE id=?', r.id).status).toBe('approved');
});
it('disables legacy server OAuth routes', async () => {
  const r = await fetch(origin + '/oauth/callback/slack?code=do-not-use');
  expect(r.status).toBe(410);
  expect(await r.text()).not.toContain('do-not-use');
});
it('requests Slack user scopes with S256 and never sends a client secret', async () => {
  const a = newAttempt(
    'profile',
    'slack',
    id(),
    'Slack',
    'public-id',
    'http://localhost:4217/oauth/callback',
  );
  const url = new URL(await authorizeURL(a));
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('user_scope')).toContain('chat:write');
  expect(url.searchParams.get('scope')).toBe('');
  const f = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          access_token: 'bot-token',
          authed_user: { access_token: 'user-token', refresh_token: 'refresh' },
        }),
      ),
  );
  vi.stubGlobal('fetch', f);
  const c = await exchange(a, {
    grant_type: 'authorization_code',
    code: 'test',
    code_verifier: a.verifier,
  });
  expect(c.access_token).toBe('user-token');
  expect(String((f.mock.calls[0] as any)[1].body)).not.toContain('client_secret');
});
it('redacts credential fields and known credential values recursively', () => {
  expect(
    redactResult({ a: ['hello-token-secret'], refresh_token: 'x' }, ['hello-token-secret']),
  ).toEqual({ a: ['[redacted]'], refresh_token: '[redacted]' });
});
it('locks loopback APIs behind a local session and same-origin requests', async () => {
  const ui = createServer();
  await new Promise<void>((r) => ui.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + (ui.address() as any).port;
  const localApp = createLocalApp(runtime, base, 'desktop/ui');
  ui.on('request', localApp.app);
  try {
    const r = await fetch(base + '/api/state');
    expect(r.status).toBe(401);
    await r.text();
    const csrf = await fetch(base + '/api/pair', {
      method: 'POST',
      headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(csrf.status).toBe(403);
    await csrf.text();
    const key = new URLSearchParams(new URL(localApp.url).hash.slice(1)).get('key');
    const session = await fetch(base + '/session', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    expect(session.status).toBe(200);
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    await session.text();
    const data = await fetch(base + '/api/state', { headers: { Cookie: cookie } }).then((r) =>
      r.json(),
    );
    expect(JSON.stringify(data)).not.toContain(profile.privateKey);
    expect(data.profiles[0].id).toBe(profile.id);
  } finally {
    ui.closeAllConnections();
    await new Promise<void>((r) => ui.close(() => r()));
  }
});
it('expires and revokes locally while the enterprise server is offline', async () => {
  const c = await connect();
  c.expiresAt = Date.now() - 1;
  local.save(profile);
  const f = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal('fetch', f);
  const offline = new LocalRuntime(
    local,
    async () => {
      throw new Error('offline');
    },
    execute,
  );
  await offline.tick();
  expect(local.get(profile.id).connections[0].status).toBe('revoked');
  expect(local.get(profile.id).connections[0].credentials.access_token).toBe('');
  expect(f).toHaveBeenCalledTimes(2);
  expect(execute).not.toHaveBeenCalled();
});
it('acknowledges revocation after enterprise device removal, restricted to its own connections', async () => {
  const c = await connect();
  store.run("UPDATE devices SET status='revoked' WHERE id=?", d.id);
  await remote(profile, '/api/local/disconnect', { id: c.id, upstream: 'confirmed' });
  expect(
    store.get<any>('SELECT revoke_status FROM connections WHERE id=?', c.id).revoke_status,
  ).toBe('confirmed');
  await expect(
    remote(profile, '/api/local/disconnect', { id: id(), upstream: 'confirmed' }),
  ).rejects.toThrow();
});
it('recovers registration when the initial metadata delivery was lost', async () => {
  const c = await connect();
  store.run('DELETE FROM local_connections WHERE connection_id=?', c.id);
  store.run('DELETE FROM connections WHERE id=?', c.id);
  await runtime.snapshot(profile);
  expect(store.get<any>('SELECT secret FROM connections WHERE id=?', c.id).secret).toBeNull();
});
it('retries a revocation acknowledgement without retaining provider credentials', async () => {
  const c = await connect();
  c.status = 'revoked';
  c.credentials = { access_token: '' };
  local.save(profile);
  await runtime.tick();
  expect(
    store.get<any>('SELECT revoke_status FROM connections WHERE id=?', c.id).revoke_status,
  ).toBe('confirmed');
});
it('stops refresh attempts after invalid_grant without exposing the provider body', async () => {
  const { c, r } = await action();
  c.credentials.expires_at = Date.now() - 1;
  local.save(profile);
  await runtime.snapshot(profile);
  const a = runtime.snapshots.get(profile.id)!.actions[0];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_grant',
            description: 'very-secret-local-refresh-token',
          }),
          { status: 400 },
        ),
    ),
  );
  await expect(runtime.execute(profile, a, true)).rejects.toThrow('Reconnect');
  expect(local.get(profile.id).connections[0].status).toBe('revoked');
  expect(execute).not.toHaveBeenCalled();
});
async function memory(teamId?: string) {
  const c: LocalConnection = {
    id: id(),
    provider: 'engram',
    scope: teamId ? 'team' : 'personal',
    teamId,
    label: teamId ? 'Team memory' : 'Personal memory',
    clientId: '',
    credentials: { access_token: '' },
    expiresAt: Date.now() + 86400000,
    status: 'active',
    autoRead: false,
  };
  await runtime.register(profile, c);
  return c;
}
async function member(teamId?: string) {
  const userId = id();
  store.run(
    'INSERT INTO users VALUES(?,?,?,?)',
    userId,
    null,
    userId + '@example.test',
    'Teammate',
  );
  store.run("INSERT INTO members VALUES(?,?,'member')", p.orgId, userId);
  if (teamId) store.run('INSERT INTO team_members VALUES(?,?,?)', p.orgId, teamId, userId);
  return { orgId: p.orgId, userId };
}
async function completeMemory(actor: Principal, c: LocalConnection, tool: any, args: any) {
  const r = await app.gateway.invoke(actor, c.id, tool, args, id());
  await runtime.snapshot(local.get(profile.id));
  const a = runtime.snapshots.get(profile.id)!.actions.find((a) => a.id === r.id)!;
  await runtime.decide(profile.id, r.id, a.digest, true);
  return app.gateway.read(actor, r.id).result as any;
}
it('remembers, retrieves and forgets encrypted personal memory through the real device flow', async () => {
  const c = await memory(),
    saved = await completeMemory(p, c, 'engram_remember', {
      content: 'Project zephyr launches on Thursday',
      title: 'Release decision',
    });
  const found = await completeMemory(p, c, 'engram_recall', { query: 'zephyr' });
  expect(found.results[0].id).toBe(saved.id);
  expect(found.results[0].source).toMatch(/^engram:/);
  expect(execute).not.toHaveBeenCalled();
  expect(JSON.stringify(local.db.prepare('SELECT * FROM memories').all())).not.toContain('zephyr');
  await completeMemory(p, c, 'engram_forget', { id: saved.id });
  expect((await completeMemory(p, c, 'engram_recall', { query: 'zephyr' })).results).toEqual([]);
});
it('shares team memory with current team members without exposing personal memory or outcomes', async () => {
  const team = id();
  store.run('INSERT INTO teams VALUES(?,?,?)', team, p.orgId, 'Product');
  store.run('INSERT INTO team_members VALUES(?,?,?)', p.orgId, team, p.userId);
  const peer = await member(team),
    outsider = await member();
  const personal = await memory(),
    shared = await memory(team);
  await completeMemory(p, personal, 'engram_remember', { content: 'personal zephyr secret' });
  await completeMemory(peer, shared, 'engram_remember', { content: 'team zephyr plan' });
  const found = await completeMemory(peer, shared, 'engram_recall', { query: 'zephyr' });
  expect(found.results).toHaveLength(1);
  expect(found.results[0].content).toBe('team zephyr plan');
  await expect(
    app.gateway.invoke(peer, personal.id, 'engram_recall', { query: 'zephyr' }, id()),
  ).rejects.toThrow();
  await expect(
    app.gateway.invoke(outsider, shared.id, 'engram_recall', { query: 'zephyr' }, id()),
  ).rejects.toThrow();
  const invocation = store.get<any>(
    'SELECT id FROM invocations WHERE user_id=? LIMIT 1',
    peer.userId,
  );
  expect(() => app.gateway.read(p, invocation.id)).toThrow();
});
it('rechecks team membership after approval and before the local memory operation', async () => {
  const team = id();
  store.run('INSERT INTO teams VALUES(?,?,?)', team, p.orgId, 'Product');
  store.run('INSERT INTO team_members VALUES(?,?,?)', p.orgId, team, p.userId);
  const peer = await member(team),
    c = await memory(team);
  const r = await app.gateway.invoke(
    peer,
    c.id,
    'engram_remember',
    { content: 'forbidden after removal' },
    id(),
  );
  await app.gateway.decide(p, r.id, true);
  const digest = store.get<any>('SELECT digest FROM invocations WHERE id=?', r.id).digest;
  store.run('DELETE FROM team_members WHERE team_id=? AND user_id=?', team, peer.userId);
  await expect(remote(profile, '/api/local/claim', { id: r.id, digest })).rejects.toThrow();
  expect(local.db.prepare('SELECT * FROM memories').all()).toHaveLength(0);
});
it('requires both administrator role and team membership to host a shared context', async () => {
  const team = id();
  store.run('INSERT INTO teams VALUES(?,?,?)', team, p.orgId, 'Private team');
  await expect(memory(team)).rejects.toThrow();
  store.run('INSERT INTO team_members VALUES(?,?,?)', p.orgId, team, p.userId);
  store.run("UPDATE members SET role='member' WHERE org_id=? AND user_id=?", p.orgId, p.userId);
  await expect(memory(team)).rejects.toThrow();
});
it('cannot widen a registered personal connection into a team context', async () => {
  const c = await memory(),
    team = id();
  store.run('INSERT INTO teams VALUES(?,?,?)', team, p.orgId, 'Team');
  store.run('INSERT INTO team_members VALUES(?,?,?)', p.orgId, team, p.userId);
  await expect(
    remote(profile, '/api/local/connections', {
      id: c.id,
      provider: 'engram',
      label: 'Widened',
      scope: 'team',
      teamId: team,
    }),
  ).rejects.toThrow();
  await expect(
    remote(profile, '/api/local/connections', {
      id: id(),
      provider: 'slack',
      label: 'Shared OAuth',
      scope: 'team',
      teamId: team,
    }),
  ).rejects.toThrow();
});
it('keeps a failed registration from blocking existing connections', async () => {
  const good = await connect();
  const denied: LocalConnection = {
    id: id(),
    provider: 'engram',
    scope: 'team',
    teamId: id(),
    label: 'Denied context',
    clientId: '',
    credentials: { access_token: '' },
    expiresAt: Date.now() + 86400000,
    status: 'active',
    autoRead: false,
  };
  await expect(runtime.register(profile, denied)).rejects.toThrow();
  await runtime.snapshot(local.get(profile.id));
  expect(runtime.snapshots.get(profile.id)?.status).toBe('active');
  expect(local.get(profile.id).connections.find((c) => c.id === good.id)?.status).toBe('active');
  expect(local.get(profile.id).connections.find((c) => c.id === denied.id)?.status).toBe('revoked');
});
