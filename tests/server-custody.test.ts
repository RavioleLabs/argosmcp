import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Store } from '../src/node-store.js';
import { Vault, id, hash, opaque, type Settings, type Connection } from '../src/foundation.js';
import { createApp } from '../src/app.js';
let server: Server,
  store: Store,
  app: ReturnType<typeof createApp>,
  origin: string,
  org: string,
  other: string,
  owner: string,
  member: string,
  cookie: string,
  memberCookie: string;
const key = Buffer.alloc(32, 8).toString('base64');
const realFetch = globalThis.fetch;
let providerCalls: string[];
beforeEach(async () => {
  store = new Store();
  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + (server.address() as any).port;
  org = id();
  other = id();
  owner = id();
  member = id();
  cookie = opaque();
  memberCookie = opaque();
  providerCalls = [];
  for (const uid of [owner, member])
    store.run('INSERT INTO users VALUES(?,?,?,?)', uid, uid, uid + '@example.test', 'Fixture');
  for (const oid of [org, other])
    store.run('INSERT INTO organizations(id,name) VALUES(?,?)', oid, 'Company');
  store.run('INSERT INTO members VALUES(?,?,?)', org, owner, 'owner');
  store.run('INSERT INTO members VALUES(?,?,?)', org, member, 'member');
  store.run('INSERT INTO sessions VALUES(?,?,?)', hash(cookie), owner, Date.now() + 60000);
  store.run('INSERT INTO sessions VALUES(?,?,?)', hash(memberCookie), member, Date.now() + 60000);
  const settings: Settings = {
    origin,
    demo: false,
    dataDir: '/tmp',
    env: {
      ARGOS_SERVER_CUSTODY: '1',
      ARGOS_PROVIDER_VAULT_KEYRING: JSON.stringify({ v1: key }),
      SLACK_PUBLIC_CLIENT_ID: 'fixture-public-client',
    },
  };
  app = createApp(store, new Vault({ v1: Buffer.alloc(32, 7) }), settings);
  server.on('request', app.app);
  vi.stubGlobal('fetch', async (input: any, init: any) => {
    const u = String(input);
    if (u.startsWith(origin)) return realFetch(input, init);
    providerCalls.push(u);
    if (u === 'https://slack.com/api/oauth.v2.access')
      return Response.json({
        ok: true,
        authed_user: {
          access_token: 'fixture-user-provider-token',
          refresh_token: 'fixture-refresh-provider-token',
          expires_in: 3600,
        },
      });
    if (u === 'https://slack.com/api/auth.revoke') return Response.json({ ok: true });
    if (u === 'https://slack.com/api/conversations.history')
      return Response.json({
        ok: true,
        messages: [
          {
            text: 'hello fixture-user-provider-token',
            access_token: 'fixture-user-provider-token',
          },
        ],
      });
    throw Error('Unexpected provider request');
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  store.db.close();
});
async function api(
  path: string,
  body?: unknown,
  method = 'POST',
  session = cookie,
  extra: Record<string, string> = {},
) {
  return fetch(origin + path, {
    method: body === undefined ? 'GET' : method,
    redirect: 'manual',
    headers: {
      Cookie: 'argos_session=' + session,
      Origin: origin,
      'Content-Type': 'application/json',
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const base = () => '/api/org/' + org;
async function enabled() {
  expect(
    (await api(base() + '/server-custody', { enabled: true, acknowledgeRisk: true }, 'PUT')).status,
  ).toBe(200);
}
async function start() {
  const r = await api(base() + '/connect/slack', {
    label: 'My Slack',
    scope: 'personal',
    acknowledgeServerCustody: true,
  });
  expect(r.status).toBe(200);
  const url = new URL((await r.json()).url);
  expect(url.searchParams.get('scope')).toBe('');
  expect(url.searchParams.get('user_scope')).toContain('chat:write');
  return {
    state: url.searchParams.get('state')!,
    binding: r.headers.get('set-cookie')!.split(';')[0],
  };
}
async function finish(s: Awaited<ReturnType<typeof start>>, session = cookie, binding = s.binding) {
  return api(
    '/oauth/callback/slack?state=' + s.state + '&code=fixture-code',
    undefined,
    'GET',
    session,
    { Cookie: 'argos_session=' + session + '; ' + binding },
  );
}
it('requires operator/admin/user opt-ins and denies other companies and forged browser callbacks', async () => {
  expect(
    (await api(base() + '/connect/slack', { label: 'Slack', acknowledgeServerCustody: true }))
      .status,
  ).toBe(403);
  expect(
    (
      await api(
        base() + '/server-custody',
        { enabled: true, acknowledgeRisk: true },
        'PUT',
        memberCookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await api(
        '/api/org/' + other + '/server-custody',
        { enabled: true, acknowledgeRisk: true },
        'PUT',
      )
    ).status,
  ).toBe(403);
  await enabled();
  expect((await api(base() + '/connect/slack', { label: 'Slack' })).status).toBe(400);
  const s = await start();
  expect((await finish(s, memberCookie)).status).toBe(403);
  expect((await finish(s, cookie, 'wrong=value')).status).toBe(403);
  expect(providerCalls).toEqual([]);
  const result = await finish(s);
  expect(result.status).toBe(302);
  expect((await finish(s)).status).toBe(400);
  const c = store.get<Connection>('SELECT * FROM connections WHERE org_id=?', org)!;
  expect(c.secret).toBeNull();
  expect(c.status).toBe('active');
  const encrypted = store.get<{ secret: string }>(
    'SELECT secret FROM server_credentials WHERE connection_id=?',
    c.id,
  )!.secret;
  expect(encrypted).not.toContain('fixture-user-provider-token');
  expect(() => new Vault({ v1: Buffer.alloc(32, 7) }).open(encrypted, 'wrong')).toThrow();
  const dashboard = await (await api(base() + '/state')).text();
  expect(dashboard).not.toContain('fixture-user-provider-token');
  expect(dashboard).toContain('"custody":"server"');
});
it('executes server tools only after company approval and redacts credentials from results', async () => {
  await enabled();
  await finish(await start());
  const c = store.get<Connection>('SELECT * FROM connections WHERE org_id=?', org)!;
  const p = { orgId: org, userId: owner };
  const result = await app.gateway.invoke(p, c.id, 'slack_history', { channel: 'C1' }, id());
  expect(result.status).toBe('pending');
  expect(providerCalls).not.toContain('https://slack.com/api/conversations.history');
  await app.gateway.decide(p, result.id, true);
  const completed = app.gateway.read(p, result.id);
  expect(completed.status).toBe('completed');
  expect(JSON.stringify(completed)).not.toContain('fixture-user-provider-token');
  const revoke = await api(
    base() + '/server-custody',
    { enabled: false, acknowledgeRisk: true },
    'PUT',
  );
  expect(revoke.status).toBe(200);
  expect(store.get<Connection>('SELECT * FROM connections WHERE id=?', c.id)?.status).toBe(
    'revoked',
  );
  expect(
    store.get<{ secret: null }>('SELECT secret FROM server_credentials WHERE connection_id=?', c.id)
      ?.secret,
  ).toBeNull();
  await expect(
    app.gateway.invoke(p, c.id, 'slack_history', { channel: 'C1' }, id()),
  ).rejects.toThrow();
});
it('rejects a pending OAuth flow after settings change and never exchanges a code for a cancelled connection', async () => {
  await enabled();
  const s = await start();
  await api(base() + '/server-custody', { enabled: false, acknowledgeRisk: true }, 'PUT');
  expect((await finish(s)).status).toBe(403);
  expect(providerCalls).toEqual([]);
});
it('revokes newly issued tokens if membership is removed while the provider exchange is in flight', async () => {
  await enabled();
  const s = await start();
  const wrapped = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: any, init: any) => {
    const response = await wrapped(input, init);
    if (String(input) === 'https://slack.com/api/oauth.v2.access')
      store.run('INSERT INTO blocked_members VALUES(?,?,?)', org, owner, Date.now());
    return response;
  });
  expect((await finish(s)).status).toBe(403);
  expect(providerCalls).toContain('https://slack.com/api/auth.revoke');
  expect(store.get<Connection>('SELECT * FROM connections WHERE org_id=?', org)?.status).toBe(
    'revoked',
  );
});
it('rechecks company policy after a token refresh before dispatching the provider action', async () => {
  const wrapped = globalThis.fetch;
  let refreshing = false;
  vi.stubGlobal('fetch', async (input: any, init: any) => {
    if (String(input) === 'https://slack.com/api/oauth.v2.access') {
      if (new URLSearchParams(init.body).get('grant_type') === 'refresh_token') {
        refreshing = true;
        store.run('UPDATE organizations SET revision=revision+1 WHERE id=?', org);
      }
      return Response.json({
        ok: true,
        authed_user: {
          access_token: 'fixture-short-token',
          refresh_token: 'fixture-refresh-token',
          expires_in: 1,
        },
      });
    }
    return wrapped(input, init);
  });
  await enabled();
  await finish(await start());
  const c = store.get<Connection>('SELECT * FROM connections WHERE org_id=?', org)!;
  const p = { orgId: org, userId: owner };
  const action = await app.gateway.invoke(p, c.id, 'slack_history', { channel: 'C1' }, id());
  await app.gateway.decide(p, action.id, true);
  expect(refreshing).toBe(true);
  expect(providerCalls).not.toContain('https://slack.com/api/conversations.history');
  expect(app.gateway.read(p, action.id).status).toBe('unknown');
});
