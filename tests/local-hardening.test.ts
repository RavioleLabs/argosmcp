import { afterEach, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, chmodSync, statSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalApp } from '../src/local/app.js';
import { LocalStorage } from '../src/local/storage.js';
import type { LocalRuntime } from '../src/local/runtime.js';

let server: Server | undefined;
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function fixture() {
  const state = vi.fn(() => []);
  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const local = createLocalApp({ state } as unknown as LocalRuntime, origin, '/nonexistent');
  server.on('request', local.app);
  const key = new URLSearchParams(new URL(local.url).hash.slice(1)).get('key');
  const login = () =>
    fetch(origin + '/session', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
  return { origin, login, state };
}
it('consumes the launch capability once, including concurrent replay', async () => {
  const { login } = await fixture();
  const replies = await Promise.all([login(), login()]);
  expect(replies.map((r) => r.status).sort()).toEqual([200, 401]);
  await Promise.all(replies.map((r) => r.text()));
});
it('expires an unused launch capability after one minute', async () => {
  const { login } = await fixture();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
  const r = await login();
  expect(r.status).toBe(401);
  await r.text();
});
it('expires stolen local session cookies after the absolute lifetime', async () => {
  const { origin, login, state } = await fixture();
  const r = await login();
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  expect(r.headers.get('set-cookie')).toContain('HttpOnly');
  expect(r.headers.get('set-cookie')).toContain('SameSite=Strict');
  await r.text();
  const read = () => fetch(origin + '/api/state', { headers: { Cookie: cookie } });
  const valid = await read();
  expect(valid.status).toBe(200);
  await valid.text();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 12 * 3600_000 + 1);
  const expired = await read();
  expect(expired.status).toBe(401);
  await expired.text();
  expect(state).toHaveBeenCalledTimes(1);
});
it('rejects DNS rebinding and cross-origin approval attempts even with a session cookie', async () => {
  const { origin, login } = await fixture();
  const r = await login();
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  await r.text();
  // fetch rewrites Host; use a raw HTTP request to send the attack as intended.
  const rebinding = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      origin + '/api/state',
      { headers: { Host: 'attacker.example', Cookie: cookie } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(rebinding).toBe(403);
  const csrf = await fetch(origin + '/api/decide', {
    method: 'POST',
    headers: {
      Origin: 'https://attacker.example',
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  expect(csrf.status).toBe(403);
  await csrf.text();
});
it.skipIf(process.platform === 'win32')(
  'repairs an existing world-readable credential directory',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'argos-permissions-'));
    dirs.push(dir);
    chmodSync(dir, 0o755);
    const storage = new LocalStorage(dir, randomBytes(32));
    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'connector.sqlite')).mode & 0o777).toBe(0o600);
    } finally {
      storage.close();
    }
  },
);
it.skipIf(process.platform === 'win32')(
  'refuses a symlinked credential database before opening it',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'argos-symlink-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'target'), 'unrelated file');
    symlinkSync(join(dir, 'target'), join(dir, 'connector.sqlite'));
    expect(() => new LocalStorage(dir, randomBytes(32))).toThrow('Unsafe credential database');
  },
);
