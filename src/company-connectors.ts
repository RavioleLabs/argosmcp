import { z } from 'zod';
import type { Express } from 'express';
import type { Auth } from './auth.js';
import { Store, id, insist, canonical, type Principal, type Connection } from './foundation.js';
import { catalog } from './connectors.js';
import { connectorDirectory } from './connector-directory.js';
import {
  remoteConfigSchema,
  configFingerprint,
  parseTools,
  remoteToolName,
  remoteToolDefinition,
  publicURL,
  type RemoteDefinition,
} from './remote-definition.js';

type Row = {
  id: string;
  name: string;
  config: string;
  fingerprint: string;
  status: string;
  tools: string;
  candidate: string;
  catalog_id: string | null;
};
export class CompanyConnectors {
  constructor(
    public store: Store,
    private publicClients: Record<string, string> = {},
  ) {}
  list(p: Principal): RemoteDefinition[] {
    const admin = this.store.member(p).role !== 'member';
    return this.store
      .all<Row>('SELECT * FROM company_connectors WHERE org_id=? ORDER BY name', p.orgId)
      .filter((r) => admin || r.status === 'enabled')
      .map((r) => ({
        id: r.id,
        name: r.name,
        config: JSON.parse(r.config),
        fingerprint: r.fingerprint,
        status: r.status,
        tools: JSON.parse(r.tools),
        candidate: admin ? JSON.parse(r.candidate) : [],
        catalogId: r.catalog_id,
      }));
  }
  get(p: Principal, connectorId: string) {
    const d = this.list(p).find((d) => d.id === connectorId);
    insist(d, 'Connector not found', 404);
    return d;
  }
  create(p: Principal, input: unknown) {
    this.store.admin(p);
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        catalogId: z.string().max(100).optional(),
        config: remoteConfigSchema,
      })
      .strict()
      .parse(input);
    insist(
      !b.catalogId || connectorDirectory.some((d) => d.id === b.catalogId),
      'Unknown directory entry',
      400,
    );
    insist(this.list(p).length < 100, 'Company connector limit reached', 400);
    const cid = id();
    this.store.run(
      "INSERT INTO company_connectors(id,org_id,name,catalog_id,config,fingerprint,status,tools,candidate) VALUES(?,?,?,?,?,?,'draft','[]','[]')",
      cid,
      p.orgId,
      b.name,
      b.catalogId ?? null,
      JSON.stringify(b.config),
      configFingerprint(b.config),
    );
    this.store.audit(p, 'connector.created', cid);
    return this.get(p, cid);
  }
  discover(p: Principal, cid: string, fingerprint: string, input: unknown) {
    this.store.admin(p);
    const d = this.get(p, cid);
    insist(d.fingerprint === fingerprint, 'Connector configuration changed', 409);
    const tools = parseTools(input);
    this.store.run(
      'UPDATE company_connectors SET candidate=? WHERE org_id=? AND id=?',
      JSON.stringify(tools),
      p.orgId,
      cid,
    );
    this.store.audit(p, 'connector.tools_discovered', cid);
    return { count: tools.length };
  }
  publish(p: Principal, cid: string, input: unknown) {
    this.store.admin(p);
    const b = z
      .object({
        enabled: z.boolean(),
        names: z.array(z.string().max(128)).max(100),
        candidateHash: z.string().length(64),
      })
      .strict()
      .parse(input);
    const d = this.get(p, cid);
    insist(
      configFingerprintForTools(d.candidate) === b.candidateHash,
      'Discovered tools changed. Review them again.',
      409,
    );
    const tools = d.candidate.filter((t) => b.names.includes(t.name));
    insist(
      !b.enabled || (tools.length > 0 && tools.length === new Set(b.names).size),
      'Select discovered tools to enable',
      400,
    );
    if (b.enabled) {
      const others = this.list(p).filter((x) => x.id !== cid && x.status === 'enabled');
      insist(
        others.reduce((count, x) => count + x.tools.length, tools.length) <= 500,
        'A company can enable up to 500 custom MCP tools',
        400,
      );
    }
    this.store.db.transaction(() => {
      this.store.run(
        'UPDATE company_connectors SET status=?,tools=? WHERE org_id=? AND id=?',
        b.enabled ? 'enabled' : 'disabled',
        JSON.stringify(tools),
        p.orgId,
        cid,
      );
      // Schema changes invalidate old decisions and reset affected tools to approval.
      for (const t of tools)
        if (!d.tools.some((old) => canonical(old) === canonical(t)))
          this.store.run(
            "INSERT INTO organization_policies VALUES(?,?,'approve') ON CONFLICT(org_id,tool) DO UPDATE SET effect='approve'",
            p.orgId,
            remoteToolName(cid, t.name),
          );
      this.store.run('UPDATE organizations SET revision=revision+1 WHERE id=?', p.orgId);
      this.store.run(
        "UPDATE invocations SET status='cancelled' WHERE org_id=? AND status IN ('pending','approved')",
        p.orgId,
      );
      this.store.audit(p, b.enabled ? 'connector.enabled' : 'connector.disabled', cid);
    })();
    return this.get(p, cid);
  }
  requests(p: Principal) {
    const admin = this.store.member(p).role !== 'member';
    return this.store.all(
      'SELECT id,requester_id,name,catalog_id,endpoint,reason,status,note,connector_id,created_at FROM connector_requests WHERE org_id=?' +
        (admin ? '' : ' AND requester_id=?') +
        ' ORDER BY created_at DESC LIMIT 200',
      p.orgId,
      ...(admin ? [] : [p.userId]),
    );
  }
  request(p: Principal, input: unknown) {
    this.store.member(p);
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        catalogId: z.string().max(100).optional(),
        endpoint: publicURL.optional(),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(input);
    insist(
      !b.catalogId || connectorDirectory.some((d) => d.id === b.catalogId),
      'Unknown directory entry',
      400,
    );
    const count = this.store.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM connector_requests WHERE org_id=? AND requester_id=? AND status='pending'",
      p.orgId,
      p.userId,
    )!.n;
    insist(count < 20, 'You already have 20 pending requests', 429);
    const rid = id();
    this.store.run(
      "INSERT INTO connector_requests(id,org_id,requester_id,name,catalog_id,endpoint,reason,status,note,created_at) VALUES(?,?,?,?,?,?,?,'pending','',?)",
      rid,
      p.orgId,
      p.userId,
      b.name,
      b.catalogId ?? null,
      b.endpoint ?? null,
      b.reason,
      Date.now(),
    );
    this.store.audit(p, 'connector.requested', rid);
    return { id: rid };
  }
  decide(p: Principal, rid: string, input: unknown) {
    this.store.admin(p);
    const b = z
      .object({
        approve: z.boolean(),
        connectorId: z.string().uuid().optional(),
        note: z.string().trim().max(2000).default(''),
      })
      .strict()
      .parse(input);
    if (b.approve)
      insist(
        b.connectorId && this.get(p, b.connectorId).status === 'enabled',
        'Enable a connector before approving this request',
        400,
      );
    insist(
      this.store.run(
        "UPDATE connector_requests SET status=?,note=?,connector_id=? WHERE org_id=? AND id=? AND status='pending'",
        b.approve ? 'approved' : 'rejected',
        b.note,
        b.approve ? b.connectorId! : null,
        p.orgId,
        rid,
      ).changes,
      'Pending request not found',
      404,
    );
    this.store.audit(
      p,
      b.approve ? 'connector.request_approved' : 'connector.request_rejected',
      rid,
    );
    return { ok: true };
  }
  mount(app: Express, auth: Auth) {
    app.get('/api/org/:orgId/connectors', (req, res) => {
      const p = auth.principal(req);
      res.json({
        directory: connectorDirectory,
        checkedAt: '2026-11-18',
        publicClients: {
          slack: /^\d+\.\d+$/.test(this.publicClients.slack ?? '')
            ? this.publicClients.slack
            : null,
        },
        serverConnections: this.store.all<{ id: string; connector_id: string }>(
          "SELECT c.id,cc.connector_id FROM connections c JOIN server_credentials sc ON sc.connection_id=c.id JOIN connection_connectors cc ON cc.connection_id=c.id WHERE c.org_id=? AND c.owner_id=? AND c.status='active' AND c.expires_at>?",
          p.orgId,
          p.userId,
          Date.now(),
        ),
        connectors: this.list(p).map((d) => ({
          ...d,
          candidateHash: configFingerprintForTools(d.candidate),
        })),
        requests: this.requests(p),
      });
    });
    app.post('/api/org/:orgId/connectors', (req, res) =>
      res.json(this.create(auth.principal(req), req.body)),
    );
    app.post('/api/org/:orgId/connectors/:id/publish', (req, res) =>
      res.json(this.publish(auth.principal(req), String(req.params.id), req.body)),
    );
    app.post('/api/org/:orgId/connector-requests', (req, res) =>
      res.json(this.request(auth.principal(req), req.body)),
    );
    app.post('/api/org/:orgId/connector-requests/:id/decide', (req, res) =>
      res.json(this.decide(auth.principal(req), String(req.params.id), req.body)),
    );
  }
}
import { hash } from './foundation.js';
export const configFingerprintForTools = (tools: unknown) => hash(canonical(tools));
export type ToolDefinition = {
  provider: string;
  title: string;
  write: boolean;
  schema: z.ZodType;
  connectorId?: string;
  inputSchema?: Record<string, unknown>;
};
export function toolsFor(store: Store, orgId: string): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = { ...catalog };
  for (const d of store.all<Row>(
    "SELECT * FROM company_connectors WHERE org_id=? AND status='enabled'",
    orgId,
  ))
    for (const t of parseTools(JSON.parse(d.tools)))
      tools[remoteToolName(d.id, t.name)] = remoteToolDefinition(d, t);
  return tools;
}
export function matchesTool(store: Store, c: Connection, def?: ToolDefinition) {
  return (
    !!def &&
    def.provider === c.provider &&
    (!def.connectorId ||
      !!store.get(
        'SELECT 1 FROM connection_connectors WHERE connection_id=? AND connector_id=? AND org_id=?',
        c.id,
        def.connectorId,
        c.org_id,
      ))
  );
}
