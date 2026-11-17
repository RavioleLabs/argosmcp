import { env, exports } from 'cloudflare:workers';
import { runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { Store, hash, opaque, id } from '../../src/foundation.js';
import { DurableDatabase } from '../../cloudflare/worker.js';
import { proofMessage } from '../../src/device-protocol.js';
import { validOrigin } from '../../src/local/remote.js';

const origin = 'https://alpha.example.test';
const rootId = '00000000-0000-4000-8000-000000000101';
async function accounts(suffix = '') {
  const a = opaque(),
    b = opaque();
  await runInDurableObject(env.WORKSPACES.getByName(rootId), (_instance, state) => {
    const store = new Store(new DurableDatabase(state.storage));
    for (const [email, token] of [
      ['creator' + suffix + '@example.test', a],
      ['second' + suffix + '@example.test', b],
    ]) {
      const uid = id();
      store.run('INSERT INTO users VALUES(?,?,?,?)', uid, email, email, email);
      store.run('INSERT INTO sessions VALUES(?,?,?)', hash(token), uid, Date.now() + 60000);
    }
  });
  return { a, b };
}
async function call(
  path: string,
  token = '',
  body?: unknown,
  method = 'POST',
  extra: Record<string, string> = {},
) {
  return exports.default.fetch(origin + path, {
    method: body === undefined ? 'GET' : method,
    redirect: 'manual',
    headers: {
      Cookie: 'argos_session=' + token,
      ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(response: Response, status = 200) {
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(status);
  return result;
}
it('creates isolated companies for any Google account, retries safely, joins by invitation, and revokes membership', async () => {
  const { a, b } = await accounts();
  await json(await call('/api/workspaces'), 401);
  await json(
    await call('/api/workspaces', a, { name: 'First company', requestId: id() }, 'POST', {
      Origin: 'https://attacker.test',
    }),
    403,
  );
  const requestId = id();
  const first = await json(
    await call('/api/workspaces', a, { name: 'First company', requestId }),
    201,
  );
  expect(first.url).toBe(origin + '/w/' + first.id);
  expect(validOrigin(first.url)).toBe(first.url);
  const path = '/w/' + first.id;
  expect(
    (await json(await call('/api/workspaces', a, { name: 'First company', requestId }), 201)).id,
  ).toBe(first.id);
  await json(await call('/api/workspaces', a, { name: 'Changed name', requestId }), 409);
  const second = await json(
    await call('/api/workspaces', b, { name: 'Second company', requestId }),
    201,
  );
  expect(second.id).not.toBe(first.id);
  const own = await json(await call(path + '/api/session', a));
  expect(own).toMatchObject({
    selfService: true,
    workspaceUrl: first.url,
    mcpUrl: first.url + '/mcp',
    organizations: [{ id: first.id, role: 'owner' }],
  });
  const stranger = await json(await call(path + '/api/session', b));
  expect(stranger.organizations).toEqual([]);
  await json(
    await call(path + '/api/org/' + first.id + '/state', b, undefined, 'GET', {
      'x-argos-internal-user': own.user.id,
    }),
    403,
  );
  const listed = await json(await call('/api/workspaces', a));
  expect(listed.workspaces.map((w: any) => w.id)).toEqual([first.id]);
  expect((await json(await call('/api/workspaces', b))).workspaces.map((w: any) => w.id)).toEqual([
    second.id,
  ]);
  await evictDurableObject(env.WORKSPACES.getByName(first.id));
  expect((await json(await call(path + '/api/session', a))).organizations[0].id).toBe(first.id);
  const invitation = await json(
    await call(path + '/api/org/' + first.id + '/invitations', a, {
      email: 'second@example.test',
      role: 'member',
    }),
  );
  expect(invitation.url.startsWith(first.url + '/?invite=')).toBe(true);
  const invite = new URL(invitation.url).searchParams.get('invite');
  await json(await call('/w/' + second.id + '/api/invitations/accept', b, { token: invite }), 403);
  await json(await call(path + '/api/invitations/accept', a, { token: invite }), 403);
  await json(await call(path + '/api/invitations/accept', b, { token: invite }));
  expect(
    (await json(await call('/api/workspaces', b))).workspaces.map((w: any) => w.id).sort(),
  ).toEqual([first.id, second.id].sort());
  const joined = await json(await call(path + '/api/session', b));
  expect(joined.organizations[0].role).toBe('member');
  await json(
    await call(path + '/api/org/' + first.id + '/members/' + joined.user.id, a, {}, 'DELETE'),
  );
  expect((await json(await call('/api/workspaces', b))).workspaces.map((w: any) => w.id)).toEqual([
    second.id,
  ]);
  await json(await call(path + '/api/org/' + first.id + '/state', b), 403);
  await json(await call('/w/' + id() + '/api/session', a), 404);

  // A native connector signs the full workspace address and its internal API path.
  const key = generateKeyPairSync('ed25519');
  const pairResponse = await exports.default.fetch(first.url + '/api/local/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: 'Local connector',
      publicKey: key.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    }),
  });
  const pair = await json(pairResponse);
  expect(pair.url).toBe(first.url + '/?device=' + pair.id);
  await json(
    await call(path + '/api/org/' + first.id + '/devices/' + pair.id + '/pair', a, {
      fingerprint: pair.fingerprint,
    }),
  );
  const at = Date.now(),
    nonce = opaque(),
    apiPath = '/api/local/status';
  const headers = {
    'Content-Type': 'application/json',
    'x-argos-device': pair.id,
    'x-argos-time': String(at),
    'x-argos-nonce': nonce,
    'x-argos-signature': sign(
      null,
      Buffer.from(proofMessage(first.url, apiPath, pair.id, at, nonce, {})),
      key.privateKey,
    ).toString('base64url'),
  };
  const status = await json(
    await exports.default.fetch(first.url + apiPath, { method: 'POST', headers, body: '{}' }),
  );
  expect(status.status).toBe('active');
  await json(
    await exports.default.fetch(second.url + apiPath, { method: 'POST', headers, body: '{}' }),
    401,
  );
  const unauthorized = await call(path + '/mcp/slack', a);
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get('www-authenticate')).toContain(
    '/.well-known/oauth-protected-resource' + path + '/mcp/slack',
  );
  await unauthorized.text();
  const resource = await json(
    await call('/.well-known/oauth-protected-resource' + path + '/mcp/slack'),
  );
  expect(resource).toMatchObject({
    resource: first.url + '/mcp/slack',
    authorization_servers: [first.url],
  });
  const metadata = await json(await call('/.well-known/oauth-authorization-server' + path));
  expect(metadata).toMatchObject({
    issuer: first.url,
    authorization_endpoint: first.url + '/authorize',
    token_endpoint: first.url + '/token',
    registration_endpoint: first.url + '/register',
  });
  const connectionId = id();
  async function native(api: string, body: unknown) {
    const time = Date.now(),
      requestNonce = opaque();
    return exports.default.fetch(first.url + api, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-argos-device': pair.id,
        'x-argos-time': String(time),
        'x-argos-nonce': requestNonce,
        'x-argos-signature': sign(
          null,
          Buffer.from(proofMessage(first.url, api, pair.id, time, requestNonce, body)),
          key.privateKey,
        ).toString('base64url'),
      },
      body: JSON.stringify(body),
    });
  }
  await json(
    await native('/api/local/connections', {
      id: connectionId,
      provider: 'engram',
      label: 'Personal memory',
    }),
  );
  const client = await json(
    await call(path + '/register', '', {
      client_name: 'Test MCP client',
      redirect_uris: ['https://client.example.test/callback'],
      token_endpoint_auth_method: 'none',
    }),
    201,
  );
  const verifier = opaque(),
    resourceURL = first.url + '/mcp/engram';
  const params = new URLSearchParams({
    client_id: client.client_id,
    response_type: 'code',
    redirect_uri: client.redirect_uris[0],
    resource: resourceURL,
    scope: 'mcp:tools',
    state: 'client-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const authorize = await call(path + '/authorize?' + params);
  expect(authorize.status).toBe(302);
  const consentURL = new URL(authorize.headers.get('location')!);
  expect(consentURL.origin + consentURL.pathname).toBe(first.url + '/');
  await authorize.text();
  const consent = consentURL.searchParams.get('consent');
  await json(
    await call('/w/' + second.id + '/api/org/' + second.id + '/consent', b, {
      token: consent,
      connections: [connectionId],
      accept: true,
    }),
    400,
  );
  const approved = await json(
    await call(path + '/api/org/' + first.id + '/consent', a, {
      token: consent,
      connections: [connectionId],
      accept: true,
    }),
  );
  const redirect = new URL(approved.redirect);
  expect(redirect.searchParams.get('iss')).toBe(first.url);
  const exchange = (base: string, suppliedVerifier: string) =>
    exports.default.fetch(base + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        resource: resourceURL,
        code: redirect.searchParams.get('code')!,
        code_verifier: suppliedVerifier,
      }),
    });
  const wrongCompany = await exchange(second.url, verifier);
  expect(wrongCompany.status).toBeGreaterThanOrEqual(400);
  await wrongCompany.text();
  const invalidVerifier = await exchange(first.url, 'wrong-verifier');
  expect(invalidVerifier.status).toBe(400);
  await invalidVerifier.text();
  const tokens = await json(await exchange(first.url, verifier));
  const rpc = (base: string, method: string, params: unknown = {}) =>
    exports.default.fetch(base + '/mcp/engram', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + tokens.access_token,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  const tools = await json(await rpc(first.url, 'tools/list'));
  expect(tools.result.tools.map((t: any) => t.name)).toContain('engram_recall');
  await json(await rpc(second.url, 'tools/list'), 401);
  const replay = await exchange(first.url, verifier);
  expect(replay.status).toBe(400);
  await replay.text();
});

