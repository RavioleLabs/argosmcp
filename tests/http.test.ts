import { beforeAll, afterAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { Store } from '../src/node-store.js';
import { Vault, id, type Connection, type Settings } from '../src/foundation.js';
import { createApp, seedDemo, DEMO_ORG, DEMO_USER } from '../src/app.js';
let server: Server,
  store: Store,
  origin: string,
  cookie: string,
  app: ReturnType<typeof createApp>,
  slack: Connection,
  notion: Connection;
const principal = { userId: DEMO_USER, orgId: DEMO_ORG };
beforeAll(async () => {
  store = new Store();
  const vault = new Vault({ v1: randomBytes(32) });
  seedDemo(store, vault);
  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const settings: Settings = { origin, demo: true, dataDir: '/tmp', env: {} };
  app = createApp(store, vault, settings);
  server.on('request', app.app);
  const login = await fetch(origin + '/api/demo/login', {
    method: 'POST',
    headers: { Origin: origin },
  });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  slack = store.get<Connection>('SELECT * FROM connections WHERE provider=?', 'slack')!;
  notion = store.get<Connection>('SELECT * FROM connections WHERE provider=?', 'notion')!;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.db.close();
});
async function rpc(path: string, token: string, method: string, params?: unknown) {
  return fetch(origin + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
it('publishes exact protected-resource metadata for every service', async () => {
  for (const path of ['/mcp', '/mcp/slack', '/mcp/notion', '/mcp/linear']) {
    const denied = await fetch(origin + path);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain(
      '/.well-known/oauth-protected-resource' + path,
    );
    const meta = await fetch(origin + '/.well-known/oauth-protected-resource' + path).then((r) =>
      r.json(),
    );
    expect(meta.resource).toBe(origin + path);
  }
});
it('keeps provider tools and bearer audiences separate', async () => {
  const g = app.auth.createGrant(principal, 'test', 'Slack', [slack.id], origin + '/mcp/slack');
  const token = app.auth.issueTokens(g).access_token;
  const response = await rpc('/mcp/slack', token, 'tools/list', {});
  expect(response.status).toBe(200);
  const body = await response.json();
  const names = body.result.tools.map((t: any) => t.name);
  expect(names).toContain('slack_history');
  expect(names).not.toContain('notion_search');
  expect(names).not.toContain('slack_delete_message');
  expect((await rpc('/mcp/notion', token, 'tools/list', {})).status).toBe(401);
  expect((await rpc('/mcp', token, 'tools/list', {})).status).toBe(401);
  const attempted = await rpc('/mcp/slack', token, 'tools/call', {
    name: 'notion_search',
    arguments: { connection_id: notion.id, request_id: id(), query: 'secret' },
  }).then((r) => r.json());
  expect(attempted.result.isError).toBe(true);
});
it('enforces approval over MCP and exposes the result only to the requesting grant', async () => {
  const g = app.auth.createGrant(principal, 'test', 'Slack', [slack.id], origin + '/mcp/slack'),
    token = app.auth.issueTokens(g).access_token;
  const req = {
    name: 'slack_send_message',
    arguments: {
      connection_id: slack.id,
      request_id: id(),
      channel: 'C_TEST',
      text: 'Simulated test',
    },
  };
  const pending = await rpc('/mcp/slack', token, 'tools/call', req).then((r) => r.json());
  const action = JSON.parse(pending.result.content[0].text);
  expect(action.status).toBe('pending');
  const decision = await fetch(`${origin}/api/org/${DEMO_ORG}/approvals/${action.id}`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve: true }),
  });
  expect(decision.status).toBe(200);
  const result = await rpc('/mcp/slack', token, 'tools/call', {
    name: 'argos_result',
    arguments: { invocation_id: action.id },
  }).then((r) => r.json());
  expect(JSON.parse(result.result.content[0].text).status).toBe('completed');
  const other = app.auth.createGrant(principal, 'test', 'Other', [slack.id], origin + '/mcp/slack');
  const forbidden = await rpc(
    '/mcp/slack',
    app.auth.issueTokens(other).access_token,
    'tools/call',
    { name: 'argos_result', arguments: { invocation_id: action.id } },
  ).then((r) => r.json());
  expect(forbidden.result.isError).toBe(true);
});
it('rejects browser mutations from another origin', async () => {
  const response = await fetch(`${origin}/api/org/${DEMO_ORG}/company-policies`, {
    method: 'PUT',
    headers: { Cookie: cookie, Origin: 'https://evil.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'slack_history', effect: 'allow' }),
  });
  expect(response.status).toBe(403);
});
it('completes public-client OAuth with PKCE and a service-specific resource', async () => {
  const client = await fetch(origin + '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Integration test',
      redirect_uris: ['http://127.0.0.1:3333/callback'],
      token_endpoint_auth_method: 'none',
    }),
  }).then((r) => r.json());
  const verifier = randomBytes(32).toString('base64url'),
    resource = origin + '/mcp/slack';
  const params = new URLSearchParams({
    client_id: client.client_id,
    response_type: 'code',
    redirect_uri: client.redirect_uris[0],
    resource,
    scope: 'mcp:tools',
    state: 'client-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const authorize = await fetch(origin + '/authorize?' + params, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const consent = new URL(authorize.headers.get('location')!).searchParams.get('consent')!;
  const accepted = await fetch(`${origin}/api/org/${DEMO_ORG}/consent`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: consent, connections: [slack.id], accept: true }),
  }).then((r) => r.json());
  const code = new URL(accepted.redirect).searchParams.get('code')!;
  const exchange = (code_verifier: string) =>
    fetch(origin + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        resource,
        code,
        code_verifier,
      }),
    });
  expect((await exchange('wrong-verifier')).status).toBe(400);
  const result = await exchange(verifier);
  expect(result.status).toBe(200);
  const tokens = await result.json();
  expect((await rpc('/mcp/slack', tokens.access_token, 'tools/list', {})).status).toBe(200);
  expect((await exchange(verifier)).status).toBe(400);
});

it('does not advertise or accept the retired memory MCP surface', async () => {
  const grant = app.auth.createGrant(principal, 'test', 'All services', [slack.id, notion.id]);
  const token = app.auth.issueTokens(grant).access_token;
  const response = await rpc('/mcp', token, 'tools/list', {});
  const body = await response.json();
  expect(body.result.tools.some((tool: any) => tool.name.startsWith('engram_'))).toBe(false);
  const oldEndpoint = await rpc('/mcp/engram', token, 'tools/list', {});
  expect(oldEndpoint.status).toBeGreaterThanOrEqual(400);
  const oldTool = await rpc('/mcp', token, 'tools/call', {
    name: 'engram_recall',
    arguments: { connection_id: notion.id, query: 'private' },
  }).then((r) => r.json());
  expect(oldTool.error || oldTool.result?.isError).toBeTruthy();
});
