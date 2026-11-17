import { exports } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { requestJSON } from '../../src/connectors.js';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

it('completes Google PKCE sign-in and isolates the owner session', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'google-test-key', alg: 'RS256', use: 'sig' };
  const origin = 'https://alpha.example.test';
  const start = await exports.default.fetch(origin + '/auth/google', { redirect: 'manual' });
  expect(start.status, start.status !== 302 ? await start.text() : '').toBe(302);
  const authorize = new URL(start.headers.get('location')!);
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  await start.text();
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  const token = await new SignJWT({
    nonce: authorize.searchParams.get('nonce'),
    email: 'owner@alpha.test',
    email_verified: true,
    name: 'Owner',
  })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer('https://accounts.google.com')
    .setAudience('google-test-client')
    .setSubject('google-login-owner')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('code_verifier')).toBeTruthy();
      expect(body.get('redirect_uri')).toBe(origin + '/auth/google/callback');
      return Response.json({ id_token: token });
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    throw new Error('Unexpected external request in Google login test');
  });
  try {
    const callback = await exports.default.fetch(
      origin + '/auth/google/callback?code=test-code&state=' + authorize.searchParams.get('state'),
      { redirect: 'manual', headers: { Cookie: cookie } },
    );
    const result = await callback.text();
    expect(result).not.toContain('google-test-secret');
    expect(callback.status, result).toBe(302);
    const sessionCookie = callback.headers.get('set-cookie')!.split(';')[0];
    const session = await exports.default.fetch(origin + '/api/session', {
      headers: { Cookie: sessionCookie },
    });
    expect(await session.json()).toMatchObject({
      user: { email: 'owner@alpha.test' },
      organizations: [],
      canCreateWorkspace: true,
      workspaceName: 'Alpha',
    });
    const created = await exports.default.fetch(origin + '/api/organizations', {
      method: 'POST',
      headers: { Cookie: sessionCookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha team' }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: '00000000-0000-4000-8000-000000000101' });
    const afterCreate = await exports.default.fetch(origin + '/api/session', {
      headers: { Cookie: sessionCookie },
    });
    expect(await afterCreate.json()).toMatchObject({
      canCreateWorkspace: false,
      organizations: [{ name: 'Alpha team', role: 'owner' }],
    });
    const other = await exports.default.fetch('https://beta.example.test/api/session', {
      headers: { Cookie: sessionCookie },
    });
    expect((await other.json()).user).toBeNull();
  } finally {
    mock.mockRestore();
  }
});

it.each([301, 302, 303, 307, 308])(
  'rejects provider redirect %i without forwarding credentials',
  async (status) => {
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.redirect).toBe('manual');
      return new Response('private-provider-body', {
        status,
        headers: { Location: 'https://untrusted.example.test/' },
      });
    });
    try {
      await expect(
        requestJSON('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { Authorization: 'Bearer fixture-secret' },
          body: 'fixture-body',
          redirect: 'follow',
        }),
      ).rejects.toThrow('Provider redirects are not allowed');
      expect(mock).toHaveBeenCalledTimes(1);
    } finally {
      mock.mockRestore();
    }
  },
);
