import { remoteConfigSchema, configFingerprint } from '../remote-definition.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { opaque, hash, insist, Fault, id } from '../foundation.js';
import { LocalRuntime } from './runtime.js';
import { newAttempt, authorizeURL, exchange, type OAuthAttempt } from './providers.js';

export function createLocalApp(runtime: LocalRuntime, origin: string, assets: string) {
  const app = express(),
    launchToken = opaque(),
    sessions = new Map<string, number>(),
    attempts = new Map<string, OAuthAttempt>();
  const launchedAt = Date.now(),
    sessionLifetime = 12 * 3600_000;
  let launchConsumed = false;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (req.headers.host !== new URL(origin).host)
      return res.status(403).json({ error: 'Host not allowed' });
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin)
      return res.status(403).json({ error: 'Same-origin request required' });
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.post('/session', (req, res) => {
    const b = z
      .object({ key: z.string().max(100) })
      .strict()
      .parse(req.body);
    insist(
      !launchConsumed &&
        Date.now() < launchedAt + 60_000 &&
        timingSafeEqual(Buffer.from(hash(b.key), 'hex'), Buffer.from(hash(launchToken), 'hex')),
      'Quit and reopen Argos Personal to start a new session',
      401,
    );
    launchConsumed = true;
    const token = opaque();
    sessions.set(hash(token), Date.now() + sessionLifetime);
    res.cookie('argos_local', token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: sessionLifetime,
    });
    res.json({ ok: true });
  });
  app.get('/oauth/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '',
      a = attempts.get(state);
    insist(a && a.expiresAt > Date.now(), 'OAuth request expired or unknown', 400);
    attempts.delete(state);
    if (req.query.error)
      return res.status(400).type('text').send('Authorization was cancelled. Return to Argos.');
    const code = z.string().min(1).max(4096).parse(req.query.code);
    if (a.oauth) insist(req.query.iss === a.oauth.issuer, 'OAuth issuer mismatch', 400);
    if (a.remote && req.query.iss)
      insist(
        new URL(String(req.query.iss)).href === a.remote.config.oauth?.issuer,
        'OAuth issuer mismatch',
        400,
      );
    await runtime.serial(async () => {
      const p = runtime.storage.get(a.profileId);
      await runtime.snapshot(p);
      insist(runtime.snapshots.get(p.id)?.status === 'active', 'Device access is no longer active');
      const credentials = await exchange(a, {
        grant_type: 'authorization_code',
        code,
        code_verifier: a.verifier,
        redirect_uri: a.redirect,
      });
      await runtime.register(p, {
        id: a.connectionId,
        provider: a.provider,
        label: a.label,
        clientId: a.clientId,
        credentials,
        expiresAt: Date.now() + 7 * 86400000,
        autoRead: false,
        status: 'active',
        oauth: a.oauth,
        ...(a.remote ? { remote: a.remote } : {}),
      });
      if (a.remote)
        await runtime.discover(
          p,
          p.connections.find((c) => c.id === a.connectionId)!,
        );
    });
    res
      .type('text')
      .send(
        'Connected. Your credentials stay on this device. You can close this tab and return to Argos.',
      );
  });
  app.use('/api', (req, res, next) => {
    const token = (req.headers.cookie ?? '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('argos_local='))
      ?.slice('argos_local='.length);
    const key = hash(token ?? '');
    if (!token || (sessions.get(key) ?? 0) <= Date.now()) {
      sessions.delete(key);
      return res
        .status(401)
        .json({ error: 'Quit and reopen Argos Personal to start a new session' });
    }
    next();
  });
  app.get('/api/state', (_req, res) =>
    res.json({ profiles: runtime.state(), callback: origin + '/oauth/callback' }),
  );
  app.post('/api/pair', async (req, res) => {
    const b = z
      .object({ origin: z.string().max(300), label: z.string().trim().min(1).max(100) })
      .strict()
      .parse(req.body);
    res.json(await runtime.serial(() => runtime.pair(b.origin.replace(/\/$/, ''), b.label)));
  });
  app.post('/api/connect', async (req, res) => {
    const b = z
      .object({
        profileId: z.string().uuid(),
        provider: z.enum(['slack', 'linear', 'notion']),
        clientId: z.string().max(300).default(''),
        label: z.string().trim().min(1).max(100),
      })
      .strict()
      .parse(req.body);
    res.json(
      await runtime.serial(async () => {
        const p = runtime.storage.get(b.profileId);
        await runtime.snapshot(p);
        insist(runtime.snapshots.get(p.id)?.status === 'active', 'Pair this device first');
        for (const [key, a] of attempts) if (a.expiresAt < Date.now()) attempts.delete(key);
        insist(attempts.size < 10, 'Too many pending connections', 429);
        const a = newAttempt(
          p.id,
          b.provider,
          id(),
          b.label,
          b.clientId,
          origin + '/oauth/callback',
        );
        const url = await authorizeURL(a);
        attempts.set(a.state, a);
        return { url };
      }),
    );
  });
  app.post('/api/connect-mcp', async (req, res) => {
    const b = z
      .object({
        profileId: z.string().uuid(),
        connectorId: z.string().uuid(),
        token: z.string().max(16000).optional(),
      })
      .strict()
      .parse(req.body);
    res.json(
      await runtime.serial(async () => {
        const p = runtime.storage.get(b.profileId);
        await runtime.snapshot(p);
        insist(runtime.snapshots.get(p.id)?.status === 'active', 'Pair this device first');
        const d = runtime.companyConnectors.get(p.id)?.find((d) => d.id === b.connectorId);
        insist(d && d.status !== 'disabled', 'Company connector unavailable', 404);
        d.config = remoteConfigSchema.parse(d.config);
        insist(configFingerprint(d.config) === d.fingerprint, 'Connector configuration mismatch');
        if (d.config.auth === 'oauth') {
          insist(!b.token, 'Do not supply a token for OAuth', 400);
          for (const [key, a] of attempts) if (a.expiresAt < Date.now()) attempts.delete(key);
          insist(attempts.size < 10, 'Too many pending connections', 429);
          const a = newAttempt(
            p.id,
            'mcp',
            id(),
            d.name,
            d.config.oauth!.clientId,
            origin + '/oauth/callback',
          );
          a.remote = d;
          const url = await authorizeURL(a);
          attempts.set(a.state, a);
          return { url };
        }
        insist(
          d.config.auth === 'bearer' ? !!b.token : !b.token,
          'Enter a token only when the connector requires one',
          400,
        );
        const c = {
          id: id(),
          provider: 'mcp' as const,
          label: d.name,
          clientId: '',
          remote: d,
          credentials: { access_token: b.token ?? '' },
          expiresAt: Date.now() + 7 * 86400000,
          autoRead: false,
          status: 'active' as const,
        };
        await runtime.register(p, c);
        return runtime.discover(p, c);
      }),
    );
  });
  app.post('/api/discover-mcp', async (req, res) => {
    const b = z
      .object({ profileId: z.string().uuid(), id: z.string().uuid() })
      .strict()
      .parse(req.body);
    res.json(
      await runtime.serial(async () => {
        const p = runtime.storage.get(b.profileId);
        await runtime.snapshot(p);
        insist(runtime.snapshots.get(p.id)?.status === 'active', 'Device is offline');
        const c = p.connections.find((c) => c.id === b.id);
        insist(c, 'Connection not found', 404);
        return runtime.discover(p, c);
      }),
    );
  });
  app.post('/api/decide', async (req, res) => {
    const b = z
      .object({
        profileId: z.string().uuid(),
        id: z.string().uuid(),
        digest: z.string().length(64),
        approve: z.boolean(),
      })
      .strict()
      .parse(req.body);
    await runtime.serial(() => runtime.decide(b.profileId, b.id, b.digest, b.approve));
    res.json({ ok: true });
  });
  app.post('/api/disconnect', async (req, res) => {
    const b = z
      .object({ profileId: z.string().uuid(), id: z.string().uuid() })
      .strict()
      .parse(req.body);
    await runtime.serial(async () => {
      const p = runtime.storage.get(b.profileId),
        c = p.connections.find((c) => c.id === b.id);
      insist(c, 'Connection not found', 404);
      await runtime.revokeConnection(p, c);
    });
    res.json({ ok: true });
  });
  app.post('/api/preferences', async (req, res) => {
    const b = z
      .object({ profileId: z.string().uuid(), id: z.string().uuid(), autoRead: z.boolean() })
      .strict()
      .parse(req.body);
    await runtime.serial(async () => {
      const p = runtime.storage.get(b.profileId),
        c = p.connections.find((c) => c.id === b.id);
      insist(c, 'Connection not found', 404);
      c.autoRead = b.autoRead;
      runtime.storage.save(p);
    });
    res.json({ ok: true });
  });
  app.use(express.static(resolve(assets), { index: 'index.html' }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(e instanceof Fault ? e.status : e instanceof z.ZodError ? 400 : 500).json({
      error:
        e instanceof Fault
          ? e.message
          : e instanceof z.ZodError
            ? 'Invalid input'
            : 'Operation failed. No credentials were exposed. Retry from Argos.',
    });
  });
  return { app, url: origin + '/#key=' + launchToken };
}
