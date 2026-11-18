import { z } from 'zod';
import type { Express } from 'express';
import type { Auth } from './auth.js';
import { Store, insist, workspaceURL, type Settings, type Principal } from './foundation.js';
import { CompanyConnectors } from './company-connectors.js';
import { publicURL, type RemoteConfig } from './remote-definition.js';
import { safeFetch, remoteJSON } from './local/remote-mcp.js';
import {
  buildDiscoveryUrls,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';

type Portal = {
  org_id: string;
  mode: 'managed' | 'company';
  endpoint: string;
  connector_id: string | null;
  status: string;
  plan: string;
  created_at: number;
};
export const portalEndpoint = publicURL.refine(
  (value) => new URL(value).pathname === '/mcp',
  'Use the portal URL ending in /mcp, without query parameters',
);
const metadata = z.object({
  issuer: publicURL,
  authorization_endpoint: publicURL,
  token_endpoint: publicURL,
  registration_endpoint: publicURL,
  code_challenge_methods_supported: z.array(z.string()),
  scopes_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

// Only the explicitly chosen portal and its Cloudflare Access issuer participate
// in discovery. No client credentials, cookies or authorization headers are sent.
export async function registerPortal(
  endpoint: string,
  callback: string,
  send = safeFetch,
): Promise<RemoteConfig> {
  const portal = new URL(portalEndpoint.parse(endpoint));
  const resource = await discoverOAuthProtectedResourceMetadata(
    portal,
    undefined,
    async (input, init) => {
      const url = new URL(String(input));
      insist(url.origin === portal.origin, 'Unexpected protected-resource metadata origin', 400);
      return send(url, init);
    },
  );
  insist(publicURL.parse(resource.resource) === endpoint, 'Portal resource audience mismatch', 400);
  const issuers = z.array(publicURL).min(1).max(1).parse(resource.authorization_servers);
  const issuer = new URL(issuers[0]);
  insist(
    issuer.origin === portal.origin || /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname),
    'Expected this portal or a Cloudflare Access issuer',
    400,
  );
  let info: z.infer<typeof metadata> | undefined;
  for (const { url } of buildDiscoveryUrls(issuer)) {
    insist(url.origin === issuer.origin, 'Unexpected discovery origin');
    const r = await send(url, { headers: { Accept: 'application/json' } });
    if (r.status === 404) {
      await r.body?.cancel();
      continue;
    }
    insist(r.ok, 'Cloudflare OAuth metadata unavailable', 502);
    info = metadata.parse(await r.json());
    break;
  }
  insist(
    info &&
      new URL(info.issuer).href === issuer.href &&
      info.code_challenge_methods_supported.includes('S256'),
    'Enable Managed OAuth with PKCE on this portal',
    400,
  );
  for (const url of [info.authorization_endpoint, info.token_endpoint, info.registration_endpoint])
    insist(
      new URL(url).origin === issuer.origin,
      'Cloudflare OAuth endpoints must match the issuer origin',
      400,
    );
  insist(
    !info.token_endpoint_auth_methods_supported ||
      info.token_endpoint_auth_methods_supported.includes('none'),
    'A public PKCE client is required',
    400,
  );
  publicURL.parse(callback);
  const registered = await remoteJSON(
    info.registration_endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Argos company portal',
        redirect_uris: [callback],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    },
    send,
  );
  insist(
    !registered.client_secret &&
      (!registered.token_endpoint_auth_method || registered.token_endpoint_auth_method === 'none'),
    'Portal returned an unsupported confidential client',
    502,
  );
  if (registered.redirect_uris)
    insist(
      JSON.stringify(registered.redirect_uris) === JSON.stringify([callback]),
      'Portal changed the OAuth callback',
      502,
    );
  const scope = ['openid', 'profile', 'email', 'offline_access']
    .filter((s) => info!.scopes_supported?.includes(s))
    .join(' ');
  return {
    kind: 'cloudflare-portal',
    endpoint,
    auth: 'oauth',
    oauth: {
      issuer: issuer.href,
      authorize: info.authorization_endpoint,
      token: info.token_endpoint,
      clientId: z.string().min(1).max(300).parse(registered.client_id),
      resource: endpoint,
      scope,
    },
  };
}

export class CloudflarePortals {
  constructor(
    private store: Store,
    private settings: Settings,
  ) {}
  private row(org: string) {
    return this.store.get<Portal>('SELECT * FROM cloudflare_portals WHERE org_id=?', org);
  }
  private managedEndpoint(org: string) {
    const domain = this.settings.env.ARGOS_MANAGED_PORTAL_DOMAIN;
    if (!domain) return null;
    insist(/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(domain), 'Invalid managed portal domain', 503);
    return portalEndpoint.parse(
      'https://w-' + z.string().uuid().parse(org) + '.' + domain + '/mcp',
    );
  }
  private provisioned(org: string, endpoint: string) {
    const entries = z
      .record(z.string().uuid(), portalEndpoint)
      .parse(JSON.parse(this.settings.env.ARGOS_PROVISIONED_PORTALS_JSON ?? '{}'));
    return entries[org] === endpoint;
  }
  view(p: Principal) {
    const admin = this.store.member(p).role !== 'member',
      r = this.row(p.orgId);
    return {
      managedAvailable: !!this.managedEndpoint(p.orgId),
      callback: workspaceURL(this.settings) + '/oauth/callback/mcp',
      portal: r
        ? {
            mode: r.mode,
            endpoint: r.endpoint,
            connectorId: r.connector_id,
            status: r.status,
            canActivate: r.mode === 'company' || this.provisioned(p.orgId, r.endpoint),
          }
        : null,
      ...(admin && r ? { plan: JSON.parse(r.plan) } : {}),
    };
  }
  request(p: Principal, input: unknown) {
    this.store.admin(p);
    const b = z
      .object({
        mode: z.enum(['managed', 'company']),
        endpoint: portalEndpoint.optional(),
        connectorIds: z.array(z.string().uuid()).max(30).default([]),
      })
      .strict()
      .parse(input);
    insist(
      !this.row(p.orgId)?.connector_id,
      'A portal is already linked. Revoke existing portal connections and contact your backend operator to migrate it.',
      409,
    );
    const endpoint = b.mode === 'managed' ? this.managedEndpoint(p.orgId) : b.endpoint;
    if (b.mode === 'company' && b.endpoint && this.settings.env.ARGOS_MANAGED_PORTAL_DOMAIN) {
      const host = new URL(b.endpoint).hostname,
        domain = this.settings.env.ARGOS_MANAGED_PORTAL_DOMAIN;
      insist(
        host !== domain && !host.endsWith('.' + domain),
        'Use managed setup for an Argos-managed portal',
        400,
      );
    }
    insist(
      endpoint,
      'Managed Cloudflare setup is not available yet; your operator must configure the portal domain',
      503,
    );
    insist(
      b.mode !== 'managed' || !b.endpoint,
      'Managed portal addresses are assigned by Argos',
      400,
    );
    const company = new CompanyConnectors(this.store);
    const servers = [...new Set(b.connectorIds)].map((cid) => {
      const d = company.get(p, cid);
      insist(
        d.config.kind !== 'cloudflare-portal' && d.config.auth === 'oauth',
        'Select direct OAuth provider connectors for your portal',
        400,
      );
      return {
        id: 'c-' + p.orgId.replaceAll('-', '') + '-' + cid.replaceAll('-', '').slice(0, 16),
        name: d.name,
        endpoint: d.config.endpoint,
      };
    });
    const emails = this.store
      .all<{ email: string }>(
        'SELECT u.email FROM users u JOIN members m ON m.user_id=u.id WHERE m.org_id=? AND NOT EXISTS (SELECT 1 FROM blocked_members b WHERE b.org_id=m.org_id AND b.user_id=m.user_id)',
        p.orgId,
      )
      .map((x) => x.email);
    const plan = {
      version: 1,
      organizationId: p.orgId,
      company: this.store.org(p.orgId).name,
      endpoint,
      callback: workspaceURL(this.settings) + '/oauth/callback/mcp',
      emails,
      servers,
      mode: b.mode,
    };
    this.store.run(
      'INSERT INTO cloudflare_portals VALUES(?,?,?,?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET mode=excluded.mode,endpoint=excluded.endpoint,status=excluded.status,plan=excluded.plan,created_at=excluded.created_at',
      p.orgId,
      b.mode,
      endpoint,
      null,
      'setup_required',
      JSON.stringify(plan),
      Date.now(),
    );
    this.store.audit(p, 'portal.setup_requested', p.orgId);
    return this.view(p);
  }
  async activate(p: Principal) {
    this.store.admin(p);
    const r = this.row(p.orgId);
    insist(r && !r.connector_id, 'No pending portal setup', 409);
    insist(
      r.mode === 'company' || this.provisioned(p.orgId, r.endpoint),
      'Your managed portal has not been provisioned yet',
      409,
    );
    const revision = this.store.org(p.orgId).revision;
    const config = await registerPortal(
      r.endpoint,
      workspaceURL(this.settings) + '/oauth/callback/mcp',
      this.settings.remoteFetch ?? safeFetch,
    );
    this.store.db.transaction(() => {
      this.store.admin(p);
      const current = this.row(p.orgId);
      insist(
        current &&
          !current.connector_id &&
          current.endpoint === r.endpoint &&
          current.plan === r.plan &&
          current.created_at === r.created_at &&
          this.store.org(p.orgId).revision === revision,
        'Company setup changed. Start again.',
        409,
      );
      const d = new CompanyConnectors(this.store).create(p, {
        name: 'Cloudflare company portal',
        catalogId: 'cloudflare-mcp-portal',
        config,
      });
      this.store.run(
        "UPDATE cloudflare_portals SET connector_id=?,status='linked' WHERE org_id=?",
        d.id,
        p.orgId,
      );
      this.store.audit(p, 'portal.linked', d.id);
    })();
    return this.view(p);
  }
  mount(app: Express, auth: Auth) {
    app.get('/api/org/:orgId/cloudflare', (req, res) => res.json(this.view(auth.principal(req))));
    app.post('/api/org/:orgId/cloudflare/setup', (req, res) =>
      res.json(this.request(auth.principal(req), req.body)),
    );
    app.post('/api/org/:orgId/cloudflare/activate', async (req, res) => {
      z.object({}).strict().parse(req.body);
      res.json(await this.activate(auth.principal(req)));
    });
  }
}
