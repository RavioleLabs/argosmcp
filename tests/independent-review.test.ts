import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/node-store.js';
import { Vault, id, type Principal, type Invocation } from '../src/foundation.js';
import { Gateway } from '../src/gateway.js';
import { SecurityControls } from '../src/security-controls.js';
let store: Store, vault: Vault, gateway: Gateway, controls: SecurityControls;
let owner: Principal,
  admin: Principal,
  member: Principal,
  outsider: Principal,
  personal: string,
  shared: string;
const execute = vi.fn(
  async (_c: unknown, _t: unknown, _a: unknown, before?: () => Promise<void>) => {
    await before?.();
    return { ok: true };
  },
);
beforeEach(() => {
  store = new Store();
  vault = new Vault({ v1: randomBytes(32) });
  gateway = new Gateway(store, vault, { execute });
  controls = new SecurityControls(store);
  execute.mockClear();
  const orgId = id(),
    otherOrg = id();
  store.run('INSERT INTO organizations(id,name) VALUES(?,?)', orgId, 'Company');
  store.run('INSERT INTO organizations(id,name) VALUES(?,?)', otherOrg, 'Other');
  owner = { orgId, userId: id() };
  admin = { orgId, userId: id() };
  member = { orgId, userId: id() };
  outsider = { orgId: otherOrg, userId: id() };
  for (const [p, role] of [
    [owner, 'owner'],
    [admin, 'admin'],
    [member, 'member'],
    [outsider, 'owner'],
  ] as const) {
    store.run(
      'INSERT INTO users VALUES(?,?,?,?)',
      p.userId,
      null,
      p.userId + '@example.test',
      role,
    );
    store.run('INSERT INTO members VALUES(?,?,?)', p.orgId, p.userId, role);
  }
  personal = id();
  shared = id();
  for (const [cid, user, scope] of [
    [personal, member.userId, 'personal'],
    [shared, owner.userId, 'organization'],
  ]) {
    store.run(
      "INSERT INTO connections(id,org_id,provider,label,scope,owner_id,created_at,expires_at) VALUES(?,?,'slack','Fixture',?,?,?,?)",
      cid,
      orgId,
      scope,
      user,
      Date.now(),
      Date.now() + 600000,
    );
  }
});
afterEach(() => store.db.close());
function enable() {
  const request = controls.request(owner, true);
  controls.decide(admin, request.id, true);
}
async function invoke(p = member, cid = personal) {
  const r = await gateway.invoke(
    p,
    cid,
    'slack_send_message',
    { channel: 'C_TEST', text: 'Exact private message' },
    id(),
  );
  return store.get<Invocation>('SELECT * FROM invocations WHERE id=?', r.id)!;
}
const approve = (p: Principal, r: Invocation, shareForReview = false) =>
  gateway.decide(p, r.id, true, { digest: r.digest, shareForReview });
