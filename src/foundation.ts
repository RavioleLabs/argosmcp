import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const id = () => randomUUID();
export const opaque = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const DAY = 86400_000;
export class Fault extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function insist(condition: unknown, message: string, status = 403): asserts condition {
  if (!condition) throw new Fault(status, message);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export interface Principal {
  userId: string;
  orgId: string;
  grantId?: string;
}
export interface Connection {
  id: string;
  org_id: string;
  provider: string;
  label: string;
  scope: 'personal' | 'team' | 'organization';
  owner_id: string;
  team_id: string | null;
  secret: string | null;
  created_at: number;
  expires_at: number;
  status: string;
  revoke_status: string;
  target_id: string | null;
  demo: number;
}
export interface Org {
  id: string;
  name: string;
  lease_hours: number;
  grant_hours: number;
  revision: number;
}
export interface Grant {
  id: string;
  org_id: string;
  user_id: string;
  client_id: string;
  label: string;
  connections: string;
  created_at: number;
  expires_at: number;
  revoked: number;
}
export interface Invocation {
  id: string;
  org_id: string;
  user_id: string;
  grant_id: string | null;
  connection_id: string;
  tool: string;
  digest: string;
  payload: string;
  result: string | null;
  status: string;
  revision: number;
  created_at: number;
  expires_at: number;
  approver_id: string | null;
  idempotency_key: string;
}
export interface EngramTarget {
  id: string;
  label: string;
  url: string;
  tokenEnv: string;
  orgId: string;
  scope: 'personal' | 'team';
  contextId: string;
}
export interface Tenant {
  id: string;
  name: string;
  ownerEmail: string;
  ownerSub?: string;
}
export interface Settings {
  basePath?: string;
  platformSession?: boolean;
  selfService?: boolean;
  hosted?: boolean;
  tenant?: Tenant;
  origin: string;
  demo: boolean;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  targets: EngramTarget[];
}

// Each value has its own data key. Associated data binds ciphertext to its tenant and record.
// Production wrapping keys are supplied by a mounted secret, never stored in the database.
export const workspaceURL = (settings: Settings) => settings.origin + (settings.basePath ?? '');

export class Vault {
  constructor(
    private keys: Record<string, Buffer>,
    private active = 'v1',
  ) {
    insist(
      keys[active]?.length === 32 && Object.values(keys).every((k) => k.length === 32),
      'Invalid vault keyring',
      500,
    );
  }
  seal(value: unknown, context: string): string {
    const dataKey = randomBytes(32);
    try {
      return JSON.stringify({
        v: this.active,
        key: this.encrypt(dataKey, this.keys[this.active], context + ':key'),
        data: this.encrypt(Buffer.from(JSON.stringify(value)), dataKey, context),
      });
    } finally {
      dataKey.fill(0);
    }
  }
  open<T>(envelope: string, context: string): T {
    const e = JSON.parse(envelope);
    insist(this.keys[e.v], 'Vault key version unavailable', 503);
    const dataKey = this.decrypt(e.key, this.keys[e.v], context + ':key');
    try {
      return JSON.parse(this.decrypt(e.data, dataKey, context).toString('utf8')) as T;
    } finally {
      dataKey.fill(0);
    }
  }
  private encrypt(data: Buffer, key: Buffer, context: string) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(context));
    const bytes = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64');
  }
  private decrypt(value: string, key: Buffer, context: string) {
    const bytes = Buffer.from(value, 'base64');
    insist(bytes.length >= 28, 'Invalid ciphertext', 500);
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
  }
}
export function loadVault(settings: Settings): Vault {
  if (settings.demo)
    return new Vault({ v1: createHash('sha256').update('argosmcp-disposable-demo-only').digest() });
  const raw = settings.env.ARGOS_VAULT_KEYRING_FILE
    ? readFileSync(settings.env.ARGOS_VAULT_KEYRING_FILE, 'utf8')
    : settings.env.ARGOS_VAULT_KEYRING;
  insist(raw, 'Configure ARGOS_VAULT_KEYRING_FILE with a JSON keyring before starting', 500);
  const ring = JSON.parse(raw);
  return new Vault(
    Object.fromEntries(Object.entries(ring).map(([k, v]) => [k, Buffer.from(String(v), 'base64')])),
    settings.env.ARGOS_VAULT_ACTIVE_KEY ?? 'v1',
  );
}

