import { Store } from '../src/node-store.js';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import {
  Vault,
  id,
  hash,
  opaque,
  DAY,
  type Connection,
  type Principal,
  type Settings,
} from '../src/foundation.js';
import { Gateway } from '../src/gateway.js';
import { Auth } from '../src/auth.js';
import { Connectors, credentialContext } from '../src/connectors.js';

let store: Store, vault: Vault, gateway: Gateway, auth: Auth, settings: Settings;
let owner: Principal,
  member: Principal,
  outsider: Principal,
  teamId: string,
  shared: Connection,
  personal: Connection,
  team: Connection;
const execute = vi.fn(async () => ({ ok: true }));
function connection(
  p: Principal,
  scope: Connection['scope'] = 'organization',
  provider = 'slack',
): Connection {
  const cid = id(),
    now = Date.now();
  store.run(
    'INSERT INTO connections(id,org_id,provider,label,scope,owner_id,team_id,created_at,expires_at,secret) VALUES(?,?,?,?,?,?,?,?,?,?)',
    cid,
    p.orgId,
    provider,
    'Fixture',
    scope,
    p.userId,
    scope === 'team' ? teamId : null,
    now,
    now + 7 * DAY,
    vault.seal({ access_token: 'fixture-secret' }, `${p.orgId}:connection:${cid}`),
  );
  return store.get<Connection>('SELECT * FROM connections WHERE id=?', cid)!;
}
function policy(c: Connection, effect: string, tool = 'slack_send_message') {
  store.run('INSERT OR REPLACE INTO organization_policies VALUES(?,?,?)', c.org_id, tool, effect);
}
beforeEach(() => {
  store = new Store();
  vault = new Vault({ v1: randomBytes(32) });
  settings = {
    origin: 'http://127.0.0.1:4180',
    demo: false,
    dataDir: '/tmp',
    env: {},
    targets: [],
  };
  auth = new Auth(store, settings);
  execute.mockClear();
  execute.mockResolvedValue({ ok: true });
  gateway = new Gateway(store, vault, { execute });
  const users = [id(), id(), id()];
  for (const user of users)
    store.run('INSERT INTO users VALUES(?,?,?,?)', user, null, `${user}@example.test`, 'User');
  const orgId = auth.createOrg(users[0], 'Company A');
  owner = { userId: users[0], orgId };
  member = { userId: users[1], orgId };
  store.run('INSERT INTO members VALUES(?,?,?)', orgId, member.userId, 'member');
  outsider = { userId: users[2], orgId: auth.createOrg(users[2], 'Company B') };
  teamId = id();
  store.run('INSERT INTO teams VALUES(?,?,?)', teamId, orgId, 'Engineering');
  store.run('INSERT INTO team_members VALUES(?,?,?)', orgId, teamId, owner.userId);
  shared = connection(owner);
  personal = connection(member, 'personal', 'engram');
  team = connection(owner, 'team', 'engram');
});
afterEach(() => {
  vi.useRealTimers();
  store.db.close();
});
describe('Tenant and context isolation', () => {
  it('rejects a connection from another company even with a known UUID', () =>
    expect(() => store.connection(outsider, shared.id)).toThrow());
  it('does not let an organization owner read a member’s personal memory', () =>
    expect(() => store.connection(owner, personal.id)).toThrow());
  it('allows only the owner to access their personal context', () =>
    expect(store.connection(member, personal.id).id).toBe(personal.id));
  it('requires explicit team membership even for an administrator', () => {
    store.run('DELETE FROM team_members');
    expect(() => store.connection(owner, team.id)).toThrow();
  });
  it('removes team access immediately', () => {
    expect(store.connection(owner, team.id).id).toBe(team.id);
    store.run('DELETE FROM team_members');
    expect(() => store.connection(owner, team.id)).toThrow();
  });
  it('blocks a removed member in every context', () => {
    store.run('INSERT INTO blocked_members VALUES(?,?,?)', member.orgId, member.userId, Date.now());
    expect(() => store.connection(member, personal.id)).toThrow();
    expect(() => store.member(member)).toThrow();
  });
  it('rejects caller-supplied memory scopes', async () => {
    await expect(
      gateway.invoke(
        member,
        personal.id,
        'engram_remember',
        { content: 'secret', scope: `workspace:${teamId}` },
        id(),
      ),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
describe('Encrypted vault', () => {
  it('encrypts with fresh data keys and nonces', () => {
    const a = vault.seal({ token: 'very-secret' }, 'a');
    expect(a).not.toContain('very-secret');
    expect(a).not.toBe(vault.seal({ token: 'very-secret' }, 'a'));
    expect(vault.open(a, 'a')).toEqual({ token: 'very-secret' });
  });
  it('prevents moving ciphertext to another tenant or record', () => {
    const e = vault.seal({ token: 'secret' }, 'company-a:one');
    expect(() => vault.open(e, 'company-b:one')).toThrow();
    expect(() => vault.open(e, 'company-a:two')).toThrow();
  });
  it('rejects tampering and supports versioned key rotation', () => {
    const k1 = randomBytes(32),
      k2 = randomBytes(32),
      old = new Vault({ v1: k1 }),
      current = new Vault({ v1: k1, v2: k2 }, 'v2');
    const e = old.seal('secret', 'c');
    expect(current.open(e, 'c')).toBe('secret');
    const bad = JSON.parse(e);
    bad.data = Buffer.alloc(60).toString('base64');
    expect(() => current.open(JSON.stringify(bad), 'c')).toThrow();
    expect(JSON.parse(current.seal('new', 'c')).v).toBe('v2');
  });
});
describe('Mandatory tool policy and exact approvals', () => {
  it('enforces company denial above a permissive connection override', async () => {
    policy(shared, 'block');
    store.run(
      'INSERT INTO policies VALUES(?,?,?,?)',
      owner.orgId,
      shared.id,
      'slack_send_message',
      'allow',
    );
    await expect(
      gateway.invoke(
        member,
        shared.id,
        'slack_send_message',
        { channel: 'C1', text: 'Hello' },
        id(),
      ),
    ).rejects.toThrow(/blocked/);
    expect(execute).not.toHaveBeenCalled();
  });
  it('enforces company approval above a permissive connection override', async () => {
    store.run(
      'INSERT INTO policies VALUES(?,?,?,?)',
      owner.orgId,
      shared.id,
      'slack_send_message',
      'allow',
    );
    const r = await gateway.invoke(
      member,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'Hello' },
      id(),
    );
    expect(r.status).toBe('pending');
    expect(execute).not.toHaveBeenCalled();
  });
  it('lets members tighten their own rules without changing other members', async () => {
    policy(shared, 'allow');
    store.run(
      'INSERT INTO personal_restrictions VALUES(?,?,?,?,?)',
      owner.orgId,
      member.userId,
      shared.id,
      'slack_send_message',
      'block',
    );
    await expect(
      gateway.invoke(
        member,
        shared.id,
        'slack_send_message',
        { channel: 'C1', text: 'Hello' },
        id(),
      ),
    ).rejects.toThrow(/blocked/);
    const r = await gateway.invoke(
      owner,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'Hello' },
      id(),
    );
    expect(r.status).toBe('completed');
  });
  it('applies company rules to private Engram without exposing the private context', async () => {
    policy(personal, 'block', 'engram_recall');
    await expect(
      gateway.invoke(member, personal.id, 'engram_recall', { query: 'private' }, id()),
    ).rejects.toThrow(/blocked/);
    expect(() => store.connection(owner, personal.id)).toThrow();
  });
  it('defaults to approval without calling the provider', async () => {
    const result = await gateway.invoke(
      owner,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'Hello' },
      id(),
    );
    expect(result.status).toBe('pending');
    expect(execute).not.toHaveBeenCalled();
  });
  it('enforces a deny before executing', async () => {
    policy(shared, 'block');
    await expect(
      gateway.invoke(
        owner,
        shared.id,
        'slack_send_message',
        { channel: 'C1', text: 'Hello' },
        id(),
      ),
    ).rejects.toThrow(/blocked/);
    expect(execute).not.toHaveBeenCalled();
  });
  it('executes an allowed tool and never reveals its connection secret', async () => {
    policy(shared, 'allow');
    const r = await gateway.invoke(
      owner,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'Hello' },
      id(),
    );
    expect(r.status).toBe('completed');
    expect(JSON.stringify(r)).not.toContain('fixture-secret');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('approves only the exact action once', async () => {
    const r = await gateway.invoke(
      owner,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'Hello' },
      id(),
    );
    await gateway.decide(owner, r.id, true);
    await expect(gateway.decide(owner, r.id, true)).rejects.toThrow();
    expect(execute).toHaveBeenCalledExactlyOnceWith(shared, 'slack_send_message', {
      channel: 'C1',
      text: 'Hello',
    });
  });
  it('blocks approval after encrypted arguments are replaced', async () => {
    const r = await gateway.invoke(
      owner,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'Hello' },
      id(),
    );
    store.run(
      'UPDATE invocations SET payload=? WHERE id=?',
      vault.seal({ channel: 'C2', text: 'Changed' }, `${owner.orgId}:invocation:${r.id}`),
      r.id,
    );
    await gateway.decide(owner, r.id, true);
    expect(execute).not.toHaveBeenCalled();
    expect(gateway.read(owner, r.id).status).toBe('cancelled');
  });
  it('does not let a member approve shared actions', async () => {
    const r = await gateway.invoke(
      member,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'Hello' },
      id(),
    );
    await expect(gateway.decide(member, r.id, true)).rejects.toThrow();
    await gateway.decide(owner, r.id, true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('allows personal approval only by the context owner', async () => {
    const r = await gateway.invoke(
      member,
      personal.id,
      'engram_remember',
      { content: 'Private' },
      id(),
    );
    expect(gateway.approvalRows(owner)).toHaveLength(0);
    expect(gateway.approvalRows(member)).toHaveLength(1);
    await expect(gateway.decide(owner, r.id, true)).rejects.toThrow();
    await gateway.decide(member, r.id, true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rechecks the policy revision before executing an approved call', async () => {
    const r = await gateway.invoke(
      owner,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'Hello' },
      id(),
    );
    store.run('UPDATE organizations SET revision=revision+1 WHERE id=?', owner.orgId);
    await gateway.decide(owner, r.id, true);
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not execute expired approvals', async () => {
    const r = await gateway.invoke(
      owner,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'Hello' },
      id(),
    );
    store.run('UPDATE invocations SET expires_at=0 WHERE id=?', r.id);
    await expect(gateway.decide(owner, r.id, true)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it('reuses the previous result on retries, rejecting changed arguments', async () => {
    policy(shared, 'allow');
    const key = id(),
      args = { channel: 'C1', text: 'Hello' };
    const a = await gateway.invoke(owner, shared.id, 'slack_send_message', args, key),
      b = await gateway.invoke(owner, shared.id, 'slack_send_message', args, key);
    expect(a.id).toBe(b.id);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      gateway.invoke(owner, shared.id, 'slack_send_message', { ...args, text: 'Other' }, key),
    ).rejects.toThrow(/Idempotency/);
  });
  it('prevents two concurrent approvals from executing twice', async () => {
    const r = await gateway.invoke(
      owner,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'Hello' },
      id(),
    );
    await Promise.allSettled([
      gateway.decide(owner, r.id, true),
      gateway.decide(owner, r.id, true),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not automatically retry an ambiguous external write', async () => {
    policy(shared, 'allow');
    execute.mockRejectedValueOnce(new Error('timeout after provider commit'));
    const key = id(),
      args = { channel: 'C1', text: 'Hello' };
    const r = await gateway.invoke(owner, shared.id, 'slack_send_message', args, key);
    expect(r.status).toBe('unknown');
    await gateway.invoke(owner, shared.id, 'slack_send_message', args, key);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('never returns another user’s result', async () => {
    policy(shared, 'allow');
    const r = await gateway.invoke(
      owner,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'Hello' },
      id(),
    );
    expect(() => gateway.read(member, r.id)).toThrow();
  });
});
describe('OAuth grants and enterprise expiration', () => {
  it('blocks an expired connection even without a sweep', async () => {
    store.run('UPDATE connections SET expires_at=0 WHERE id=?', shared.id);
    await expect(
      gateway.invoke(
        owner,
        shared.id,
        'slack_send_message',
        { channel: 'C1', text: 'Hello' },
        id(),
      ),
    ).rejects.toThrow(/expired/);
  });
  it('applies shortened leases immediately to existing connections', () => {
    store.run('UPDATE connections SET created_at=? WHERE id=?', Date.now() - 2 * DAY, shared.id);
    store.run('UPDATE organizations SET lease_hours=24 WHERE id=?', owner.orgId);
    expect(() => store.live(store.connection(owner, shared.id))).toThrow(/expired/);
  });
  it('never lets an agent exceed its explicit connection grant', async () => {
    const g = auth.createGrant(owner, 'test', 'Agent', [shared.id]);
    await expect(
      gateway.invoke(
        { ...owner, grantId: g.id },
        team.id,
        'engram_recall',
        { query: 'secret' },
        id(),
      ),
    ).rejects.toThrow(/not authorized/);
  });
  it('denies a revoked grant immediately', async () => {
    const g = auth.createGrant(owner, 'test', 'Agent', [shared.id]),
      tokens = auth.issueTokens(g);
    await expect(auth.verifyAccessToken(tokens.access_token)).resolves.toBeTruthy();
    store.run('UPDATE grants SET revoked=1 WHERE id=?', g.id);
    await expect(auth.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });
  it('applies shortened grant limits to issued tokens', async () => {
    const g = auth.createGrant(owner, 'test', 'Agent', [shared.id]),
      tokens = auth.issueTokens(g);
    store.run('UPDATE grants SET created_at=? WHERE id=?', Date.now() - 2 * DAY, g.id);
    store.run('UPDATE organizations SET grant_hours=24 WHERE id=?', owner.orgId);
    await expect(auth.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });
  it('binds refresh tokens to the client and resource; rotates on use', async () => {
    const client = { client_id: 'test', redirect_uris: ['https://example.test/callback'] },
      g = auth.createGrant(owner, 'test', 'Agent', [shared.id]),
      tokens = auth.issueTokens(g);
    await expect(
      auth.exchangeRefreshToken(
        { ...client, client_id: 'evil' },
        tokens.refresh_token!,
        undefined,
        new URL(auth.audience),
      ),
    ).rejects.toThrow();
    await expect(
      auth.exchangeRefreshToken(
        client,
        tokens.refresh_token!,
        undefined,
        new URL('https://other.test/mcp'),
      ),
    ).rejects.toThrow();
    const next = await auth.exchangeRefreshToken(
      client,
      tokens.refresh_token!,
      undefined,
      new URL(auth.audience),
    );
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    await expect(
      auth.exchangeRefreshToken(client, tokens.refresh_token!, undefined, new URL(auth.audience)),
    ).rejects.toThrow();
  });
  it('binds authorization codes to the redirect, client and audience, and consumes once', async () => {
    const client = { client_id: 'test', redirect_uris: ['https://example.test/callback'] },
      g = auth.createGrant(owner, 'test', 'Agent', [shared.id]),
      code = opaque(),
      challenge = createHash('sha256').update('verifier').digest('base64url');
    store.run(
      'INSERT INTO codes VALUES(?,?,?,?,?,?,?)',
      hash(code),
      'test',
      g.id,
      challenge,
      client.redirect_uris[0],
      auth.audience,
      Date.now() + 60000,
    );
    expect(await auth.challengeForAuthorizationCode(client, code)).toBe(challenge);
    await expect(
      auth.exchangeAuthorizationCode(
        client,
        code,
        undefined,
        'https://evil.test',
        new URL(auth.audience),
      ),
    ).rejects.toThrow();
    await auth.exchangeAuthorizationCode(
      client,
      code,
      undefined,
      client.redirect_uris[0],
      new URL(auth.audience),
    );
    await expect(
      auth.exchangeAuthorizationCode(
        client,
        code,
        undefined,
        client.redirect_uris[0],
        new URL(auth.audience),
      ),
    ).rejects.toThrow();
  });
  it('stores only hashed agent and session tokens', () => {
    const g = auth.createGrant(owner, 'test', 'Agent', [shared.id]),
      t = auth.issueTokens(g);
    expect(JSON.stringify(store.all('SELECT * FROM tokens'))).not.toContain(t.access_token);
  });
  it('rejects unsafe dynamic-registration redirects', () => {
    expect(() =>
      auth.clientsStore.registerClient({
        redirect_uris: ['http://evil.test/callback'],
        token_endpoint_auth_method: 'none',
      }),
    ).toThrow();
  });
  it('rejects a state replay', () => {
    const token = store.state('test', { ok: true });
    expect(store.takeState(token, 'test')).toEqual({ ok: true });
    expect(() => store.takeState(token, 'test')).toThrow();
  });
});
describe('Engram bindings and revocation', () => {
  it('refuses an Engram target bound to another user before any network call', async () => {
    const connectors = new Connectors(store, vault, settings);
    settings.targets = [
      {
        id: 'target',
        label: 'Dedicated',
        url: 'http://127.0.0.1:7777/mcp',
        tokenEnv: 'TOKEN',
        orgId: owner.orgId,
        scope: 'personal',
        contextId: owner.userId,
      },
    ];
    store.run('UPDATE connections SET target_id=? WHERE id=?', 'target', personal.id);
    const c = store.connection(member, personal.id);
    await expect(connectors.execute(c, 'engram_recall', { query: 'secret' })).rejects.toThrow(
      /binding mismatch/,
    );
  });
  it('revokes locally and cancels pending actions before provider revocation', async () => {
    const connectors = new Connectors(store, vault, settings);
    const r = await gateway.invoke(
      owner,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'Hello' },
      id(),
    );
    connectors.revokeLocally(shared);
    expect(
      store.get<{ status: string }>('SELECT status FROM invocations WHERE id=?', r.id)?.status,
    ).toBe('cancelled');
    expect(() => store.live(store.connection(owner, shared.id))).toThrow();
  });
  it('marks Engram local-only revocation honestly and removes its stored token', async () => {
    const connectors = new Connectors(store, vault, settings);
    connectors.revokeLocally(personal);
    await connectors.revokeUpstream(personal.id);
    const c = store.connection(member, personal.id);
    expect(c.revoke_status).toBe('local_only');
    expect(c.secret).toBeNull();
  });
  it('preserves encrypted credentials for retry if the provider is unavailable', async () => {
    const connectors = new Connectors(store, vault, settings);
    connectors.revokeLocally(shared);
    const old = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    try {
      await connectors.revokeUpstream(shared.id);
      const c = store.connection(owner, shared.id);
      expect(c.status).toBe('revoked');
      expect(c.revoke_status).toBe('retry_required');
      expect(vault.open(c.secret!, credentialContext(c))).toEqual({
        access_token: 'fixture-secret',
      });
    } finally {
      globalThis.fetch = old;
    }
  });
  it('does not log arguments, tokens or retrieved memory content in the audit trail', async () => {
    policy(shared, 'allow');
    await gateway.invoke(
      owner,
      shared.id,
      'slack_send_message',
      { channel: 'C1', text: 'sensitive-note' },
      id(),
    );
    const raw = JSON.stringify(store.all('SELECT * FROM audit'));
    expect(raw).not.toContain('sensitive-note');
    expect(raw).not.toContain('fixture-secret');
  });
});
