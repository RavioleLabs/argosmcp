import { executeRemote, remoteJSON } from './remote-mcp.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  catalog,
  executeProvider,
  requestJSON,
  providerConfig,
  OAuthExpired,
  type Credentials,
  type ToolName,
} from '../connectors.js';
import { opaque, insist } from '../foundation.js';
import type { LocalConnection } from './storage.js';

export interface OAuthAttempt {
  clientName?: string;
  profileId: string;
  provider: LocalConnection['provider'];
  connectionId: string;
  label: string;
  clientId: string;
  state: string;
  verifier: string;
  redirect: string;
  expiresAt: number;
  oauth?: LocalConnection['oauth'];
  remote?: LocalConnection['remote'];
}
export const challenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');
const notionEndpoint = (value: string) => {
  const u = new URL(value);
  insist(
    u.origin === 'https://mcp.notion.com' && !u.username && !u.password && !u.hash,
    'Unexpected Notion OAuth endpoint',
    502,
  );
  return u.href;
};
export async function authorizeURL(a: OAuthAttempt) {
  const params = new URLSearchParams({
    client_id: a.clientId,
    response_type: 'code',
    redirect_uri: a.redirect,
    state: a.state,
    code_challenge: challenge(a.verifier),
    code_challenge_method: 'S256',
  });
  if (a.provider === 'mcp') {
    const o = a.remote?.config.oauth;
    insist(o, 'Missing OAuth configuration', 400);
    params.set('client_id', o.clientId);
    params.set(
      'scope',
      a.remote?.config.endpoint === 'https://mcp.slack.com/mcp'
        ? o.scope
            .split(/[,\s]+/)
            .filter(Boolean)
            .join(',')
        : o.scope,
    );
    if (o.resource) params.set('resource', o.resource);
    return o.authorize + '?' + params;
  }
  if (a.provider === 'notion') {
    const meta = await requestJSON('https://mcp.notion.com/.well-known/oauth-authorization-server');
    insist(
      meta.issuer === 'https://mcp.notion.com' &&
        meta.code_challenge_methods_supported?.includes('S256'),
      'Notion must support PKCE',
      502,
    );
    const registered = await requestJSON(notionEndpoint(meta.registration_endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: a.clientName ?? 'Argos Personal Connector',
        redirect_uris: [a.redirect],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    a.clientId = z.string().min(1).parse(registered.client_id);
    a.oauth = {
      issuer: meta.issuer,
      token: notionEndpoint(meta.token_endpoint),
      revoke: meta.revocation_endpoint ? notionEndpoint(meta.revocation_endpoint) : undefined,
      ...(registered.client_secret
        ? { clientSecret: z.string().parse(registered.client_secret) }
        : {}),
    };
    params.set('client_id', a.clientId);
    params.set('resource', 'https://mcp.notion.com/mcp');
    params.set('scope', 'default');
    return notionEndpoint(meta.authorization_endpoint) + '?' + params;
  }
  insist(a.clientId.length > 0, 'Enter the public OAuth client ID for this provider', 400);
  if (a.provider === 'slack') {
    params.set('scope', '');
    params.set('user_scope', 'channels:history,groups:history,chat:write');
  } else params.set('scope', 'read,write');
  return providerConfig[a.provider].authorize + '?' + params;
}
export async function exchange(
  a: Pick<OAuthAttempt, 'provider' | 'clientId' | 'oauth' | 'remote'>,
  fields: Record<string, string>,
): Promise<Credentials> {
  const body: Record<string, string> = { ...fields, client_id: a.clientId };
  if (a.provider === 'mcp') {
    const o = a.remote?.config.oauth;
    insist(o, 'Missing OAuth configuration', 400);
    body.client_id = o.clientId;
    if (o.resource) body.resource = o.resource;
    const data = await remoteJSON(o.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    insist(
      !data.error && data.ok !== false,
      'Provider rejected OAuth. Check the Slack app approval, PKCE setting and callback URL.',
      502,
    );
    return {
      access_token: z.string().min(1).max(16000).parse(data.access_token),
      refresh_token: z.string().max(16000).optional().parse(data.refresh_token),
      expires_at:
        data.expires_in === undefined
          ? undefined
          : Date.now() + z.coerce.number().positive().finite().parse(data.expires_in) * 1000,
    };
  }
  if (a.provider === 'notion') {
    body.resource = 'https://mcp.notion.com/mcp';
    if (a.oauth?.clientSecret) body.client_secret = a.oauth.clientSecret;
  }
  const endpoint =
    a.provider === 'notion' ? notionEndpoint(a.oauth!.token) : providerConfig[a.provider].token;
  const response = await requestJSON(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    },
    true,
  );
  // Slack desktop OAuth authorizes the user's account; never fall back to a bot token.
  const data =
    a.provider === 'slack' && fields.grant_type === 'authorization_code'
      ? response.authed_user
      : response;
  insist(
    data && typeof data.access_token === 'string' && data.access_token.length > 0,
    'Provider did not return a user token',
    502,
  );
  const expires = data.expires_in === undefined ? undefined : Number(data.expires_in);
  insist(
    expires === undefined || (Number.isFinite(expires) && expires > 0),
    'Invalid token expiry',
    502,
  );
  return {
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expires_at: expires ? Date.now() + expires * 1000 : undefined,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
  };
}
export async function refresh(c: LocalConnection) {
  insist(
    c.provider === 'mcp' || Object.hasOwn(providerConfig, c.provider),
    'Provider no longer supported',
    410,
  );
  if (!c.credentials.expires_at || c.credentials.expires_at > Date.now() + 60000) return;
  if (!c.credentials.refresh_token) throw new OAuthExpired();
  const previous = c.credentials.refresh_token;
  const next = await exchange(
    { ...c, provider: c.provider },
    { grant_type: 'refresh_token', refresh_token: previous },
  );
  c.credentials = { ...next, refresh_token: next.refresh_token ?? previous };
}
export async function revoke(c: LocalConnection): Promise<'confirmed' | 'manual_required'> {
  try {
    if (!Object.hasOwn(providerConfig, c.provider)) return 'manual_required';
    if (c.provider === 'slack') {
      for (const token of [c.credentials.refresh_token, c.credentials.access_token].filter(
        Boolean,
      )) {
        const r = await fetch(providerConfig.slack.revoke, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
        });
        insist(r.ok, 'Revocation failed');
        const data = (await r.json()) as any;
        insist(
          data.ok || ['token_revoked', 'invalid_auth'].includes(data.error),
          'Revocation failed',
        );
      }
    } else {
      const endpoint = c.provider === 'notion' ? c.oauth?.revoke : providerConfig.linear.revoke;
      insist(endpoint, 'Revoke this connection in the provider settings');
      const fields: Record<string, string> = {
        token: c.credentials.refresh_token ?? c.credentials.access_token,
        token_type_hint: c.credentials.refresh_token ? 'refresh_token' : 'access_token',
        client_id: c.clientId,
      };
      if (c.oauth?.clientSecret) fields.client_secret = c.oauth.clientSecret;
      await requestJSON(c.provider === 'notion' ? notionEndpoint(endpoint) : endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
    }
    return 'confirmed';
  } catch {
    return 'manual_required';
  }
}
export async function executeLocal(
  c: LocalConnection,
  tool: string,
  args: Record<string, unknown>,
  beforeDispatch: () => Promise<void>,
) {
  insist(c.status === 'active' && c.expiresAt > Date.now(), 'Local connection expired');
  if (c.provider === 'mcp') return executeRemote(c, tool, args, beforeDispatch);
  const builtinTool = tool as ToolName;
  insist(
    Object.hasOwn(catalog, tool) && catalog[builtinTool].provider === c.provider,
    'Wrong connection for tool',
  );
  const parsed = catalog[builtinTool].schema.parse(args);
  if (c.provider !== 'notion') {
    await beforeDispatch();
    return executeProvider(c.provider, c.credentials.access_token, builtinTool, parsed);
  }
  const client = new Client({ name: 'argos-personal', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.notion.com/mcp'), {
    requestInit: {
      headers: { Authorization: 'Bearer ' + c.credentials.access_token },
      redirect: 'manual',
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
    const a = parsed as Record<string, unknown>;
    const request =
      tool === 'notion_search'
        ? { name: 'notion-search', arguments: { query: a.query, query_type: 'internal' } }
        : tool === 'notion_read_page'
          ? { name: 'notion-fetch', arguments: { id: a.page_id } }
          : {
              name: 'notion-update-page',
              arguments: {
                page_id: a.page_id,
                command: 'insert_content',
                content: a.text,
                position: { type: 'end' },
                allow_async: false,
              },
            };
    await beforeDispatch();
    const result = await client.callTool(request, undefined, { timeout: 25000 });
    insist(!result.isError, 'Notion rejected this action', 502);
    return result;
  } finally {
    await client.close();
  }
}
export function redactResult(value: unknown, secrets: string[]): unknown {
  const redact = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let s = v;
      for (const secret of secrets.filter((s) => s.length > 8))
        s = s.split(secret).join('[redacted]');
      return s;
    }
    if (Array.isArray(v)) return v.map(redact);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          /^(access_token|refresh_token|client_secret|authorization)$/i.test(k)
            ? '[redacted]'
            : redact(x),
        ]),
      );
    return v;
  };
  return redact(value);
}
export const newAttempt = (
  profileId: string,
  provider: OAuthAttempt['provider'],
  connectionId: string,
  label: string,
  clientId: string,
  redirect: string,
): OAuthAttempt => ({
  profileId,
  provider,
  connectionId,
  label,
  clientId,
  redirect,
  state: opaque(),
  verifier: opaque(),
  expiresAt: Date.now() + 600000,
});
