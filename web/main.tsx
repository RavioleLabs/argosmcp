import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type View =
  | 'overview'
  | 'connections'
  | 'policies'
  | 'approvals'
  | 'agents'
  | 'engram'
  | 'teams'
  | 'activity'
  | 'settings';
type Connection = {
  id: string;
  provider: string;
  label: string;
  scope: string;
  teamId: string | null;
  ownerId: string;
  expiresAt: number;
  status: string;
  revokeStatus: string;
  demo: boolean;
  local?: boolean;
  policies: {
    tool: string;
    title: string;
    write: boolean;
    effect: string;
    companyEffect: string;
    personalEffect: string;
  }[];
};
const views: { id: View; title: string; icon: string }[] = [
  { id: 'overview', title: 'Overview', icon: '◈' },
  { id: 'connections', title: 'Connections', icon: '↔' },
  { id: 'policies', title: 'Access rules', icon: '≋' },
  { id: 'approvals', title: 'Approvals', icon: '✓' },
  { id: 'agents', title: 'Agents & clients', icon: '⌘' },
  { id: 'engram', title: 'Engram contexts', icon: '◎' },
  { id: 'teams', title: 'Teams & members', icon: '◇' },
  { id: 'activity', title: 'Activity', icon: '↳' },
  { id: 'settings', title: 'Security', icon: '⛨' },
];
const providerNames: Record<string, string> = {
  slack: 'Slack',
  notion: 'Notion',
  linear: 'Linear',
  engram: 'EngramMCP',
};
const effects: Record<string, string> = { allow: 'Allow', approve: 'Approval', block: 'Deny' };
const scopes: Record<string, string> = {
  personal: 'Personal',
  team: 'Team',
  organization: 'Company',
};
const events: Record<string, string> = {
  'demo.started': 'Demo workspace created',
  'organization.created': 'Workspace created',
  'organization.security_updated': 'Security lifetimes updated',
  'connection.created': 'Service connected',
  'connection.revoked': 'Connection revoked',
  'connection.expired': 'Connection expired',
  'engram.connected': 'Engram context connected',
  'invocation.denied': 'Action blocked',
  'invocation.completed': 'Action completed',
  'invocation.incomplete': 'Execution needs review',
  'invocation.allowed': 'Action allowed',
  'approval.requested': 'Approval requested',
  'approval.approved': 'Action approved',
  'approval.rejected': 'Action denied',
  'agent.authorized': 'Agent authorized',
  'agent.revoked': 'Agent revoked',
  'policy.allow': 'Rule: allow',
  'policy.approve': 'Rule: approval',
  'policy.block': 'Rule: deny',
  'team.created': 'Team created',
  'team.member_added': 'Team member added',
  'team.member_removed': 'Team access removed',
  'member.invited': 'Invitation created',
  'member.joined': 'Member joined',
  'member.removed': 'Member removed',
};
const date = (n: number) =>
  new Date(n).toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
