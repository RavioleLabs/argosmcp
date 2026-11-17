import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store, Vault, Fault, insist, type Connection, type Settings } from './foundation.js';

const text = z.string().min(1).max(10000),
  ref = z.string().min(1).max(100);
export const catalog = {
  slack_history: {
    provider: 'slack',
    title: 'Read channel history',
    write: false,
    schema: z
      .object({ channel: ref, limit: z.number().int().min(1).max(100).default(20) })
      .strict(),
  },
  slack_send_message: {
    provider: 'slack',
    title: 'Send a message',
    write: true,
    schema: z.object({ channel: ref, text }).strict(),
  },
  slack_delete_message: {
    provider: 'slack',
    title: 'Delete a message',
    write: true,
    schema: z.object({ channel: ref, ts: ref }).strict(),
  },
  notion_search: {
    provider: 'notion',
    title: 'Search pages',
    write: false,
    schema: z.object({ query: z.string().max(500) }).strict(),
  },
  notion_read_page: {
    provider: 'notion',
    title: 'Read a page',
    write: false,
    schema: z.object({ page_id: z.string().uuid() }).strict(),
  },
  notion_append: {
    provider: 'notion',
    title: 'Append content',
    write: true,
    schema: z.object({ page_id: z.string().uuid(), text: z.string().min(1).max(2000) }).strict(),
  },
  linear_search: {
    provider: 'linear',
    title: 'Search issues',
    write: false,
    schema: z.object({ query: text }).strict(),
  },
  linear_create_issue: {
    provider: 'linear',
    title: 'Create an issue',
    write: true,
    schema: z
      .object({
        team_id: z.string().uuid(),
        title: z.string().min(1).max(250),
        description: z.string().max(10000).default(''),
      })
      .strict(),
  },
  engram_recall: {
    provider: 'engram',
    title: 'Search this context',
    write: false,
    schema: z.object({ query: text, limit: z.number().int().min(1).max(30).default(8) }).strict(),
  },
  engram_remember: {
    provider: 'engram',
    title: 'Remember in this context',
    write: true,
    schema: z
      .object({
        content: text,
        title: z.string().max(250).optional(),
        tags: z.array(z.string().max(60)).max(20).optional(),
      })
      .strict(),
  },
  engram_forget: {
    provider: 'engram',
    title: 'Forget a memory',
    write: true,
    schema: z.object({ id: ref }).strict(),
  },
} as const;
export type ToolName = keyof typeof catalog;
export interface Credentials {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
}
export const credentialContext = (c: Connection) => `${c.org_id}:connection:${c.id}`;
export const providerConfig = {
  slack: {
    authorize: 'https://slack.com/oauth/v2/authorize',
    token: 'https://slack.com/api/oauth.v2.access',
    scope: 'channels:history,groups:history,chat:write',
    revoke: 'https://slack.com/api/auth.revoke',
  },
  notion: {
    authorize: 'https://api.notion.com/v1/oauth/authorize',
    token: 'https://api.notion.com/v1/oauth/token',
    scope: '',
    revoke: 'https://api.notion.com/v1/oauth/revoke',
  },
  linear: {
    authorize: 'https://linear.app/oauth/authorize',
    token: 'https://api.linear.app/oauth/token',
    scope: 'read,write',
    revoke: 'https://api.linear.app/oauth/revoke',
  },
} as const;
export type OAuthProvider = keyof typeof providerConfig;
// Never return raw provider error bodies: some endpoints echo credentials or request arguments.
export class OAuthExpired extends Fault {
  constructor() {
    super(401, 'Provider authorization expired. Reconnect this service.');
  }
}
export async function requestJSON(
  url: string,
  init: RequestInit = {},
  oauth = false,
): Promise<any> {
  const response = await fetch(url, {
    ...init,
    // Workers supports manual/follow only. Never forward credentials on redirects.
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Fault(502, 'Provider redirects are not allowed');
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new Fault(502, 'Provider response too large');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = Buffer.concat(chunks).toString('utf8');
  const data = body ? JSON.parse(body) : {};
  if (oauth && ['invalid_grant', 'invalid_refresh_token', 'token_revoked'].includes(data.error))
    throw new OAuthExpired();
  insist(response.ok, `Provider request failed (${response.status})`, 502);
  insist(data.ok !== false && !data.error && !data.errors, 'Provider rejected the request', 502);
  return data;
}
export class Connectors {
  private refreshing = new Map<string, Promise<Credentials>>();
  constructor(
    public store: Store,
    public vault: Vault,
    public settings: Settings,
  ) {}
  configured(provider: string) {
    return !!(
      this.settings.env[`${provider.toUpperCase()}_CLIENT_ID`] &&
      this.settings.env[`${provider.toUpperCase()}_CLIENT_SECRET`]
    );
  }
  async exchange(provider: OAuthProvider, fields: Record<string, string>): Promise<Credentials> {
    const env = this.settings.env,
      prefix = provider.toUpperCase();
    const clientId = env[`${prefix}_CLIENT_ID`]!,
      secret = env[`${prefix}_CLIENT_SECRET`]!;
    insist(clientId && secret, `${provider} OAuth is not configured`, 503);
    const headers: Record<string, string> = {};
    let body: string;
    if (provider === 'notion') {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(fields);
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams({
        ...fields,
        client_id: clientId,
        client_secret: secret,
      }).toString();
    }
    const data = await requestJSON(providerConfig[provider].token, {
      method: 'POST',
      headers,
      body,
    });
    insist(
      typeof data.access_token === 'string' && data.access_token.length > 0,
      'Missing provider token',
      502,
    );
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      scope: data.scope,
      expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined,
    };
  }
  async credentials(c: Connection): Promise<Credentials> {
    this.store.live(c);
    insist(c.secret, 'Connection has no credentials', 503);
    const creds = this.vault.open<Credentials>(c.secret, credentialContext(c));
    if (!creds.expires_at || creds.expires_at > Date.now() + 60_000) return creds;
    insist(
      creds.refresh_token && c.provider in providerConfig,
      'Provider token expired. Reconnect.',
      403,
    );
    const prior = this.refreshing.get(c.id);
    if (prior) return prior;
    const promise = (async () => {
      const refreshed = await this.exchange(c.provider as OAuthProvider, {
        grant_type: 'refresh_token',
        refresh_token: creds.refresh_token!,
      });
      if (!refreshed.refresh_token) refreshed.refresh_token = creds.refresh_token;
      // Store new rotating credentials even when revoked concurrently so the revoker uses the latest token.
      this.store.run(
        'UPDATE connections SET secret=? WHERE id=?',
        this.vault.seal(refreshed, credentialContext(c)),
        c.id,
      );
      const current = this.store.get<Connection>('SELECT * FROM connections WHERE id=?', c.id)!;
      this.store.live(current);
      return refreshed;
    })().finally(() => this.refreshing.delete(c.id));
    this.refreshing.set(c.id, promise);
    return promise;
  }
  async execute(c: Connection, tool: ToolName, args: Record<string, any>): Promise<unknown> {
    this.store.live(c);
    if (c.demo) {
      insist(this.settings.demo, 'Demo connector disabled');
      return {
        simulation: true,
        provider: c.provider,
        tool,
        context: c.label,
        message: 'Local simulation: no external service called.',
        ...(tool === 'engram_recall'
          ? {
              results: [
                {
                  title: 'Architecture ArgosMCP',
                  snippet:
                    'Personal and team access are isolated. Every call follows ArgosMCP rules.',
                  source: 'Demo example',
                },
              ],
            }
          : {}),
      };
    }
    if (c.provider === 'engram') return this.engram(c, tool, args);
    const { access_token } = await this.credentials(c);
    const current = this.store.get<Connection>('SELECT * FROM connections WHERE id=?', c.id)!;
    this.store.live(current);
    return executeProvider(c.provider, access_token, tool, args);
  }
  private async engram(c: Connection, tool: ToolName, args: Record<string, any>) {
    const target = this.settings.targets.find((t) => t.id === c.target_id);
    // A target MUST be a dedicated Engram store for one context. Never use the existing personal global store for multiple teams.
    insist(
      target &&
        target.orgId === c.org_id &&
        target.scope === c.scope &&
        target.contextId === (c.scope === 'personal' ? c.owner_id : c.team_id),
      'Engram context binding mismatch',
      403,
    );
    const secret = this.vault.open<Credentials>(c.secret!, credentialContext(c));
    const url = new URL(target.url);
    insist(
      url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)),
      'Engram requires HTTPS or a local dedicated instance',
      400,
    );
    const client = new Client({ name: 'argosmcp', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { Authorization: `Bearer ${secret.access_token}` },
        redirect: 'error',
      },
    });
    try {
      await client.connect(transport);
      const upstream = tool.replace('engram_', '');
      const result = await client.callTool(
        {
          name: upstream,
          arguments: tool === 'engram_remember' ? { ...args, scope: 'personal' } : args,
        },
        undefined,
        { timeout: 30_000 },
      );
      insist(!result.isError, 'Engram rejected the request', 502);
      return result;
    } finally {
      await client.close();
    }
  }
  revokeLocally(c: Connection) {
    this.store.run(
      "UPDATE connections SET status='revoked',revoke_status='pending' WHERE id=?",
      c.id,
    );
    this.store.run(
      "UPDATE invocations SET status='cancelled' WHERE connection_id=? AND status IN ('pending','approved')",
      c.id,
    );
  }
  async revokeUpstream(connectionId: string) {
    try {
      await this.refreshing.get(connectionId);
    } catch {
      /* latest rotating token is persisted */
    }
    const c = this.store.get<Connection>('SELECT * FROM connections WHERE id=?', connectionId)!;
    if (this.store.get('SELECT 1 FROM local_connections WHERE connection_id=?', c.id)) {
      this.store.run(
        "UPDATE connections SET revoke_status='device_pending' WHERE id=? AND revoke_status NOT IN ('confirmed','manual_required')",
        c.id,
      );
      return;
    }
    if (c.demo || c.provider === 'engram') {
      this.store.run(
        'UPDATE connections SET secret=NULL,revoke_status=? WHERE id=?',
        c.demo ? 'simulated' : 'local_only',
        c.id,
      );
      return;
    }
    if (!c.secret) return;
    try {
      const creds = this.vault.open<Credentials>(c.secret, credentialContext(c));
      const provider = c.provider as OAuthProvider;
      if (provider === 'notion') {
        const env = this.settings.env;
        await requestJSON(providerConfig.notion.revoke, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Notion-Version': '2025-09-03',
            Authorization: `Basic ${Buffer.from(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`).toString('base64')}`,
          },
          body: JSON.stringify({ token: creds.access_token }),
        });
      } else {
        await requestJSON(providerConfig[provider].revoke, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...(provider === 'slack' ? { Authorization: `Bearer ${creds.access_token}` } : {}),
          },
          body: new URLSearchParams(
            provider === 'linear'
              ? {
                  token: creds.refresh_token ?? creds.access_token,
                  token_type_hint: creds.refresh_token ? 'refresh_token' : 'access_token',
                }
              : {},
          ).toString(),
        });
      }
      this.store.run(
        "UPDATE connections SET secret=NULL,revoke_status='confirmed' WHERE id=?",
        c.id,
      );
    } catch {
      this.store.run("UPDATE connections SET revoke_status='retry_required' WHERE id=?", c.id);
    }
  }
  async sweep() {
    const rows = this.store.all<Connection>(
      "SELECT * FROM connections WHERE status='active' OR revoke_status IN ('pending','retry_required')",
    );
    for (const c of rows) {
      if (c.status === 'active' && this.store.expires(c) <= Date.now()) {
        this.revokeLocally(c);
        this.store.audit({ orgId: c.org_id, userId: 'system' }, 'connection.expired', c.id);
      } else if (c.status === 'active') continue;
      await this.revokeUpstream(c.id);
    }
    this.store.run(
      "UPDATE invocations SET status='expired' WHERE status IN ('pending','approved') AND expires_at<=?",
      Date.now(),
    );
    this.store.run('DELETE FROM states WHERE expires_at<=?', Date.now());
    this.store.run('DELETE FROM sessions WHERE expires_at<=?', Date.now());
    this.store.run('DELETE FROM tokens WHERE expires_at<=?', Date.now());
    this.store.run('DELETE FROM codes WHERE expires_at<=?', Date.now());
  }
}

export async function executeProvider(
  provider: string,
  access_token: string,
  tool: ToolName,
  args: Record<string, any>,
): Promise<unknown> {
  insist(
    Object.hasOwn(catalog, tool) && catalog[tool].provider === provider,
    'Tool/provider mismatch',
  );
  args = catalog[tool].schema.parse(args);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access_token}`,
    'Content-Type': 'application/json',
  };
  if (provider === 'slack') {
    const method = {
      slack_history: 'conversations.history',
      slack_send_message: 'chat.postMessage',
      slack_delete_message: 'chat.delete',
    }[tool as 'slack_history'];
    return requestJSON(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
  }
  if (provider === 'notion') {
    headers['Notion-Version'] = '2025-09-03';
    if (tool === 'notion_search')
      return requestJSON('https://api.notion.com/v1/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: args.query, page_size: 30 }),
      });
    const url = `https://api.notion.com/v1/blocks/${encodeURIComponent(args.page_id)}/children`;
    return requestJSON(url, {
      method: tool === 'notion_append' ? 'PATCH' : 'GET',
      headers,
      ...(tool === 'notion_append'
        ? {
            body: JSON.stringify({
              children: [
                {
                  object: 'block',
                  type: 'paragraph',
                  paragraph: { rich_text: [{ type: 'text', text: { content: args.text } }] },
                },
              ],
            }),
          }
        : {}),
    });
  }
  if (provider === 'linear') {
    const query =
      tool === 'linear_search'
        ? 'query Search($query:String!){searchIssues(term:$query,first:30){nodes{id identifier title url}}}'
        : 'mutation Create($input:IssueCreateInput!){issueCreate(input:$input){success issue{id identifier title url}}}';
    const variables =
      tool === 'linear_search'
        ? { query: args.query }
        : { input: { teamId: args.team_id, title: args.title, description: args.description } };
    return requestJSON('https://api.linear.app/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });
  }
  throw new Fault(400, 'Unknown provider');
}
