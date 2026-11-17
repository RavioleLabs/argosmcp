import { expect, it } from 'vitest';
import { setupProgress, workspacePage } from '../web/onboarding';

const now = 10000000;
const data = () => ({
  org: { grant_hours: 1 },
  devices: [
    {
      user_id: 'me',
      status: 'active',
      expires_at: now + 5000000,
      created_at: now - 1000,
      last_seen: now,
    },
  ],
  connections: [
    {
      id: 'c',
      ownerId: 'me',
      local: true,
      demo: false,
      status: 'active',
      expiresAt: now + 1000000,
    },
  ],
  grants: [{ userId: 'me', revoked: false, expiresAt: now + 1000000, connections: ['c'] }],
});
it('keeps company scope when navigating or clearing pairing parameters', () => {
  const prefix = '/w/00000000-0000-4000-8000-000000000001';
  expect(workspacePage(prefix, 'setup')).toBe(prefix + '/?view=setup');
  expect(workspacePage(prefix)).toBe(prefix + '/');
  expect(workspacePage('', 'agents')).toBe('/?view=agents');
});
it('uses only the current user’s live device, personal connection and grant', () => {
  expect(setupProgress(data(), 'me', now)).toEqual({
    paired: true,
    online: true,
    connected: true,
    authorized: true,
  });
  expect(setupProgress(data(), 'other', now)).toEqual({
    paired: false,
    online: false,
    connected: false,
    authorized: false,
  });
  const sample = data();
  sample.grants[0].connections = ['unrelated'];
  expect(setupProgress(sample, 'me', now).authorized).toBe(false);
  sample.connections[0].demo = true;
  expect(setupProgress(sample, 'me', now).connected).toBe(false);
});
it('does not report setup complete after revocation, expiry or a shorter company lifetime', () => {
  const sample = data();
  sample.devices[0].created_at = now - 3600001;
  expect(setupProgress(sample, 'me', now).paired).toBe(false);
  sample.devices[0].created_at = now;
  sample.grants[0].revoked = true;
  expect(setupProgress(sample, 'me', now).authorized).toBe(false);
  sample.connections[0].expiresAt = now;
  expect(setupProgress(sample, 'me', now).connected).toBe(false);
  sample.devices[0].status = 'revoked';
  expect(setupProgress(sample, 'me', now).paired).toBe(false);
});
it('distinguishes pairing from a recently online connector', () => {
  const sample = data();
  sample.devices[0].last_seen = now - 90001;
  expect(setupProgress(sample, 'me', now)).toMatchObject({ paired: true, online: false });
});
