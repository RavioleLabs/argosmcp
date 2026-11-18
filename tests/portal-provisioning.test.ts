import { it, expect } from 'vitest';
// @ts-expect-error Operator-only JavaScript CLI, tested without account credentials.
import { portalOperations, provision } from '../scripts/provision-cloudflare-portal.mjs';
const org = '11111111-1111-4111-8111-111111111111',
  zone = 'a'.repeat(32),
  account = 'b'.repeat(32);
const plan = {
  version: 1,
  organizationId: org,
  company: 'Fixture',
  mode: 'company',
  endpoint: 'https://tools.example.com/mcp',
  callback: 'https://argos.example.com/oauth/callback/mcp',
  emails: ['owner@example.com'],
  servers: [
    {
      id: 'c-' + org.replaceAll('-', '') + '-' + 'c'.repeat(16),
      name: 'Provider',
      endpoint: 'https://provider.example.com/mcp',
    },
  ],
};
it('provisions isolated per-user servers, restricted OAuth and DNS last', async () => {
  const bundle = portalOperations(plan, account, zone),
    calls: any[] = [];
  const state = { zoneName: 'example.com', completed: {} as Record<string, string> };
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'zones') return [{ id: zone, name: 'example.com', status: 'active' }];
    if (args.includes('identity-providers')) return [{ id: 'idp' }];
    if (args.includes('list')) return [];
    return { id: 'resource-' + calls.length };
  };
  await provision(bundle, run, state, async () => {});
  const creations = calls.filter((x) => x.includes('--body')).map((x) => JSON.parse(x.at(-1)));
  expect(creations[0].include).toEqual([{ email: { email: 'owner@example.com' } }]);
  expect(creations.find((x) => x.code_mode).servers[0].on_behalf).toBe(true);
  const oauth = creations.find((x) => x.type === 'mcp_portal').oauth_configuration;
  expect(oauth.dynamic_client_registration.allowed_uris).toEqual([plan.callback]);
  expect(oauth.dynamic_client_registration.allow_any_on_loopback).toBe(false);
  expect(creations.at(-1).type).toBe('CNAME');
  calls.length = 0;
  await provision(bundle, run, state, async () => {});
  expect(calls.some((x) => x.includes('create'))).toBe(false);
});
it('makes no mutations when DNS is pending or resources already exist', async () => {
  for (const pending of [true, false]) {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'zones')
        return [{ id: zone, name: 'example.com', status: pending ? 'pending' : 'active' }];
      if (args.includes('identity-providers')) return [{ id: 'idp' }];
      return [{ id: 'existing', hostname: 'tools.example.com' }];
    };
    await expect(
      provision(
        portalOperations(plan, account, zone),
        run,
        { zoneName: 'example.com', completed: {} },
        async () => {},
      ),
    ).rejects.toThrow();
    expect(calls.some((x) => x.includes('create'))).toBe(false);
  }
});
it('rejects connector IDs from a different company and duplicate definitions', () => {
  expect(() =>
    portalOperations(
      { ...plan, organizationId: '22222222-2222-4222-8222-222222222222' },
      account,
      zone,
    ),
  ).toThrow();
  expect(() =>
    portalOperations({ ...plan, servers: [plan.servers[0], plan.servers[0]] }, account, zone),
  ).toThrow();
});

it('supports a public documentation server without shared provider credentials', () => {
  const bundle = portalOperations(
    { ...plan, servers: [{ ...plan.servers[0], auth: 'unauthenticated' }] },
    account,
    zone,
  );
  const server = bundle.operations.find((x: any) => x.key === plan.servers[0].id);
  expect(server.body.auth_type).toBe('unauthenticated');
  expect(bundle.operations.find((x: any) => x.key === 'portal').body.servers[0].on_behalf).toBe(
    false,
  );
  expect(
    bundle.operations.find((x: any) => x.key === 'portal-access').body.oauth_configuration.enabled,
  ).toBe(true);
});

it('uses stable Cloudflare identifiers of at most 32 characters', () => {
  const operations = portalOperations(plan, account, zone).operations;
  const server = operations.find((x: any) => x.key === plan.servers[0].id).body.id;
  const portal = operations.find((x: any) => x.key === 'portal').body;
  expect(server.length).toBeLessThanOrEqual(32);
  expect(portal.id.length).toBeLessThanOrEqual(32);
  expect(portal.servers[0].server_id).toBe(server);
  expect(
    operations.find((x: any) => x.key === plan.servers[0].id + '-access').body.destinations[0]
      .mcp_server_id,
  ).toBe(server);
  expect(server).not.toContain('_');
});