const duration = (hours: number) => (hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`);
const remaining = (n: number) =>
  n <= Date.now() ? 'Expired' : `${Math.max(1, Math.ceil((n - Date.now()) / 3600000))} h remaining`;
async function api(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(path, {
    ...(body === undefined
      ? {}
      : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'The request failed.');
  return data;
}
function Logo({ small = false }: { small?: boolean }) {
  return (
    <div className={`wordmark ${small ? 'small' : ''}`}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path
          d="M7 20h9m0 0L31 7m-15 13 15 13m-15-13h15"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="6" cy="20" r="3" fill="currentColor" />
        <circle cx="32" cy="7" r="3" fill="currentColor" />
        <circle cx="32" cy="20" r="3" fill="currentColor" />
        <circle cx="32" cy="33" r="3" fill="currentColor" />
      </svg>
      <span>
        argos<span className="mcp">MCP</span>
      </span>
    </div>
  );
}
function ProviderIcon({ provider }: { provider: string }) {
  return (
    <span className={`provider-icon ${provider}`} aria-hidden="true">
      {({ slack: '#', notion: 'N', linear: '◩', engram: '◎' } as Record<string, string>)[provider]}
    </span>
  );
}
function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <span>◇</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function App() {
  const [session, setSession] = useState<any>(null),
    [orgId, setOrgId] = useState(''),
    [data, setData] = useState<any>(null);
  const [view, setView] = useState<View>(
    (new URLSearchParams(location.search).get('view') as View) || 'overview',
  );
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [menu, setMenu] = useState(false);
  const [modal, setModal] = useState<{ title: string; content: React.ReactNode } | null>(null);
  const [pairDevice, setPairDevice] = useState<any>(null);
  const [consent, setConsent] = useState<any>(null),
    [consentSelected, setConsentSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(() => {
    const params = new URLSearchParams(location.search);
    const found = {
      consent: params.get('consent'),
      invite: params.get('invite'),
      device: params.get('device'),
    };
    if (found.consent || found.invite || found.device) {
      sessionStorage.setItem('argos_pending', JSON.stringify(found));
      return found;
    }
    try {
      return JSON.parse(sessionStorage.getItem('argos_pending') ?? '{}');
    } catch {
      return {};
    }
  });
  const loadSession = async () => {
    const s = await api('/api/session');
    setSession(s);
    if (s.organizations.length)
      setOrgId((old) =>
        s.organizations.some((o: any) => o.id === old) ? old : s.organizations[0].id,
      );
  };
  const base = `/api/org/${orgId}`;
  const reload = async () => {
    if (orgId) setData(await api(`${base}/state`));
  };
  useEffect(() => {
    loadSession().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    setData(null);
    reload().catch((e) => setError(e.message));
  }, [orgId]);
  useEffect(() => {
    if (!orgId) return;
    const timer = setInterval(() => reload().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [orgId]);
  useEffect(() => {
    if (session?.user && pending.consent)
      api(`/api/consent/${encodeURIComponent(pending.consent)}`)
        .then(setConsent)
        .catch((e) => setError(e.message));
  }, [session?.user?.id, pending.consent]);
  useEffect(() => {
    if (session?.user && pending.device)
      api(`/api/devices/${encodeURIComponent(pending.device)}/pair`)
        .then(setPairDevice)
        .catch((e) => setError(e.message));
  }, [session?.user?.id, pending.device]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModal(null);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);
  const action = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await reload();
      if (message) setNotice(message);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const go = (next: View) => {
    setView(next);
    setMenu(false);
    history.replaceState(null, '', `/?view=${next}`);
  };
  const clearPending = () => {
    sessionStorage.removeItem('argos_pending');
    setPending({});
    setConsent(null);
    history.replaceState(null, '', '/');
  };
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('Copied to clipboard.');
    } catch {
      setError('Select the text to copy it.');
    }
  };
  const admin = data && data.role !== 'member';
  const connections: Connection[] = data?.connections ?? [];
  const active = connections.filter((c) => c.status === 'active');
  const consentConnections = active.filter(
    (c) =>
      !consent?.resource ||
      consent.resource === session.mcpUrl ||
      consent.resource === session.mcpUrl + '/' + c.provider,
  );
  const openConnect = (provider: string) =>
    setModal({
      title: `Connect ${providerNames[provider]} on your device`,
      content: (
        <div className="form-stack">
          <p>
            Open Argos Personal, pair this device with this workspace, then connect{' '}
            {providerNames[provider]} there.
          </p>
          <p>
            OAuth credentials stay in your device’s keychain. This dashboard receives connection
            status and tool results, never your provider tokens.
          </p>
          <label>
            Workspace URL
            <input readOnly value={location.origin} />
          </label>
          <button className="primary" onClick={() => copy(location.origin)}>
            Copy workspace URL
          </button>
        </div>
      ),
    });
  const openAgent = () =>
    setModal({
      title: 'Authorize an agent',
      content: (
        <AgentForm
          mcpUrl={session.mcpUrl}
          connections={active}
          onSubmit={(input) =>
            action(async () => {
              const result = await api(`${base}/grants`, input);
              setModal({
                title: 'Agent access created',
                content: (
                  <div className="form-stack">
                    <p>This token is shown only once. It expires on {date(result.expiresAt)}.</p>
                    <label>
                      URL MCP
                      <input readOnly value={result.mcpUrl} />
                    </label>
                    <label>
                      Access token
                      <textarea readOnly value={result.token} />
                    </label>
                    <button className="primary" onClick={() => copy(result.token)}>
                      Copy token
                    </button>
                    <p className="muted">
                      For clients supporting MCP OAuth, add the MCP URL and sign in. Use this token
                      for bots and manually configured clients.
                    </p>
                  </div>
                ),
              });
            })
          }
        />
      ),
    });
  const openTest = (c: Connection, tool?: string) =>
    setModal({
      title: `Test ${providerNames[c.provider]}`,
      content: (
        <TestForm
          connection={c}
          initialTool={tool}
          onSubmit={(input) =>
            action(async () => {
              const result = await api(`${base}/invoke`, {
                ...input,
                connectionId: c.id,
                requestId: crypto.randomUUID(),
              });
              setModal({
                title: result.status === 'pending' ? 'Approval requested' : 'Tool result',
                content: (
                  <div className="form-stack">
                    <p>
                      Status: <strong>{result.status}</strong>
                    </p>
                    {result.status === 'pending' ? (
                      <>
                        <p>
                          This action is waiting for your approval. No external call has been made.
                        </p>
                        <button
                          className="primary"
                          onClick={() => {
                            setModal(null);
                            go('approvals');
                          }}
                        >
                          Review approvals
                        </button>
                      </>
                    ) : (
                      <pre>{JSON.stringify(result.result ?? result, null, 2)}</pre>
                    )}
                  </div>
                ),
              });
            })
          }
        />
      ),
    });
  const confirmRevoke = (c: Connection) =>
    setModal({
      title: `Revoke ${c.label} ?`,
      content: (
        <div className="form-stack">
          <p>Agents will lose access immediately. Pending approvals will be cancelled.</p>
          <button
            className="danger"
            onClick={() =>
              action(async () => {
                await api(`${base}/connections/${c.id}/revoke`, {});
                setModal(null);
              }, 'Connection revoked.')
            }
          >
            Revoke connection
          </button>
        </div>
      ),
    });
  if (!session)
    return (
      <div className="loading">
        <Logo />
        <p>Opening your workspace…</p>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  if (!session.user)
    return (
      <div className="login">
        <div className="login-art">
          <Logo />
          <div className="login-statement">
            <span className="eyebrow light">YOUR TOOLS. YOUR RULES.</span>
            <h1>
              Let your agents work.
              <br />
              You set the boundaries.
            </h1>
            <p>
              One connection to your tools and shared knowledge. Every action follows your rules.
            </p>
            <div className="login-route">
              <span>Your AI</span>
              <i>→</i>
              <b>ArgosMCP</b>
              <i>→</i>
              <span>Your tools</span>
            </div>
          </div>
          <small>Any model. Your company’s control.</small>
        </div>
        <main className="login-form">
          <span className="eyebrow">ARGOSMCP WORKSPACE</span>
          <h2>
            Welcome to
            <br />
            your workspace.
          </h2>
          <p>Manage your tools, agents and Engram memory in one place.</p>
          {session.googleConfigured && !session.demo ? (
            <a className="primary button" href="/auth/google">
              Continue with Google <span>↗</span>
            </a>
          ) : (
            <div className="setup-note">
              Google sign-in will be available once the OAuth application is configured.
            </div>
          )}
          {session.demo && (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await api('/api/demo/login', {});
                  await loadSession();
                })
              }
            >
              Explore demo <span>→</span>
            </button>
          )}
          <small>
            {session.demo
              ? 'Local demo. Sample data, no external services called.'
              : 'Sign in with Google. Connect each tool separately, on your terms.'}
          </small>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
        </main>
      </div>
    );
  return (
    <div className="shell">
      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <Logo small />
        <div className="workspace">
          <span className="workspace-avatar">{data?.org.name.slice(0, 1) ?? 'R'}</span>
          <div>
            <span className="eyebrow">WORKSPACE</span>
            <select
              aria-label="Active workspace"
              value={orgId}
              onChange={(e) => {
                setConsentSelected([]);
                setOrgId(e.target.value);
              }}
            >
              {session.organizations.map((o: any) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {!session.hosted && (
          <button
            className="text-button"
            onClick={() =>
              setModal({
                title: 'Create workspace',
                content: (
                  <SimpleForm
                    label="Company name"
                    onSubmit={(value) =>
                      action(async () => {
                        const result = await api('/api/organizations', { name: value });
                        setModal(null);
                        await loadSession();
                        setOrgId(result.id);
                      })
                    }
                  />
                ),
              })
            }
          >
            ＋ New workspace
          </button>
        )}
        <nav aria-label="Main navigation">
          {views.map((v) => (
            <button key={v.id} className={view === v.id ? 'active' : ''} onClick={() => go(v.id)}>
              <span className="nav-icon">{v.icon}</span>
              {v.title}
              {v.id === 'approvals' && !!data?.approvals.length && (
                <b className="nav-count">{data.approvals.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="boundary">
            <span className="live-dot" />
            Server-enforced access
          </div>
          <div className="profile">
            <span className="avatar">{session.user.name.slice(0, 1)}</span>
            <div>
              <strong>{session.user.name}</strong>
              <small>
                {data?.role === 'owner'
                  ? 'Owner'
                  : data?.role === 'admin'
                    ? 'Administrator'
                    : 'Member'}
              </small>
            </div>
            <button
              aria-label="Sign out"
              title="Sign out"
              onClick={() =>
                action(async () => {
                  await api('/auth/logout', {});
                  setData(null);
                  setOrgId('');
                  await loadSession();
                })
              }
            >
              ↪
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Open menu" onClick={() => setMenu(!menu)}>
            ☰
          </button>
          <span>
            Workspace <span className="breadcrumb">/</span>{' '}
            <strong>{views.find((v) => v.id === view)?.title}</strong>
          </span>
          <div className="topbar-right">
            {session.demo && <span className="demo-badge">DEMO</span>}
            <span className="status-dot" /> <span className="desktop-only">ArgosMCP · v0.1</span>
          </div>
        </header>
        {session.demo && (
          <div className="demo-strip">
            Local demo · Connections are simulated. Access rules and approvals are enforced.
          </div>
        )}
        <main className="content">
          {error && (
            <div className="error" role="alert">
              {error}
              <button aria-label="Close error" onClick={() => setError('')}>
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="toast" role="status">
              ✓ {notice}
            </div>
          )}
          {pending.invite && (
            <div className="banner">
              <div>
                <strong>You have an invitation</strong>
                <p>Join with the Google account that was invited.</p>
              </div>
              <button
                className="primary"
                onClick={() =>
                  action(async () => {
                    await api('/api/invitations/accept', { token: pending.invite });
                    clearPending();
                    await loadSession();
                  }, 'Invitation accepted.')
                }
              >
                Accept invitation
              </button>
            </div>
          )}
          {!data ? (
            <div className="loading inline">
              {session.organizations.length
                ? 'Loading workspace…'
                : 'You need an invitation to join this workspace.'}
            </div>
          ) : (
            <>
              {pairDevice && (
                <section className="panel consent">
                  <span className="eyebrow">PAIR YOUR PERSONAL CONNECTOR</span>
                  <h2>
                    Connect {pairDevice.label} to {data.org.name}?
                  </h2>
                  <p>
                    Only continue if you started this request in your Argos Personal app. Compare
                    the fingerprint shown on your device.
                  </p>
                  <pre>{pairDevice.fingerprint}</pre>
                  <p>
                    This device will be linked to <strong>{session.user.email}</strong> in{' '}
                    <strong>{data.org.name}</strong>. It can approve your personal actions and
                    execute your authorized tools.
                  </p>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await api(`${base}/devices/${pairDevice.id}/pair`, {
                          fingerprint: pairDevice.fingerprint,
                        });
                        setPairDevice(null);
                        clearPending();
                      }, 'Device paired. Return to Argos Personal.')
                    }
                  >
                    The fingerprints match — pair device
                  </button>
                </section>
              )}
              {consent && (
                <section className="panel consent">
                  <span className="eyebrow">MCP AUTHORIZATION</span>
                  <h2>{consent.name} would like access to your workspace</h2>
                  <p>
                    Choose the connections this client may access in{' '}
                    <strong>{data.org.name}</strong>. Company rules always apply.
                  </p>
                  <p className="muted">Redirect address: {consent.redirectUri}</p>
                  <div className="check-list">
                    {consentConnections.map((c) => (
                      <label key={c.id}>
                        <input
                          type="checkbox"
                          checked={consentSelected.includes(c.id)}
                          onChange={(e) =>
                            setConsentSelected(
                              e.target.checked
                                ? [...consentSelected, c.id]
                                : consentSelected.filter((id) => id !== c.id),
                            )
                          }
                        />
                        <ProviderIcon provider={c.provider} />
                        <span>
                          {c.label}
                          <small>{scopes[c.scope]}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="button-row">
                    <button
                      onClick={() =>
                        action(async () => {
                          const r = await api(`${base}/consent`, {
                            token: pending.consent,
                            connections: [],
                            accept: false,
                          });
                          clearPending();
                          location.assign(r.redirect);
                        })
                      }
                    >
                      Deny
                    </button>
                    <button
                      className="primary"
                      disabled={!consentSelected.length || busy}
                      onClick={() =>
                        action(async () => {
                          const r = await api(`${base}/consent`, {
                            token: pending.consent,
                            connections: consentSelected,
                            accept: true,
                          });
                          clearPending();
                          location.assign(r.redirect);
                        })
                      }
                    >
                      Allow for {duration(data.org.grant_hours)}
                    </button>
                  </div>
                </section>
              )}
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    {view === 'engram' ? 'KNOWLEDGE, WITH BOUNDARIES' : 'YOUR WORKSPACE'}
                  </span>
                  <h1>
                    {
                      (
                        {
                          overview: 'Overview',
                          connections: 'Connections',
                          policies: 'Access rules',
                          approvals: 'Approvals',
                          agents: 'Agents & clients',
                          engram: 'Engram memory',
                          teams: 'Teams & members',
                          activity: 'Activity',
                          settings: 'Security',
                        } as Record<View, string>
                      )[view]
                    }
                  </h1>
                  <p>
                    {
                      (
                        {
                          overview: 'Connect your tools, set permissions and stay in control.',
                          connections:
                            'Credentials stay on your device. Company rules apply to every request.',
                          policies:
                            'Company rules apply to every tool call, including personal connections.',
                          approvals:
                            'Review an exact action before it runs. Each approval applies once.',
                          agents:
                            'Connect an MCP client with OAuth, or create scoped access for your bot.',
                          engram:
                            'Personal memory stays private. Team memory follows team membership.',
                          teams: 'Choose who can access shared tools and knowledge.',
                          activity: 'Review actions, approvals and security changes.',
                          settings: 'Set access lifetimes and require regular reauthorization.',
                        } as Record<View, string>
                      )[view]
                    }
                  </p>
                </div>
                {view === 'overview' ? (
                  <button className="primary" onClick={() => go('connections')}>
                    Connect a tool <span>＋</span>
                  </button>
                ) : view === 'agents' ? (
                  <button className="primary" onClick={openAgent} disabled={!active.length}>
                    Authorize an agent <span>＋</span>
                  </button>
                ) : null}
              </div>
              {view === 'overview' && (
                <>
                  <section className="gateway-map" aria-label="Agent request flow">
                    <div className="map-source">
                      <span className="eyebrow">YOUR AGENTS</span>
                      <strong>Claude · Codex · Gemini</strong>
                      <small>or your own bot</small>
                    </div>
                    <div className="map-line">
                      <span>MCP request</span>
                    </div>
                    <div className="map-gate">
                      <span className="gate-symbol">⛨</span>
                      <div>
                        <strong>ArgosMCP</strong>
                        <span>Identity → Policy → Your device</span>
                      </div>
                      <b>ACCESS CONTROL</b>
                    </div>
                    <div className="map-line">
                      <span>authorized access</span>
                    </div>
                    <div className="map-dest">
                      <div>
                        {['slack', 'notion', 'linear', 'engram'].map((p) => (
                          <ProviderIcon key={p} provider={p} />
                        ))}
                      </div>
                      <small>Tools & memory</small>
                    </div>
                  </section>
                  <div className="stats">
                    <button onClick={() => go('connections')}>
                      <span>Active connections</span>
                      <strong>{active.length.toString().padStart(2, '0')}</strong>
                      <small>
                        of {connections.length} connections <b>↗</b>
                      </small>
                    </button>
                    <button onClick={() => go('approvals')}>
                      <span>Waiting for you</span>
                      <strong className="amber-text">
                        {String(data.approvals.length).padStart(2, '0')}
                      </strong>
                      <small>
                        actions to review <b>↗</b>
                      </small>
                    </button>
                    <button onClick={() => go('engram')}>
                      <span>Engram contexts</span>
                      <strong>
                        {connections
                          .filter((c) => c.provider === 'engram')
                          .length.toString()
                          .padStart(2, '0')}
                      </strong>
                      <small>
                        personal and team <b>↗</b>
                      </small>
                    </button>
                    <button onClick={() => go('settings')}>
                      <span>Connection lifetime</span>
                      <strong>
                        {data.org.lease_hours % 24 === 0
                          ? data.org.lease_hours / 24
                          : data.org.lease_hours}
                        <em>{data.org.lease_hours % 24 === 0 ? ' days' : ' h'}</em>
                      </strong>
                      <small>
                        maximum lifetime <b>↗</b>
                      </small>
                    </button>
                  </div>
                  <div className="overview-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Your connections</h2>
                        <button className="text-button" onClick={() => go('connections')}>
                          View all ↗
                        </button>
                      </div>
                      {connections.length ? (
                        connections.slice(0, 5).map((c) => (
                          <div className="connection-row" key={c.id}>
                            <ProviderIcon provider={c.provider} />
                            <div className="grow">
                              <strong>{c.label}</strong>
                              <small>
                                {scopes[c.scope]} · {remaining(c.expiresAt)}
                              </small>
                            </div>
                            <span className={`pill ${c.status === 'active' ? 'allow' : 'block'}`}>
                              {c.status === 'active' ? 'Active' : 'Inactive'}
                            </span>
                          </div>
                        ))
                      ) : (
                        <Empty title="Connect your first tool">
                          Start with Slack, Notion or Linear.
                        </Empty>
                      )}
                    </section>
                    <section className="panel principles">
                      <span className="eyebrow">THREE CLEAR CHOICES</span>
                      <h2>
                        You decide
                        <br />
                        what happens next.
                      </h2>
                      {['allow', 'approve', 'block'].map((effect, i) => (
                        <div className="principle" key={effect}>
                          <span className={`rule-dot ${effect}`}>{['✓', '◷', '×'][i]}</span>
                          <div>
                            <strong>{effects[effect]}</strong>
                            <p>
                              {
                                [
                                  'The agent acts within its authorized scope.',
                                  'Review the exact arguments before execution.',
                                  'The request is blocked before it reaches your tool.',
                                ][i]
                              }
                            </p>
                          </div>
                        </div>
                      ))}
                      <button className="text-button" onClick={() => go('policies')}>
                        Manage access rules →
                      </button>
                    </section>
                  </div>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Recent activity</h2>
                      <button className="text-button" onClick={() => go('activity')}>
                        View activity ↗
                      </button>
                    </div>
                    <Audit rows={data.audit.slice(0, 5)} />
                  </section>
                </>
              )}
              {view === 'connections' && (
                <>
                  <section className="panel">
                    <h2>Your personal devices</h2>
                    <p>
                      Pair from Argos Personal. Keep it running to execute tools and review
                      approvals.
                    </p>
                    {(data.devices ?? []).map((d: any) => (
                      <div className="connection-row" key={d.id}>
                        <div className="grow">
                          <strong>{d.label}</strong>
                          <small>
                            {d.status} · Last seen {d.last_seen ? date(d.last_seen) : 'never'}
                          </small>
                        </div>
                        <button
                          disabled={d.status !== 'active'}
                          onClick={() =>
                            setModal({
                              title: 'Disconnect this device?',
                              content: (
                                <div className="form-stack">
                                  <p>
                                    New tool calls will be blocked. The device will revoke its
                                    provider tokens when it reconnects.
                                  </p>
                                  <button
                                    className="danger"
                                    onClick={() =>
                                      action(async () => {
                                        await api(`${base}/devices/${d.id}/revoke`, {});
                                        setModal(null);
                                      }, 'Device revoked.')
                                    }
                                  >
                                    Disconnect device
                                  </button>
                                </div>
                              ),
                            })
                          }
                        >
                          Revoke device
                        </button>
                      </div>
                    ))}
                  </section>
                  <div className="provider-grid">
                    {['slack', 'notion', 'linear'].map((provider) => (
                      <section className="panel provider-card" key={provider}>
                        <ProviderIcon provider={provider} />
                        <h2>{providerNames[provider]}</h2>
                        <p>
                          {
                            (
                              {
                                slack: 'Messages and channels for your work.',
                                notion: 'Documents and shared knowledge.',
                                linear: 'Issues and projects for your team.',
                              } as Record<string, string>
                            )[provider]
                          }
                        </p>
                        <button onClick={() => openConnect(provider)}>
                          Connect {providerNames[provider]} <span>↗</span>
                        </button>
                      </section>
                    ))}
                  </div>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Workspace connections</h2>
                      <span className="muted">
                        Reauthorize every {duration(data.org.lease_hours)}
                      </span>
                    </div>
                    {connections.map((c) => (
                      <div className="connection-row wrap" key={c.id}>
                        <ProviderIcon provider={c.provider} />
                        <div className="grow">
                          <strong>{c.label}</strong>
                          <small>
                            {scopes[c.scope]} · Expires {date(c.expiresAt)}
                            {c.revokeStatus !== 'none' ? ` · Revocation: ${c.revokeStatus}` : ''}
                          </small>
                        </div>
                        <span className={`pill ${c.status === 'active' ? 'allow' : 'block'}`}>
                          {c.status === 'active' ? 'Active' : 'Reconnect required'}
                        </span>
                        <button disabled={c.status !== 'active'} onClick={() => openTest(c)}>
                          Test
                        </button>
                        {(admin || c.scope === 'personal') && (
                          <button
                            className="text-danger"
                            onClick={() => confirmRevoke(c)}
                            disabled={c.status !== 'active'}
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    ))}
                    {!connections.length && (
                      <Empty title="No connections yet">
                        Choose a service above to get started.
                      </Empty>
                    )}
                  </section>
                </>
              )}
              {view === 'policies' && (
                <>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Company rules</h2>
                        <p>
                          Mandatory for everyone, including personal connections. New tools require
                          approval.
                        </p>
                      </div>
                      <span className="pill neutral">{admin ? 'Administrator' : 'Read only'}</span>
                    </div>
                    {data.companyPolicies.map((policy: any) => (
                      <div className="policy-row" key={policy.tool}>
                        <div className="inline-provider">
                          <ProviderIcon provider={policy.provider} />
                          <div>
                            <strong>{policy.title}</strong>
                            <small>
                              {policy.write ? 'Write' : 'Read'} · <code>{policy.tool}</code>
                            </small>
                          </div>
                        </div>
                        <div
                          className="segmented"
                          role="group"
                          aria-label={`Company rule for ${policy.title}`}
                        >
                          {['allow', 'approve', 'block'].map((effect) => (
                            <button
                              key={effect}
                              disabled={!admin || busy}
                              aria-pressed={policy.effect === effect}
                              className={policy.effect === effect ? effect : ''}
                              onClick={() =>
                                action(
                                  () =>
                                    api(
                                      `${base}/company-policies`,
                                      { tool: policy.tool, effect },
                                      'PUT',
                                    ),
                                  'Company rule updated.',
                                )
                              }
                            >
                              {effects[effect]}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </section>
                  <div className="page-heading">
                    <div>
                      <h2>My restrictions</h2>
                      <p>
                        Add stricter rules for your own agents. Company restrictions always apply.
                      </p>
                    </div>
                  </div>
                  {connections.map((c) => (
                    <section className="panel policy-panel" key={c.id}>
                      <div className="panel-heading">
                        <div className="inline-provider">
                          <ProviderIcon provider={c.provider} />
                          <h2>{c.label}</h2>
                        </div>
                        <span className="muted">{scopes[c.scope]}</span>
                      </div>
                      {c.policies.map((policy) => (
                        <div className="policy-row" key={policy.tool}>
                          <div>
                            <strong>{policy.title}</strong>
                            <small>
                              Company: {effects[policy.companyEffect]} · Effective:{' '}
                              {effects[policy.effect]}
                            </small>
                          </div>
                          <div
                            className="segmented"
                            role="group"
                            aria-label={`My rule for ${policy.title} in ${c.label}`}
                          >
                            {['inherit', 'approve', 'block'].map((effect) => (
                              <button
                                key={effect}
                                disabled={busy}
                                aria-pressed={policy.personalEffect === effect}
                                className={
                                  policy.personalEffect === effect
                                    ? effect === 'inherit'
                                      ? 'neutral'
                                      : effect
                                    : ''
                                }
                                onClick={() =>
                                  action(
                                    () =>
                                      api(
                                        `${base}/my-restrictions`,
                                        { connectionId: c.id, tool: policy.tool, effect },
                                        'PUT',
                                      ),
                                    'Personal restriction updated.',
                                  )
                                }
                              >
                                {effect === 'inherit' ? 'Use company rule' : effects[effect]}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </section>
                  ))}
                </>
              )}
              {view === 'approvals' && (
                <>
                  {data.approvals.length ? (
                    data.approvals.map((a: any) => {
                      const c = connections.find((c) => c.id === a.connectionId);
                      return (
                        <section className="panel approval-card" key={a.id}>
                          <div className="panel-heading">
                            <div className="inline-provider">
                              <ProviderIcon provider={c?.provider ?? 'engram'} />
                              <div>
                                <h2>
                                  {c?.policies.find((p) => p.tool === a.tool)?.title ?? a.tool}
                                </h2>
                                <small className="muted">
                                  {c?.label} · {date(a.createdAt)}
                                </small>
                              </div>
                            </div>
                            <span className="pill approve">Needs review</span>
                          </div>
                          <dl className="approval-details">
                            <div>
                              <dt>Requested by</dt>
                              <dd>
                                {data.members.find((m: any) => m.id === a.userId)?.name ?? 'Member'}
                              </dd>
                            </div>
                            <div>
                              <dt>Expires</dt>
                              <dd>{date(a.expiresAt)}</dd>
                            </div>
                            <div>
                              <dt>Scope</dt>
                              <dd>{scopes[c?.scope ?? 'personal']}</dd>
                            </div>
                          </dl>
                          <pre>{JSON.stringify(a.args, null, 2)}</pre>
                          <div className="approval-footer">
                            <small>This decision applies only to these exact arguments.</small>
                            <div className="button-row">
                              <button
                                disabled={busy}
                                onClick={() =>
                                  action(
                                    () => api(`${base}/approvals/${a.id}`, { approve: false }),
                                    'Action denied.',
                                  )
                                }
                              >
                                Deny
                              </button>
                              <button
                                className="primary"
                                disabled={busy}
                                onClick={() =>
                                  action(async () => {
                                    const r = await api(`${base}/approvals/${a.id}`, {
                                      approve: true,
                                    });
                                    setNotice(
                                      r.status === 'completed'
                                        ? 'Action completed.'
                                        : `Status: ${r.status}. Check activity before retrying.`,
                                    );
                                  })
                                }
                              >
                                Approve action ✓
                              </button>
                            </div>
                          </div>
                        </section>
                      );
                    })
                  ) : (
                    <Empty title="You’re all caught up">
                      Agent approval requests will appear here. Try a tool from Connections to see
                      the flow.
                    </Empty>
                  )}
                </>
              )}
              {view === 'agents' && (
                <>
                  <section className="endpoint">
                    <div>
                      <span className="eyebrow">YOUR MCP ENDPOINT</span>
                      <code>{session.mcpUrl}</code>
                      <p>
                        Add this URL to an MCP OAuth client. Sign in with Google and choose which
                        connections it can use.
                      </p>
                    </div>
                    <button onClick={() => copy(session.mcpUrl)}>Copy URL</button>
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Connect one service</h2>
                      <span className="muted">Separate MCP endpoints</span>
                    </div>
                    {['slack', 'notion', 'linear', 'engram'].map((provider) => (
                      <div className="connection-row" key={provider}>
                        <ProviderIcon provider={provider} />
                        <div className="grow">
                          <strong>{providerNames[provider]}</strong>
                          <small>
                            {session.mcpUrl}/{provider}
                          </small>
                        </div>
                        <button onClick={() => copy(session.mcpUrl + '/' + provider)}>
                          Copy URL
                        </button>
                      </div>
                    ))}
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Authorized agents</h2>
                      <span className="muted">
                        Maximum lifetime: {duration(data.org.grant_hours)}
                      </span>
                    </div>
                    {data.grants.map((g: any) => (
                      <div className="connection-row wrap" key={g.id}>
                        <span className="agent-icon">⌘</span>
                        <div className="grow">
                          <strong>{g.label}</strong>
                          <small>
                            {g.connections.length} connections · {date(g.expiresAt)}
                          </small>
                        </div>
                        <span
                          className={`pill ${g.revoked || g.expiresAt <= Date.now() ? 'block' : 'allow'}`}
                        >
                          {g.revoked
                            ? 'Revoked'
                            : g.expiresAt <= Date.now()
                              ? 'Expired'
                              : 'Authorized'}
                        </span>
                        <button
                          disabled={g.revoked || busy}
                          onClick={() =>
                            action(
                              () => api(`${base}/grants/${g.id}/revoke`, {}),
                              'Agent access revoked.',
                            )
                          }
                        >
                          Revoke
                        </button>
                      </div>
                    ))}
                    {!data.grants.length && (
                      <Empty title="No agents connected">
                        Connect a client with OAuth or create access for your bot.
                      </Empty>
                    )}
                  </section>
                </>
              )}
              {view === 'engram' && (
                <>
                  <div className="engram-intro">
                    <div>
                      <span className="context-orbit personal-orbit">◎</span>
                      <h2>Personal context</h2>
                      <p>
                        Your notes and working memory. Only you can access them, including in a
                        company workspace.
                      </p>
                      <span className="pill neutral">Only you</span>
                    </div>
                    <div>
                      <span className="context-orbit team-orbit">◉</span>
                      <h2>Team context</h2>
                      <p>
                        Shared decisions, documents and knowledge. Removing a member immediately
                        removes their access.
                      </p>
                      <span className="pill neutral">Team members</span>
                    </div>
                  </div>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Connected contexts</h2>
                      <span className="muted">Explicit access only</span>
                    </div>
                    {connections
                      .filter((c) => c.provider === 'engram')
                      .map((c) => (
                        <div className="connection-row wrap" key={c.id}>
                          <ProviderIcon provider="engram" />
                          <div className="grow">
                            <strong>{c.label}</strong>
                            <small>
                              {c.scope === 'personal'
                                ? 'Private · only you'
                                : data.teams.find((t: any) => t.id === c.teamId)?.name}{' '}
                              · {remaining(c.expiresAt)}
                            </small>
                          </div>
                          <button
                            disabled={c.status !== 'active'}
                            onClick={() => openTest(c, 'engram_recall')}
                          >
                            Search
                          </button>
                          <button
                            disabled={c.status !== 'active'}
                            onClick={() => openTest(c, 'engram_remember')}
                          >
                            Remember
                          </button>
                        </div>
                      ))}
                    {!connections.some((c) => c.provider === 'engram') && (
                      <Empty title="No contexts connected">
                        Create your personal or team context in Argos Personal → Connections.
                      </Empty>
                    )}
                  </section>
                  <div className="info-line">
                    Create contexts in Argos Personal → Connections. Memory stays encrypted on the
                    hosting device; team access is checked for every action. Keep that device
                    online.
                  </div>
                </>
              )}
              {view === 'teams' && (
                <>
                  <div className="button-row section-actions">
                    {admin && (
                      <>
                        <button
                          className="primary"
                          onClick={() =>
                            setModal({
                              title: 'Create team',
                              content: (
                                <SimpleForm
                                  label="Team name"
                                  onSubmit={(value) =>
                                    action(async () => {
                                      await api(`${base}/teams`, { name: value });
                                      setModal(null);
                                    }, 'Team created.')
                                  }
                                />
                              ),
                            })
                          }
                        >
                          Create team ＋
                        </button>
                        <button
                          onClick={() =>
                            setModal({
                              title: 'Invite member',
                              content: (
                                <InviteForm
                                  onSubmit={(input) =>
                                    action(async () => {
                                      const result = await api(`${base}/invitations`, input);
                                      setModal({
                                        title: 'Invitation ready',
                                        content: (
                                          <div className="form-stack">
                                            <p>
                                              Share this link with your teammate. They must use the
                                              invited Google account. No invitation email has been
                                              sent.
                                            </p>
                                            <textarea readOnly value={result.url} />
                                            <button
                                              className="primary"
                                              onClick={() => copy(result.url)}
                                            >
                                              Copy link
                                            </button>
                                          </div>
                                        ),
                                      });
                                    })
                                  }
                                />
                              ),
                            })
                          }
                        >
                          Invite member ↗
                        </button>
                      </>
                    )}
                  </div>
                  <div className="team-grid">
                    {data.teams.map((t: any) => (
                      <section className="panel" key={t.id}>
                        <div className="panel-heading">
                          <h2>{t.name}</h2>
                          <span className="pill neutral">{t.members.length} members</span>
                        </div>
                        {data.members.map((m: any) => (
                          <label className="team-member" key={m.id}>
                            <span className="avatar">{m.name.slice(0, 1)}</span>
                            <span className="grow">
                              {m.name}
                              <small>{m.email}</small>
                            </span>
                            <input
                              type="checkbox"
                              aria-label={`Access for ${m.name} to ${t.name}`}
                              checked={t.members.includes(m.id)}
                              disabled={!admin || busy}
                              onChange={(e) =>
                                action(
                                  () =>
                                    api(
                                      `${base}/teams/${t.id}/members`,
                                      { userId: m.id, add: e.target.checked },
                                      'PUT',
                                    ),
                                  'Team membership updated.',
                                )
                              }
                            />
                          </label>
                        ))}
                      </section>
                    ))}
                  </div>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Workspace members</h2>
                    </div>
                    {data.members.map((m: any) => (
                      <div className="connection-row wrap" key={m.id}>
                        <span className="avatar">{m.name.slice(0, 1)}</span>
                        <div className="grow">
                          <strong>{m.name}</strong>
                          <small>{m.email}</small>
                        </div>
                        <span className="pill neutral">
                          {m.role === 'owner'
                            ? 'Owner'
                            : m.role === 'admin'
                              ? 'Administrator'
                              : 'Member'}
                        </span>
                        {admin && m.role !== 'owner' && (
                          <button
                            onClick={() =>
                              setModal({
                                title: `Remove ${m.name} ?`,
                                content: (
                                  <div className="form-stack">
                                    <p>
                                      Their access to this workspace and its team contexts will end
                                      immediately.
                                    </p>
                                    <button
                                      className="danger"
                                      onClick={() =>
                                        action(async () => {
                                          await api(`${base}/members/${m.id}`, {}, 'DELETE');
                                          setModal(null);
                                        }, 'Member access removed.')
                                      }
                                    >
                                      Remove member
                                    </button>
                                  </div>
                                ),
                              })
                            }
                          >
                            Remove access
                          </button>
                        )}
                      </div>
                    ))}
                  </section>
                </>
              )}
              {view === 'activity' && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Workspace activity</h2>
                    <span className="muted">60 most recent events</span>
                  </div>
                  <Audit rows={data.audit} />
                  <div className="panel-note">
                    The audit log records decisions and identifiers, without credentials or memory
                    content. Entries are hash-chained for integrity checks.
                  </div>
                </section>
              )}
              {view === 'settings' && (
                <SettingsForm
                  key={`${orgId}:${data.org.revision}`}
                  org={data.org}
                  admin={admin}
                  busy={busy}
                  onSubmit={(input) =>
                    action(
                      () => api(`${base}/settings`, input, 'PUT'),
                      'Lifetimes updated. The new limits apply immediately to existing access.',
                    )
                  }
                />
              )}
            </>
          )}
        </main>
        <footer className="footer">
          <span>ArgosMCP</span>
          <span>Permission before action.</span>
          <span>{data?.org.name}</span>
        </footer>
      </div>
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section className="modal" role="dialog" aria-modal="true" aria-label={modal.title}>
            <div className="panel-heading">
              <h2>{modal.title}</h2>
              <button autoFocus aria-label="Close" onClick={() => setModal(null)}>
                ×
              </button>
            </div>
            {modal.content}
            {busy && <p role="status">Working…</p>}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function Audit({ rows }: { rows: any[] }) {
  return rows.length ? (
    <div className="audit-list">
      {rows.map((r) => (
        <div className="audit-row" key={r.id}>
          <span
            className={`audit-mark ${r.event.includes('denied') || r.event.includes('rejected') ? 'red' : ''}`}
          >
            ↳
          </span>
          <div className="grow">
            <strong>{events[r.event] ?? r.event}</strong>
            <small>{r.entity_id ? r.entity_id.slice(0, 8) : 'Company'}</small>
          </div>
          <time>{date(r.created_at)}</time>
        </div>
      ))}
    </div>
  ) : (
    <Empty title="Your activity starts here">
      Your agents’ actions and decisions will appear here.
    </Empty>
  );
}
function SimpleForm({ label, onSubmit }: { label: string; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <label>
        {label}
        <input required maxLength={120} value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <button className="primary">Create</button>
    </form>
  );
}
function InviteForm({ onSubmit }: { onSubmit: (v: any) => void }) {
  const [email, setEmail] = useState(''),
    [role, setRole] = useState('member');
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ email, role });
      }}
    >
      <label>
        Teammate’s Google email
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">Member</option>
          <option value="admin">Administrator</option>
        </select>
      </label>
      <button className="primary">Create invitation link</button>
    </form>
  );
}
function AgentForm({
  mcpUrl,
  connections,
  onSubmit,
}: {
  mcpUrl: string;
  connections: Connection[];
  onSubmit: (v: any) => void;
}) {
  const [label, setLabel] = useState(''),
    [ids, setIds] = useState<string[]>([]),
    [provider, setProvider] = useState('');
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ label, connections: ids, resource: mcpUrl + (provider ? '/' + provider : '') });
      }}
    >
      <label>
        Agent name
        <input
          required
          maxLength={120}
          placeholder="My clawbot"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label>
        Tool access
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setIds([]);
          }}
        >
          <option value="">All authorized services</option>
          {['slack', 'notion', 'linear', 'engram'].map((p) => (
            <option key={p} value={p}>
              {providerNames[p]}
            </option>
          ))}
        </select>
      </label>
      <div className="check-list">
        {connections
          .filter((c) => !provider || c.provider === provider)
          .map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={ids.includes(c.id)}
                onChange={(e) =>
                  setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))
                }
              />
              <ProviderIcon provider={c.provider} />
              <span>
                {c.label}
                <small>{scopes[c.scope]}</small>
              </span>
            </label>
          ))}
      </div>
      <button className="primary" disabled={!ids.length}>
        Create scoped access
      </button>
    </form>
  );
}
const examples: Record<string, any> = {
  slack_history: { channel: 'C_CHANNEL', limit: 20 },
  slack_send_message: { channel: 'C_CHANNEL', text: 'Hello, here is the team update.' },
  slack_delete_message: { channel: 'C_CHANNEL', ts: '1234567890.123456' },
  notion_search: { query: 'Product decisions' },
  notion_read_page: { page_id: '00000000-0000-4000-8000-000000000000' },
  notion_append: {
    page_id: '00000000-0000-4000-8000-000000000000',
    text: 'Decision to add to this page.',
  },
  linear_search: { query: 'ArgosMCP' },
  linear_create_issue: {
    team_id: '00000000-0000-4000-8000-000000000000',
    title: 'Prepare launch',
    description: 'Define the launch steps.',
  },
  engram_recall: { query: 'What decisions have we made about ArgosMCP?', limit: 8 },
  engram_remember: {
    content: 'OAuth access expires after seven days by default.',
    title: 'Access lifetime',
  },
  engram_forget: { id: 'memory-id' },
};
function TestForm({
  connection,
  initialTool,
  onSubmit,
}: {
  connection: Connection;
  initialTool?: string;
  onSubmit: (v: any) => void;
}) {
  const [tool, setTool] = useState(initialTool ?? connection.policies[0].tool),
    [args, setArgs] = useState(
      JSON.stringify(examples[initialTool ?? connection.policies[0].tool], null, 2),
    ),
    [error, setError] = useState('');
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          const parsed = JSON.parse(args);
          setError('');
          onSubmit({ tool, args: parsed });
        } catch {
          setError('Arguments must be a valid JSON object.');
        }
      }}
    >
      <p>
        {connection.demo
          ? 'This call is simulated. Access rules and approvals are enforced.'
          : 'This call uses a live connection. Review the arguments before requesting it.'}
      </p>
      <label>
        Action
        <select
          value={tool}
          onChange={(e) => {
            setTool(e.target.value);
            setArgs(JSON.stringify(examples[e.target.value], null, 2));
          }}
        >
          {connection.policies.map((p) => (
            <option key={p.tool} value={p.tool}>
              {p.title} · {effects[p.effect]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Exact arguments
        <textarea
          className="code-input"
          rows={8}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="primary">Request action →</button>
    </form>
  );
}
function SettingsForm({
  org,
  admin,
  busy,
  onSubmit,
}: {
  org: any;
  admin: boolean;
  busy: boolean;
  onSubmit: (v: any) => void;
}) {
  const [orgName, setName] = useState(org.name),
    [lease, setLease] = useState(org.lease_hours),
    [grant, setGrant] = useState(org.grant_hours);
  return (
    <form
      className="settings-grid"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name: orgName, leaseHours: lease, grantHours: grant });
      }}
    >
      <section className="panel form-stack">
        <h2>Company settings</h2>
        <label>
          Company name
          <input
            required
            maxLength={120}
            disabled={!admin}
            value={orgName}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="form-divider" />
        <label>
          Require tool reauthorization
          <select
            disabled={!admin}
            value={[24, 168, 720].includes(lease) ? lease : 'custom'}
            onChange={(e) => setLease(e.target.value === 'custom' ? 48 : Number(e.target.value))}
          >
            <option value={24}>Every day</option>
            <option value={168}>Every week</option>
            <option value={720}>Every 30 days</option>
            <option value="custom">Custom interval</option>
          </select>
        </label>
        <label>
          Maximum lifetime in hours
          <input
            type="number"
            required
            min={1}
            max={8760}
            disabled={!admin}
            value={lease}
            onChange={(e) => setLease(Number(e.target.value))}
          />
          <small>
            Starts at the last OAuth connection. Token refresh never extends this lifetime.
          </small>
        </label>
        <div className="form-divider" />
        <label>
          Maximum agent access lifetime
          <input
            type="number"
            required
            min={1}
            max={8760}
            disabled={!admin}
            value={grant}
            onChange={(e) => setGrant(Number(e.target.value))}
          />
          <small>In hours. Every agent must be authorized again when its access expires.</small>
        </label>
        <button className="primary" disabled={!admin || busy}>
          Save limits
        </button>
      </section>
      <section className="panel security-explanation">
        <span className="eyebrow">WHEN ACCESS EXPIRES</span>
        <h2>
          Access ends.
          <br />
          You stay in control.
        </h2>
        <div className="principle">
          <span className="rule-dot block">×</span>
          <div>
            <strong>Immediate enforcement</strong>
            <p>Expiration is checked on every call, even if scheduled cleanup is delayed.</p>
          </div>
        </div>
        <div className="principle">
          <span className="rule-dot approve">↻</span>
          <div>
            <strong>Provider revocation</strong>
            <p>
              The personal connector revokes provider access when online. Company access is blocked
              immediately; offline devices cannot receive new actions.
            </p>
          </div>
        </div>
        <div className="principle">
          <span className="rule-dot allow">✓</span>
          <div>
            <strong>Fresh authorization</strong>
            <p>Reconnection is required. Shorter lifetimes also apply to existing connections.</p>
          </div>
        </div>
        <div className="info-line">
          Provider credentials stay encrypted on the personal device and are never sent to Argos or
          agents. These controls apply to access through ArgosMCP.
        </div>
      </section>
    </form>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
