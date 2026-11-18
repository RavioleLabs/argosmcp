import { CompanyConnectors } from './company-connectors.js';
import { discoverRemote, safeFetch } from './local/remote-mcp.js';
import { canonical } from './foundation.js';
import type { Express, Request } from 'express';
import { z } from 'zod';
import {
  Store,
  Vault,
  insist,
  hash,
  id,
  opaque,
  workspaceURL,
  type Settings,
  type Connection,
  type Principal,
} from './foundation.js';
import { Auth, cookies } from './auth.js';
import {
  authorizeURL,
  newAttempt,
  exchange,
  refresh,
  revoke,
  executeLocal,
  redactResult,
  type OAuthAttempt,
} from './local/providers.js';
import type { LocalConnection } from './local/storage.js';
import type { Connectors, ToolName } from './connectors.js';

export class ServerCustody {
  readonly available: boolean;
  private vault?: Vault;
  private get send() {
    return this.settings.remoteFetch ?? safeFetch;
  }
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    private store: Store,
    private settings: Settings,
  ) {
    this.available = settings.env.ARGOS_SERVER_CUSTODY === '1';
    insist(
      !this.available || settings.env.ARGOS_PROVIDER_VAULT_KEYRING,
      'A dedicated provider vault keyring is required',
      503,
    );
    if (settings.env.ARGOS_PROVIDER_VAULT_KEYRING) {
      const keys = JSON.parse(settings.env.ARGOS_PROVIDER_VAULT_KEYRING ?? '{}');
      this.vault = new Vault(
        Object.fromEntries(
          Object.entries(keys).map(([k, v]) => [k, Buffer.from(String(v), 'base64')]),
        ),
      );
    }
  }
  enabled(orgId: string) {
    return (
      this.available &&
      !!this.store.get<{ enabled: number }>(
        'SELECT enabled FROM custody_settings WHERE org_id=?',
        orgId,
      )?.enabled
    );
  }
  configured(provider: string) {
    return (
      this.available &&
      (provider === 'mcp' ||
        provider === 'notion' ||
        !!this.settings.env[provider.toUpperCase() + '_PUBLIC_CLIENT_ID'])
    );
  }
  private context(c: Connection) {
    return `${workspaceURL(this.settings)}:${c.org_id}:server-provider:${c.id}`;
  }
  private scope(p: Principal, c: Pick<Connection, 'scope' | 'team_id'>) {
    this.store.member(p);
    if (c.scope !== 'personal') this.store.admin(p);
    if (c.scope === 'team')
      insist(
        c.team_id &&
          this.store.get(
            'SELECT 1 FROM team_members WHERE org_id=? AND team_id=? AND user_id=?',
            p.orgId,
            c.team_id,
            p.userId,
          ),
        'Join the team before connecting its service',
      );
    else insist(!c.team_id, 'teamId only applies to team connections', 400);
  }
  private guard(c: Connection, discovery = false) {
    insist(this.enabled(c.org_id), 'Server credential custody is disabled');
    if (discovery && c.provider === 'mcp') {
      insist(
        c.status === 'active' && this.store.expires(c) > Date.now(),
        'Connection expired or revoked',
      );
      const binding = this.store.get<{ connector_id: string }>(
        'SELECT connector_id FROM connection_connectors WHERE connection_id=? AND org_id=?',
        c.id,
        c.org_id,
      );
      insist(binding, 'Connector binding missing');
      const d = new CompanyConnectors(this.store).get(
        { orgId: c.org_id, userId: c.owner_id },
        binding.connector_id,
      );
      insist(d.status !== 'disabled', 'Company connector disabled');
    } else this.store.live(c);
    this.store.member({ orgId: c.org_id, userId: c.owner_id });
    if (c.scope === 'team')
      insist(
        this.store.get(
          'SELECT 1 FROM team_members WHERE org_id=? AND team_id=? AND user_id=?',
          c.org_id,
          c.team_id,
          c.owner_id,
        ),
        'Connection owner no longer belongs to this team',
      );
  }
  private async serial<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(connectionId) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(fn);
    this.locks.set(connectionId, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(connectionId) === task) this.locks.delete(connectionId);
    }
  }
  private saved(c: Connection): LocalConnection {
    const row = this.store.get<{ secret: string | null }>(
      'SELECT secret FROM server_credentials WHERE connection_id=?',
      c.id,
    );
    insist(this.vault && row?.secret, 'Server credentials unavailable', 503);
    return this.vault.open<LocalConnection>(row.secret, this.context(c));
  }
  private currentRemote(c: Connection, saved: LocalConnection) {
    if (!saved.remote) return;
    const d = new CompanyConnectors(this.store).get(
      { orgId: c.org_id, userId: c.owner_id },
      saved.remote.id,
    );
    insist(
      d.status === 'enabled' && d.fingerprint === saved.remote.fingerprint,
      'Company connector is not enabled or its configuration changed',
      403,
    );
    saved.remote = d;
  }
  private async discover(c: Connection, saved: LocalConnection) {
    if (!saved.remote) return;
    const p = { orgId: c.org_id, userId: c.owner_id };
    const tools = await discoverRemote(
      saved.remote.config,
      saved.credentials.access_token,
      this.send,
    );
    this.guard(this.store.get<Connection>('SELECT * FROM connections WHERE id=?', c.id)!, true);
    if (this.store.member(p).role !== 'member')
      new CompanyConnectors(this.store).discover(
        p,
        saved.remote.id,
        saved.remote.fingerprint,
        tools,
      );
  }
  async execute(
    c: Connection,
    tool: ToolName,
    args: Record<string, unknown>,
    beforeDispatch: () => Promise<void>,
  ) {
    return this.serial(c.id, async () => {
      this.guard(c);
      const saved = this.saved(c);
      const prior = [
        saved.credentials.access_token,
        saved.credentials.refresh_token ?? '',
        saved.oauth?.clientSecret ?? '',
      ];
      this.currentRemote(c, saved);
      await refresh(saved, this.send);
      this.store.run(
        'UPDATE server_credentials SET secret=? WHERE connection_id=?',
        this.vault!.seal(saved, this.context(c)),
        c.id,
      );
      const output = await executeLocal(
        saved,
        tool,
        args,
        async () => {
          this.guard(this.store.get<Connection>('SELECT * FROM connections WHERE id=?', c.id)!);
          const manifest = saved.remote ? canonical(saved.remote.tools) : '';
          this.currentRemote(c, saved);
          insist(
            !saved.remote || canonical(saved.remote.tools) === manifest,
            'Company tools changed',
            409,
          );
          await beforeDispatch();
        },
        this.send,
      );
      return redactResult(output, [
        ...prior,
        saved.credentials.access_token,
        saved.credentials.refresh_token ?? '',
      ]);
    });
  }
  async revoke(connectionId: string) {
    await this.serial(connectionId, async () => {
      const c = this.store.get<Connection>('SELECT * FROM connections WHERE id=?', connectionId)!;
      const row = this.store.get<{ secret: string | null }>(
        'SELECT secret FROM server_credentials WHERE connection_id=?',
        c.id,
      );
      if (!row?.secret) {
        this.store.run("UPDATE connections SET revoke_status='confirmed' WHERE id=?", c.id);
        return;
      }
      // Removing deployment keys cannot silently erase unrevoked credentials.
      if (!this.vault) {
        this.store.run("UPDATE connections SET revoke_status='retry_required' WHERE id=?", c.id);
        return;
      }
      const result = await revoke(this.saved(c));
      this.store.run(
        'UPDATE connections SET revoke_status=? WHERE id=?',
        result === 'confirmed' ? 'confirmed' : 'retry_required',
        c.id,
      );
      if (result === 'confirmed')
        this.store.run('UPDATE server_credentials SET secret=NULL WHERE connection_id=?', c.id);
    });
  }
  mount(app: Express, auth: Auth, connectors: Connectors) {
    app.put('/api/org/:orgId/server-custody', async (req, res) => {
      const p = auth.principal(req);
      this.store.admin(p);
      const input = z
        .object({ enabled: z.boolean(), acknowledgeRisk: z.literal(true) })
        .strict()
        .parse(req.body);
      insist(
        !input.enabled || this.available,
        'The backend operator must configure a dedicated provider vault first',
        503,
      );
      this.store.db.transaction(() => {
        this.store.run(
          'INSERT INTO custody_settings VALUES(?,?) ON CONFLICT(org_id) DO UPDATE SET enabled=excluded.enabled',
          p.orgId,
          Number(input.enabled),
        );
        this.store.run('UPDATE organizations SET revision=revision+1 WHERE id=?', p.orgId);
        if (!input.enabled)
          for (const c of this.store.all<Connection>(
            'SELECT c.* FROM connections c JOIN server_credentials s ON s.connection_id=c.id WHERE c.org_id=?',
            p.orgId,
          ))
            connectors.revokeLocally(c);
        this.store.audit(
          p,
          input.enabled ? 'custody.server_enabled' : 'custody.server_disabled',
          p.orgId,
        );
      })();
      if (!input.enabled) await connectors.sweep();
      res.json({ ok: true });
    });
    app.post('/api/org/:orgId/server-connections/:id/discover', async (req, res) => {
      const p = auth.principal(req);
      this.store.admin(p);
      const c = this.store.connection(p, String(req.params.id));
      insist(c.owner_id === p.userId && c.provider === 'mcp', 'Use your own remote MCP connection');
      await this.serial(c.id, async () => {
        this.guard(c, true);
        const saved = this.saved(c);
        await refresh(saved, this.send);
        this.store.run(
          'UPDATE server_credentials SET secret=? WHERE connection_id=?',
          this.vault!.seal(saved, this.context(c)),
          c.id,
        );
        await this.discover(c, saved);
      });
      res.json({ ok: true });
    });
    app.post('/api/org/:orgId/connect/:provider', async (req, res) => {
      const p = auth.principal(req);
      if (!this.available)
        return res
          .status(410)
          .json({ error: 'Server custody is unavailable. Use Argos Personal.' });
      insist(this.enabled(p.orgId), 'Your administrator must enable server custody first');
      const provider = z.enum(['slack', 'notion', 'linear', 'mcp']).parse(req.params.provider);
      const input = z
        .object({
          label: z.string().trim().min(1).max(120),
          scope: z.enum(['personal', 'team', 'organization']).default('personal'),
          teamId: z.string().uuid().nullable().optional(),
          acknowledgeServerCustody: z.literal(true),
          connectorId: z.string().uuid().optional(),
          token: z.string().min(1).max(16000).optional(),
        })
        .strict()
        .parse(req.body);
      this.scope(p, { scope: input.scope, team_id: input.teamId ?? null });
      const definition =
        provider === 'mcp'
          ? new CompanyConnectors(this.store).get(p, z.string().uuid().parse(input.connectorId))
          : undefined;
      if (definition) {
        insist(input.scope === 'personal', 'Remote MCP accounts are personal', 400);
        insist(definition.status !== 'disabled', 'Company connector disabled', 403);
        insist(
          definition.config.auth === 'bearer' ? !!input.token : !input.token,
          'Unexpected or missing connector token',
          400,
        );
      } else insist(!input.connectorId && !input.token, 'Unexpected remote connector fields', 400);
      insist(
        this.configured(provider),
        'The backend operator must configure this provider OAuth app',
        503,
      );
      const count = this.store.get<{ n: number }>(
        "SELECT count(*) n FROM connections WHERE org_id=? AND owner_id=? AND status='pending'",
        p.orgId,
        p.userId,
      )!.n;
      insist(count < 5, 'Finish or wait for an existing connection attempt to expire', 429);
      const connectionId = id(),
        binding = opaque();
      const a = newAttempt(
        p.orgId,
        provider,
        connectionId,
        input.label,
        this.settings.env[provider.toUpperCase() + '_PUBLIC_CLIENT_ID'] ?? '',
        workspaceURL(this.settings) + '/oauth/callback/' + provider,
      );
      a.clientName = 'ArgosMCP server connector';
      if (definition) a.remote = definition;
      const revision = this.store.org(p.orgId).revision;
      const url = definition && definition.config.auth !== 'oauth' ? null : await authorizeURL(a);
      insist(
        this.enabled(p.orgId) && this.store.org(p.orgId).revision === revision,
        'Company settings changed. Start again.',
        409,
      );
      this.scope(p, { scope: input.scope, team_id: input.teamId ?? null });
      this.store.db.transaction(() => {
        this.store.run(
          "INSERT INTO connections(id,org_id,provider,label,scope,owner_id,team_id,created_at,expires_at,status) VALUES(?,?,?,?,?,?,?,?,?,'pending')",
          connectionId,
          p.orgId,
          provider,
          input.label,
          input.scope,
          p.userId,
          input.teamId ?? null,
          Date.now(),
          a.expiresAt,
        );
        this.store.run('INSERT INTO server_credentials VALUES(?,NULL)', connectionId);
        if (definition)
          this.store.run(
            'INSERT INTO connection_connectors VALUES(?,?,?)',
            connectionId,
            p.orgId,
            definition.id,
          );
        this.store.run(
          'INSERT INTO states VALUES(?,?,?,?)',
          hash(a.state),
          'server:' + provider,
          JSON.stringify({
            sealed: this.vault!.seal(
              { a, p, revision, binding: hash(binding) },
              'server-oauth:' + hash(a.state),
            ),
          }),
          a.expiresAt,
        );
        this.store.audit(p, 'connection.server_consent_started', connectionId);
      })();
      if (definition && !url) {
        this.store.run('DELETE FROM states WHERE id=?', hash(a.state));
        const c = this.store.get<Connection>('SELECT * FROM connections WHERE id=?', connectionId)!;
        const saved: LocalConnection = {
          id: c.id,
          provider: 'mcp',
          label: c.label,
          clientId: '',
          remote: definition,
          credentials: { access_token: input.token ?? '' },
          autoRead: false,
          status: 'active',
          expiresAt: Date.now() + this.store.org(p.orgId).lease_hours * 3600000,
        };
        this.store.run(
          'UPDATE server_credentials SET secret=? WHERE connection_id=?',
          this.vault!.seal(saved, this.context(c)),
          c.id,
        );
        this.store.run(
          "UPDATE connections SET status='active',expires_at=? WHERE id=?",
          saved.expiresAt,
          c.id,
        );
        try {
          await this.discover(
            this.store.get<Connection>('SELECT * FROM connections WHERE id=?', c.id)!,
            saved,
          );
        } catch (error) {
          connectors.revokeLocally(c);
          await this.revoke(c.id);
          throw error;
        }
        this.store.audit(p, 'connection.server_created', c.id);
        return res.json({ connected: true });
      }
      res.cookie(this.cookie(provider), binding, {
        httpOnly: true,
        secure: this.settings.origin.startsWith('https:'),
        sameSite: 'lax',
        path: (this.settings.basePath ?? '') + '/oauth/callback/' + provider,
        maxAge: 600000,
      });
      res.json({ url });
    });
    app.get('/oauth/callback/:provider', async (req, res) => {
      if (!this.available) return res.status(410).json({ error: 'Server custody is unavailable.' });
      const provider = z.enum(['slack', 'notion', 'linear', 'mcp']).parse(req.params.provider);
      const state = z.string().min(24).max(200).parse(req.query.state);
      const row = this.store.get<{ payload: string; expires_at: number }>(
        'SELECT payload,expires_at FROM states WHERE id=? AND kind=?',
        hash(state),
        'server:' + provider,
      );
      insist(row && row.expires_at > Date.now(), 'OAuth request expired', 400);
      const payload = this.vault!.open<{
        a: OAuthAttempt;
        p: Principal;
        revision: number;
        binding: string;
      }>(JSON.parse(row.payload).sealed, 'server-oauth:' + hash(state));
      insist(
        auth.user(req) === payload.p.userId &&
          hash(cookies(req)[this.cookie(provider)] ?? '') === payload.binding,
        'OAuth browser or account mismatch',
        403,
      );
      this.store.takeState(state, 'server:' + provider);
      const c = this.store.get<Connection>(
        'SELECT * FROM connections WHERE id=? AND org_id=?',
        payload.a.connectionId,
        payload.p.orgId,
      )!;
      const valid = () => {
        insist(row.expires_at > Date.now(), 'OAuth request expired', 400);
        insist(
          c && this.enabled(c.org_id) && this.store.org(c.org_id).revision === payload.revision,
          'Company authorization changed',
        );
        this.scope(payload.p, c);
        if (payload.a.remote) {
          const d = new CompanyConnectors(this.store).get(payload.p, payload.a.remote.id);
          insist(
            d.status !== 'disabled' && d.fingerprint === payload.a.remote.fingerprint,
            'Company connector changed',
            409,
          );
        }
        insist(
          this.store.get<Connection>('SELECT * FROM connections WHERE id=?', c.id)?.status ===
            'pending',
          'Connection was cancelled',
        );
      };
      try {
        valid();
        const code = z.string().min(1).max(4096).parse(req.query.code);
        if (payload.a.remote && req.query.iss)
          insist(
            new URL(String(req.query.iss)).href === payload.a.remote.config.oauth?.issuer,
            'OAuth issuer mismatch',
            400,
          );
        const credentials = await exchange(
          payload.a,
          {
            grant_type: 'authorization_code',
            code,
            redirect_uri: payload.a.redirect,
            code_verifier: payload.a.verifier,
          },
          this.send,
        );
        const expiresAt = Date.now() + this.store.org(c.org_id).lease_hours * 3600000;
        const saved: LocalConnection = {
          id: c.id,
          provider,
          label: c.label,
          clientId: payload.a.clientId,
          expiresAt,
          credentials,
          autoRead: false,
          status: 'active',
          oauth: payload.a.oauth,
          remote: payload.a.remote,
        };
        // Persist the new token before rechecking policy, so a racing revocation can revoke it too.
        this.store.run(
          'UPDATE server_credentials SET secret=? WHERE connection_id=?',
          this.vault!.seal(saved, this.context(c)),
          c.id,
        );
        valid();
        this.store.run(
          "UPDATE connections SET status='active',created_at=?,expires_at=? WHERE id=?",
          Date.now(),
          expiresAt,
          c.id,
        );
        await this.discover(
          this.store.get<Connection>('SELECT * FROM connections WHERE id=?', c.id)!,
          saved,
        );
        this.store.audit(payload.p, 'connection.server_created', c.id);
      } catch (error) {
        if (c) {
          connectors.revokeLocally(c);
          await this.revoke(c.id);
        }
        throw error;
      } finally {
        res.clearCookie(this.cookie(provider), {
          path: (this.settings.basePath ?? '') + '/oauth/callback/' + provider,
        });
      }
      res.redirect(workspaceURL(this.settings) + '/?view=connections');
    });
  }
  private cookie(provider: string) {
    return 'argos_provider_' + hash(workspaceURL(this.settings) + ':' + provider).slice(0, 16);
  }
}
