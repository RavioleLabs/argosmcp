import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
// Configure without printing credentials. Supply an official Google OAuth client JSON file.
process.umask(0o077);
const [originArg, ownerEmail, googleFile, company = 'My company'] = process.argv.slice(2);
if (!originArg || !ownerEmail || !googleFile) {
  console.error(
    'Usage: node scripts/configure-hosted.mjs https://company.example.com owner@example.com /path/to/google-client.json',
  );
  process.exit(1);
}
const origin = new URL(originArg);
if (
  origin.origin !== originArg ||
  origin.protocol !== 'https:' ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)
)
  throw Error('Provide a canonical HTTPS origin and a valid owner email.');
const google = JSON.parse(readFileSync(googleFile, 'utf8')).web;
if (
  !google?.client_id ||
  !google?.client_secret ||
  !google.redirect_uris?.includes(originArg + '/auth/google/callback')
)
  throw Error(
    'Google client must be a Web application with this exact /auth/google/callback redirect.',
  );
mkdirSync('.data', { recursive: true, mode: 0o700 });
const path = '.data/cloudflare.secrets.json';
const secrets = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const tenants = JSON.parse(secrets.ARGOS_TENANTS_JSON ?? '{}');
if (tenants[originArg] && tenants[originArg].ownerEmail !== ownerEmail.toLowerCase())
  throw Error(
    'Existing workspace owner differs. Explicitly migrate ownership instead of replacing it.',
  );
tenants[originArg] ??= {
  id: randomUUID(),
  name: process.env.ARGOS_COMPANY_NAME ?? company,
  ownerEmail: ownerEmail.toLowerCase(),
};
secrets.ARGOS_TENANTS_JSON = JSON.stringify(tenants);
secrets.ARGOS_VAULT_KEYRING ??= JSON.stringify({ v1: randomBytes(32).toString('base64') });
secrets.ARGOS_DASHBOARD_URL ??= 'https://argos-dashboard.leraviole.workers.dev';
secrets.ARGOS_DASHBOARD_VERSION ??= '';
secrets.ARGOS_SERVER_CUSTODY ??= '0';
secrets.ARGOS_DEPLOYMENT ??= 'company-cloudflare';
secrets.ARGOS_PROVIDER_VAULT_KEYRING ??= JSON.stringify({ v1: randomBytes(32).toString('base64') });
secrets.SLACK_PUBLIC_CLIENT_ID ??= '';
secrets.LINEAR_PUBLIC_CLIENT_ID ??= '';
secrets.GOOGLE_CLIENT_ID = google.client_id;
secrets.GOOGLE_CLIENT_SECRET = google.client_secret;
writeFileSync(path, JSON.stringify(secrets, null, 2), { mode: 0o600 });
chmodSync(path, 0o600);
console.log(
  'Workspace configuration saved locally. Existing encryption keys and company IDs preserved.',
);
console.log('Deploy: npx cf deploy --mode cloudflare --secrets-file .data/cloudflare.secrets.json');
