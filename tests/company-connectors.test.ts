import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/node-store.js';
import { id, Vault, type Principal, type Connection } from '../src/foundation.js';
import {
  CompanyConnectors,
  toolsFor,
  configFingerprintForTools,
} from '../src/company-connectors.js';
import {
  remoteToolName,
  remoteConfigSchema,
  parseTools,
  inputValidator,
  publicURL,
} from '../src/remote-definition.js';
import { Gateway } from '../src/gateway.js';
import { isPublicIPv4, safeFetch, discoverRemote, executeRemote } from '../src/local/remote-mcp.js';
import { authorizeURL, newAttempt } from '../src/local/providers.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]),
}));
let store: Store, company: CompanyConnectors, owner: Principal, member: Principal, other: Principal;
const config = { endpoint: 'https://mcp.example.com/mcp', auth: 'none' as const };
const manifest = [
  {
    name: 'find_records',
    description: 'Find CRM records',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];
beforeEach(() => {
  store = new Store();
  company = new CompanyConnectors(store);
  const org = id(),
    org2 = id();
  store.run('INSERT INTO organizations(id,name) VALUES(?,?)', org, 'A');
  store.run('INSERT INTO organizations(id,name) VALUES(?,?)', org2, 'B');
  owner = { orgId: org, userId: id() };
  member = { orgId: org, userId: id() };
  other = { orgId: org2, userId: id() };
  for (const p of [owner, member, other]) {
    store.run(
      'INSERT INTO users VALUES(?,?,?,?)',
      p.userId,
      null,
      p.userId + '@example.test',
      'User',
    );
    store.run(
      'INSERT INTO members VALUES(?,?,?)',
      p.orgId,
      p.userId,
      p === member ? 'member' : 'owner',
    );
  }
});
afterEach(() => store.db.close());
const draft = () => company.create(owner, { name: 'CRM', config });
function enabled() {
  const d = draft();
  company.discover(owner, d.id, d.fingerprint, manifest);
  return company.publish(owner, d.id, {
    enabled: true,
    names: ['find_records'],
    candidateHash: configFingerprintForTools(manifest),
  });
}
function connection(connectorId: string) {
  const cid = id();
  store.run(
    'INSERT INTO connections(id,org_id,provider,label,scope,owner_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
    cid,
    owner.orgId,
    'mcp',
    'CRM',
    'personal',
    owner.userId,
    Date.now(),
    Date.now() + 60000,
  );
  store.run('INSERT INTO connection_connectors VALUES(?,?,?)', cid, owner.orgId, connectorId);
  return store.get<Connection>('SELECT * FROM connections WHERE id=?', cid)!;
}

it('allows member requests but never member configuration, discovery or publishing', () => {
  const d = draft();
  company.request(member, { name: 'CRM', reason: 'Account research' });
  expect(company.requests(owner)).toHaveLength(1);
  expect(company.list(member)).toEqual([]);
  expect(() => company.create(member, { name: 'CRM', config })).toThrow(/Administrator/);
  expect(() => company.discover(member, d.id, d.fingerprint, manifest)).toThrow(/Administrator/);
  expect(() => company.publish(member, d.id, {})).toThrow(/Administrator/);
});
it('isolates connector definitions and requests by company and requester', () => {
  const d = enabled();
  const r = company.request(member, { name: 'CRM', reason: 'Work' });
  company.request(owner, { name: 'Other', reason: 'Work' });
  expect(company.requests(member)).toHaveLength(1);
  expect(company.requests(other)).toHaveLength(0);
  expect(company.list(other)).toEqual([]);
  expect(() => company.get(other, d.id)).toThrow(/not found/);
  expect(() => company.decide(other, r.id, { approve: false })).toThrow(/not found/);
});
it('only approves a pending request against an enabled connector in the same company', () => {
  const d = draft(),
    r = company.request(member, { name: 'CRM', reason: 'Work' });
  expect(() => company.decide(owner, r.id, { approve: true, connectorId: d.id })).toThrow(/Enable/);
  company.discover(owner, d.id, d.fingerprint, manifest);
  company.publish(owner, d.id, {
    enabled: true,
    names: ['find_records'],
    candidateHash: configFingerprintForTools(manifest),
  });
  company.decide(owner, r.id, {
    approve: true,
    connectorId: d.id,
    note: 'Connect in Argos Personal',
  });
  expect(company.requests(member)[0]).toMatchObject({ status: 'approved', connector_id: d.id });
  expect(() => company.decide(owner, r.id, { approve: false })).toThrow();
  expect(store.all('SELECT * FROM connections')).toHaveLength(0);
});
it('rejects stale reviews and never automatically enables newly discovered tools', () => {
  const d = enabled();
  const more = [...manifest, { ...manifest[0], name: 'delete_records' }];
  company.discover(owner, d.id, d.fingerprint, more);
  expect(toolsFor(store, owner.orgId)[remoteToolName(d.id, 'delete_records')]).toBeUndefined();
  expect(() =>
    company.publish(owner, d.id, {
      enabled: true,
      names: ['find_records'],
      candidateHash: configFingerprintForTools(manifest),
    }),
  ).toThrow(/changed/);
});
it('binds tools to their exact company connector and defaults to approval', async () => {
  const d = enabled(),
    c = connection(d.id),
    d2 = enabled(),
    c2 = connection(d2.id);
  const gateway = new Gateway(store, new Vault({ v1: randomBytes(32) }), {
    execute: async () => {
      throw new Error('Must not dispatch');
    },
  });
  const tool = remoteToolName(d.id, 'find_records');
  expect(gateway.companyPolicy(owner.orgId, tool)).toBe('approve');
  expect(() => gateway.authorize(owner, c2.id, tool)).toThrow();
  const r = await gateway.invoke(owner, c.id, tool, { arguments: { query: 'acme' } }, id());
  expect(r.status).toBe('pending');
  company.publish(owner, d.id, {
    enabled: false,
    names: [],
    candidateHash: configFingerprintForTools(manifest),
  });
  expect(store.get<any>('SELECT status FROM invocations WHERE id=?', r.id).status).toBe(
    'cancelled',
  );
  expect(() => gateway.authorize(owner, c.id, tool)).toThrow(/not enabled/);
});
it('resets allow decisions when a tool manifest changes', () => {
  const d = enabled(),
    tool = remoteToolName(d.id, manifest[0].name);
  store.run(
    "UPDATE organization_policies SET effect='allow' WHERE org_id=? AND tool=?",
    owner.orgId,
    tool,
  );
  const changed = [{ ...manifest[0], description: 'Changed behavior' }];
  company.discover(owner, d.id, d.fingerprint, changed);
  company.publish(owner, d.id, {
    enabled: true,
    names: ['find_records'],
    candidateHash: configFingerprintForTools(changed),
  });
  expect(
    store.get<any>(
      'SELECT effect FROM organization_policies WHERE org_id=? AND tool=?',
      owner.orgId,
      tool,
    ).effect,
  ).toBe('approve');
});
it('rejects unsafe URLs, secret fields and unbounded or unsupported schemas', () => {
  for (const u of [
    'http://example.com/mcp',
    'https://127.0.0.1/mcp',
    'https://user:password@example.com/mcp',
    'https://x.local/mcp',
    'https://example.com/mcp?token=secret',
    'https://[::1]/mcp',
  ])
    expect(() => publicURL.parse(u)).toThrow();
  expect(() => remoteConfigSchema.parse({ ...config, token: 'secret' })).toThrow();
  for (const schema of [
    { type: 'object', $ref: 'https://evil.test' },
    { type: 'object', properties: { q: { type: 'string', pattern: '(a+)+$' } } },
    { type: 'object', dependencies: { x: ['y'] } },
  ])
    expect(() => parseTools([{ ...manifest[0], inputSchema: schema }])).toThrow();
  expect(() => parseTools(Array(101).fill(manifest[0]))).toThrow();
});
it('validates exact arguments without applying JSON Schema defaults', () => {
  const s = inputValidator({
    type: 'object',
    properties: { query: { type: 'string', default: 'unexpected' } },
    additionalProperties: false,
  });
  expect(s.parse({})).toEqual({});
  expect(() => s.parse({ token: 'unexpected' })).toThrow();
});
it('blocks private network and metadata addresses before making a request', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
  ])
    expect(isPublicIPv4(ip)).toBe(false);
  expect(isPublicIPv4('1.1.1.1')).toBe(true);
  await expect(safeFetch('https://127.0.0.1/mcp')).rejects.toThrow();
  await expect(safeFetch('https://127.0.0.1.nip.io/mcp')).rejects.toThrow(/public addresses/);
});
it('uses the official Slack OAuth MCP endpoints with PKCE and optional DM scopes', async () => {
  const a = newAttempt(
    id(),
    'mcp',
    id(),
    'Slack',
    'public-client',
    'http://127.0.0.1:43127/oauth/callback',
  );
  a.remote = {
    ...draft(),
    config: remoteConfigSchema.parse({
      endpoint: 'https://mcp.slack.com/mcp',
      auth: 'oauth',
      oauth: {
        issuer: 'https://mcp.slack.com',
        authorize: 'https://slack.com/oauth/v2_user/authorize',
        token: 'https://slack.com/api/oauth.v2.user.access',
        clientId: 'public-client',
        scope: 'search:read.im im:history',
        resource: 'https://mcp.slack.com',
      },
    }),
  };
  const u = new URL(await authorizeURL(a));
  expect(u.origin + u.pathname).toBe('https://slack.com/oauth/v2_user/authorize');
  expect(u.searchParams.get('scope')).toBe('search:read.im,im:history');
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  expect(u.searchParams.has('client_secret')).toBe(false);
});

