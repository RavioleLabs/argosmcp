import { publicURL } from '../src/remote-definition.js';
import { Fault, insist } from '../src/foundation.js';

// This Worker requires global_fetch_strictly_public. No service bindings,
// arbitrary proxy headers, redirects or private-network fetch override here.
export async function cloudflareRemoteFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = publicURL.parse(String(input));
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.any([AbortSignal.timeout(30000), ...(init.signal ? [init.signal] : [])]),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Fault(502, 'MCP redirects are not allowed');
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) return controller.close();
        bytes += next.value.byteLength;
        insist(bytes <= 2_000_000, 'MCP response exceeds the size limit', 502);
        controller.enqueue(next.value);
      } catch {
        await reader.cancel().catch(() => {});
        controller.error(new Fault(502, 'MCP response interrupted or too large'));
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}
