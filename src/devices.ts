import { CompanyConnectors } from './company-connectors.js';
import { createPublicKey, verify } from 'node:crypto';
import type { Express, Request } from 'express';
import { z } from 'zod';
import {
  Store,
  Vault,
  insist,
  id,
  hash,
  opaque,
  canonical,
  type Principal,
  type Connection,
  type Invocation,
} from './foundation.js';
import { proofMessage, type Device, type LocalAction } from './device-protocol.js';
import type { Auth } from './auth.js';
import type { Gateway } from './gateway.js';

export class Devices {
  constructor(
    public store: Store,
    private vault: Vault,
    private gateway: Gateway,
    private origin: string,
  ) {}
  pair(publicKey: string, label: string) {
    const key = createPublicKey(publicKey);
    insist(key.asymmetricKeyType === 'ed25519', 'Use an Ed25519 device key', 400);
    const normalized = key.export({ format: 'pem', type: 'spki' }).toString(),
      deviceId = id();
    this.store.run(
      'INSERT INTO devices(id,public_key,label,created_at,expires_at) VALUES(?,?,?,?,?)',
      deviceId,
      normalized,
      label,
      Date.now(),
      Date.now() + 600000,
    );
    return {
      id: deviceId,
      fingerprint: hash(normalized).slice(0, 24),
      url: `${this.origin}/?device=${deviceId}`,
    };
  }
  info(deviceId: string) {
    const d = this.store.get<Device>('SELECT * FROM devices WHERE id=?', deviceId);
    insist(d && d.status === 'pending' && d.expires_at > Date.now(), 'Pairing expired', 404);
    return { id: d.id, label: d.label, fingerprint: hash(d.public_key).slice(0, 24) };
  }
  approve(p: Principal, deviceId: string, fingerprint: string) {
    this.store.member(p);
    const info = this.info(deviceId);
    insist(info.fingerprint === fingerprint, 'Device fingerprint mismatch', 400);
    insist(
      this.store.run(
        "UPDATE devices SET org_id=?,user_id=?,status='active',created_at=?,expires_at=? WHERE id=? AND status='pending'",
        p.orgId,
        p.userId,
        Date.now(),
        Date.now() + this.store.org(p.orgId).grant_hours * 3600000,
        deviceId,
      ).changes,
      'Device already paired',
      409,
    );
    this.store.audit(p, 'device.paired', deviceId);
  }
  proof(req: Request): Device {
    const deviceId = z.string().uuid().parse(req.headers['x-argos-device']);
    const at = Number(req.headers['x-argos-time']),
      nonce = z.string().min(24).max(100).parse(req.headers['x-argos-nonce']);
    insist(
      Number.isSafeInteger(at) && Math.abs(Date.now() - at) < 60000,
      'Device request expired',
      401,
    );
    const d = this.store.get<Device>('SELECT * FROM devices WHERE id=?', deviceId);
    insist(d, 'Unknown device', 401);
    const signature = z.string().max(200).parse(req.headers['x-argos-signature']);
    insist(
      verify(
        null,
        Buffer.from(
          proofMessage(this.origin, req.originalUrl, deviceId, at, nonce, req.body ?? {}),
        ),
        createPublicKey(d.public_key),
        Buffer.from(signature, 'base64url'),
      ),
      'Invalid device proof',
      401,
    );
    this.store.db.transaction(() => {
      this.store.run('DELETE FROM device_nonces WHERE expires_at<?', Date.now());
      insist(
        !this.store.get(
          'SELECT 1 FROM device_nonces WHERE device_id=? AND nonce=?',
          deviceId,
          nonce,
        ),
        'Replayed device request',
        401,
      );
      this.store.run(
        'INSERT INTO device_nonces VALUES(?,?,?)',
        deviceId,
        nonce,
        Date.now() + 120000,
      );
      this.store.run('UPDATE devices SET last_seen=? WHERE id=?', Date.now(), deviceId);
    })();
    return d;
  }
  principal(d: Device): Principal {
    insist(d.org_id && d.user_id && d.status === 'active', 'Device not authorized', 401);
    insist(
      Math.min(d.expires_at, d.created_at + this.store.org(d.org_id).grant_hours * 3600000) >
        Date.now(),
      'Device authorization expired',
      401,
    );
    const p = { orgId: d.org_id, userId: d.user_id };
    this.store.member(p);
    return p;
  }
  register(
    d: Device,
    input: {
      id: string;
      provider: string;
      label: string;
      scope?: 'personal' | 'team';
      teamId?: string;
      connectorId?: string;
      fingerprint?: string;
    },
  ) {
    insist(
      ['slack', 'notion', 'linear', 'mcp'].includes(input.provider),
      'Unsupported provider',
      400,
    );
    const p = this.principal(d),
      now = Date.now(),
      scope = input.scope ?? 'personal';
    if (input.provider === 'mcp') {
      insist(input.connectorId, 'Missing company connector', 400);
      const definition = new CompanyConnectors(this.store).get(p, input.connectorId);
      insist(
        definition.status !== 'disabled' && definition.fingerprint === input.fingerprint,
        'Company connector configuration mismatch',
        403,
      );
    } else insist(!input.connectorId && !input.fingerprint, 'Unexpected connector binding', 400);
    insist(scope === 'personal', 'Personal provider connections cannot be shared');
    insist(!input.teamId, 'Unexpected team');
    const previous = this.store.get<Connection>('SELECT * FROM connections WHERE id=?', input.id);
    if (previous) {
      insist(
        previous.org_id === p.orgId &&
          previous.owner_id === p.userId &&
          previous.provider === input.provider &&
          (input.provider !== 'mcp' ||
            !!this.store.get(
              'SELECT 1 FROM connection_connectors WHERE connection_id=? AND org_id=? AND connector_id=?',
              input.id,
              p.orgId,
              input.connectorId,
            )) &&
          previous.scope === scope &&
          previous.team_id === (input.teamId ?? null) &&
          this.store.get(
            'SELECT 1 FROM local_connections WHERE connection_id=? AND device_id=?',
            input.id,
            d.id,
          ),
        'Connection belongs to another context',
      );
      insist(
        previous.status === 'active' && this.store.expires(previous) > Date.now(),
        'Connection expired or revoked',
        403,
      );
      return { id: previous.id, expiresAt: this.store.expires(previous) };
    }
    this.store.db.transaction(() => {
      this.store.run(
        'INSERT INTO connections(id,org_id,provider,label,scope,owner_id,team_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
        input.id,
        p.orgId,
        input.provider,
        input.label,
        scope,
        p.userId,
        input.teamId ?? null,
        now,
        now + this.store.org(p.orgId).lease_hours * 3600000,
      );
      this.store.run('INSERT INTO local_connections VALUES(?,?)', input.id, d.id);
      if (input.connectorId)
        this.store.run(
          'INSERT INTO connection_connectors VALUES(?,?,?)',
          input.id,
          p.orgId,
          input.connectorId,
        );
      this.store.audit(p, 'connection.local_connected', input.id);
    })();
    return { id: input.id, expiresAt: now + this.store.org(p.orgId).lease_hours * 3600000 };
  }
  own(d: Device, connectionId: string) {
    const p = this.principal(d),
      c = this.store.connection(p, connectionId);
    insist(
      c.owner_id === p.userId &&
        this.store.get(
          'SELECT 1 FROM local_connections WHERE connection_id=? AND device_id=?',
          c.id,
          d.id,
        ),
      'Connection not on this device',
      404,
    );
    return c;
  }
  snapshot(d: Device) {
    const p = this.principal(d);
    this.store.run(
      "UPDATE invocations SET status='unknown' WHERE status='executing' AND id IN (SELECT invocation_id FROM local_dispatches WHERE expires_at<?)",
      Date.now(),
    );
    const connections = this.store.all<Connection>(
      'SELECT c.* FROM connections c JOIN local_connections l ON l.connection_id=c.id WHERE l.device_id=? AND c.org_id=? AND c.owner_id=?',
      d.id,
      p.orgId,
      p.userId,
    );
    const actions: LocalAction[] = [];
    for (const r of this.store.all<Invocation>(
      "SELECT i.* FROM invocations i JOIN local_connections l ON l.connection_id=i.connection_id WHERE l.device_id=? AND i.org_id=? AND i.status IN ('pending','approved') AND i.expires_at>? ORDER BY i.created_at LIMIT 100",
      d.id,
      p.orgId,
      Date.now(),
    )) {
      try {
        this.gateway.authorize(
          { orgId: p.orgId, userId: r.user_id, ...(r.grant_id ? { grantId: r.grant_id } : {}) },
          r.connection_id,
          r.tool,
        );
        this.own(d, r.connection_id);
        if (r.revision !== this.store.org(p.orgId).revision) throw new Error();
        const args = this.vault.open<Record<string, unknown>>(
          r.payload,
          `${r.org_id}:invocation:${r.id}`,
        );
        actions.push({
          independentReview: this.gateway.independent(r.org_id, r.tool),
          id: r.id,
          orgId: p.orgId,
          userId: r.user_id,
          requester: this.store.get<{ email: string }>(
            'SELECT email FROM users WHERE id=?',
            r.user_id,
          )?.email,
          grantId: r.grant_id,
          connectionId: r.connection_id,
          tool: r.tool,
          args,
          digest: r.digest,
          expiresAt: r.expires_at,
          status: r.status,
          agent: r.grant_id
            ? (this.store.get<{ label: string }>('SELECT label FROM grants WHERE id=?', r.grant_id)
                ?.label ?? 'Agent')
            : 'Dashboard',
        });
      } catch {
        this.store.run(
          "UPDATE invocations SET status='cancelled' WHERE id=? AND status IN ('pending','approved')",
          r.id,
        );
      }
    }
    return {
      connectors: new CompanyConnectors(this.store).list(p),
      administrator: this.store.member(p).role !== 'member',
      teams: this.store.all<{ id: string; name: string }>(
        'SELECT t.id,t.name FROM teams t JOIN team_members m ON m.team_id=t.id AND m.org_id=t.org_id WHERE t.org_id=? AND m.user_id=?',
        p.orgId,
        p.userId,
      ),
      identity: {
        ...p,
        name: this.store.org(p.orgId).name,
        email: this.store.get<{ email: string }>('SELECT email FROM users WHERE id=?', p.userId)!
          .email,
      },
      connections: connections.map((c) => ({
        id: c.id,
        provider: c.provider,
        label: c.label,
        status: c.status,
        expiresAt: this.store.expires(c),
        revokeStatus: c.revoke_status,
      })),
      actions,
    };
  }
  async decide(d: Device, invocationId: string, digest: string, approve: boolean) {
    const p = this.principal(d),
      r = this.store.get<Invocation>(
        'SELECT * FROM invocations WHERE id=? AND org_id=?',
        invocationId,
        p.orgId,
      );
    insist(r && r.digest === digest, 'Action changed or unavailable', 409);
    this.own(d, r.connection_id);
    if (r.status === 'approved' && !approve) {
      this.store.run(
        "UPDATE invocations SET status='rejected' WHERE id=? AND status='approved'",
        r.id,
      );
      this.store.audit(p, 'approval.rejected', r.id);
      return { status: 'rejected' };
    }
    return this.gateway.decide(p, invocationId, approve);
  }
  claim(d: Device, invocationId: string, digest: string) {
    return this.store.db.transaction(() => {
      const p = this.principal(d),
        { r, c, args } = this.gateway.prepared(invocationId);
      insist(r.org_id === p.orgId && r.digest === digest, 'Action binding mismatch');
      this.own(d, c.id);
      const receipt = opaque(),
        expiresAt = Math.min(
          Date.now() + 30000,
          r.expires_at,
          this.store.expires(c),
          d.expires_at,
          d.created_at + this.store.org(p.orgId).grant_hours * 3600000,
        );
      insist(
        this.store.run(
          "UPDATE invocations SET status='executing' WHERE id=? AND status='approved'",
          r.id,
        ).changes,
        'Already dispatched',
        409,
      );
      this.store.run(
        'INSERT INTO local_dispatches VALUES(?,?,?,?)',
        r.id,
        d.id,
        hash(receipt),
        Date.now() + 120000,
      );
      this.store.audit(p, 'invocation.dispatched', r.id);
      return { id: r.id, digest: r.digest, args, receipt, expiresAt };
    })();
  }
  complete(
    d: Device,
    input: { id: string; receipt: string; status: 'completed' | 'unknown'; result?: unknown },
  ) {
    // Permit a claimed action to report its outcome after device revocation. It cannot acquire new work.
    const dispatch = this.store.get<{ receipt_hash: string; device_id: string }>(
      'SELECT * FROM local_dispatches WHERE invocation_id=?',
      input.id,
    );
    insist(
      dispatch?.device_id === d.id && dispatch.receipt_hash === hash(input.receipt),
      'Invalid execution receipt',
      403,
    );
    const r = this.store.get<Invocation>(
      'SELECT i.* FROM invocations i JOIN local_connections l ON l.connection_id=i.connection_id WHERE i.id=? AND i.org_id=? AND l.device_id=?',
      input.id,
      d.org_id,
      d.id,
    );
    insist(r, 'Action not found', 404);
    insist(
      Buffer.byteLength(JSON.stringify(input.result ?? null)) <= 128000,
      'Result too large',
      413,
    );
    if (r.status === 'completed') return { ok: true };
    insist(['executing', 'unknown'].includes(r.status), 'Action not executing', 409);
    this.store.run(
      'UPDATE invocations SET status=?,result=? WHERE id=?',
      input.status,
      input.status === 'completed'
        ? this.vault.seal(input.result ?? null, `${r.org_id}:result:${r.id}`)
        : null,
      r.id,
    );
    this.store.audit({ orgId: r.org_id, userId: r.user_id }, `invocation.${input.status}`, r.id);
    return { ok: true };
  }
  mount(app: Express, auth: Auth) {
    app.post('/api/local/pair', (req, res) => {
      const b = z
        .object({ publicKey: z.string().max(200), label: z.string().trim().min(1).max(100) })
        .strict()
        .parse(req.body);
      res.json(this.pair(b.publicKey, b.label));
    });
    app.get('/api/devices/:id/pair', (req, res) => {
      auth.user(req);
      res.json(this.info(String(req.params.id)));
    });
    app.post('/api/org/:orgId/devices/:id/pair', (req, res) => {
      const b = z.object({ fingerprint: z.string() }).strict().parse(req.body);
      this.approve(auth.principal(req), String(req.params.id), b.fingerprint);
      res.json({ ok: true });
    });
    app.post('/api/org/:orgId/devices/:id/revoke', (req, res) => {
      const p = auth.principal(req),
        d = this.store.get<Device>(
          'SELECT * FROM devices WHERE id=? AND org_id=?',
          String(req.params.id),
          p.orgId,
        );
      insist(d, 'Device not found', 404);
      if (d.user_id !== p.userId) this.store.admin(p);
      this.store.run("UPDATE devices SET status='revoked' WHERE id=?", d.id);
      this.store.run(
        "UPDATE connections SET status='revoked',revoke_status='device_pending' WHERE id IN (SELECT connection_id FROM local_connections WHERE device_id=?)",
        d.id,
      );
      this.store.run(
        "UPDATE invocations SET status='cancelled' WHERE connection_id IN (SELECT connection_id FROM local_connections WHERE device_id=?) AND status IN ('pending','approved')",
        d.id,
      );
      this.store.audit(p, 'device.revoked', d.id);
      res.json({ ok: true });
    });
    app.post('/api/local/status', (req, res) => {
      const d = this.proof(req);
      z.object({}).strict().parse(req.body);
      if (d.status === 'pending') {
        insist(d.expires_at > Date.now(), 'Pairing expired', 401);
        return res.json({ status: 'pending' });
      }
      try {
        res.json({ status: 'active', ...this.snapshot(d) });
      } catch {
        res.json({ status: 'revoked', actions: [], connections: [] });
      }
    });
    app.post('/api/local/connections', (req, res) => {
      const d = this.proof(req),
        b = z
          .object({
            id: z.string().uuid(),
            provider: z.enum(['slack', 'notion', 'linear', 'mcp']),
            connectorId: z.string().uuid().optional(),
            fingerprint: z.string().length(64).optional(),
            scope: z.enum(['personal', 'team']).optional(),
            teamId: z.string().uuid().optional(),
            label: z.string().trim().min(1).max(100),
          })
          .strict()
          .parse(req.body);
      res.json(this.register(d, b));
    });
    app.post('/api/local/connector-tools', (req, res) => {
      const d = this.proof(req),
        p = this.principal(d);
      const b = z
        .object({
          connectorId: z.string().uuid(),
          fingerprint: z.string().length(64),
          tools: z.unknown(),
        })
        .strict()
        .parse(req.body);
      res.json(
        new CompanyConnectors(this.store).discover(p, b.connectorId, b.fingerprint, b.tools),
      );
    });
    app.post('/api/local/decide', async (req, res) => {
      const d = this.proof(req),
        b = z
          .object({ id: z.string().uuid(), digest: z.string().length(64), approve: z.boolean() })
          .strict()
          .parse(req.body);
      res.json(await this.decide(d, b.id, b.digest, b.approve));
    });
    app.post('/api/local/claim', (req, res) => {
      const d = this.proof(req),
        b = z
          .object({ id: z.string().uuid(), digest: z.string().length(64) })
          .strict()
          .parse(req.body);
      res.json(this.claim(d, b.id, b.digest));
    });
    app.post('/api/local/complete', (req, res) => {
      const d = this.proof(req),
        b = z
          .object({
            id: z.string().uuid(),
            receipt: z.string().max(100),
            status: z.enum(['completed', 'unknown']),
            result: z.unknown().optional(),
          })
          .strict()
          .parse(req.body);
      res.json(this.complete(d, b));
    });
    app.post('/api/local/disconnect', (req, res) => {
      const d = this.proof(req),
        b = z
          .object({ id: z.string().uuid(), upstream: z.enum(['confirmed', 'manual_required']) })
          .strict()
          .parse(req.body);
      const c = this.store.get<Connection>(
        'SELECT c.* FROM connections c JOIN local_connections l ON l.connection_id=c.id WHERE c.id=? AND l.device_id=? AND c.org_id=? AND c.owner_id=?',
        b.id,
        d.id,
        d.org_id,
        d.user_id,
      );
      insist(c, 'Connection not found', 404);
      this.store.run(
        "UPDATE connections SET status='revoked',revoke_status=? WHERE id=?",
        b.upstream,
        c.id,
      );
      this.store.audit({ orgId: c.org_id, userId: c.owner_id }, 'connection.revoked', c.id);
      res.json({ ok: true });
    });
  }
}
