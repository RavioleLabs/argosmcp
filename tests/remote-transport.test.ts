import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { safeFetch } from '../src/local/remote-mcp.js';
afterEach(() => vi.resetAllMocks());
it('aborts during stalled DNS without opening a socket, even if DNS later resolves', async () => {
  let resolve!: (value: unknown) => void;
  mocks.lookup.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const controller = new AbortController();
  const promise = safeFetch('https://mcp.example.com/mcp', { signal: controller.signal });
  controller.abort();
  await expect(promise).rejects.toThrow('name resolution interrupted');
  resolve([{ address: '1.1.1.1', family: 4 }]);
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.request).not.toHaveBeenCalled();
});
it('rejects private and mixed public/private DNS answers before sending credentials', async () => {
  for (const addresses of [['169.254.169.254'], ['1.1.1.1', '127.0.0.1'], ['10.0.0.1']]) {
    mocks.lookup.mockResolvedValue(addresses.map((address) => ({ address, family: 4 })));
    await expect(
      safeFetch('https://mcp.example.com/mcp', {
        headers: { Authorization: 'Bearer fake-test-value' },
      }),
    ).rejects.toThrow('public addresses');
  }
  expect(mocks.request).not.toHaveBeenCalled();
});
