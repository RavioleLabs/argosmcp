import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Entry } from '@napi-rs/keyring';
import { LocalStorage } from '../dist/local/storage.js';
import { hash } from '../dist/foundation.js';

// Run only against a fresh temporary test profile. Never read the user's app profile.
if (process.argv[2] === '--missing-key') {
  try {
    const storage = new LocalStorage(process.argv[3]);
    storage.close();
    process.exitCode = 1;
  } catch (error) {
    process.exitCode =
      error instanceof Error && error.message.includes('Keychain key missing') ? 0 : 2;
  }
} else {
  assert.equal(
    process.platform,
    'win32',
    'This integration check targets Windows Credential Manager.',
  );
  const directory = mkdtempSync(join(tmpdir(), 'argos-credential-ci-'));
  const entry = new Entry('ai.argosnode.connector', hash(resolve(directory)));
  let storage;
  try {
    assert.equal(entry.getPassword(), null);
    storage = new LocalStorage(directory);
    const key = entry.getPassword();
    assert.ok(key && Buffer.from(key, 'base64').length === 32);
    const token = randomBytes(32).toString('base64url');
    const profile = {
      id: randomUUID(),
      origin: 'https://workspace.example.test',
      deviceId: randomUUID(),
      privateKey: 'test-only-device-key',
      publicKey: 'test-only-public-key',
      label: 'CI device',
      fingerprint: 'test-only-fingerprint',
      pairUrl: 'https://workspace.example.test/',
      connections: [
        {
          id: randomUUID(),
          provider: 'slack',
          scope: 'personal',
          label: 'CI fixture',
          clientId: 'fixture',
          expiresAt: Date.now() + 60000,
          credentials: { access_token: token },
          autoRead: false,
          status: 'active',
        },
      ],
    };
    storage.save(profile);
    const row = storage.db.prepare('SELECT payload FROM profiles WHERE id=?').get(profile.id);
    assert.ok(!row.payload.includes(token), 'Provider token must not be stored in plaintext.');
    storage.close();
    storage = undefined;
    storage = new LocalStorage(directory);
    assert.equal(storage.get(profile.id).connections[0].credentials.access_token, token);
    assert.equal(entry.getPassword(), key, 'Reopening must reuse the OS-protected key.');
    storage.close();
    storage = undefined;
    assert.equal(entry.deleteCredential(), true);
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--missing-key', directory],
      { stdio: 'pipe' },
    );
    assert.equal(child.status, 0, 'A missing OS key must prevent reopening an encrypted profile.');
    assert.equal(entry.getPassword(), null, 'A lost key must not be silently replaced.');
    console.log(
      'Windows Credential Manager: create, encrypted persistence, reopen and missing-key refusal passed.',
    );
  } finally {
    storage?.close();
    entry.deleteCredential();
    rmSync(directory, { recursive: true, force: true });
  }
}
