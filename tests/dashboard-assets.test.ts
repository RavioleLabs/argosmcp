import { afterEach, expect, it, vi } from 'vitest';
import { dashboardAsset } from '../src/dashboard-assets.js';
const publisher = 'https://dashboard.example.test';
const version = '0123456789abcdef';
const environment = { ARGOS_DASHBOARD_URL: publisher };
afterEach(() => vi.unstubAllGlobals());
it('loads only public release files, switches roles, and never forwards a browser session', async () => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.headers).toEqual({
      Accept: url.endsWith('.json') ? 'application/json' : 'text/html',
    });
    expect(init.redirect).toBe('manual');
    if (url === publisher + '/manifest.json') return Response.json({ apiVersion: 1, version });
    expect(url).toBe(publisher + '/releases/' + version + '/index.html');
    return new Response('<html data-argos-dashboard="service"></html>', {
      headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'forged=1' },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const response = await dashboardAsset('/', environment);
  expect(await response.text()).toContain('data-argos-dashboard="backend"');
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('pins releases without consulting the latest manifest and blocks arbitrary proxy paths', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response('<html data-argos-dashboard="service"></html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await dashboardAsset('/', { ...environment, ARGOS_DASHBOARD_VERSION: version });
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const path of [
    '/api/session',
    '/dashboard-assets/https://internal.test/key',
    '/dashboard-assets/releases/' + version + '/assets/../../api',
    '/dashboard-assets/releases/' + version + '/assets/a.js?secret=1',
  ])
    await expect(dashboardAsset(path, environment)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('refuses redirects and type confusion from the configured publisher', async () => {
  vi.stubGlobal(
    'fetch',
    async () => new Response(null, { status: 302, headers: { Location: 'http://internal.test/' } }),
  );
  await expect(dashboardAsset('/', environment)).rejects.toThrow();
  vi.stubGlobal(
    'fetch',
    async () => new Response('<script>', { headers: { 'Content-Type': 'text/html' } }),
  );
  await expect(
    dashboardAsset('/dashboard-assets/releases/' + version + '/assets/main.js', environment),
  ).rejects.toThrow();
});