function fixtureTransport(tools = manifest) {
  const calls: any[] = [];
  const send = async (_url: string | URL, init: RequestInit = {}) => {
    if (init.method !== 'POST') return new Response(null, { status: 405 });
    const m = JSON.parse(init.body as string);
    calls.push(m);
    if (!Object.hasOwn(m, 'id')) return new Response(null, { status: 202 });
    const result =
      m.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : m.method === 'tools/list'
          ? { tools }
          : { content: [{ type: 'text', text: 'A record' }] };
    return Response.json({ jsonrpc: '2.0', id: m.id, result });
  };
  return { calls, send };
}
it('discovers and calls a remote tool only after a fresh dispatch permit', async () => {
  const { calls, send } = fixtureTransport(),
    d = enabled();
  expect(await discoverRemote(config, '', send)).toEqual(manifest);
  let permitted = false;
  const c = {
    id: id(),
    provider: 'mcp' as const,
    remote: d,
    clientId: '',
    label: 'CRM',
    credentials: { access_token: 'local-secret' },
    status: 'active' as const,
    expiresAt: Date.now() + 60000,
    autoRead: false,
  };
  const guardedSend = async (url: string | URL, init: RequestInit = {}) => {
    if (typeof init.body === 'string' && JSON.parse(init.body).method === 'tools/call')
      expect(permitted).toBe(true);
    return send(url, init);
  };
  await executeRemote(
    c,
    remoteToolName(d.id, 'find_records'),
    { arguments: { query: 'acme' } },
    async () => {
      permitted = true;
    },
    guardedSend,
  );
  expect(calls.filter((m) => m.method === 'tools/call')).toHaveLength(1);
  expect(calls.find((m) => m.method === 'tools/call').params).toEqual({
    name: 'find_records',
    arguments: { query: 'acme' },
  });
});
it('refuses changed remote schemas before claiming or invoking a tool', async () => {
  const d = enabled(),
    { calls, send } = fixtureTransport([{ ...manifest[0], description: 'Different operation' }]);
  const c = {
    id: id(),
    provider: 'mcp' as const,
    remote: d,
    clientId: '',
    label: 'CRM',
    credentials: { access_token: '' },
    status: 'active' as const,
    expiresAt: Date.now() + 60000,
    autoRead: false,
  };
  let claimed = false;
  await expect(
    executeRemote(
      c,
      remoteToolName(d.id, 'find_records'),
      { arguments: { query: 'x' } },
      async () => {
        claimed = true;
      },
      send,
    ),
  ).rejects.toThrow(/changed/);
  expect(claimed).toBe(false);
  expect(calls.some((m) => m.method === 'tools/call')).toBe(false);
});
it('refuses Cloudflare Code Mode tools that hide individual upstream actions', () => {
  for (const name of ['portal_codemode_search', 'portal_codemode_execute'])
    expect(() =>
      parseTools([{ name, description: 'Fixture', inputSchema: { type: 'object' } }]),
    ).toThrow('Code Mode');
});
