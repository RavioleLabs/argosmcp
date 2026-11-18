import { expect, it, afterEach, vi } from 'vitest';
import { cloudflareRemoteFetch } from '../../cloudflare/remote-fetch.js';
afterEach(() => vi.unstubAllGlobals());
it('uses public HTTPS destinations, rejects redirects and limits streamed upstream data', async () => {
  const send = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } }),
  );
  vi.stubGlobal('fetch', send);
  await expect(cloudflareRemoteFetch('http://localhost/mcp')).rejects.toThrow();
  await expect(cloudflareRemoteFetch('https://127.0.0.1/mcp')).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  await expect(cloudflareRemoteFetch('https://mcp.example.com/mcp')).rejects.toThrow('redirects');
  expect(send.mock.calls[0][1].redirect).toBe('manual');
  vi.stubGlobal('fetch', async () => new Response('x'.repeat(2_000_001)));
  const oversized = await cloudflareRemoteFetch('https://mcp.example.com/mcp');
  await expect(oversized.text()).rejects.toThrow();
  vi.stubGlobal('fetch', async () => Response.json({ ok: true }));
  expect(await (await cloudflareRemoteFetch('https://mcp.example.com/mcp')).json()).toEqual({
    ok: true,
  });
});
