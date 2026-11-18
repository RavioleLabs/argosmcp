import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Fault, insist, canonical } from '../foundation.js';
import {
  publicURL,
  parseTools,
  remoteToolName,
  remoteToolDefinition,
  type RemoteConfig,
  type RemoteTool,
} from '../remote-definition.js';
import type { LocalConnection } from './storage.js';

const blocked = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(ip, prefix, 'ipv4');
export const isPublicIPv4 = (ip: string) =>
  /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !blocked.check(ip, 'ipv4');

// Resolve and pin public IPv4 addresses for each connection. No proxies, redirects,
// local network access, cookies, arbitrary headers or executable stdio commands.
const headerObject = (input?: HeadersInit) => {
  const out: Record<string, string> = {};
  new Headers(input).forEach((v, k) => {
    out[k] = v;
  });
  return out;
};
export async function safeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const u = new URL(publicURL.parse(String(input)));
  const addresses = await lookup(u.hostname, { family: 4, all: true });
  insist(
    addresses.length > 0 && addresses.every((a) => isPublicIPv4(a.address)),
    'MCP endpoint must resolve only to public addresses',
    400,
  );
  init.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ended = false;
    const req = request(
      u,
      {
        method: init.method ?? 'GET',
        headers: headerObject(init.headers),
        agent: false,
        lookup: (_host, options, cb) =>
          options.all ? cb(null, [addresses[0]]) : cb(null, addresses[0].address, 4),
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers))
          if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          req.destroy();
          reject(new Fault(502, 'MCP redirects are not allowed'));
          return;
        }
        let bytes = 0;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
          cancel() {
            ended = true;
            req.destroy();
          },
        });
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2_000_000) req.destroy(new Error('Response limit'));
          else if (!ended) controller?.enqueue(new Uint8Array(chunk));
        });
        res.on('end', () => {
          if (!ended) {
            ended = true;
            controller?.close();
          }
        });
        res.on('error', () => {
          if (!ended) {
            ended = true;
            controller?.error(new Fault(502, 'MCP response interrupted'));
          }
        });
        resolve(new Response([204, 304].includes(status) ? null : stream, { status, headers }));
      },
    );
    const timeout = setTimeout(() => req.destroy(new Error('Timeout')), 30000);
    const abort = () => req.destroy(new Error('Aborted'));
    init.signal?.addEventListener('abort', abort, { once: true });
    req.on('close', () => {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abort);
    });
    req.on('error', () => {
      const error = new Fault(502, 'MCP request failed');
      reject(error);
      if (!ended) {
        ended = true;
        controller?.error(error);
      }
    });
    insist(!init.body || typeof init.body === 'string', 'Unsupported MCP request body');
    req.end(init.body || undefined);
  });
}
export async function remoteJSON(url: string, init: RequestInit) {
  const r = await safeFetch(url, init);
  if (!r.ok) {
    await r.body?.cancel();
    throw new Fault(502, 'OAuth request failed. Check the provider configuration or reconnect.');
  }
  return r.json() as Promise<any>;
}
async function withClient<T>(
  config: RemoteConfig,
  token: string,
  fn: (client: Client) => Promise<T>,
  send = safeFetch,
): Promise<T> {
  const client = new Client({ name: 'argos-personal', version: '0.1.3' });
  const endpoint = new URL(config.endpoint);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: async (url, init) => {
      insist(String(url) === endpoint.href, 'Unexpected MCP endpoint');
      return send(endpoint, {
        ...init,
        headers: {
          ...headerObject(init?.headers),
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
      });
    },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}
async function list(client: Client): Promise<RemoteTool[]> {
  const tools: RemoteTool[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 25000 });
    tools.push(
      ...result.tools.map((t) => ({
        name: t.name,
        description: (t.description ?? '').slice(0, 2000),
        inputSchema: t.inputSchema,
      })),
    );
    insist(
      tools.length <= 100,
      'This server exposes more than 100 tools. Use a scoped endpoint.',
      400,
    );
    cursor = result.nextCursor;
    insist(!cursor || !cursors.has(cursor), 'Invalid MCP pagination', 502);
    if (cursor) cursors.add(cursor);
    insist(cursors.size < 20, 'Too many MCP tool pages', 502);
  } while (cursor);
  return parseTools(tools);
}
export const discoverRemote = (config: RemoteConfig, token: string, send = safeFetch) =>
  withClient(config, token, list, send);
export async function executeRemote(
  c: LocalConnection,
  name: string,
  args: Record<string, unknown>,
  dispatch: () => Promise<void>,
  send = safeFetch,
) {
  const d = c.remote!;
  const t = d.tools.find((t) => remoteToolName(d.id, t.name) === name);
  insist(t, 'Tool not approved on this device');
  const parsed = remoteToolDefinition(d, t).schema.parse(args);
  return withClient(
    d.config,
    c.credentials.access_token,
    async (client) => {
      const current = (await list(client)).find((x) => x.name === t.name);
      insist(
        current && canonical(current) === canonical(t),
        'Provider tool changed. Ask your administrator to review it again.',
        409,
      );
      await dispatch();
      // Exactly one call, no automatic retry of writes.
      return client.callTool(
        { name: t.name, arguments: parsed.arguments as Record<string, unknown> },
        undefined,
        { timeout: 25000 },
      );
    },
    send,
  );
}
