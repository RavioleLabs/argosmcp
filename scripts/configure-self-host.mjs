import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
process.umask(0o077);
const [address, owner, googleFile, company = 'My company'] = process.argv.slice(2);
if (!address || !owner || !googleFile)
  throw Error(
    'Usage: node scripts/configure-self-host.mjs https://argos.company.com owner@example.com /secure/google-client.json "Company name"',
  );
const url = new URL(address);
if (
  url.origin !== address ||
  url.protocol !== 'https:' ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)
)
  throw Error('Use a canonical HTTPS origin and valid owner email.');
const google = JSON.parse(readFileSync(googleFile, 'utf8')).web;
if (
  !google?.client_id ||
  !google.client_secret ||
  !google.redirect_uris?.includes(address + '/auth/google/callback')
)
  throw Error('Google Web client must register this exact /auth/google/callback.');
mkdirSync('.data', { recursive: true, mode: 0o700 });
const path = '.data/self-host.secrets.json';
const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const tenant = JSON.parse(saved.ARGOS_TENANTS_JSON ?? '{}')[address];
if (
  saved.ARGOS_ORIGIN &&
  (saved.ARGOS_ORIGIN !== address || tenant?.ownerEmail !== owner.toLowerCase())
)
  throw Error(
    'Existing installation identity differs. Use a separate installation for each company.',
  );
const configuration = {
  ...saved,
  ARGOS_ORIGIN: address,
  ARGOS_TENANTS_JSON: JSON.stringify({
    [address]: tenant ?? { id: randomUUID(), name: company, ownerEmail: owner.toLowerCase() },
  }),
  ARGOS_VAULT_KEYRING:
    saved.ARGOS_VAULT_KEYRING ?? JSON.stringify({ v1: randomBytes(32).toString('base64') }),
  ARGOS_PROVIDER_VAULT_KEYRING:
    saved.ARGOS_PROVIDER_VAULT_KEYRING ??
    JSON.stringify({ v1: randomBytes(32).toString('base64') }),
  ARGOS_SERVER_CUSTODY: saved.ARGOS_SERVER_CUSTODY ?? '0',
  ARGOS_DASHBOARD_URL: saved.ARGOS_DASHBOARD_URL ?? 'https://argos-dashboard.leraviole.workers.dev',
  GOOGLE_CLIENT_ID: google.client_id,
  GOOGLE_CLIENT_SECRET: google.client_secret,
};
// Compose single-quoted values are literal; reject characters that could escape their framing.
const entries = Object.entries(configuration);
if (entries.some(([, value]) => /['\r\n\0]/.test(String(value))))
  throw Error('Configuration contains unsupported characters.');
writeFileSync(path, JSON.stringify(configuration, null, 2), { mode: 0o600 });
writeFileSync(
  '.data/self-host.env',
  entries.map(([key, value]) => `${key}='${value}'`).join('\n') + '\n',
  { mode: 0o600 },
);
chmodSync(path, 0o600);
chmodSync('.data/self-host.env', 0o600);
console.log(
  'Saved company configuration privately; existing UUID and keyrings preserved. Start: docker compose up -d --build',
);
