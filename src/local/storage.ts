import Database from 'better-sqlite3';
import { Entry } from '@napi-rs/keyring';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Vault, hash, insist } from '../foundation.js';
import type { Credentials } from '../connectors.js';
export interface LocalConnection {
  id: string;
  provider: 'slack' | 'linear' | 'notion' | 'engram';
  scope?: 'personal' | 'team';
  teamId?: string;
  label: string;
  clientId: string;
  expiresAt: number;
  credentials: Credentials;
  autoRead: boolean;
  registered?: boolean;
  status: 'active' | 'revoked';
  lastRevokeAt?: number;
  oauth?: { issuer: string; token: string; revoke?: string; clientSecret?: string };
}
export interface Profile {
  id: string;
  origin: string;
  deviceId: string;
  privateKey: string;
  publicKey: string;
  label: string;
  fingerprint: string;
  pairUrl: string;
  identity?: { orgId: string; userId: string; name: string; email: string };
  connections: LocalConnection[];
}
export class LocalStorage {
  db: Database.Database;
  vault: Vault;
  constructor(directory: string, key?: Buffer) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(resolve(directory, 'connector.sqlite'));
    chmodSync(resolve(directory, 'connector.sqlite'), 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS executions(profile TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL,payload TEXT,PRIMARY KEY(profile,id));',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS memories(context TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(context,id));',
    );
    if (!key) {
      // OS credential store only. No file fallback, no explicit cloud synchronization.
      const entry = new Entry('ai.argosnode.connector', hash(resolve(directory)), {
        linux: { store: 'secret-service' },
      });
      const saved = entry.getPassword();
      insist(
        saved || !this.db.prepare('SELECT 1 FROM profiles LIMIT 1').get(),
        'Keychain key missing. Restore your keychain or reconnect in a new profile.',
        503,
      );
      if (saved) key = Buffer.from(saved, 'base64');
      else {
        key = randomBytes(32);
        entry.setPassword(key.toString('base64'));
      }
    }
    insist(key, 'OS credential key unavailable', 503);
    this.vault = new Vault({ v1: key });
  }
  all(): Profile[] {
    return (
      this.db.prepare('SELECT * FROM profiles').all() as { id: string; payload: string }[]
    ).map((r) => this.vault.open<Profile>(r.payload, 'profile:' + r.id));
  }
  get(id: string) {
    const row = this.db.prepare('SELECT payload FROM profiles WHERE id=?').get(id) as
      { payload: string } | undefined;
    insist(row, 'Profile not found', 404);
    return this.vault.open<Profile>(row.payload, 'profile:' + id);
  }
  save(p: Profile) {
    this.db
      .prepare(
        'INSERT INTO profiles VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(p.id, this.vault.seal(p, 'profile:' + p.id));
  }
  begin(profile: string, id: string, digest: string) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO executions(profile,id,digest,status) VALUES(?,?,?,'started')",
        )
        .run(profile, id, digest).changes === 1
    );
  }
  record(profile: string, id: string, value: unknown) {
    this.db
      .prepare("UPDATE executions SET status='report',payload=? WHERE profile=? AND id=?")
      .run(this.vault.seal(value, `execution:${profile}:${id}`), profile, id);
  }
  reports(profile: string) {
    return (
      this.db
        .prepare("SELECT id,payload FROM executions WHERE profile=? AND status='report'")
        .all(profile) as { id: string; payload: string }[]
    ).map((r) => ({
      id: r.id,
      value: this.vault.open<any>(r.payload, `execution:${profile}:${r.id}`),
    }));
  }
  reported(profile: string, id: string) {
    this.db
      .prepare("UPDATE executions SET status='done',payload=NULL WHERE profile=? AND id=?")
      .run(profile, id);
  }
  close() {
    this.db.close();
  }
}
