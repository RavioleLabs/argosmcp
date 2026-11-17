export const personalRelease = {
  url: 'https://github.com/RavioleLabs/argosmcp/releases/download/personal-v0.1.0-preview.1/Argos-Personal-macOS-arm64.zip',
  notes: 'https://github.com/RavioleLabs/argosmcp/releases/tag/personal-v0.1.0-preview.1',
  source: 'https://github.com/RavioleLabs/argosmcp#start-locally',
};

// Navigation must retain the company prefix, including after pairing and consent.
export const workspacePage = (prefix: string, view?: string) =>
  prefix + '/' + (view ? '?view=' + encodeURIComponent(view) : '');

// Progress reflects this user's live access, never another company member's setup.
export function setupProgress(data: any, userId: string, now = Date.now()) {
  const devices = (data.devices ?? []).filter(
    (d: any) =>
      d.user_id === userId &&
      d.status === 'active' &&
      Math.min(d.expires_at, d.created_at + data.org.grant_hours * 3600000) > now,
  );
  const connections = (data.connections ?? []).filter(
    (c: any) =>
      c.ownerId === userId && c.local && !c.demo && c.status === 'active' && c.expiresAt > now,
  );
  const authorized = (data.grants ?? []).some(
    (g: any) =>
      g.userId === userId &&
      !g.revoked &&
      g.expiresAt > now &&
      connections.some((c: any) => g.connections.includes(c.id)),
  );
  return {
    paired: devices.length > 0,
    online: devices.some((d: any) => d.last_seen > now - 90000),
    connected: devices.length > 0 && connections.length > 0,
    authorized: devices.length > 0 && connections.length > 0 && authorized,
  };
}
