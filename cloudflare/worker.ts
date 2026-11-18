import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { createServer } from 'node:http';
import {
  Store,
  Fault,
  hash,
  id,
  loadVault,
  insist,
  type SyncDatabase,
  type Tenant,
  type Settings,
} from '../src/foundation.js';
import { dashboardAsset } from '../src/dashboard-assets.js';
import { createApp } from '../src/app.js';
import { trustedBrowserUser } from '../src/auth.js';
import {
  AccountDirectory,
  accountKey,
  type Identity,
  type WorkspaceBinding,
  type WorkspaceSummary,
} from './accounts.js';
export { AccountDirectory } from './accounts.js';
import type { InferEnv } from 'cf/config';
import type config from '../cloudflare.config.js';

export type Env = Omit<InferEnv<typeof config.worker>, 'WORKSPACES' | 'ACCOUNTS'> & {
  WORKSPACES: DurableObjectNamespace<CompanyWorkspace>;
  ACCOUNTS: DurableObjectNamespace<AccountDirectory>;
};
export class DurableDatabase implements SyncDatabase {
  constructor(private storage: DurableObjectStorage) {}
  exec(sql: string) {
    return this.storage.sql.exec(sql);
  }
  prepare(sql: string) {
    const run = (args: unknown[]) =>
      this.storage.sql.exec(
        sql,
        ...args.map((value) => {
          insist(
            value === null ||
              typeof value === 'string' ||
              typeof value === 'number' ||
              value instanceof ArrayBuffer,
            'Invalid SQL binding',
            500,
          );
          return value;
        }),
      );
    return {
      get: (...args: unknown[]) => run(args).toArray()[0],
      all: (...args: unknown[]) => run(args).toArray(),
      run: (...args: unknown[]) => {
        const cursor = run(args);
        cursor.toArray();
        return { changes: cursor.rowsWritten };
      },
    };
  }
  transaction<T>(callback: () => T) {
    return () => this.storage.transactionSync(callback);
  }
  close() {}
}

function tenants(env: Env): Record<string, Tenant> {
  const value: unknown = JSON.parse(env.ARGOS_TENANTS_JSON || '{}');
  insist(
    value && typeof value === 'object' && !Array.isArray(value),
    'Invalid tenant configuration',
    503,
  );
  const records = value as Record<string, Tenant>;
  const seen = new Set<string>();
  for (const [origin, tenant] of Object.entries(records)) {
    const url = new URL(origin);
    insist(
      url.origin === origin &&
        (url.protocol === 'https:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost'),
      'Invalid tenant origin',
      503,
    );
    insist(
      /^[a-f0-9-]{36}$/.test(tenant.id) &&
        typeof tenant.name === 'string' &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tenant.ownerEmail),
      'Invalid tenant record',
      503,
    );
    insist(!seen.has(tenant.id), 'Each tenant must have one canonical origin', 503);
    seen.add(tenant.id);
  }
  return records;
}

