import {
  Store,
  Vault,
  insist,
  id,
  hash,
  canonical,
  type Principal,
  type Connection,
  type Invocation,
} from './foundation.js';
import { catalog, type ToolName, type Connectors } from './connectors.js';

export class Gateway {
  constructor(
    public store: Store,
    private vault: Vault,
    public connectors: Pick<Connectors, 'execute'>,
  ) {}
  companyPolicy(orgId: string, tool: string): 'allow' | 'approve' | 'block' {
    return (
      this.store.get<{ effect: 'allow' | 'approve' | 'block' }>(
        'SELECT effect FROM organization_policies WHERE org_id=? AND tool=?',
        orgId,
        tool,
      )?.effect ?? 'approve'
    );
  }
  personalRestriction(
    p: Principal,
    connectionId: string,
    tool: string,
  ): 'inherit' | 'approve' | 'block' {
    return (
      this.store.get<{ effect: 'approve' | 'block' }>(
        'SELECT effect FROM personal_restrictions WHERE org_id=? AND user_id=? AND connection_id=? AND tool=?',
        p.orgId,
        p.userId,
        connectionId,
        tool,
      )?.effect ?? 'inherit'
    );
  }
  policy(c: Connection, tool: string, p?: Principal): 'allow' | 'approve' | 'block' {
    const company = this.companyPolicy(c.org_id, tool);
    const connection =
      this.store.get<{ effect: 'allow' | 'approve' | 'block' }>(
        'SELECT effect FROM policies WHERE org_id=? AND connection_id=? AND tool=?',
        c.org_id,
        c.id,
        tool,
      )?.effect ?? 'allow';
    const personal = p ? this.personalRestriction(p, c.id, tool) : 'inherit';
    // Permissions intersect. No personal or connection override can relax enterprise policy.
    const all = [company, connection, personal];
    return all.includes('block') ? 'block' : all.includes('approve') ? 'approve' : 'allow';
  }
  authorize(p: Principal, connectionId: string, tool: string) {
    const c = this.store.connection(p, connectionId);
    this.store.live(c);
    const local = this.store.get<{ device_id: string }>(
      'SELECT device_id FROM local_connections WHERE connection_id=?',
      c.id,
    );
    if (local) {
      const device = this.store.get<{ status: string; expires_at: number; created_at: number }>(
        'SELECT status,expires_at,created_at FROM devices WHERE id=? AND org_id=? AND user_id=?',
        local.device_id,
        p.orgId,
        c.owner_id,
      );
      insist(
        device &&
          device.status === 'active' &&
          Math.min(
            device.expires_at,
            device.created_at + this.store.org(p.orgId).grant_hours * 3600000,
          ) > Date.now(),
        'Local device expired or revoked',
      );
    }
    insist(
      tool in catalog && catalog[tool as ToolName].provider === c.provider,
      'Tool unavailable for this connection',
      404,
    );
    if (p.grantId) {
      const g = this.store.grant(p.grantId);
      insist(
        g.org_id === p.orgId && g.user_id === p.userId && JSON.parse(g.connections).includes(c.id),
        'Agent not authorized for this connection',
      );
    }
    insist(this.policy(c, tool, p) !== 'block', 'Action blocked by access policy');
    return c;
  }
  async invoke(p: Principal, connectionId: string, tool: ToolName, input: unknown, key: string) {
    let c: Connection;
    try {
      c = this.authorize(p, connectionId, tool);
    } catch (error) {
      this.store.audit(p, 'invocation.denied', connectionId);
      throw error;
    }
    const args = catalog[tool].schema.parse(input);
    const digest = hash(
      canonical({
        org: p.orgId,
        user: p.userId,
        grant: p.grantId ?? null,
        connectionId,
        tool,
        args,
      }),
    );
    const previous = this.store.get<Invocation>(
      'SELECT * FROM invocations WHERE org_id=? AND user_id=? AND idempotency_key=?',
      p.orgId,
      p.userId,
      key,
    );
    if (previous) {
      insist(
        previous.digest === digest,
        'Idempotency key already used for different arguments',
        409,
      );
      return this.read(p, previous.id);
    }
    const invocationId = id(),
      now = Date.now(),
      effect = this.policy(c, tool, p);
    this.store.run(
      'INSERT INTO invocations(id,org_id,user_id,grant_id,connection_id,tool,digest,payload,status,revision,created_at,expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      invocationId,
      p.orgId,
      p.userId,
      p.grantId ?? null,
      c.id,
      tool,
      digest,
      this.vault.seal(args, `${p.orgId}:invocation:${invocationId}`),
      effect === 'approve' ? 'pending' : 'approved',
      this.store.org(p.orgId).revision,
      now,
      now + 15 * 60_000,
      key,
    );
    this.store.audit(
      p,
      effect === 'approve' ? 'approval.requested' : 'invocation.allowed',
      invocationId,
    );
    if (effect === 'allow') await this.execute(invocationId);
    return this.read(p, invocationId);
  }
  read(p: Principal, invocationId: string) {
    const r = this.store.get<Invocation>(
      'SELECT * FROM invocations WHERE org_id=? AND id=?',
      p.orgId,
      invocationId,
    );
    insist(
      r && r.user_id === p.userId && (!p.grantId || r.grant_id === p.grantId),
      'Invocation not found',
      404,
    );
    this.authorize(p, r.connection_id, r.tool);
    if (p.grantId) this.store.grant(p.grantId);
    return {
      id: r.id,
      status: r.status,
      expiresAt: r.expires_at,
      result: r.result ? this.vault.open(r.result, `${r.org_id}:result:${r.id}`) : null,
    };
  }
  approvalRows(p: Principal) {
    this.store.member(p);
    return this.store
      .all<Invocation>(
        "SELECT * FROM invocations WHERE org_id=? AND status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 100",
        p.orgId,
        Date.now(),
      )
      .filter((r) => {
        const c = this.store.get<Connection>(
          'SELECT * FROM connections WHERE org_id=? AND id=?',
          p.orgId,
          r.connection_id,
        )!;
        return this.canApprove(p, c);
      })
      .map((r) => ({
        id: r.id,
        tool: r.tool,
        connectionId: r.connection_id,
        userId: r.user_id,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        args: this.vault.open(r.payload, `${r.org_id}:invocation:${r.id}`),
      }));
  }
  private canApprove(p: Principal, c: Connection) {
    return (
      this.store.canAccess(p, c) &&
      (c.scope === 'personal'
        ? c.owner_id === p.userId
        : ['owner', 'admin'].includes(this.store.member(p).role))
    );
  }
  async decide(p: Principal, invocationId: string, approve: boolean) {
    this.store.db.transaction(() => {
      const r = this.store.get<Invocation>(
        'SELECT * FROM invocations WHERE org_id=? AND id=?',
        p.orgId,
        invocationId,
      );
      insist(r, 'Approval not found', 404);
      const c = this.store.connection(p, r.connection_id);
      insist(this.canApprove(p, c), 'You cannot approve this context');
      insist(
        r.status === 'pending' && r.expires_at > Date.now(),
        'Approval expired or already decided',
        409,
      );
      this.store.run(
        'UPDATE invocations SET status=?,approver_id=? WHERE id=?',
        approve ? 'approved' : 'rejected',
        p.userId,
        r.id,
      );
      this.store.audit(p, approve ? 'approval.approved' : 'approval.rejected', r.id);
    })();
    if (approve) await this.execute(invocationId);
    return this.store.get<{ status: string }>(
      'SELECT status FROM invocations WHERE id=?',
      invocationId,
    )!;
  }
  private async execute(invocationId: string) {
    const r = this.store.get<Invocation>('SELECT * FROM invocations WHERE id=?', invocationId)!;
    const p = {
      orgId: r.org_id,
      userId: r.user_id,
      ...(r.grant_id ? { grantId: r.grant_id } : {}),
    };
    try {
      const c = this.authorize(p, r.connection_id, r.tool);
      const args = this.vault.open<Record<string, unknown>>(
        r.payload,
        `${r.org_id}:invocation:${r.id}`,
      );
      insist(
        r.digest ===
          hash(
            canonical({
              org: p.orgId,
              user: p.userId,
              grant: p.grantId ?? null,
              connectionId: c.id,
              tool: r.tool,
              args,
            }),
          ),
        'Approved arguments changed',
      );
      insist(
        r.expires_at > Date.now() && r.revision === this.store.org(p.orgId).revision,
        'Approval expired or policy changed. Request again.',
        409,
      );
      if (this.policy(c, r.tool, p) === 'approve') {
        insist(
          r.approver_id && this.canApprove({ orgId: r.org_id, userId: r.approver_id }, c),
          'Valid human approval required',
        );
      }
      if (this.store.get('SELECT 1 FROM local_connections WHERE connection_id=?', c.id)) return;
      const acquired = this.store.run(
        "UPDATE invocations SET status='executing' WHERE id=? AND status='approved'",
        r.id,
      ).changes;
      if (!acquired) return;
      const output = await this.connectors.execute(c, r.tool as ToolName, args);
      this.store.run(
        "UPDATE invocations SET status='completed',result=? WHERE id=?",
        this.vault.seal(output, `${r.org_id}:result:${r.id}`),
        r.id,
      );
      this.store.audit(p, 'invocation.completed', r.id);
    } catch {
      // No automatic retry: a network failure may have occurred AFTER the provider committed a write.
      this.store.run(
        "UPDATE invocations SET status=CASE WHEN status='executing' THEN 'unknown' ELSE 'cancelled' END WHERE id=? AND status IN ('approved','executing')",
        r.id,
      );
      this.store.audit(p, 'invocation.incomplete', r.id);
    }
  }
  // Called again at dispatch, after the device has prepared its credentials. No cached decision.
  prepared(invocationId: string) {
    const r = this.store.get<Invocation>('SELECT * FROM invocations WHERE id=?', invocationId);
    insist(r && r.status === 'approved', 'Action is not ready', 409);
    const p = {
      orgId: r.org_id,
      userId: r.user_id,
      ...(r.grant_id ? { grantId: r.grant_id } : {}),
    };
    const c = this.authorize(p, r.connection_id, r.tool);
    const args = this.vault.open<Record<string, unknown>>(
      r.payload,
      `${r.org_id}:invocation:${r.id}`,
    );
    insist(
      r.digest ===
        hash(
          canonical({
            org: p.orgId,
            user: p.userId,
            grant: p.grantId ?? null,
            connectionId: c.id,
            tool: r.tool,
            args,
          }),
        ),
      'Arguments changed',
      409,
    );
    insist(
      r.expires_at > Date.now() && r.revision === this.store.org(p.orgId).revision,
      'Action expired or policy changed',
      409,
    );
    if (this.policy(c, r.tool, p) === 'approve')
      insist(
        r.approver_id && this.canApprove({ orgId: r.org_id, userId: r.approver_id }, c),
        'Approval no longer valid',
      );
    return { r, p, c, args };
  }
}