export interface SyncDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): { changes: number | bigint };
  };
  transaction<T>(callback: () => T): () => T;
  close(): void;
}
export class Store {
  constructor(public db: SyncDatabase) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, google_sub TEXT UNIQUE, email TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, lease_hours INTEGER NOT NULL DEFAULT 168, grant_hours INTEGER NOT NULL DEFAULT 168, revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS members (org_id TEXT REFERENCES organizations(id), user_id TEXT REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','member')), PRIMARY KEY(org_id,user_id));
      CREATE TABLE IF NOT EXISTS blocked_members (org_id TEXT NOT NULL,user_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(org_id,user_id));
      CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, UNIQUE(org_id,id));
      CREATE TABLE IF NOT EXISTS team_members (org_id TEXT, team_id TEXT, user_id TEXT, PRIMARY KEY(org_id,team_id,user_id), FOREIGN KEY(org_id,team_id) REFERENCES teams(org_id,id), FOREIGN KEY(org_id,user_id) REFERENCES members(org_id,user_id));
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS states (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), provider TEXT NOT NULL, label TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('personal','team','organization')), owner_id TEXT NOT NULL, team_id TEXT, secret TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', revoke_status TEXT NOT NULL DEFAULT 'none', target_id TEXT, demo INTEGER NOT NULL DEFAULT 0, UNIQUE(org_id,id), FOREIGN KEY(org_id,owner_id) REFERENCES members(org_id,user_id), FOREIGN KEY(org_id,team_id) REFERENCES teams(org_id,id));
      CREATE UNIQUE INDEX IF NOT EXISTS engram_target_binding ON connections(target_id) WHERE target_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS policies (org_id TEXT NOT NULL, connection_id TEXT NOT NULL, tool TEXT NOT NULL, effect TEXT NOT NULL CHECK(effect IN ('allow','approve','block')), PRIMARY KEY(org_id,connection_id,tool), FOREIGN KEY(org_id,connection_id) REFERENCES connections(org_id,id));
      CREATE TABLE IF NOT EXISTS organization_policies (org_id TEXT NOT NULL REFERENCES organizations(id),tool TEXT NOT NULL,effect TEXT NOT NULL CHECK(effect IN ('allow','approve','block')),PRIMARY KEY(org_id,tool));
      CREATE TABLE IF NOT EXISTS personal_restrictions (org_id TEXT NOT NULL,user_id TEXT NOT NULL,connection_id TEXT NOT NULL,tool TEXT NOT NULL,effect TEXT NOT NULL CHECK(effect IN ('approve','block')),PRIMARY KEY(org_id,user_id,connection_id,tool),FOREIGN KEY(org_id,connection_id) REFERENCES connections(org_id,id),FOREIGN KEY(org_id,user_id) REFERENCES members(org_id,user_id));
      CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, client_id TEXT NOT NULL, label TEXT NOT NULL, connections TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(org_id,user_id) REFERENCES members(org_id,user_id));
      CREATE TABLE IF NOT EXISTS grant_resources (grant_id TEXT PRIMARY KEY REFERENCES grants(id), resource TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id), kind TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES grants(id), challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invocations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, grant_id TEXT, connection_id TEXT NOT NULL, tool TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, status TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approver_id TEXT, idempotency_key TEXT NOT NULL, UNIQUE(org_id,user_id,idempotency_key), FOREIGN KEY(org_id,connection_id) REFERENCES connections(org_id,id));
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, org_id TEXT NOT NULL, actor_id TEXT NOT NULL, event TEXT NOT NULL, entity_id TEXT NOT NULL, created_at INTEGER NOT NULL, previous_hash TEXT NOT NULL, entry_hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_org ON audit(org_id,seq);
      CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, label TEXT NOT NULL, org_id TEXT, user_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS device_nonces (device_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(device_id,nonce));
      CREATE TABLE IF NOT EXISTS local_connections (connection_id TEXT PRIMARY KEY REFERENCES connections(id), device_id TEXT NOT NULL REFERENCES devices(id));
      CREATE TABLE IF NOT EXISTS local_dispatches (invocation_id TEXT PRIMARY KEY REFERENCES invocations(id), device_id TEXT NOT NULL, receipt_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
  }
  get<T>(sql: string, ...args: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: unknown[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: unknown[]) {
    return this.db.prepare(sql).run(...args);
  }
  org(orgId: string) {
    const o = this.get<Org>('SELECT * FROM organizations WHERE id=?', orgId);
    insist(o, 'Organization not found', 404);
    return o;
  }
  member(p: Principal) {
    const m = this.get<{ role: string }>(
      'SELECT role FROM members WHERE org_id=? AND user_id=?',
      p.orgId,
      p.userId,
    );
    insist(
      m &&
        !this.get('SELECT 1 FROM blocked_members WHERE org_id=? AND user_id=?', p.orgId, p.userId),
      'Organization access denied',
    );
    return m;
  }
  admin(p: Principal) {
    insist(['owner', 'admin'].includes(this.member(p).role), 'Administrator access required');
  }
  canAccess(p: Principal, c: Connection) {
    if (
      c.org_id !== p.orgId ||
      !this.get('SELECT 1 FROM members WHERE org_id=? AND user_id=?', p.orgId, p.userId)
    )
      return false;
    if (this.get('SELECT 1 FROM blocked_members WHERE org_id=? AND user_id=?', p.orgId, p.userId))
      return false;
    if (c.scope === 'personal') return c.owner_id === p.userId;
    if (c.scope === 'team')
      return !!this.get(
        'SELECT 1 FROM team_members WHERE org_id=? AND team_id=? AND user_id=?',
        p.orgId,
        c.team_id,
        p.userId,
      );
    return true;
  }
  connection(p: Principal, connectionId: string) {
    const c = this.get<Connection>(
      'SELECT * FROM connections WHERE org_id=? AND id=?',
      p.orgId,
      connectionId,
    );
    insist(c && this.canAccess(p, c), 'Connection not found', 404);
    return c;
  }
  expires(c: Connection) {
    return Math.min(c.expires_at, c.created_at + this.org(c.org_id).lease_hours * 3600_000);
  }
  live(c: Connection) {
    insist(
      c.status === 'active' && this.expires(c) > Date.now(),
      'Connection expired or revoked. Reconnect to continue.',
      403,
    );
  }
  grant(grantId: string): Grant {
    const g = this.get<Grant>('SELECT * FROM grants WHERE id=?', grantId);
    insist(
      g &&
        !g.revoked &&
        Math.min(g.expires_at, g.created_at + this.org(g.org_id).grant_hours * 3600_000) >
          Date.now(),
      'Agent access expired or revoked',
      401,
    );
    this.member({ orgId: g.org_id, userId: g.user_id });
    return g;
  }
  audit(p: Principal, event: string, entityId = '') {
    this.db.transaction(() => {
      const previous =
        this.get<{ entry_hash: string }>(
          'SELECT entry_hash FROM audit WHERE org_id=? ORDER BY seq DESC LIMIT 1',
          p.orgId,
        )?.entry_hash ?? '';
      const entry = {
        id: id(),
        org: p.orgId,
        actor: p.userId,
        event,
        entity: entityId,
        time: Date.now(),
        previous,
      };
      this.run(
        'INSERT INTO audit(id,org_id,actor_id,event,entity_id,created_at,previous_hash,entry_hash) VALUES(?,?,?,?,?,?,?,?)',
        entry.id,
        entry.org,
        entry.actor,
        event,
        entityId,
        entry.time,
        previous,
        hash(canonical(entry)),
      );
    })();
  }
  state(kind: string, payload: unknown, ttl = 600_000) {
    const token = opaque();
    this.run(
      'INSERT INTO states VALUES(?,?,?,?)',
      hash(token),
      kind,
      JSON.stringify(payload),
      Date.now() + ttl,
    );
    return token;
  }
  takeState<T>(token: string, kind: string): T {
    return this.db.transaction(() => {
      const state = this.get<{ payload: string; expires_at: number }>(
        'SELECT * FROM states WHERE id=? AND kind=?',
        hash(token),
        kind,
      );
      insist(state && state.expires_at > Date.now(), 'Request expired or already used', 400);
      this.run('DELETE FROM states WHERE id=?', hash(token));
      return JSON.parse(state.payload) as T;
    })();
  }
}
