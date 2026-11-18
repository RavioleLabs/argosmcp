import { Store, id, insist, type Principal } from './foundation.js';

export class SecurityControls {
  constructor(private store: Store) {}
  enabled(orgId: string) {
    return !!this.store.get<{ independent_writes: number }>(
      'SELECT independent_writes FROM security_controls WHERE org_id=?',
      orgId,
    )?.independent_writes;
  }
  view(p: Principal) {
    const admin = ['owner', 'admin'].includes(this.store.member(p).role);
    return {
      independentWrites: this.enabled(p.orgId),
      changes: admin
        ? this.store.all(
            "SELECT id,requester_id,enabled,revision,expires_at FROM security_control_changes WHERE org_id=? AND status='pending' AND expires_at>?",
            p.orgId,
            Date.now(),
          )
        : [],
    };
  }
  request(p: Principal, enabled: boolean) {
    this.store.admin(p);
    insist(enabled !== this.enabled(p.orgId), 'This security mode is already active', 409);
    const admins = this.store.all<{ user_id: string }>(
      "SELECT user_id FROM members m WHERE org_id=? AND role IN ('owner','admin') AND NOT EXISTS(SELECT 1 FROM blocked_members b WHERE b.org_id=m.org_id AND b.user_id=m.user_id)",
      p.orgId,
    );
    insist(
      admins.length >= 2,
      'Add a second company administrator before requesting this change',
      409,
    );
    const changeId = id();
    this.store.db.transaction(() => {
      // One outstanding proposal per company avoids confusing parallel enable/disable requests.
      this.store.run(
        "UPDATE security_control_changes SET status='superseded' WHERE org_id=? AND status='pending'",
        p.orgId,
      );
      this.store.run(
        'INSERT INTO security_control_changes VALUES(?,?,?,?,?,?,?)',
        changeId,
        p.orgId,
        p.userId,
        enabled ? 1 : 0,
        this.store.org(p.orgId).revision,
        Date.now() + 15 * 60000,
        'pending',
      );
      this.store.audit(p, 'security.change_requested', changeId);
    })();
    return { id: changeId, status: 'pending' };
  }
  decide(p: Principal, changeId: string, approve: boolean) {
    this.store.admin(p);
    this.store.db.transaction(() => {
      const change = this.store.get<{
        requester_id: string;
        enabled: number;
        revision: number;
        expires_at: number;
        status: string;
      }>('SELECT * FROM security_control_changes WHERE org_id=? AND id=?', p.orgId, changeId);
      insist(change, 'Security change not found', 404);
      insist(
        change.status === 'pending' &&
          change.expires_at > Date.now() &&
          change.revision === this.store.org(p.orgId).revision,
        'Security change expired or company policy changed',
        409,
      );
      if (approve) {
        insist(
          change.requester_id !== p.userId,
          'A different administrator must approve this change',
        );
        this.store.admin({ orgId: p.orgId, userId: change.requester_id });
        this.store.run(
          'INSERT INTO security_controls VALUES(?,?) ON CONFLICT(org_id) DO UPDATE SET independent_writes=excluded.independent_writes',
          p.orgId,
          change.enabled,
        );
        this.store.run('UPDATE organizations SET revision=revision+1 WHERE id=?', p.orgId);
        this.store.run(
          "UPDATE invocations SET status='cancelled' WHERE org_id=? AND status IN ('pending','approved')",
          p.orgId,
        );
      }
      this.store.run(
        'UPDATE security_control_changes SET status=? WHERE id=?',
        approve ? 'approved' : 'rejected',
        changeId,
      );
      this.store.audit(
        p,
        approve ? 'security.change_approved' : 'security.change_rejected',
        changeId,
      );
    })();
    return { ok: true };
  }
}
