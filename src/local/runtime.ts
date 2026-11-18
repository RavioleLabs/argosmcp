import {
  remoteToolDefinition,
  remoteToolName,
  type RemoteDefinition,
} from '../remote-definition.js';
import { discoverRemote } from './remote-mcp.js';
import { generateKeyPairSync } from 'node:crypto';
import { catalog, OAuthExpired, type ToolName } from '../connectors.js';
import { canonical, hash, id, insist, Fault } from '../foundation.js';
import type { LocalAction } from '../device-protocol.js';
import { LocalStorage, type Profile, type LocalConnection } from './storage.js';
import { remote, validOrigin } from './remote.js';
import { executeLocal, refresh, revoke, redactResult } from './providers.js';

export class LocalRuntime {
  snapshots = new Map<string, { status: string; actions: LocalAction[]; error?: string }>();
  companyConnectors = new Map<string, RemoteDefinition[]>();
  administrators = new Set<string>();
  teams = new Map<string, { id: string; name: string }[]>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    public storage: LocalStorage,
    private send = remote,
    private providerExecute = executeLocal,
  ) {}
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }
  async pair(origin: string, label: string) {
    validOrigin(origin);
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const r = await fetch(origin + '/api/local/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey, label }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    insist(r.ok, 'Could not start device pairing', 502);
    const data = (await r.json()) as any;
    insist(
      typeof data.id === 'string' &&
        /^[a-f0-9-]{36}$/.test(data.id) &&
        data.fingerprint === hash(publicKey).slice(0, 24),
      'Invalid pairing response',
      502,
    );
    const p: Profile = {
      id: id(),
      origin,
      deviceId: data.id,
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKey,
      label,
      fingerprint: data.fingerprint,
      pairUrl: origin + '/?device=' + data.id,
      connections: [],
    };
    this.storage.save(p);
    return { id: p.id, url: p.pairUrl, fingerprint: p.fingerprint };
  }
  async snapshot(p: Profile) {
    const data = await this.send(p, '/api/local/status');
    if (data.status === 'pending') {
      this.snapshots.set(p.id, { status: 'pending', actions: [] });
      return;
    }
    if (data.status !== 'active') {
      this.snapshots.set(p.id, { status: 'revoked', actions: [] });
      for (const c of p.connections) {
        c.status = 'revoked';
        this.storage.save(p);
        if (!c.lastRevokeAt || Date.now() - c.lastRevokeAt > 60000)
          await this.revokeConnection(p, c);
      }
      return;
    }
    insist(
      data.identity &&
        typeof data.identity.orgId === 'string' &&
        typeof data.identity.userId === 'string',
      'Missing company identity',
      502,
    );
    if (p.identity)
      insist(
        p.identity.orgId === data.identity.orgId && p.identity.userId === data.identity.userId,
        'Device company identity changed',
        403,
      );
    else {
      p.identity = data.identity;
      this.storage.save(p);
    }
    this.teams.set(p.id, data.teams ?? []);
    this.companyConnectors.set(p.id, data.connectors ?? []);
    if (data.administrator) this.administrators.add(p.id);
    else this.administrators.delete(p.id);
    insist(
      Array.isArray(data.connections) && Array.isArray(data.actions),
      'Invalid workspace response',
      502,
    );
    for (const c of p.connections) {
      const live = data.connections.find((r: any) => r.id === c.id);
      if (live) {
        c.registered = true;
        c.expiresAt = Math.min(c.expiresAt, Number(live.expiresAt));
        if (live.status !== 'active' || c.expiresAt <= Date.now()) c.status = 'revoked';
      } else if (c.status === 'active' && c.expiresAt > Date.now()) {
        c.registered = false;
        try {
          const registered = await this.send(p, '/api/local/connections', {
            id: c.id,
            provider: c.provider,
            ...(c.remote ? { connectorId: c.remote.id, fingerprint: c.remote.fingerprint } : {}),
            label: c.label,
            ...(c.scope ? { scope: c.scope } : {}),
            ...(c.teamId ? { teamId: c.teamId } : {}),
          });
          c.expiresAt = Math.min(c.expiresAt, registered.expiresAt);
          c.registered = true;
        } catch (error) {
          if (error instanceof Fault && [400, 401, 403, 404].includes(error.status))
            c.status = 'revoked';
        }
      }
      if (c.status === 'revoked' && (!c.lastRevokeAt || Date.now() - c.lastRevokeAt > 60000)) {
        this.storage.save(p);
        await this.revokeConnection(p, c);
      }
    }
    this.storage.save(p);
    const actions: LocalAction[] = data.actions.filter((a: LocalAction) => {
      try {
        this.validate(p, a);
        return true;
      } catch {
        return false;
      }
    });
    this.snapshots.set(p.id, { status: 'active', actions });
  }
  definition(c: LocalConnection, name: string) {
    if (c.provider === 'mcp') {
      const t = c.remote?.tools.find((t) => remoteToolName(c.remote!.id, t.name) === name);
      return t ? remoteToolDefinition(c.remote!, t) : undefined;
    }
    const d = Object.hasOwn(catalog, name) ? catalog[name as ToolName] : undefined;
    return d?.provider === c.provider ? d : undefined;
  }
  async discover(p: Profile, c: LocalConnection) {
    insist(c.remote && c.status === 'active', 'MCP connection unavailable');
    const tools = await discoverRemote(c.remote.config, c.credentials.access_token);
    c.remote.tools = tools;
    this.storage.save(p);
    if (this.administrators.has(p.id))
      await this.send(p, '/api/local/connector-tools', {
        connectorId: c.remote.id,
        fingerprint: c.remote.fingerprint,
        tools,
      });
    return { count: tools.length, reviewRequired: this.administrators.has(p.id) };
  }
  validate(p: Profile, a: LocalAction) {
    const c = p.connections.find((c) => c.id === a.connectionId);
    insist(
      c && c.status === 'active' && c.registered !== false && c.expiresAt > Date.now(),
      'Local connection unavailable',
    );
    insist(
      a.orgId === p.identity?.orgId &&
        (c.scope === 'team' || a.userId === p.identity?.userId) &&
        a.expiresAt > Date.now(),
      'Action identity or expiration mismatch',
    );
    insist(!!this.definition(c, a.tool), 'Tool not allowed on this connection');
    const args = this.definition(c, a.tool)!.schema.parse(a.args);
    insist(
      a.digest ===
        hash(
          canonical({
            org: a.orgId,
            user: a.userId,
            grant: a.grantId ?? null,
            connectionId: c.id,
            tool: a.tool,
            args,
          }),
        ),
      'Action arguments changed',
    );
    return c;
  }
  async tick() {
    for (const p of this.storage.all()) {
      // Lease expiration is local: a disconnected workspace cannot extend it.
      for (const c of p.connections) {
        if (c.expiresAt <= Date.now()) c.status = 'revoked';
        if (c.status === 'revoked' && (!c.lastRevokeAt || Date.now() - c.lastRevokeAt > 60000))
          await this.revokeConnection(p, c);
      }
      this.storage.save(p);
      try {
        for (const report of this.storage.reports(p.id)) {
          await this.send(p, '/api/local/complete', report.value);
          this.storage.reported(p.id, report.id);
        }
        await this.snapshot(p);
        for (const a of this.snapshots.get(p.id)?.actions ?? []) {
          const c = this.validate(p, a);
          if (a.status === 'approved' && c.autoRead && !this.definition(c, a.tool)!.write)
            await this.execute(p, a, false);
        }
      } catch {
        this.snapshots.set(p.id, {
          status: 'offline',
          actions: [],
          error: 'Workspace unavailable. Actions are blocked until it reconnects.',
        });
      }
    }
  }
  async decide(profileId: string, actionId: string, digest: string, approve: boolean) {
    const p = this.storage.get(profileId);
    await this.snapshot(p);
    const a = this.snapshots
      .get(p.id)
      ?.actions.find((a) => a.id === actionId && a.digest === digest);
    insist(a, 'Action changed, expired or already handled. Refresh your approvals.', 409);
    if (!approve) {
      await this.send(p, '/api/local/decide', { id: a.id, digest: a.digest, approve: false });
      await this.snapshot(p);
      return;
    }
    insist(
      !(a.status === 'pending' && a.independentReview),
      'Open your workspace dashboard to share this action for independent review',
      409,
    );
    if (a.status === 'pending')
      await this.send(p, '/api/local/decide', { id: a.id, digest: a.digest, approve: true });
    await this.execute(p, a, true);
    await this.snapshot(p);
  }
  async execute(p: Profile, a: LocalAction, userConfirmed: boolean) {
    const c = this.validate(p, a);
    insist(
      userConfirmed || (c.autoRead && !this.definition(c, a.tool)!.write),
      'Local confirmation required',
    );
    try {
      await refresh(c);
    } catch (error) {
      if (error instanceof OAuthExpired) {
        c.status = 'revoked';
        this.storage.save(p);
      }
      throw error;
    }
    this.storage.save(p);
    // Persist before any dispatch. If interrupted, never repeat the external operation.
    insist(
      this.storage.begin(p.id, a.id, a.digest),
      'This action was already attempted. Check its outcome before requesting a new action.',
      409,
    );
    let receipt: string | undefined;
    try {
      const dispatch = async () => {
        this.validate(p, a);
        const permit = await this.send(p, '/api/local/claim', { id: a.id, digest: a.digest });
        insist(
          permit.id === a.id &&
            permit.digest === a.digest &&
            canonical(permit.args) === canonical(a.args) &&
            typeof permit.receipt === 'string' &&
            permit.expiresAt > Date.now(),
          'Invalid or expired execution permit',
        );
        receipt = permit.receipt;
        // Persist the receipt before performing the provider write. Restart reports unknown, never retries it.
        this.storage.record(p.id, a.id, { id: a.id, receipt, status: 'unknown' });
      };
      const output = await this.providerExecute(c, a.tool as ToolName, a.args, dispatch);
      insist(receipt, 'No server authorization');
      const safe = redactResult(output, [
        c.credentials.access_token,
        c.credentials.refresh_token ?? '',
        c.oauth?.clientSecret ?? '',
      ]);
      const result =
        Buffer.byteLength(JSON.stringify(safe)) > 120000
          ? {
              message:
                'Action completed. Result exceeds the display limit; inspect it in the provider.',
            }
          : safe;
      this.storage.record(p.id, a.id, { id: a.id, receipt, status: 'completed', result });
    } catch {
      if (receipt) this.storage.record(p.id, a.id, { id: a.id, receipt, status: 'unknown' });
    }
    for (const report of this.storage.reports(p.id)) {
      await this.send(p, '/api/local/complete', report.value);
      this.storage.reported(p.id, report.id);
    }
  }
  async register(p: Profile, c: LocalConnection) {
    insist(p.identity, 'Pair your device first');
    // Persist locally first. A lost registration response never loses OAuth credentials.
    c.registered = false;
    p.connections.push(c);
    this.storage.save(p);
    const result = await this.send(p, '/api/local/connections', {
      id: c.id,
      provider: c.provider,
      ...(c.remote ? { connectorId: c.remote.id, fingerprint: c.remote.fingerprint } : {}),
      label: c.label,
      ...(c.scope ? { scope: c.scope } : {}),
      ...(c.teamId ? { teamId: c.teamId } : {}),
    });
    c.registered = true;
    c.expiresAt = Math.min(c.expiresAt, result.expiresAt);
    this.storage.save(p);
  }
  async revokeConnection(p: Profile, c: LocalConnection) {
    c.status = 'revoked';
    c.lastRevokeAt = Date.now();
    this.storage.save(p);
    const upstream = c.credentials.access_token ? await revoke(c) : 'confirmed';
    if (upstream === 'confirmed') c.credentials = { access_token: '' };
    this.storage.save(p);
    try {
      await this.send(p, '/api/local/disconnect', { id: c.id, upstream });
    } catch {
      /* Local refusal remains effective while the server is unavailable. */
    }
  }
  state() {
    return this.storage.all().map((p) => ({
      id: p.id,
      label: p.label,
      origin: p.origin,
      fingerprint: p.fingerprint,
      pairUrl: p.pairUrl,
      identity: p.identity,
      teams: this.teams.get(p.id) ?? [],
      connectors: this.companyConnectors.get(p.id) ?? [],
      administrator: this.administrators.has(p.id),
      ...(this.snapshots.get(p.id) ?? { status: 'offline', actions: [] }),
      connections: p.connections.map((c) => ({
        id: c.id,
        provider: c.provider,
        scope: c.scope ?? 'personal',
        teamId: c.teamId,
        label: c.label,
        expiresAt: c.expiresAt,
        registered: c.registered !== false,
        status: c.status,
        autoRead: c.autoRead,
        revocationPending: c.status === 'revoked' && !!c.credentials.access_token,
      })),
    }));
  }
}
