import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { Store, hash, opaque } from '../../src/foundation.js';
import { DurableDatabase } from '../../cloudflare/worker.js';

it('reserves hosted workspace creation for its designated owner and only once', async () => {
  const origin = 'https://beta.example.test';
  const company = '00000000-0000-4000-8000-000000000102';
  const outsiderToken = opaque(),
    ownerToken = opaque();
  await runInDurableObject(env.WORKSPACES.getByName(company), (_instance, state) => {
    const store = new Store(new DurableDatabase(state.storage));
    for (const [user, email, token] of [
      ['outsider', 'other@beta.test', outsiderToken],
      ['owner', 'owner@beta.test', ownerToken],
    ]) {
      store.run('INSERT INTO users VALUES(?,?,?,?)', user, 'google-' + user, email, user);
      store.run('INSERT INTO sessions VALUES(?,?,?)', hash(token), user, Date.now() + 60000);
    }
  });
  const session = async (token: string) =>
    (
      await exports.default.fetch(origin + '/api/session', {
        headers: { Cookie: 'argos_session=' + token },
      })
    ).json();
  const create = (token: string, requestOrigin = origin, body = { name: 'Beta company' }) =>
    exports.default.fetch(origin + '/api/organizations', {
      method: 'POST',
      headers: {
        Cookie: 'argos_session=' + token,
        Origin: requestOrigin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  expect(await session(outsiderToken)).toMatchObject({
    canCreateWorkspace: false,
    organizations: [],
    user: { email: 'other@beta.test' },
  });
  expect(await session(ownerToken)).toMatchObject({ canCreateWorkspace: true, organizations: [] });
  const denied = await create(outsiderToken);
  expect(denied.status).toBe(403);
  await denied.text();
  const unauthenticated = await create('unknown');
  expect(unauthenticated.status).toBe(401);
  await unauthenticated.text();
  const crossSite = await create(ownerToken, 'https://untrusted.test');
  expect(crossSite.status).toBe(403);
  await crossSite.text();
  expect(await session(ownerToken)).toMatchObject({ canCreateWorkspace: true, organizations: [] });
  const created = await create(ownerToken);
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({ id: company });
  const duplicate = await create(ownerToken);
  expect(duplicate.status).toBe(409);
  await duplicate.text();
  expect(await session(ownerToken)).toMatchObject({
    canCreateWorkspace: false,
    organizations: [{ name: 'Beta company', role: 'owner' }],
  });
  expect(await session(outsiderToken)).toMatchObject({
    canCreateWorkspace: false,
    organizations: [],
  });
  const crossTenant = await exports.default.fetch('https://alpha.example.test/api/organizations', {
    method: 'POST',
    headers: {
      Cookie: 'argos_session=' + ownerToken,
      Origin: 'https://alpha.example.test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Take over' }),
  });
  expect(crossTenant.status).toBe(401);
  await crossTenant.text();
});
