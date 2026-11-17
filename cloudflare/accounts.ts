import { DurableObject } from 'cloudflare:workers';
import { hash, id, insist } from '../src/foundation.js';
import type { Env } from './worker.js';

export interface Identity {
  origin: string;
  sub: string;
  email: string;
  name: string;
}
export interface WorkspaceBinding {
  id: string;
  origin: string;
  basePath: string;
  name: string;
  ownerEmail: string;
  ownerSub: string;
}
export interface WorkspaceSummary {
  id: string;
  name: string;
  url: string;
  role: string;
}
export const accountKey = (identity: Identity) => hash(identity.origin + '\n' + identity.sub);

// A private directory per Google identity and platform origin. Entries are navigation hints,
// never authorization: the company rechecks current membership before returning any details.
export class AccountDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, request_key TEXT UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);`,
    );
  }
  private bind(identity: Identity) {
    const key = accountKey(identity);
    const bound = this.ctx.storage.kv.get<string>('identity');
    insist(!bound || bound === key, 'Account routing mismatch', 403);
    if (!bound) this.ctx.storage.kv.put('identity', key);
  }
  async create(identity: Identity, name: string, requestKey: string) {
    this.bind(identity);
    const intent = this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ id: string; name: string }>(
          'SELECT id,name FROM entries WHERE request_key=?',
          requestKey,
        )
        .toArray()[0];
      if (existing)
        return existing.name === name
          ? existing
          : { error: 'This creation request was already used with a different name.', status: 409 };
      const count = this.ctx.storage.sql
        .exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM entries WHERE request_key IS NOT NULL',
        )
        .one().count;
      if (count >= 20)
        return { error: 'Your account has reached the limit of 20 workspaces.', status: 429 };
      const workspaceId = id();
      this.ctx.storage.sql.exec(
        'INSERT INTO entries VALUES(?,?,?,?)',
        workspaceId,
        requestKey,
        name,
        Date.now(),
      );
      return { id: workspaceId, name };
    });
    if ('error' in intent) return intent;
    // Durable intent makes retries resume provisioning, never create a duplicate company.
    await this.env.WORKSPACES.getByName(intent.id).provision(identity, intent.id, intent.name);
    return { id: intent.id, name: intent.name, url: identity.origin + '/w/' + intent.id };
  }
  async remember(identity: Identity, workspaceId: string) {
    this.bind(identity);
    const summary = await this.env.WORKSPACES.getByName(workspaceId).membership(identity);
    if (!summary) return;
    const count = this.ctx.storage.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM entries')
      .one().count;
    insist(
      count < 200 ||
        this.ctx.storage.sql.exec('SELECT 1 FROM entries WHERE id=?', workspaceId).toArray().length,
      'Workspace directory limit reached',
      429,
    );
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO entries VALUES(?,NULL,?,?)',
      workspaceId,
      summary.name,
      Date.now(),
    );
  }
  async list(identity: Identity): Promise<WorkspaceSummary[]> {
    this.bind(identity);
    const entries = this.ctx.storage.sql
      .exec<{ id: string }>('SELECT id FROM entries ORDER BY created_at DESC LIMIT 200')
      .toArray();
    const result: WorkspaceSummary[] = [];
    // Bound fan-out; do not turn a directory entry into a membership grant.
    for (let i = 0; i < entries.length; i += 10) {
      const batch = await Promise.all(
        entries
          .slice(i, i + 10)
          .map((entry) => this.env.WORKSPACES.getByName(entry.id).membership(identity)),
      );
      result.push(...batch.filter((entry) => entry !== null));
    }
    return result;
  }
}
