import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { createServer } from 'node:http';
import {
  Store,
  loadVault,
  insist,
  type SyncDatabase,
  type Tenant,
  type Settings,
} from '../src/foundation.js';
import { createApp } from '../src/app.js';
import type { InferEnv } from 'cf/config';
import type config from '../cloudflare.config.js';

type Env = Omit<InferEnv<typeof config.worker>, 'WORKSPACES'> & {
  WORKSPACES: DurableObjectNamespace<CompanyWorkspace>;
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
  private initialize(origin: string) {
    const tenant = tenants(this.env)[origin];
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
      hosted: true,
      demo: false,
      dataDir: '',
      env: secrets,
      targets: JSON.parse(secrets.ENGRAM_TARGETS_JSON || '[]'),
    };
    insist(
      new Set(settings.targets.map((t) => new URL(t.url).href)).size === settings.targets.length,
      'Engram targets must be distinct',
      503,
    );
    this.runtime = createApp(this.store, loadVault(settings), settings);
    return this.runtime;
  }
  async handle(request: Request): Promise<Response> {
    const origin = new URL(request.url).origin;
    const runtime = this.initialize(origin);
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    // Request-owned Node server: never retains request I/O across Durable Object events.
    const server = createServer(runtime.app);
    server.listen(0);
    const address = server.address();
    insist(address && typeof address !== 'string', 'HTTP adapter unavailable', 500);
    const headers = new Headers(request.headers);
    headers.set('Host', new URL(origin).host);
    try {
      return await handleAsNodeRequest(address.port, new Request(request, { headers }));
    } finally {
      server.close();
    }
  }
  async alarm() {
    const bound = this.ctx.storage.kv.get<{ origin: string }>('tenant');
    if (!bound) return;
    try {
      await this.initialize(bound.origin).connectors.sweep();
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
      if (
        request.method === 'GET' &&
        (url.pathname === '/' || url.pathname.startsWith('/assets/'))
      ) {
        const response = await env.ASSETS.fetch(request);
        const headers = new Headers(response.headers);
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('X-Frame-Options', 'DENY');
        headers.set('Referrer-Policy', 'no-referrer');
        headers.set(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        if (url.pathname === '/') headers.set('Cache-Control', 'no-store');
        return new Response(response.body, { status: response.status, headers });
      }
      return await env.WORKSPACES.getByName(tenant.id).handle(request);
    } catch {
      // Never log URLs, headers, OAuth codes, provider responses or credentials.
      if (!url.search)
        console.error(JSON.stringify({ event: 'request.failed', service: 'argosmcp' }));
      return Response.json({ error: 'Workspace temporarily unavailable' }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