it('requires a second current administrator to enable and disable the mode', () => {
  const request = controls.request(owner, true);
  expect(() => controls.decide(owner, request.id, true)).toThrow('different administrator');
  expect(() => controls.decide(member, request.id, true)).toThrow();
  expect(() => controls.decide(outsider, request.id, true)).toThrow();
  controls.decide(admin, request.id, true);
  expect(controls.enabled(owner.orgId)).toBe(true);
  const disable = controls.request(admin, false);
  expect(() => controls.decide(admin, disable.id, true)).toThrow();
  expect(controls.enabled(owner.orgId)).toBe(true);
  controls.decide(owner, disable.id, true);
  expect(controls.enabled(owner.orgId)).toBe(false);
});
it('rejects expired, stale and replayed governance changes and removed requesters', () => {
  let r = controls.request(owner, true);
  store.run('UPDATE security_control_changes SET expires_at=0 WHERE id=?', r.id);
  expect(() => controls.decide(admin, r.id, true)).toThrow();
  r = controls.request(owner, true);
  store.run('UPDATE organizations SET revision=revision+1 WHERE id=?', owner.orgId);
  expect(() => controls.decide(admin, r.id, true)).toThrow();
  r = controls.request(owner, true);
  store.run('INSERT INTO blocked_members VALUES(?,?,?)', owner.orgId, owner.userId, Date.now());
  expect(() => controls.decide(admin, r.id, true)).toThrow();
  expect(controls.enabled(owner.orgId)).toBe(false);
});
it('overrides Allow for writes and requires explicit disclosure before a personal action becomes reviewable', async () => {
  enable();
  store.run(
    "INSERT INTO organization_policies VALUES(?,?,'allow')",
    owner.orgId,
    'slack_send_message',
  );
  const r = await invoke();
  expect(r.status).toBe('pending');
  expect(execute).not.toHaveBeenCalled();
  expect(gateway.approvalRows(admin)).toEqual([]);
  await expect(approve(admin, r)).rejects.toThrow();
  await expect(approve(member, r)).rejects.toThrow('Explicit consent');
  expect(gateway.approvalRows(admin)).toEqual([]);
  expect((await approve(member, r, true)).status).toBe('pending');
  expect(gateway.approvalRows(admin)[0].args).toEqual({
    channel: 'C_TEST',
    text: 'Exact private message',
  });
  expect(gateway.approvalRows(outsider)).toEqual([]);
  expect(() => store.connection(admin, personal)).toThrow();
  expect((await approve(admin, r)).status).toBe('completed');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(() => gateway.read(admin, r.id)).toThrow();
  expect(gateway.read(member, r.id).result).toEqual({ ok: true });
});
it('cannot reach quorum with duplicate votes or an agent grant', async () => {
  enable();
  const r = await invoke();
  await approve(member, r, true);
  await approve(member, r, true);
  await expect(approve({ ...member, grantId: id() }, r, true)).rejects.toThrow();
  expect(store.all('SELECT * FROM invocation_reviews')).toHaveLength(1);
  expect(execute).not.toHaveBeenCalled();
});
it('binds votes to the exact digest and current policy', async () => {
  enable();
  const r = await invoke();
  await expect(
    gateway.decide(member, r.id, true, { digest: '0'.repeat(64), shareForReview: true }),
  ).rejects.toThrow();
  await approve(member, r, true);
  store.run('UPDATE organizations SET revision=revision+1 WHERE id=?', owner.orgId);
  await expect(approve(admin, r)).rejects.toThrow('policy changed');
  expect(execute).not.toHaveBeenCalled();
});
it('needs two eligible administrators for a shared context and never counts ordinary members', async () => {
  enable();
  const r = await invoke(owner, shared);
  await expect(approve(member, r)).rejects.toThrow();
  expect((await approve(owner, r)).status).toBe('pending');
  expect((await approve(admin, r)).status).toBe('completed');
  expect(execute).toHaveBeenCalledTimes(1);
});
it('removes a personal review from other administrators after its owner is removed', async () => {
  enable();
  const r = await invoke();
  await approve(member, r, true);
  store.run('INSERT INTO blocked_members VALUES(?,?,?)', member.orgId, member.userId, Date.now());
  expect(gateway.approvalRows(admin)).toEqual([]);
  await expect(approve(admin, r)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});
it('rechecks both reviewers at local dispatch and cancels pending work when the mode changes', async () => {
  const device = id();
  store.run(
    "INSERT INTO devices(id,public_key,label,org_id,user_id,status,created_at,expires_at) VALUES(?,'fixture','Fixture',?,?,'active',?,?)",
    device,
    member.orgId,
    member.userId,
    Date.now(),
    Date.now() + 600000,
  );
  store.run('INSERT INTO local_connections VALUES(?,?)', personal, device);
  enable();
  const r = await invoke();
  await approve(member, r, true);
  await approve(admin, r);
  expect(gateway.prepared(r.id).r.status).toBe('approved');
  store.run(
    "UPDATE members SET role='member' WHERE org_id=? AND user_id=?",
    admin.orgId,
    admin.userId,
  );
  expect(() => gateway.prepared(r.id)).toThrow('Approval no longer valid');
  store.run(
    "UPDATE members SET role='admin' WHERE org_id=? AND user_id=?",
    admin.orgId,
    admin.userId,
  );
  const disable = controls.request(owner, false);
  controls.decide(admin, disable.id, true);
  expect(store.get<Invocation>('SELECT * FROM invocations WHERE id=?', r.id)?.status).toBe(
    'cancelled',
  );
  expect(() => gateway.prepared(r.id)).toThrow();
  expect(execute).not.toHaveBeenCalled();
});
it('refuses changed encrypted arguments before sharing or recording a review', async () => {
  enable();
  const r = await invoke();
  const row = store.get<Invocation>('SELECT * FROM invocations WHERE id=?', r.id)!;
  store.run(
    'UPDATE invocations SET payload=? WHERE id=?',
    vault.seal({ channel: 'other', text: 'changed' }, `${member.orgId}:invocation:${r.id}`),
    r.id,
  );
  await expect(
    gateway.decide(member, r.id, true, { digest: row.digest, shareForReview: true }),
  ).rejects.toThrow('arguments changed');
  expect(store.get('SELECT 1 FROM invocation_reviews WHERE invocation_id=?', r.id)).toBeUndefined();
  expect(gateway.approvalRows(admin)).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
});
