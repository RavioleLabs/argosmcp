import express, { type Request, type Response, type NextFunction } from 'express';
import { dashboardAsset } from './dashboard-assets.js';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  Store,
  workspaceURL,
  Vault,
  Fault,
  insist,
  id,
  opaque,
  hash,
  DAY,
  type Principal,
  type Connection,
  type Grant,
  type Settings,
} from './foundation.js';
import { Auth, cookies } from './auth.js';
import {
  Connectors,
  catalog,
  credentialContext,
  providerConfig,
  type OAuthProvider,
  type ToolName,
} from './connectors.js';
import { Gateway } from './gateway.js';
import { ServerCustody } from './server-custody.js';
import { Devices } from './devices.js';

const name = z.string().trim().min(1).max(120);
const selected = z.array(z.string().uuid()).min(1).max(100);
const scopeSchema = z
  .object({
    scope: z.enum(['personal', 'team', 'organization']),
    teamId: z.string().uuid().nullable().optional(),
  })
  .strict();
export function createApp(store: Store, vault: Vault, settings: Settings) {
  const app = express(),
    auth = new Auth(store, settings),
    connectors = new Connectors(store, vault, settings),
    serverCustody = new ServerCustody(store, settings),
    gateway = new Gateway(store, vault, {
      execute: (c, t, a, beforeDispatch) => {
        if (settings.demo && c.demo) return connectors.execute(c, t, a, beforeDispatch);
        return serverCustody.execute(c, t, a, beforeDispatch ?? (async () => {}));
      },
    });
  connectors.server = serverCustody;
  const devices = new Devices(store, vault, gateway, workspaceURL(settings));
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (settings.origin.startsWith('https:'))
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    // Host and Origin checking also protects loopback demo from DNS rebinding and drive-by requests.
    if (req.headers.host !== new URL(settings.origin).host)
      return res.status(403).json({ error: 'Host not allowed' });
    const origin = req.headers.origin;
    if (req.path.startsWith('/api/local/') && req.headers.origin)
      return res.status(403).json({ error: 'Native connector requests only' });
    if (
      !req.path.startsWith('/api/local/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      ![
        '/token',
        '/register',
        '/revoke',
        '/mcp',
        '/mcp/slack',
        '/mcp/notion',
        '/mcp/linear',
      ].includes(req.path)
    ) {
      if (origin !== settings.origin)
        return res.status(403).json({ error: 'Same-origin request required' });
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  // Basic single-instance throttling; OAuth endpoints additionally use the SDK's rate limiter.
  const rates = new Map<string, { count: number; until: number }>();
  app.use((req, res, next) => {
    const key = hash(
        settings.hosted
          ? String(req.headers['cf-connecting-ip'] ?? 'unknown')
          : (req.ip ?? 'unknown'),
      ),
      now = Date.now();
    if (settings.hosted) {
      store.run('DELETE FROM rate_limits WHERE until<?', now);
      const bucket = ['/authorize', '/register', '/token', '/revoke'].includes(req.path)
        ? 'oauth:'
        : 'api:';
      const count = store.db.transaction(() => {
        store.run(
          'INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',
          bucket + key,
          now + 60000,
        );
        return store.get<{ count: number }>(
          'SELECT count FROM rate_limits WHERE key=?',
          bucket + key,
        )!.count;
      })();
      if (count > (bucket === 'oauth:' ? 60 : 300))
        return res.status(429).json({ error: 'Too many requests. Try again in one minute.' });
      return next();
    }
    if (rates.size > 10000) for (const [k, v] of rates) if (v.until < now) rates.delete(k);
    let row = rates.get(key);
    if (!row || row.until < now) {
      row = { count: 0, until: now + 60_000 };
      rates.set(key, row);
    }
    if (++row.count > 300)
      return res.status(429).json({ error: 'Too many requests. Try again in one minute.' });
    next();
  });
  auth.mount(app);
  devices.mount(app, auth);
  serverCustody.mount(app, auth, connectors);
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'argosmcp' }));
  app.get('/api/session', (req, res) => {
    const userId = auth.session(req);
    const user = userId
      ? store.get<{ id: string; name: string; email: string }>(
          'SELECT id,name,email FROM users WHERE id=?',
          userId,
        )
      : null;
    const canCreateWorkspace =
      !!user &&
      (!settings.hosted ||
        (!!settings.tenant &&
          user.email.toLowerCase() === settings.tenant.ownerEmail.toLowerCase() &&
          !store.get('SELECT 1 FROM organizations')));
    res.json({
      demo: settings.demo,
      hosted: !!settings.hosted,
      singleWorkspace: !!settings.tenant,
      selfService: !!settings.selfService,
      workspaceUrl: workspaceURL(settings),
      googleConfigured: !!(settings.env.GOOGLE_CLIENT_ID && settings.env.GOOGLE_CLIENT_SECRET),
      user,
      canCreateWorkspace,
      workspaceName: user ? (settings.tenant?.name ?? null) : null,
      organizations: userId
        ? store.all(
            'SELECT o.*,m.role FROM organizations o JOIN members m ON o.id=m.org_id WHERE m.user_id=? AND NOT EXISTS(SELECT 1 FROM blocked_members b WHERE b.org_id=m.org_id AND b.user_id=m.user_id)',
            userId,
          )
        : [],
      mcpUrl: auth.audience,
    });
  });
  app.post('/api/demo/login', (_req, res) => {
    insist(settings.demo, 'Demo disabled', 404);
    seedDemo(store, vault);
    auth.issueSession(res, DEMO_USER);
    res.json({ ok: true });
  });
  app.post('/api/organizations', (req, res) => {
    insist(
      !settings.hosted || settings.tenant,
      'This address is not configured for workspace creation',
      403,
    );
    const input = z.object({ name }).strict().parse(req.body);
    res.json({ id: auth.createOrg(auth.user(req), input.name) });
  });
  app.get('/api/consent/:token', (req, res) => {
    auth.user(req);
    res.json(auth.consentInfo(String(req.params.token)));
  });
  app.post('/api/org/:orgId/consent', (req, res) => {
    const input = z
      .object({
        token: z.string().min(1),
        connections: z.array(z.string().uuid()).max(100),
        accept: z.boolean(),
      })
      .strict()
      .parse(req.body);
    res.json({
      redirect: auth.approveConsent(
        auth.principal(req),
        input.token,
        input.connections,
        input.accept,
      ),
    });
  });
  app.get('/api/org/:orgId/state', (req, res) => {
    const p = auth.principal(req),
      org = store.org(p.orgId),
      role = store.member(p).role;
    const connections = store
      .all<Connection>('SELECT * FROM connections WHERE org_id=? ORDER BY created_at', p.orgId)
      .filter((c) => ['slack', 'notion', 'linear'].includes(c.provider) && store.canAccess(p, c))
      .map((c) => ({
        id: c.id,
        provider: c.provider,
        label: c.label,
        scope: c.scope,
        ownerId: c.owner_id,
        teamId: c.team_id,
        expiresAt: store.expires(c),
        status: c.status === 'active' && store.expires(c) <= Date.now() ? 'expired' : c.status,
        revokeStatus: c.revoke_status,
        demo: !!c.demo,
        custody: store.get('SELECT 1 FROM server_credentials WHERE connection_id=?', c.id)
          ? 'server'
          : c.demo
            ? 'demo'
            : 'local',
        local: !!store.get('SELECT 1 FROM local_connections WHERE connection_id=?', c.id),
        policies: Object.entries(catalog)
          .filter(([, t]) => t.provider === c.provider)
          .map(([key, t]) => ({
            tool: key,
            title: t.title,
            write: t.write,
            effect: gateway.policy(c, key, p),
            companyEffect: gateway.companyPolicy(p.orgId, key),
            personalEffect: gateway.personalRestriction(p, c.id, key),
          })),
      }));
    const teams = store
      .all<{ id: string; name: string }>('SELECT id,name FROM teams WHERE org_id=?', p.orgId)
      .map((t) => ({
        ...t,
        members: store
          .all<{ user_id: string }>(
            'SELECT user_id FROM team_members WHERE org_id=? AND team_id=?',
            p.orgId,
            t.id,
          )
          .map((m) => m.user_id),
      }));
    const grants = store
      .all<Grant>(
        role === 'member'
          ? 'SELECT * FROM grants WHERE org_id=? AND user_id=?'
          : 'SELECT * FROM grants WHERE org_id=?',
        ...[p.orgId, ...(role === 'member' ? [p.userId] : [])],
      )
      .map((g) => ({
        id: g.id,
        label: g.label,
        userId: g.user_id,
        revoked: !!g.revoked,
        expiresAt: Math.min(g.expires_at, g.created_at + org.grant_hours * 3600_000),
        connections: JSON.parse(g.connections),
      }));
    res.json({
      org,
      role,
      connections,
      serverCustody: {
        available: serverCustody.available,
        enabled: serverCustody.enabled(p.orgId),
        providers: ['slack', 'notion', 'linear'].map((provider) => ({
          provider,
          configured: serverCustody.configured(provider),
        })),
      },
      teams,
      grants,
      devices: store.all(
        'SELECT id,label,user_id,status,created_at,expires_at,last_seen FROM devices WHERE org_id=?' +
          (role === 'member' ? ' AND user_id=?' : ''),
        p.orgId,
        ...(role === 'member' ? [p.userId] : []),
      ),
      companyPolicies: Object.entries(catalog).map(([tool, def]) => ({
        tool,
        provider: def.provider,
        title: def.title,
        write: def.write,
        effect: gateway.companyPolicy(p.orgId, tool),
      })),
      approvals: gateway.approvalRows(p),
      members: store.all(
        'SELECT u.id,u.name,u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.org_id=? AND NOT EXISTS(SELECT 1 FROM blocked_members b WHERE b.org_id=m.org_id AND b.user_id=m.user_id)',
        p.orgId,
      ),
      audit: store.all(
        'SELECT id,actor_id,event,entity_id,created_at,entry_hash FROM audit WHERE org_id=? ORDER BY seq DESC LIMIT 60',
        p.orgId,
      ),
      providers: ['slack', 'notion', 'linear'].map((provider) => ({
        provider,
        configured: connectors.configured(provider),
      })),
    });
  });
  app.put('/api/org/:orgId/settings', async (req, res) => {
    const p = auth.principal(req);
    store.admin(p);
    const input = z
      .object({
        name,
        leaseHours: z.number().int().min(1).max(8760),
        grantHours: z.number().int().min(1).max(8760),
      })
      .strict()
      .parse(req.body);
    store.run(
      'UPDATE organizations SET name=?,lease_hours=?,grant_hours=?,revision=revision+1 WHERE id=?',
      input.name,
      input.leaseHours,
      input.grantHours,
      p.orgId,
    );
    store.audit(p, 'organization.security_updated', p.orgId);
    res.json({ ok: true });
  });
  function validScope(p: Principal, scope: string, teamId?: string | null) {
    if (scope !== 'personal') store.admin(p);
    if (scope === 'team')
      insist(
        teamId &&
          store.get(
            'SELECT 1 FROM team_members WHERE org_id=? AND team_id=? AND user_id=?',
            p.orgId,
            teamId,
            p.userId,
          ),
        'Join the team before connecting its service',
      );
    else insist(!teamId, 'teamId only applies to team contexts', 400);
  }
  app.post('/api/org/:orgId/connections/:id/revoke', async (req, res) => {
    const p = auth.principal(req),
      c = store.connection(p, String(req.params.id));
    if (c.scope !== 'personal') store.admin(p);
    connectors.revokeLocally(c);
    store.audit(p, 'connection.revoked', c.id);
    await connectors.revokeUpstream(c.id);
    res.json({ ok: true });
  });
  app.put('/api/org/:orgId/policies', (req, res) => {
    const p = auth.principal(req);
    store.admin(p);
    const input = z
      .object({
        connectionId: z.string().uuid(),
        tool: z.string(),
        effect: z.enum(['allow', 'approve', 'block']),
      })
      .strict()
      .parse(req.body);
    const c = store.connection(p, input.connectionId);
    insist(
      input.tool in catalog && catalog[input.tool as ToolName].provider === c.provider,
      'Unknown tool',
      400,
    );
    store.db.transaction(() => {
      store.run(
        'INSERT INTO policies VALUES(?,?,?,?) ON CONFLICT(org_id,connection_id,tool) DO UPDATE SET effect=excluded.effect',
        p.orgId,
        c.id,
        input.tool,
        input.effect,
      );
      store.run('UPDATE organizations SET revision=revision+1 WHERE id=?', p.orgId);
      store.run(
        "UPDATE invocations SET status='cancelled' WHERE org_id=? AND status IN ('pending','approved')",
        p.orgId,
      );
      store.audit(p, `policy.${input.effect}`, c.id);
    })();
    res.json({ ok: true });
  });
  app.put('/api/org/:orgId/company-policies', (req, res) => {
    const p = auth.principal(req);
    store.admin(p);
    const input = z
      .object({ tool: z.string(), effect: z.enum(['allow', 'approve', 'block']) })
      .strict()
      .parse(req.body);
    insist(Object.hasOwn(catalog, input.tool), 'Unknown tool', 400);
    store.db.transaction(() => {
      store.run(
        'INSERT INTO organization_policies VALUES(?,?,?) ON CONFLICT(org_id,tool) DO UPDATE SET effect=excluded.effect',
        p.orgId,
        input.tool,
        input.effect,
      );
      store.run('UPDATE organizations SET revision=revision+1 WHERE id=?', p.orgId);
      store.run(
        "UPDATE invocations SET status='cancelled' WHERE org_id=? AND status IN ('pending','approved')",
        p.orgId,
      );
      store.audit(p, `company_policy.${input.effect}`, input.tool);
    })();
    res.json({ ok: true });
  });
  app.put('/api/org/:orgId/my-restrictions', (req, res) => {
    const p = auth.principal(req);
    const input = z
      .object({
        connectionId: z.string().uuid(),
        tool: z.string(),
        effect: z.enum(['inherit', 'approve', 'block']),
      })
      .strict()
      .parse(req.body);
    const c = store.connection(p, input.connectionId);
    insist(
      Object.hasOwn(catalog, input.tool) && catalog[input.tool as ToolName].provider === c.provider,
      'Unknown tool',
      400,
    );
    store.db.transaction(() => {
      if (input.effect === 'inherit')
        store.run(
          'DELETE FROM personal_restrictions WHERE org_id=? AND user_id=? AND connection_id=? AND tool=?',
          p.orgId,
          p.userId,
          c.id,
          input.tool,
        );
      else
        store.run(
          'INSERT INTO personal_restrictions VALUES(?,?,?,?,?) ON CONFLICT(org_id,user_id,connection_id,tool) DO UPDATE SET effect=excluded.effect',
          p.orgId,
          p.userId,
          c.id,
          input.tool,
          input.effect,
        );
      store.run(
        "UPDATE invocations SET status='cancelled' WHERE org_id=? AND user_id=? AND status IN ('pending','approved')",
        p.orgId,
        p.userId,
      );
      store.audit(p, 'personal_restriction.updated', c.id);
    })();
    res.json({ ok: true });
  });
  app.post('/api/org/:orgId/approvals/:id', async (req, res) => {
    const input = z.object({ approve: z.boolean() }).strict().parse(req.body);
    res.json(await gateway.decide(auth.principal(req), String(req.params.id), input.approve));
  });
  app.post('/api/org/:orgId/invoke', async (req, res) => {
    const input = z
      .object({
        connectionId: z.string().uuid(),
        tool: z.string(),
        args: z.record(z.string(), z.unknown()),
        requestId: z.string().min(1).max(128),
      })
      .strict()
      .parse(req.body);
    res.json(
      await gateway.invoke(
        auth.principal(req),
        input.connectionId,
        input.tool as ToolName,
        input.args,
        input.requestId,
      ),
    );
  });
  app.get('/api/org/:orgId/results/:id', (req, res) =>
    res.json(gateway.read(auth.principal(req), String(req.params.id))),
  );
  app.post('/api/org/:orgId/grants', (req, res) => {
    const p = auth.principal(req),
      input = z
        .object({ label: name, connections: selected, resource: z.string().optional() })
        .strict()
        .parse(req.body);
    const grant = auth.createGrant(
      p,
      'personal-agent',
      input.label,
      input.connections,
      input.resource,
    );
    // Bot token has an absolute enterprise-controlled lifetime. The raw token is shown once.
    const token = opaque();
    store.run(
      'INSERT INTO tokens VALUES(?,?,?,?)',
      hash(token),
      grant.id,
      'access',
      grant.expires_at,
    );
    res.json({
      id: grant.id,
      token,
      expiresAt: grant.expires_at,
      mcpUrl: auth.grantResource(grant.id),
    });
  });
  app.post('/api/org/:orgId/grants/:id/revoke', (req, res) => {
    const p = auth.principal(req),
      g = store.get<Grant>(
        'SELECT * FROM grants WHERE id=? AND org_id=?',
        String(req.params.id),
        p.orgId,
      );
    insist(g, 'Agent not found', 404);
    if (g.user_id !== p.userId) store.admin(p);
    store.run('UPDATE grants SET revoked=1 WHERE id=?', g.id);
    store.audit(p, 'agent.revoked', g.id);
    res.json({ ok: true });
  });
  app.post('/api/org/:orgId/teams', (req, res) => {
    const p = auth.principal(req);
    store.admin(p);
    const input = z.object({ name }).strict().parse(req.body),
      teamId = id();
    store.db.transaction(() => {
      store.run('INSERT INTO teams VALUES(?,?,?)', teamId, p.orgId, input.name);
      store.run('INSERT INTO team_members VALUES(?,?,?)', p.orgId, teamId, p.userId);
      store.audit(p, 'team.created', teamId);
    })();
    res.json({ id: teamId });
  });
  app.put('/api/org/:orgId/teams/:id/members', (req, res) => {
    const p = auth.principal(req);
    store.admin(p);
    const input = z
        .object({ userId: z.string().uuid(), add: z.boolean() })
        .strict()
        .parse(req.body),
      teamId = String(req.params.id);
    insist(
      store.get('SELECT 1 FROM teams WHERE org_id=? AND id=?', p.orgId, teamId),
      'Team not found',
      404,
    );
    store.member({ orgId: p.orgId, userId: input.userId });
    if (input.add)
      store.run('INSERT OR IGNORE INTO team_members VALUES(?,?,?)', p.orgId, teamId, input.userId);
    else
      store.run(
        'DELETE FROM team_members WHERE org_id=? AND team_id=? AND user_id=?',
        p.orgId,
        teamId,
        input.userId,
      );
    store.audit(p, input.add ? 'team.member_added' : 'team.member_removed', teamId);
    res.json({ ok: true });
  });
  app.post('/api/org/:orgId/invitations', (req, res) => {
    const p = auth.principal(req);
    store.admin(p);
    const input = z
      .object({ email: z.string().email(), role: z.enum(['admin', 'member']) })
      .strict()
      .parse(req.body);
    const token = opaque();
    store.run(
      'INSERT INTO invitations VALUES(?,?,?,?,?,?)',
      id(),
      p.orgId,
      input.email.toLowerCase(),
      input.role,
      hash(token),
      Date.now() + 7 * DAY,
    );
    store.audit(p, 'member.invited');
    res.json({ url: workspaceURL(settings) + '/?invite=' + token });
  });
  app.post('/api/invitations/accept', (req, res) => {
    const userId = auth.user(req),
      input = z
        .object({ token: z.string().min(1) })
        .strict()
        .parse(req.body);
    const user = store.get<{ email: string }>('SELECT email FROM users WHERE id=?', userId)!;
    store.db.transaction(() => {
      const invite = store.get<{ id: string; org_id: string; email: string; role: string }>(
        'SELECT * FROM invitations WHERE token_hash=? AND expires_at>?',
        hash(input.token),
        Date.now(),
      );
      insist(
        invite && invite.email === user.email.toLowerCase(),
        'Invitation unavailable for this Google account',
      );
      store.run('INSERT OR IGNORE INTO members VALUES(?,?,?)', invite.org_id, userId, invite.role);
      store.run('DELETE FROM blocked_members WHERE org_id=? AND user_id=?', invite.org_id, userId);
      store.run('DELETE FROM invitations WHERE id=?', invite.id);
      store.audit({ orgId: invite.org_id, userId }, 'member.joined');
    })();
    res.json({ ok: true });
  });
  app.delete('/api/org/:orgId/members/:id', (req, res) => {
    const p = auth.principal(req);
    store.admin(p);
    const userId = String(req.params.id),
      target = store.member({ orgId: p.orgId, userId });
    insist(target.role !== 'owner', 'The owner cannot be removed');
    insist(
      target.role !== 'admin' || store.member(p).role === 'owner',
      'Only the owner can remove an administrator',
    );
    // Retain historical foreign keys while removing all authorization for this identity.
    store.run('INSERT OR REPLACE INTO blocked_members VALUES(?,?,?)', p.orgId, userId, Date.now());
    store.run('UPDATE grants SET revoked=1 WHERE org_id=? AND user_id=?', p.orgId, userId);
    for (const c of store.all<Connection>(
      'SELECT * FROM connections WHERE org_id=? AND owner_id=?',
      p.orgId,
      userId,
    ))
      connectors.revokeLocally(c);
    store.run('DELETE FROM team_members WHERE org_id=? AND user_id=?', p.orgId, userId);
    store.audit(p, 'member.removed', userId);
    res.json({ ok: true });
  });

  app.all(['/mcp', '/mcp/:provider'], async (req, res) => {
    const provider = req.params.provider ? String(req.params.provider) : null;
    insist(
      !provider || ['slack', 'notion', 'linear'].includes(provider),
      'MCP endpoint not found',
      404,
    );
    const resource = auth.audience + (provider ? '/' + provider : '');
    // Browser clients may use their own origin; bearer auth is mandatory and cookies are never accepted here.
    if (req.method === 'OPTIONS') {
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type,MCP-Protocol-Version,Accept',
        'Access-Control-Allow-Methods': 'POST,GET,DELETE,OPTIONS',
      });
      return res.sendStatus(204);
    }
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'WWW-Authenticate',
    });
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    let p: Principal;
    try {
      const info = await auth.verifyAccessToken(token ?? '');
      insist(info.resource.href === resource, 'Token audience mismatch', 401);
      p = info.extra as unknown as Principal;
    } catch {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${new URL(settings.origin).origin}/.well-known/oauth-protected-resource${new URL(resource).pathname}"`,
      );
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
    const server = new Server(
      { name: 'ArgosMCP', version: '0.1.0' },
      {
        capabilities: { tools: {} },
        instructions:
          'All actions are enforced by ArgosMCP. When pending or approved, the personal connector must approve/execute. Show the dashboard approval URL and use argos_result later. An approved action is not yet completed. The device must be online. Never report a pending action as completed. Use a stable request_id when retrying.',
      },
    );
    function available() {
      const g = store.grant(p.grantId!);
      return store
        .all<Connection>('SELECT * FROM connections WHERE org_id=?', p.orgId)
        .filter(
          (c) =>
            (!provider || c.provider === provider) &&
            store.canAccess(p, c) &&
            JSON.parse(g.connections).includes(c.id) &&
            c.status === 'active' &&
            store.expires(c) > Date.now(),
        );
    }
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const connections = available();
      const tools = Object.entries(catalog)
        .filter(([tool, def]) =>
          connections.some(
            (c) => c.provider === def.provider && gateway.policy(c, tool, p) !== 'block',
          ),
        )
        .map(([tool, def]) => {
          const schema = z.toJSONSchema(def.schema, { target: 'draft-7', io: 'input' }) as any;
          return {
            name: tool,
            description:
              def.title +
              ' · subject to enterprise policy. Use argos_connections to select an authorized context.',
            inputSchema: {
              ...schema,
              type: 'object' as const,
              properties: {
                ...schema.properties,
                connection_id: {
                  type: 'string',
                  enum: connections
                    .filter(
                      (c) => c.provider === def.provider && gateway.policy(c, tool, p) !== 'block',
                    )
                    .map((c) => c.id),
                },
                request_id: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 128,
                  description: 'Unique stable idempotency key for this intended action',
                },
              },
              required: [...(schema.required ?? []), 'connection_id', 'request_id'],
              additionalProperties: false,
            },
          };
        });
      return {
        tools: [
          ...tools,
          {
            name: 'argos_connections',
            description: 'List your authorized service and memory contexts.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
          {
            name: 'argos_result',
            description: 'Check status and obtain the result of your previously requested action.',
            inputSchema: {
              type: 'object',
              properties: { invocation_id: { type: 'string' } },
              required: ['invocation_id'],
              additionalProperties: false,
            },
          },
        ],
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const tool = request.params.name,
          input = request.params.arguments ?? {};
        let result: unknown;
        if (tool === 'argos_connections')
          result = available().map((c) => ({
            id: c.id,
            provider: c.provider,
            name: c.label,
            scope: c.scope,
            teamId: c.team_id,
            expiresAt: store.expires(c),
          }));
        else if (tool === 'argos_result') {
          const invocationId = z
            .object({ invocation_id: z.string().uuid() })
            .strict()
            .parse(input).invocation_id;
          if (provider) {
            const row = store.get<{ connection_id: string }>(
              'SELECT connection_id FROM invocations WHERE id=? AND org_id=?',
              invocationId,
              p.orgId,
            );
            insist(
              row && available().some((c) => c.id === row.connection_id),
              'Result not available on this endpoint',
              404,
            );
          }
          result = gateway.read(p, invocationId);
        } else {
          const { connection_id, request_id, ...args } = input;
          const connectionId = z.string().uuid().parse(connection_id),
            requestId = z.string().min(1).max(128).parse(request_id);
          insist(
            available().some((c) => c.id === connectionId),
            'Connection not available on this endpoint',
          );
          result = {
            ...(await gateway.invoke(p, connectionId, tool as ToolName, args, requestId)),
            approvalUrl: workspaceURL(settings) + '/?view=approvals',
          };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: e instanceof Fault ? e.message : 'Invalid arguments or action unavailable',
            },
          ],
        };
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  if (!settings.hosted) {
    app.get(['/', '/dashboard-assets/*path'], async (req, res) => {
      const asset = await dashboardAsset(req.path, settings.env);
      res.status(asset.status);
      asset.headers.forEach((value, key) => res.setHeader(key, value));
      res.send(Buffer.from(await asset.arrayBuffer()));
    });
  }

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof z.ZodError)
      return res
        .status(400)
        .json({ error: 'Invalid input', fields: err.issues.map((i) => i.path.join('.')) });
    res.status(err instanceof Fault ? err.status : 500).json({
      error: err instanceof Fault ? err.message : 'Request failed. No credentials were exposed.',
    });
  });
  return { app, auth, connectors, gateway, devices, serverCustody };
}
export const DEMO_USER = '00000000-0000-4000-8000-000000000001';
export const DEMO_ORG = '00000000-0000-4000-8000-000000000002';
export function seedDemo(store: Store, vault: Vault) {
  if (store.get('SELECT 1 FROM users WHERE id=?', DEMO_USER)) {
    for (const [tool, def] of Object.entries(catalog))
      store.run(
        'INSERT OR IGNORE INTO organization_policies VALUES(?,?,?)',
        DEMO_ORG,
        tool,
        tool.includes('delete') || tool.includes('forget')
          ? 'block'
          : def.write
            ? 'approve'
            : 'allow',
      );
    return;
  }
  store.db.transaction(() => {
    store.run(
      'INSERT INTO users VALUES(?,?,?,?)',
      DEMO_USER,
      null,
      'emeric@example.test',
      'Emeric',
    );
    store.run('INSERT INTO organizations(id,name) VALUES(?,?)', DEMO_ORG, 'Raviole Labs');
    store.run('INSERT INTO members VALUES(?,?,?)', DEMO_ORG, DEMO_USER, 'owner');
    const teamId = id();
    store.run('INSERT INTO teams VALUES(?,?,?)', teamId, DEMO_ORG, 'Product & engineering');
    store.run('INSERT INTO team_members VALUES(?,?,?)', DEMO_ORG, teamId, DEMO_USER);
    for (const [provider, label, scope] of [
      ['slack', 'Slack · Raviole Labs', 'organization'],
      ['notion', 'Notion · Documentation', 'team'],
      ['linear', 'Linear · Product', 'team'],
    ]) {
      const cid = id(),
        now = Date.now();
      store.run(
        'INSERT INTO connections(id,org_id,provider,label,scope,owner_id,team_id,secret,created_at,expires_at,demo) VALUES(?,?,?,?,?,?,?,?,?,?,1)',
        cid,
        DEMO_ORG,
        provider,
        label,
        scope,
        DEMO_USER,
        scope === 'team' ? teamId : null,
        vault.seal({ access_token: 'demo-token-never-used' }, `${DEMO_ORG}:connection:${cid}`),
        now,
        now + 7 * DAY,
      );
    }
    for (const [tool, def] of Object.entries(catalog))
      store.run(
        'INSERT INTO organization_policies VALUES(?,?,?)',
        DEMO_ORG,
        tool,
        tool.includes('delete') || tool.includes('forget')
          ? 'block'
          : def.write
            ? 'approve'
            : 'allow',
      );
    store.audit({ orgId: DEMO_ORG, userId: DEMO_USER }, 'demo.started');
  })();
}