it('preserves safe Google return paths and rejects redirect escapes', async () => {
  const target = '/w/' + id() + '/?invite=fixture-invitation';
  const response = await call('/auth/google?return_to=' + encodeURIComponent(target));
  expect(response.status).toBe(302);
  const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
  await response.text();
  const stored = await runInDurableObject(
    env.WORKSPACES.getByName(rootId),
    (_instance, context) => {
      const store = new Store(new DurableDatabase(context.storage));
      return store.get<{ payload: string }>('SELECT payload FROM states WHERE id=?', hash(state))!;
    },
  );
  expect(JSON.parse(stored.payload).returnTo).toBe(target);
  for (const destination of [
    'https://evil.test/',
    '//evil.test/',
    '/\\evil.test/',
    '/w/../auth/logout',
    '/?x=1#fragment',
  ]) {
    await json(await call('/auth/google?return_to=' + encodeURIComponent(destination)), 400);
  }
  expect(() => validOrigin(origin + '/w/not-a-workspace')).toThrow();
  expect(() => validOrigin(origin + '/w/' + id() + '?override=1')).toThrow();
});
it('binds server OAuth callbacks and encrypted credentials to their company and signed-in account', async () => {
  const { a, b } = await accounts('-server');
  const company = await json(
    await call('/api/workspaces', a, { name: 'Server custody', requestId: id() }),
    201,
  );
  const path = '/w/' + company.id;
  const base = path + '/api/org/' + company.id;
  await json(
    await call(base + '/server-custody', a, { enabled: true, acknowledgeRisk: true }, 'PUT'),
  );
  const started = await call(base + '/connect/slack', a, {
    label: 'Slack on server',
    scope: 'personal',
    acknowledgeServerCustody: true,
  });
  const binding = started.headers.get('set-cookie')!;
  expect(binding).toContain('Path=' + path + '/oauth/callback/slack');
  const url = new URL((await json(started)).url);
  expect(url.searchParams.get('redirect_uri')).toBe(origin + path + '/oauth/callback/slack');
  const callback =
    path + '/oauth/callback/slack?state=' + url.searchParams.get('state') + '&code=fixture-code';
  const { vi } = await import('vitest');
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    expect(String(input)).toBe('https://slack.com/api/oauth.v2.access');
    return Response.json({
      ok: true,
      authed_user: {
        access_token: 'fixture-workerd-token',
        refresh_token: 'fixture-workerd-refresh',
        expires_in: 3600,
      },
    });
  });
  try {
    const cookie = binding.split(';')[0];
    await json(
      await call(callback, b, undefined, 'GET', { Cookie: 'argos_session=' + b + '; ' + cookie }),
      403,
    );
    expect(provider).not.toHaveBeenCalled();
    const completed = await call(callback, a, undefined, 'GET', {
      Cookie: 'argos_session=' + a + '; ' + cookie,
    });
    expect(completed.status, await completed.text()).toBe(302);
    expect(completed.headers.get('location')).toBe(company.url + '/?view=connections');
    const state = await json(await call(base + '/state', a));
    expect(state.connections).toMatchObject([{ custody: 'server', status: 'active' }]);
    expect(JSON.stringify(state)).not.toContain('fixture-workerd-token');
    await json(await call(base + '/state', b), 403);
  } finally {
    provider.mockRestore();
  }
});
