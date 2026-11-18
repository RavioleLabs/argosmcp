import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { z } from 'zod';
const https = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (!u.port || u.port === '443') &&
      /^[a-z0-9.-]+\.[a-z]{2,}$/.test(u.hostname)
    );
  });
const schema = z.object({
  version: z.literal(1),
  organizationId: z.string().uuid(),
  company: z.string().min(1).max(160),
  mode: z.enum(['managed', 'company']),
  endpoint: https.refine((v) => new URL(v).pathname === '/mcp'),
  callback: https,
  emails: z.array(z.string().email()).min(1).max(1000),
  servers: z
    .array(
      z.object({
        id: z.string().regex(/^c-[a-f0-9]{32}-[a-f0-9]{16}$/),
        name: z.string().min(1).max(160),
        endpoint: https,
        auth: z.enum(['oauth', 'unauthenticated']).default('oauth'),
      }),
    )
    .max(30),
});
const cloudId = (kind, value) =>
  kind + '-' + createHash('sha256').update(value).digest('hex').slice(0, 30);
export function portalOperations(input, account, zone) {
  const p = schema.parse(input);
  z.string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(account);
  z.string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(zone);
  const org = p.organizationId.replaceAll('-', ''),
    hostname = new URL(p.endpoint).hostname;
  if (p.servers.some((s) => !s.id.startsWith('c-' + org + '-')))
    throw Error('Connector belongs to another company');
  if (new Set(p.servers.map((s) => s.id)).size !== p.servers.length)
    throw Error('Duplicate server');
  const app = (name, type, destinations, more = {}) => ({
    name,
    type,
    destinations,
    policies: [{ id: '$POLICY_ID', precedence: 1 }],
    ...more,
  });
  const operations = [
    {
      key: 'policy',
      command: ['zero-trust', 'access', 'policies', 'create'],
      body: {
        name: 'Argos ' + p.organizationId,
        decision: 'allow',
        include: p.emails.map((email) => ({ email: { email } })),
      },
    },
  ];
  for (const s of p.servers)
    operations.push(
      {
        key: s.id,
        command: ['mcp', 'servers', 'create'],
        body: { id: cloudId('c', s.id), name: s.name, hostname: s.endpoint, auth_type: s.auth },
      },
      {
        key: s.id + '-access',
        command: ['zero-trust', 'access', 'applications', 'create'],
        body: app(s.name, 'mcp', [
          { type: 'via_mcp_server_portal', mcp_server_id: cloudId('c', s.id) },
        ]),
      },
    );
  operations.push(
    {
      key: 'portal',
      command: ['mcp', 'portals', 'create'],
      body: {
        id: cloudId('a', p.organizationId),
        name: p.company,
        hostname,
        code_mode: 'off',
        servers: p.servers.map((s) => ({
          server_id: cloudId('c', s.id),
          on_behalf: s.auth === 'oauth',
          default_disabled: false,
        })),
      },
    },
    {
      key: 'portal-access',
      command: ['zero-trust', 'access', 'applications', 'create'],
      body: app(p.company, 'mcp_portal', [{ type: 'public', uri: hostname }], {
        domain: hostname,
        oauth_configuration: {
          enabled: true,
          dynamic_client_registration: {
            enabled: true,
            allow_any_on_localhost: false,
            allow_any_on_loopback: false,
            allowed_uris: [p.callback],
          },
          grant: { access_token_lifetime: '5m', session_duration: '24h' },
        },
      }),
    },
    {
      key: 'dns',
      command: ['dns', 'records', 'create', '--zone', zone],
      body: {
        type: 'CNAME',
        name: hostname,
        content: 'gateway.agents.cloudflare.com',
        proxied: true,
        ttl: 1,
      },
    },
  );
  return { plan: p, account, zone, operations };
}
export async function provision(bundle, run, state, save) {
  const { plan: p, zone, operations } = bundle,
    hostname = new URL(p.endpoint).hostname;
  const zones = await run(['zones', 'list', '--name', state.zoneName]);
  const found = zones.find((z) => z.id === zone);
  if (
    !found ||
    found.status !== 'active' ||
    !(hostname === found.name || hostname.endsWith('.' + found.name))
  )
    throw Error(
      'Activate the matching Cloudflare DNS zone before provisioning. Nothing was changed.',
    );
  const providers = await run(['zero-trust', 'identity-providers', 'list']);
  if (!providers.length)
    throw Error('Configure a Cloudflare Zero Trust identity provider first. Nothing was changed.');
  if (!Object.keys(state.completed).length) {
    const records = await run(['dns', 'records', 'list', '--zone', zone, '--name', hostname]);
    const portals = await run(['mcp', 'portals', 'list']);
    if (
      records.length ||
      portals.some((x) => x.hostname === hostname || x.id === cloudId('a', p.organizationId))
    )
      throw Error(
        'Hostname or portal already exists. Review and import it manually; this command never overwrites existing portals.',
      );
  }
  for (const operation of operations) {
    if (state.completed[operation.key]) continue;
    const body = JSON.parse(
      JSON.stringify(operation.body).replaceAll(
        '$POLICY_ID',
        state.completed.policy ?? '$POLICY_ID',
      ),
    );
    if (JSON.stringify(body).includes('$POLICY_ID')) throw Error('Missing access policy');
    const result = await run([...operation.command, '--body', JSON.stringify(body)]);
    if (!result?.id)
      throw Error(
        'Cloudflare returned no resource identifier. Inspect the account before retrying.',
      );
    state.completed[operation.key] = result.id;
    await save(state);
  }
  return {
    organizationId: p.organizationId,
    endpoint: p.endpoint,
    portalId: state.completed.portal,
  };
}
async function main() {
  process.umask(0o077);
  const [planFile, account, zone, zoneName, action] = process.argv.slice(2);
  if (!planFile || !account || !zone || !zoneName || (action && action !== '--apply'))
    throw Error(
      'Usage: node scripts/provision-cloudflare-portal.mjs plan.json ACCOUNT_ID ZONE_ID zone.example [--apply]',
    );
  const bundle = portalOperations(JSON.parse(readFileSync(planFile, 'utf8')), account, zone);
  if (!action) {
    console.log(
      JSON.stringify(
        {
          notice:
            'Preview only. Review the company, member emails, endpoints and callback before --apply. Cloudflare credentials remain with your local cf login.',
          ...bundle,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (process.env.CLOUDFLARE_API_BASE_URL || process.env.CLOUDFLARE_API_EXTRA_HEADERS)
    throw Error('Custom Cloudflare API routing is not supported');
  const filename = planFile + '.state.json',
    digest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  const state = existsSync(filename)
    ? JSON.parse(readFileSync(filename, 'utf8'))
    : { digest, zoneName, completed: {} };
  if (state.digest !== digest || state.zoneName !== zoneName)
    throw Error(
      'Plan differs from saved deployment. Review the existing resources before changing it.',
    );
  const cli = fileURLToPath(new URL('../node_modules/cf/bin/cf', import.meta.url));
  const run = async (args) => {
    try {
      return JSON.parse(
        execFileSync(process.execPath, [cli, ...args], {
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account },
          encoding: 'utf8',
          maxBuffer: 4000000,
          timeout: 60000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch {
      throw Error(
        'Cloudflare command failed: ' +
          args
            .slice(0, args.indexOf('--body') < 0 ? args.length : args.indexOf('--body'))
            .join(' ') +
          '. Inspect the account and saved state before retrying. Credentials and API output were not logged.',
      );
    }
  };
  const result = await provision(bundle, run, state, async (value) => {
    writeFileSync(filename, JSON.stringify(value, null, 2), { mode: 0o600 });
    chmodSync(filename, 0o600);
  });
  console.log(
    JSON.stringify(
      {
        ...result,
        next: 'Verify DNS, Access policies and Managed OAuth in Cloudflare. Managed operators then add this organization/endpoint to ARGOS_PROVISIONED_PORTALS_JSON. In Argos, verify and link, sign in personally, discover tools and publish the reviewed manifest. This output does not prove upstream OAuth compatibility.',
      },
      null,
      2,
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
