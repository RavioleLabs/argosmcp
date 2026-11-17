const $ = (id) => document.getElementById(id);
let profiles = [],
  selected = '',
  tab = 'approvals',
  busy = false,
  lastCount = 0,
  addingWorkspace = false;
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
async function api(path, body) {
  const r = await fetch(path, {
    credentials: 'same-origin',
    ...(body !== undefined
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function error(e) {
  $('error').textContent = e.message;
  $('error').hidden = false;
}
async function action(fn) {
  if (busy) return;
  busy = true;
  $('error').hidden = true;
  document.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    await fn();
    await load();
  } catch (e) {
    error(e);
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}
function native(message) {
  window.webkit?.messageHandlers?.argos?.postMessage(message);
}
function external(url) {
  const u = new URL(url);
  if (!['https:', 'http:'].includes(u.protocol)) return;
  if (window.webkit?.messageHandlers?.argos) native({ type: 'open', url: u.href });
  else window.open(u.href, '_blank', 'noopener,noreferrer');
}
function choose() {
  return profiles.find((p) => p.id === selected) || profiles[0];
}
function show() {
  const p = choose();
  ['welcome', 'pairing', 'approvals', 'connections', 'device'].forEach(
    (id) => ($(id).hidden = true),
  );
  document
    .querySelectorAll('[data-tab]')
    .forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('company').textContent = p?.identity?.name || 'Your personal connector';
  $('status').textContent = p?.status === 'active' ? 'Connected' : p?.status || 'Not connected';
  $('status').className = 'pill ' + (p?.status || '');
  if (!p || addingWorkspace) {
    $('welcome').hidden = false;
    return;
  }
  if (p.status === 'pending') {
    $('pairing').hidden = false;
    $('fingerprint').textContent = p.fingerprint;
    $('pair-link').href = p.pairUrl;
    return;
  }
  $(tab).hidden = false;
  $('dashboard').href = p.origin;
  renderActions(p);
  renderConnections(p);
}
function renderActions(p) {
  const list = $('actions');
  list.replaceChildren();
  const actions = p.actions || [];
  $('count').textContent = actions.length;
  native({ type: 'count', count: actions.length });
  if (
    actions.length > lastCount &&
    !window.webkit?.messageHandlers?.argos &&
    window.Notification?.permission === 'granted'
  )
    new Notification('Argos needs your approval', {
      body: 'Review the action in your personal connector.',
    });
  lastCount = actions.length;
  if (!actions.length) {
    const e = el('div', undefined, 'empty');
    e.append(
      el('div', '✓', 'mark'),
      el('h2', p.status === 'active' ? 'All clear.' : 'Actions are paused.'),
      el(
        'p',
        p.status === 'active'
          ? 'New requests will appear here. Keep Argos running to stay connected.'
          : 'Reconnect this device from the company dashboard. No tools run while it is offline.',
      ),
    );
    list.append(e);
    return;
  }
  for (const a of actions) {
    const c = p.connections.find((c) => c.id === a.connectionId),
      card = el('article', undefined, 'card'),
      meta = el('div', undefined, 'meta');
    meta.append(
      el('span', a.agent + ' · ' + (c?.label || 'Connection')),
      el('span', a.status === 'pending' ? 'Company approval needed' : 'Local confirmation needed'),
    );
    card.append(
      meta,
      el('h2', a.tool.replaceAll('_', ' ')),
      el('small', p.identity.name + ' · ' + (a.requester || p.identity.email)),
      el('pre', JSON.stringify(a.args, null, 2)),
      el('small', 'Expires ' + new Date(a.expiresAt).toLocaleTimeString()),
    );
    const buttons = el('div', undefined, 'actions');
    for (const [label, approve] of [
      ['Deny', false],
      ['Approve once', true],
    ]) {
      const b = el('button', label, approve ? 'primary' : '');
      b.onclick = () =>
        action(() => api('/api/decide', { profileId: p.id, id: a.id, digest: a.digest, approve }));
      buttons.append(b);
    }
    card.append(buttons);
    list.append(card);
  }
}
function renderConnections(p) {
  const team = $('memory-team'),
    prior = team.value;
  team.replaceChildren();
  for (const t of p.teams || []) {
    const o = el('option', t.name);
    o.value = t.id;
    team.append(o);
  }
  if ([...team.options].some((o) => o.value === prior)) team.value = prior;
  const list = $('connection-list');
  list.replaceChildren();
  for (const c of p.connections) {
    const card = el('article', undefined, 'card');
    card.append(
      el('h2', c.label),
      el('small', c.scope === 'team' ? 'Shared with your team' : 'Personal context'),
      el(
        'small',
        c.status === 'active' && c.registered === false
          ? 'Waiting for workspace registration'
          : c.status === 'active'
            ? 'On this device · expires ' + new Date(c.expiresAt).toLocaleString()
            : c.revocationPending
              ? 'Disconnected locally. Revoke access in the provider settings if retry fails.'
              : 'Disconnected',
      ),
    );
    if (c.status === 'active') {
      const label = el('label', undefined, 'check'),
        check = el('input');
      check.type = 'checkbox';
      check.checked = c.autoRead;
      check.onchange = () =>
        action(() =>
          api('/api/preferences', { profileId: p.id, id: c.id, autoRead: check.checked }),
        );
      label.append(
        check,
        document.createTextNode('Run company-approved reads without asking here'),
      );
      card.append(label, el('small', 'Writes always need your confirmation.'));
    }
    const b = el(
      'button',
      c.status === 'active' ? 'Disconnect' : 'Retry provider revocation',
      'danger',
    );
    b.onclick = () => {
      if (confirm('Disconnect ' + c.label + ' from this device?'))
        action(() => api('/api/disconnect', { profileId: p.id, id: c.id }));
    };
    card.append(b);
    list.append(card);
  }
}
async function load() {
  const data = await api('/api/state');
  profiles = data.profiles;
  if (!profiles.some((p) => p.id === selected)) selected = profiles[0]?.id || '';
  const select = $('workspace');
  select.replaceChildren();
  for (const p of profiles) {
    const o = el('option', p.identity?.name || p.label);
    o.value = p.id;
    select.append(o);
  }
  select.value = selected;
  $('callback').textContent = 'OAuth callback: ' + data.callback;
  show();
}
$('workspace').onchange = () => {
  selected = $('workspace').value;
  addingWorkspace = false;
  show();
};
document.querySelectorAll('[data-tab]').forEach(
  (b) =>
    (b.onclick = () => {
      tab = b.dataset.tab;
      addingWorkspace = false;
      show();
    }),
);
$('pair').onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const r = await api('/api/pair', { origin: $('origin').value, label: $('label').value });
    selected = r.id;
    addingWorkspace = false;
    external(r.url);
  });
};
$('provider').onchange = () => {
  $('client-id-label').hidden = $('provider').value === 'notion';
  $('connection-label').value = 'My ' + $('provider').selectedOptions[0].textContent;
};
$('connect').onsubmit = (e) => {
  e.preventDefault();
  const p = choose();
  if (p)
    action(async () => {
      const r = await api('/api/connect', {
        profileId: p.id,
        provider: $('provider').value,
        clientId: $('client-id').value,
        label: $('connection-label').value,
      });
      external(r.url);
    });
};
$('add-workspace').onclick = () => {
  addingWorkspace = true;
  show();
  $('origin').focus();
};
$('memory-scope').onchange = () => {
  $('memory-team-label').hidden = $('memory-scope').value !== 'team';
};
$('memory').onsubmit = (e) => {
  e.preventDefault();
  const p = choose();
  if (p)
    action(() =>
      api('/api/memory', {
        profileId: p.id,
        label: $('memory-label').value,
        scope: $('memory-scope').value,
        ...($('memory-scope').value === 'team' ? { teamId: $('memory-team').value } : {}),
      }),
    );
};
$('notifications').onclick = () => {
  if (window.webkit?.messageHandlers?.argos) native({ type: 'notifications' });
  else if (window.Notification) Notification.requestPermission();
};
for (const id of ['pair-link', 'dashboard'])
  $(id).onclick = (e) => {
    e.preventDefault();
    external(e.currentTarget.href);
  };
(async () => {
  try {
    const key = new URLSearchParams(location.hash.slice(1)).get('key');
    history.replaceState(null, '', '/');
    if (key) await api('/session', { key });
    await load();
    setInterval(() => {
      if (!busy) load().catch(error);
    }, 4000);
  } catch (e) {
    error(e);
  }
})();
