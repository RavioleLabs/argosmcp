import { beforeEach, afterEach, it, expect } from 'vitest';
import { Store } from '../src/node-store.js';
import { id, type Settings, type Principal } from '../src/foundation.js';
import { CloudflarePortals, registerPortal } from '../src/cloudflare-portals.js';
import { CompanyConnectors } from '../src/company-connectors.js';
import { parseTools } from '../src/remote-definition.js';
let store: Store, settings: Settings, owner: Principal, member: Principal, other: Principal;
const endpoint = 'https://tools.company.com/mcp',
  issuer = 'https://company.cloudflareaccess.com',
  callback = 'https://argos.company.com/oauth/callback/mcp';
const metadata = {
  issuer,
  authorization_endpoint: issuer + '/authorize',
  token_endpoint: issuer + '/token',
  registration_endpoint: issuer + '/register',
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
};
function transport(
  overrides: Record<string, unknown> = {},
  registration: Record<string, unknown> = {},
) {
  const calls: string[] = [];
  return {
    calls,
    send: async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push(url);
      expect(new Headers(init.headers).has('authorization')).toBe(false);
      if (url.includes('oauth-protected-resource'))
        return Response.json({ resource: endpoint, authorization_servers: [issuer] });
      if (url === issuer + '/register') {
        expect(JSON.parse(String(init.body)).redirect_uris).toEqual([callback]);
        return Response.json({ client_id: 'public-client', ...registration });
      }
      return Response.json({ ...metadata, ...overrides });
    },
  };
}
beforeEach(() => {
  store = new Store();
  owner = { orgId: id(), userId: id() };
  member = { orgId: owner.orgId, userId: id() };
  other = { orgId: id(), userId: id() };
  for (const p of [owner, other])
    store.run('INSERT INTO organizations(id,name) VALUES(?,?)', p.orgId, 'Company');
  for (const p of [owner, member, other]) {
    store.run(
      'INSERT INTO users VALUES(?,?,?,?)',
      p.userId,
      null,
      p.userId + '@example.com',
      'User',
    );
    store.run(
      'INSERT INTO members VALUES(?,?,?)',
      p.orgId,
      p.userId,
      p === member ? 'member' : 'owner',
    );
  }
  settings = {
    origin: 'https://argos.company.com',
    dataDir: '/tmp',
    demo: false,
    env: {
      ARGOS_MANAGED_PORTAL_DOMAIN: 'portals.argosnode.ai',
      ARGOS_PROVISIONED_PORTALS_JSON: '{}',
    },
    remoteFetch: transport().send,
  };
});
afterEach(() => store.db.close());
it('registers a public PKCE client without provider or account credentials', async () => {
  const t = transport();
  const config = await registerPortal(endpoint, callback, t.send);
  expect(config.kind).toBe('cloudflare-portal');
  expect(config.oauth?.clientId).toBe('public-client');
  expect(t.calls.at(-1)).toBe(issuer + '/register');
});
it.each([
  { code_challenge_methods_supported: ['plain'] },
  { token_endpoint: 'https://attacker.example.com/token' },
  { registration_endpoint: 'https://attacker.example.com/register' },
  { issuer: 'https://other.cloudflareaccess.com' },
  { token_endpoint_auth_methods_supported: ['client_secret_post'] },
])('rejects unsafe OAuth metadata before registration: %j', async (overrides) => {
  const t = transport(overrides);
  await expect(registerPortal(endpoint, callback, t.send)).rejects.toThrow();
  expect(t.calls.some((x) => x.endsWith('/register'))).toBe(false);
});
it('rejects confidential clients and changed redirects', async () => {
  for (const response of [
    { client_secret: 'unexpected' },
    { redirect_uris: ['https://attacker.example.com/callback'] },
  ])
    await expect(
      registerPortal(endpoint, callback, transport({}, response).send),
    ).rejects.toThrow();
});
it('isolates company plans and prohibits members from changing setup', async () => {
  const service = new CloudflarePortals(store, settings);
  expect(() => service.request(member, { mode: 'managed' })).toThrow();
  const result = service.request(owner, { mode: 'managed' });
  expect(result.portal?.endpoint).toContain(owner.orgId);
  expect(service.view(member)).not.toHaveProperty('plan');
  expect(service.view(other).portal).toBeNull();
  await expect(service.activate(owner)).rejects.toThrow('not been provisioned');
  expect(() => service.request(owner, { mode: 'managed', endpoint })).toThrow();
  expect(() =>
    service.request(other, { mode: 'company', endpoint: result.portal!.endpoint }),
  ).toThrow('managed setup');
});
it('prevents cross-company connector selection', () => {
  const d = new CompanyConnectors(store).create(other, {
    name: 'Other provider',
    config: { endpoint: 'https://provider.example.com/mcp', auth: 'none' },
  });
  expect(() =>
    new CloudflarePortals(store, settings).request(owner, {
      mode: 'company',
      endpoint,
      connectorIds: [d.id],
    }),
  ).toThrow();
});
it('links a company portal as an unpublished connector after verification', async () => {
  const s = new CloudflarePortals(store, settings);
  s.request(owner, { mode: 'company', endpoint });
  const result = await s.activate(owner);
  expect(result.portal?.status).toBe('linked');
  const d = new CompanyConnectors(store).get(owner, result.portal!.connectorId!);
  expect(d.status).toBe('draft');
  expect(d.config.kind).toBe('cloudflare-portal');
  await expect(s.activate(owner)).rejects.toThrow();
});
it('rejects policy changes during external registration', async () => {
  const original = transport().send;
  settings.remoteFetch = async (url, init) => {
    const r = await original(url, init);
    if (String(url).endsWith('/register'))
      store.run('UPDATE organizations SET revision=revision+1 WHERE id=?', owner.orgId);
    return r;
  };
  const s = new CloudflarePortals(store, settings);
  s.request(owner, { mode: 'company', endpoint });
  await expect(s.activate(owner)).rejects.toThrow('changed');
  expect(s.view(owner).portal?.connectorId).toBeNull();
});
it.each(['portal_execute', 'portal_query_tools', 'portal_codemode_execute'])(
  'rejects generic execution wrapper %s',
  (name) => {
    expect(() =>
      parseTools([
        { name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ]),
    ).toThrow();
  },
);

it('binds an operator-provisioned pilot hostname to only its assigned company', () => {
  settings.env.ARGOS_PROVISIONED_PORTALS_JSON = JSON.stringify({ [owner.orgId]: endpoint });
  const service = new CloudflarePortals(store, settings);
  const assigned = service.request(owner, { mode: 'managed' });
  expect(assigned.portal?.endpoint).toBe(endpoint);
  expect(assigned.portal?.canActivate).toBe(true);
  expect(service.request(other, { mode: 'managed' }).portal?.endpoint).not.toBe(endpoint);
  expect(() => service.request(other, { mode: 'company', endpoint })).toThrow('managed setup');
});