// One persistent coordination object per company. No global database or global tenant object.
export class CompanyWorkspace extends DurableObject<Env> {
  private store: Store;
  private runtime?: ReturnType<typeof createApp>;
  private origin?: string;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(new DurableDatabase(ctx.storage));
    this.store.run(
      "UPDATE invocations SET status='unknown' WHERE status='executing' AND id NOT IN (SELECT invocation_id FROM local_dispatches WHERE expires_at>strftime('%s','now')*1000)",
    );
  }
  private initialize(origin: string, dynamic = false) {
    const workspace = this.ctx.storage.kv.get<WorkspaceBinding>('workspace');
    insist(dynamic ? workspace?.origin === origin : !workspace, 'Workspace not found', 404);
    const tenant = dynamic ? workspace : tenants(this.env)[origin];
    insist(tenant, 'Workspace not found', 404);
    const bound = this.ctx.storage.kv.get<{ id: string; origin: string }>('tenant');
    insist(
      !bound || (bound.id === tenant.id && bound.origin === origin),
      'Tenant routing mismatch',
      403,
    );
    if (!bound) this.ctx.storage.kv.put('tenant', { id: tenant.id, origin });
    if (this.runtime) {
      insist(this.origin === origin, 'Tenant routing mismatch', 403);
      return this.runtime;
    }
    this.origin = origin;
    const secrets = Object.fromEntries(
      Object.entries(this.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    const settings: Settings = {
      origin,
      tenant,
      basePath: dynamic ? workspace!.basePath : undefined,
      platformSession: dynamic,
      selfService: true,
      hosted: true,
      demo: false,
      dataDir: '',
      env: secrets,
    };
    this.runtime = createApp(this.store, loadVault(settings), settings);
    return this.runtime;
  }
  // Only Worker RPC callers can provide identities. No public route accepts these objects.
  identity(origin: string, cookieHeader: string | null): Identity | null {
    this.initialize(origin);
    const cookie = (cookieHeader ?? '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('argos_session='))
      ?.slice('argos_session='.length);
    if (!cookie) return null;
    const user = this.store.get<{ google_sub: string; email: string; name: string }>(
      'SELECT u.google_sub,u.email,u.name FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?',
      hash(cookie),
      Date.now(),
    );
    return user?.google_sub
      ? { origin, sub: user.google_sub, email: user.email, name: user.name }
      : null;
  }
  provision(identity: Identity, workspaceId: string, name: string) {
    const existing = this.ctx.storage.kv.get<WorkspaceBinding>('workspace');
    if (existing) {
      insist(
        existing.id === workspaceId &&
          existing.origin === identity.origin &&
          existing.ownerSub === identity.sub,
        'Workspace binding mismatch',
        403,
      );
      return;
    }
    insist(
      !this.ctx.storage.kv.get('tenant') && !this.store.get('SELECT 1 FROM organizations'),
      'Workspace already reserved',
      409,
    );
    const binding: WorkspaceBinding = {
      id: workspaceId,
      origin: identity.origin,
      basePath: '/w/' + workspaceId,
      name,
      ownerEmail: identity.email,
      ownerSub: identity.sub,
    };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put('workspace', binding);
      const userId = id();
      this.store.run(
        'INSERT INTO users VALUES(?,?,?,?)',
        userId,
        identity.sub,
        identity.email,
        identity.name,
      );
      this.store.run('INSERT INTO organizations(id,name) VALUES(?,?)', workspaceId, name);
      this.store.run('INSERT INTO members VALUES(?,?,?)', workspaceId, userId, 'owner');
      this.store.audit({ orgId: workspaceId, userId }, 'organization.created', workspaceId);
    });
  }
  membership(identity: Identity): WorkspaceSummary | null {
    const binding = this.ctx.storage.kv.get<WorkspaceBinding>('workspace');
    if (!binding || binding.origin !== identity.origin) return null;
    const member = this.store.get<{ name: string; role: string }>(
      'SELECT o.name,m.role FROM organizations o JOIN members m ON m.org_id=o.id JOIN users u ON u.id=m.user_id WHERE o.id=? AND u.google_sub=? AND NOT EXISTS(SELECT 1 FROM blocked_members b WHERE b.org_id=m.org_id AND b.user_id=m.user_id)',
      binding.id,
      identity.sub,
    );
    return member ? { id: binding.id, url: binding.origin + binding.basePath, ...member } : null;
  }
  private userFor(identity: Identity) {
    const existing = this.store.get<{ id: string }>(
      'SELECT id FROM users WHERE google_sub=?',
      identity.sub,
    );
    const userId = existing?.id ?? id();
    if (!existing)
      this.store.run(
        'INSERT INTO users VALUES(?,?,?,?)',
        userId,
        identity.sub,
        identity.email,
        identity.name,
      );
    else
      this.store.run(
        'UPDATE users SET email=?,name=? WHERE id=?',
        identity.email,
        identity.name,
        userId,
      );
    return userId;
  }
  async handleScoped(request: Request, identity: Identity | null): Promise<Response> {
    const url = new URL(request.url),
      route = workspaceRoute(url.pathname);
    const binding = this.ctx.storage.kv.get<WorkspaceBinding>('workspace');
    if (!binding || !route || binding.id !== route.id || binding.origin !== url.origin)
      return Response.json({ error: 'Workspace not found' }, { status: 404 });
    insist(!identity || identity.origin === url.origin, 'Identity origin mismatch', 403);
    const runtime = this.initialize(url.origin, true);
    const userId = identity ? this.userFor(identity) : undefined;
    url.pathname = route.internalPath;
    return this.serve(new Request(url, request), runtime, userId);
  }
  async handle(request: Request): Promise<Response> {
    return this.serve(request, this.initialize(new URL(request.url).origin));
  }
  private async serve(
    request: Request,
    runtime: ReturnType<typeof createApp>,
    userId?: string,
  ): Promise<Response> {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    // Identity is an in-memory property of this single HTTP request, never a client header.
    const server = createServer((req, res) => {
      if (userId) Object.defineProperty(req, trustedBrowserUser, { value: userId });
      runtime.app(req, res);
    });
    server.listen(0);
    const address = server.address();
    insist(address && typeof address !== 'string', 'HTTP adapter unavailable', 500);
    const headers = new Headers(request.headers);
    headers.set('Host', new URL(request.url).host);
    try {
      return await handleAsNodeRequest(address.port, new Request(request, { headers }));
    } finally {
      server.close();
    }
  }
  async alarm() {
    const dynamic = this.ctx.storage.kv.get<WorkspaceBinding>('workspace');
    const bound = dynamic ?? this.ctx.storage.kv.get<{ origin: string }>('tenant');
    if (!bound) return;
    try {
      await this.initialize(bound.origin, !!dynamic).connectors.sweep();
    } finally {
      const outstanding = this.store.get(
        'SELECT 1 FROM connections WHERE status=? OR revoke_status=? LIMIT 1',
        'active',
        'retry_required',
      );
      if (outstanding) await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }
}

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
function workspaceRoute(path: string): { id: string; internalPath: string } | null {
  const scoped = path.match(new RegExp('^/w/(' + UUID + ')(/.*)?$'));
  if (scoped) return { id: scoped[1], internalPath: scoped[2] ?? '/' };
  const resource = path.match(
    new RegExp(
      '^/\\.well-known/oauth-protected-resource/w/(' + UUID + ')/mcp(?:/(slack|notion|linear))?$',
    ),
  );
  if (resource) return { id: resource[1], internalPath: path };
  const issuer = path.match(
    new RegExp('^/\\.well-known/oauth-authorization-server/w/(' + UUID + ')$'),
  );
  return issuer ? { id: issuer[1], internalPath: '/.well-known/oauth-authorization-server' } : null;
}
async function creationInput(request: Request) {
  insist(
    request.headers.get('content-type')?.split(';')[0] === 'application/json',
    'Use JSON',
    415,
  );
  const reader = request.body?.getReader();
  insist(reader, 'Workspace details required', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        throw new Fault(413, 'Workspace details too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Fault(400, 'Invalid JSON');
  }
  insist(
    value && typeof value === 'object' && !Array.isArray(value),
    'Invalid workspace details',
    400,
  );
  const body = value as Record<string, unknown>;
  insist(
    Object.keys(body).every((k) => ['name', 'requestId'].includes(k)) &&
      typeof body.name === 'string' &&
      body.name.trim().length > 0 &&
      body.name.trim().length <= 120 &&
      typeof body.requestId === 'string' &&
      new RegExp('^' + UUID + '$').test(body.requestId),
    'Provide a workspace name and request ID',
    400,
  );
  return { name: body.name.trim(), requestId: body.requestId };
}
const privateJSON = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      const tenant = tenants(env)[url.origin];
      if (!tenant) {
        if (request.method === 'GET' && url.pathname === '/')
          return new Response(
            `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ArgosMCP</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f8fa;color:#18212f;margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:560px;padding:48px}svg{width:56px;stroke:#246bfe;fill:none;stroke-width:3}h1{font-size:48px;letter-spacing:-2px;margin:24px 0 16px}p{color:#586579;font-size:18px;line-height:1.6}.badge{display:inline-block;background:#e8edf5;border-radius:24px;padding:8px 14px;font-size:13px;margin-top:24px}</style><main><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M6 20h10L32 7M16 20h16M16 20l16 13"/></svg><h1>Your AI.<br>Your rules.</h1><p>ArgosMCP connects your AI to company tools. Company policies govern every action. Provider credentials stay on your device.</p><span class="badge">Workspace setup in progress</span><p>This address is not accepting sign-ins or tool requests yet. Use your company's configured workspace address.</p></main></html>`,
            {
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy':
                  "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
              },
            },
          );
        return Response.json({ error: 'Workspace not configured' }, { status: 503 });
      }
      const root = env.WORKSPACES.getByName(tenant.id);
      if (url.pathname === '/api/workspaces') {
        const identity = await root.identity(url.origin, request.headers.get('cookie'));
        insist(identity, 'Sign in to create or choose a workspace', 401);
        const account = env.ACCOUNTS.getByName(accountKey(identity));
        if (request.method === 'GET') {
          const workspaces = await account.list(identity);
          const sessionResponse = await root.handle(
            new Request(url.origin + '/api/session', { headers: request.headers }),
          );
          const session = (await sessionResponse.json()) as {
            organizations: { id: string; name: string; role: string }[];
          };
          return privateJSON({
            workspaces: [
              ...session.organizations.map((o) => ({ ...o, url: url.origin })),
              ...workspaces,
            ],
          });
        }
        insist(request.method === 'POST', 'Method not allowed', 405);
        insist(request.headers.get('origin') === url.origin, 'Same-origin request required', 403);
        const input = await creationInput(request);
        const result = await account.create(identity, input.name, input.requestId);
        return privateJSON(result, 'error' in result ? result.status : 201);
      }
      const route = workspaceRoute(url.pathname);
      if (
        ['GET', 'HEAD'].includes(request.method) &&
        (url.pathname === '/' ||
          url.pathname.startsWith('/dashboard-assets/') ||
          (route && route.internalPath === '/'))
      ) {
        return await dashboardAsset(
          route ? '/' : url.pathname,
          Object.fromEntries(
            Object.entries(env).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ),
        );
      }

      if (route) {
        if (route.internalPath.startsWith('/auth/'))
          return privateJSON({ error: 'Use platform sign-in' }, 404);
        // Native devices and bearer-authenticated MCP endpoints do not inherit browser identity.
        const browser =
          route.internalPath.startsWith('/oauth/callback/') ||
          route.internalPath === '/api/session' ||
          (route.internalPath.startsWith('/api/') && !route.internalPath.startsWith('/api/local/'));
        const identity = browser
          ? await root.identity(url.origin, request.headers.get('cookie'))
          : null;
        const company = env.WORKSPACES.getByName(route.id);
        const response = await company.handleScoped(request, identity);
        if (
          identity &&
          response.ok &&
          (route.internalPath === '/api/session' ||
            route.internalPath === '/api/invitations/accept')
        ) {
          await env.ACCOUNTS.getByName(accountKey(identity)).remember(identity, route.id);
        }
        return response;
      }
      return await root.handle(request);
    } catch (error) {
      if (error instanceof Fault) return privateJSON({ error: error.message }, error.status);
      // Never log URLs, headers, OAuth codes, provider responses or credentials.
      if (!url.search)
        console.error(JSON.stringify({ event: 'request.failed', service: 'argosmcp' }));
      return Response.json({ error: 'Workspace temporarily unavailable' }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
