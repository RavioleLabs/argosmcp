import { createHash } from 'node:crypto';
import type { Request, Response, Express } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import {
  InvalidGrantError,
  InvalidTokenError,
  InvalidClientMetadataError,
  InvalidRequestError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  Store,
  insist,
  hash,
  opaque,
  id,
  DAY,
  type Settings,
  type Principal,
  type Grant,
} from './foundation.js';
import { requestJSON } from './connectors.js';

export const cookies = (req: Request) =>
  Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .filter((s) => s.includes('='))
      .map((s) => {
        const i = s.indexOf('=');
        return [s.slice(0, i).trim(), s.slice(i + 1)];
      }),
  );
export class Auth implements OAuthServerProvider {
  readonly audience: string;
  readonly clientsStore;
  constructor(
    public store: Store,
    public settings: Settings,
  ) {
    this.audience = settings.origin + '/mcp';
    this.clientsStore = {
      getClient: (clientId: string) => {
        const r = store.get<{ payload: string }>(
          'SELECT payload FROM clients WHERE id=?',
          clientId,
        );
        return r ? (JSON.parse(r.payload) as OAuthClientInformationFull) : undefined;
      },
      registerClient: (
        client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
      ) => {
        if (client.token_endpoint_auth_method && client.token_endpoint_auth_method !== 'none')
          throw new InvalidClientMetadataError('Only public clients with PKCE are supported');
        if (!client.redirect_uris.length || client.redirect_uris.length > 10)
          throw new InvalidClientMetadataError('Invalid redirect URI list');
        for (const uri of client.redirect_uris) {
          const u = new URL(uri);
          if (
            u.hash ||
            u.username ||
            u.password ||
            !(
              u.protocol === 'https:' ||
              (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
            )
          )
            throw new InvalidClientMetadataError('Use HTTPS or a loopback redirect');
        }
        const full = {
          ...client,
          token_endpoint_auth_method: 'none' as const,
          client_id: id(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        delete full.client_secret;
        store.run('INSERT INTO clients VALUES(?,?)', full.client_id, JSON.stringify(full));
        return full;
      },
    };
  }
  resources() {
    return [
      this.audience,
      ...['slack', 'notion', 'linear', 'engram'].map((p) => this.audience + '/' + p),
    ];
  }
  grantResource(grantId: string) {
    return (
      this.store.get<{ resource: string }>(
        'SELECT resource FROM grant_resources WHERE grant_id=?',
        grantId,
      )?.resource ?? this.audience
    );
  }
  session(req: Request): string | undefined {
    const cookie = cookies(req).argos_session;
    if (!cookie) return;
    return this.store.get<{ user_id: string }>(
      'SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?',
      hash(cookie),
      Date.now(),
    )?.user_id;
  }
  user(req: Request): string {
    const user = this.session(req);
    insist(user, 'Sign in required', 401);
    return user;
  }
  principal(req: Request): Principal {
    const p = { userId: this.user(req), orgId: String(req.params.orgId ?? '') };
    this.store.member(p);
    return p;
  }
  issueSession(res: Response, userId: string) {
    const token = opaque();
    this.store.run('INSERT INTO sessions VALUES(?,?,?)', hash(token), userId, Date.now() + DAY);
    res.cookie('argos_session', token, {
      httpOnly: true,
      secure: this.settings.origin.startsWith('https:'),
      sameSite: 'lax',
      path: '/',
      maxAge: DAY,
    });
  }
  createOrg(userId: string, name: string) {
    const orgId = this.settings.tenant?.id ?? id();
    if (this.settings.tenant) {
      const user = this.store.get<{ email: string }>('SELECT email FROM users WHERE id=?', userId);
      insist(
        user?.email.toLowerCase() === this.settings.tenant.ownerEmail.toLowerCase(),
        'Only the designated owner may initialize this workspace',
      );
    }
    this.store.db.transaction(() => {
      if (this.settings.tenant)
        insist(
          !this.store.get('SELECT 1 FROM organizations'),
          'This workspace has already been created',
          409,
        );
      this.store.run('INSERT INTO organizations(id,name) VALUES(?,?)', orgId, name);
      this.store.run('INSERT INTO members VALUES(?,?,?)', orgId, userId, 'owner');
      this.store.audit({ orgId, userId }, 'organization.created', orgId);
    })();
    return orgId;
  }
  mount(app: Express) {
    app.get('/auth/google', (req, res) => {
      const env = this.settings.env;
      insist(
        env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET,
        'Google OAuth is not configured yet',
        503,
      );
      const verifier = opaque(),
        nonce = opaque(),
        binding = opaque();
      const state = this.store.state('google', { verifier, nonce, binding: hash(binding) });
      res.cookie('argos_login', binding, {
        httpOnly: true,
        secure: this.settings.origin.startsWith('https:'),
        sameSite: 'lax',
        maxAge: 600_000,
        path: '/auth/google',
      });
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: this.settings.origin + '/auth/google/callback',
        response_type: 'code',
        scope: 'openid email profile',
        prompt: 'select_account',
        state,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      res.redirect(url.toString());
    });
    const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
    app.get('/auth/google/callback', async (req, res) => {
      const state = this.store.takeState<{ verifier: string; nonce: string; binding: string }>(
        String(req.query.state ?? ''),
        'google',
      );
      insist(state.binding === hash(cookies(req).argos_login ?? ''), 'Login browser mismatch', 400);
      insist(typeof req.query.code === 'string', 'Google sign-in cancelled', 400);
      const token = await requestJSON('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: req.query.code,
          code_verifier: state.verifier,
          client_id: this.settings.env.GOOGLE_CLIENT_ID!,
          client_secret: this.settings.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: this.settings.origin + '/auth/google/callback',
        }).toString(),
      });
      const { payload } = await jwtVerify(token.id_token, jwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: this.settings.env.GOOGLE_CLIENT_ID,
        algorithms: ['RS256'],
      });
      insist(
        payload.nonce === state.nonce &&
          payload.email_verified === true &&
          payload.sub &&
          typeof payload.email === 'string',
        'Invalid Google identity',
        401,
      );
      let user = this.store.get<{ id: string }>(
        'SELECT id FROM users WHERE google_sub=?',
        payload.sub,
      );
      if (!user) {
        user = { id: id() };
        this.store.run(
          'INSERT INTO users VALUES(?,?,?,?)',
          user.id,
          payload.sub,
          payload.email,
          String(payload.name ?? payload.email),
        );
      } else
        this.store.run(
          'UPDATE users SET email=?,name=? WHERE id=?',
          payload.email,
          String(payload.name ?? payload.email),
          user.id,
        );
      this.issueSession(res, user.id);
      res.clearCookie('argos_login', { path: '/auth/google' });
      res.redirect('/');
    });
    app.post('/auth/logout', (req, res) => {
      this.store.run(
        'DELETE FROM sessions WHERE token_hash=?',
        hash(cookies(req).argos_session ?? ''),
      );
      res.clearCookie('argos_session', { path: '/' });
      res.json({ ok: true });
    });
    for (const resource of this.resources()) {
      app.get('/.well-known/oauth-protected-resource' + new URL(resource).pathname, (_req, res) =>
        res.set('Access-Control-Allow-Origin', '*').json({
          resource,
          authorization_servers: [this.settings.origin],
          scopes_supported: ['mcp:tools'],
          resource_name: 'ArgosMCP',
        }),
      );
    }
    app.use(
      mcpAuthRouter({
        ...(this.settings.hosted
          ? {
              authorizationOptions: { rateLimit: false as const },
              tokenOptions: { rateLimit: false as const },
              clientRegistrationOptions: { rateLimit: false as const },
              revocationOptions: { rateLimit: false as const },
            }
          : {}),
        provider: this,
        issuerUrl: new URL(this.settings.origin),
        resourceServerUrl: new URL(this.audience),
        scopesSupported: ['mcp:tools'],
        resourceName: 'ArgosMCP',
      }),
    );
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    if (!params.resource || !this.resources().includes(params.resource.href))
      throw new InvalidRequestError('resource must match the ArgosMCP endpoint');
    if (params.scopes?.some((s) => s !== 'mcp:tools'))
      throw new InvalidRequestError('Unknown scope');
    const request = this.store.state('consent', {
      clientId: client.client_id,
      params: { ...params, resource: params.resource.href },
    });
    res.redirect(`${this.settings.origin}/?consent=${request}`);
  }
  consentInfo(token: string) {
    const r = this.store.get<{ payload: string; expires_at: number }>(
      'SELECT * FROM states WHERE id=? AND kind=?',
      hash(token),
      'consent',
    );
    insist(r && r.expires_at > Date.now(), 'Consent request expired', 400);
    const state = JSON.parse(r.payload);
    const client = this.clientsStore.getClient(state.clientId)!;
    return {
      resource: state.params.resource,
      name: client.client_name ?? 'MCP client',
      redirectUri: state.params.redirectUri,
      clientId: client.client_id,
    };
  }
  approveConsent(p: Principal, token: string, connections: string[], accept: boolean) {
    const state = this.store.takeState<{
      clientId: string;
      params: { codeChallenge: string; redirectUri: string; state?: string; resource: string };
    }>(token, 'consent');
    this.store.member(p);
    const url = new URL(state.params.redirectUri);
    if (state.params.state) url.searchParams.set('state', state.params.state);
    url.searchParams.set('iss', this.settings.origin);
    if (!accept) {
      url.searchParams.set('error', 'access_denied');
      return url.toString();
    }
    const client = this.clientsStore.getClient(state.clientId)!;
    const g = this.createGrant(
      p,
      client.client_id,
      client.client_name ?? 'MCP client',
      connections,
      state.params.resource,
    );
    const code = opaque();
    this.store.run(
      'INSERT INTO codes VALUES(?,?,?,?,?,?,?)',
      hash(code),
      client.client_id,
      g.id,
      state.params.codeChallenge,
      state.params.redirectUri,
      state.params.resource,
      Date.now() + 120_000,
    );
    url.searchParams.set('code', code);
    return url.toString();
  }
  createGrant(
    p: Principal,
    clientId: string,
    label: string,
    connectionIds: string[],
    resource = this.audience,
  ): Grant {
    this.store.member(p);
    insist(
      connectionIds.length > 0 && connectionIds.length <= 100,
      'Choose at least one connection',
      400,
    );
    insist(this.resources().includes(resource), 'Invalid MCP resource', 400);
    const provider = resource === this.audience ? null : resource.slice(this.audience.length + 1);
    for (const connectionId of connectionIds) {
      const c = this.store.connection(p, connectionId);
      this.store.live(c);
      insist(
        !provider || c.provider === provider,
        'Connection does not belong to the selected MCP endpoint',
        400,
      );
    }
    const now = Date.now();
    const g = {
      id: id(),
      org_id: p.orgId,
      user_id: p.userId,
      client_id: clientId,
      label,
      connections: JSON.stringify([...new Set(connectionIds)]),
      created_at: now,
      expires_at: now + this.store.org(p.orgId).grant_hours * 3600_000,
      revoked: 0,
    };
    this.store.run('INSERT INTO grants VALUES(?,?,?,?,?,?,?,?,?)', ...Object.values(g));
    this.store.run('INSERT INTO grant_resources VALUES(?,?)', g.id, resource);
    this.store.audit(p, 'agent.authorized', g.id);
    return g;
  }
  issueTokens(g: Grant): OAuthTokens {
    const access = opaque(),
      refresh = opaque(),
      now = Date.now();
    const end = Math.min(
      g.expires_at,
      g.created_at + this.store.org(g.org_id).grant_hours * 3600_000,
    );
    const accessEnd = Math.min(now + 3600_000, end);
    this.store.run('INSERT INTO tokens VALUES(?,?,?,?)', hash(access), g.id, 'access', accessEnd);
    this.store.run('INSERT INTO tokens VALUES(?,?,?,?)', hash(refresh), g.id, 'refresh', end);
    return {
      token_type: 'Bearer',
      access_token: access,
      refresh_token: refresh,
      expires_in: Math.floor((accessEnd - now) / 1000),
      scope: 'mcp:tools',
    };
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const c = this.store.get<{ challenge: string }>(
      'SELECT challenge FROM codes WHERE code_hash=? AND client_id=? AND expires_at>?',
      hash(code),
      client.client_id,
      Date.now(),
    );
    if (!c) throw new InvalidGrantError('Invalid authorization code');
    return c.challenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    return this.store.db.transaction(() => {
      const c = this.store.get<{ grant_id: string; redirect_uri: string; resource: string }>(
        'SELECT * FROM codes WHERE code_hash=? AND client_id=? AND expires_at>?',
        hash(code),
        client.client_id,
        Date.now(),
      );
      if (!c || c.redirect_uri !== redirectUri || c.resource !== resource?.href)
        throw new InvalidGrantError('Invalid code, redirect or resource');
      const g = this.store.grant(c.grant_id);
      this.store.run('DELETE FROM codes WHERE code_hash=?', hash(code));
      return this.issueTokens(g);
    })();
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    token: string,
    scopes?: string[],
    resource?: URL,
  ) {
    return this.store.db.transaction(() => {
      const t = this.store.get<{ grant_id: string }>(
        'SELECT grant_id FROM tokens WHERE token_hash=? AND kind=? AND expires_at>?',
        hash(token),
        'refresh',
        Date.now(),
      );
      if (
        !t ||
        resource?.href !== this.grantResource(t.grant_id) ||
        scopes?.some((s) => s !== 'mcp:tools')
      )
        throw new InvalidGrantError('Invalid refresh request');
      const g = this.store.grant(t.grant_id);
      if (g.client_id !== client.client_id) throw new InvalidGrantError('Client mismatch');
      this.store.run('DELETE FROM tokens WHERE token_hash=?', hash(token));
      return this.issueTokens(g);
    })();
  }
  async verifyAccessToken(token: string) {
    try {
      const t = this.store.get<{ grant_id: string; expires_at: number }>(
        'SELECT * FROM tokens WHERE token_hash=? AND kind=? AND expires_at>?',
        hash(token),
        'access',
        Date.now(),
      );
      if (!t) throw new Error();
      const g = this.store.grant(t.grant_id);
      return {
        token,
        clientId: g.client_id,
        scopes: ['mcp:tools'],
        expiresAt: Math.floor(t.expires_at / 1000),
        resource: new URL(this.grantResource(g.id)),
        extra: { userId: g.user_id, orgId: g.org_id, grantId: g.id },
      };
    } catch {
      throw new InvalidTokenError('Token expired or revoked');
    }
  }
  async revokeToken(client: OAuthClientInformationFull, request: { token: string }) {
    const t = this.store.get<{ grant_id: string }>(
      'SELECT grant_id FROM tokens WHERE token_hash=?',
      hash(request.token),
    );
    if (!t) return;
    this.store.run(
      'UPDATE grants SET revoked=1 WHERE id=? AND client_id=?',
      t.grant_id,
      client.client_id,
    );
  }
}
