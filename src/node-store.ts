import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Store as BaseStore } from './foundation.js';
export class Store extends BaseStore {
  constructor(filename = ':memory:') {
    if (filename !== ':memory:')
      mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
    const db = new Database(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    super(db);
  }
}
