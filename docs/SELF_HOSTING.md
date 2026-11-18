# Run ArgosMCP on your infrastructure

The MIT backend can run independently of Argos hosting. The hosted dashboard is a separately maintained service. It supplies public, versioned interface files; your backend serves them at its own origin. Browser API calls, Google login, cookies, MCP sessions, approvals and tool results stay on your backend. The publisher receives static-asset requests, not your browser's cookies or API payloads.

The dashboard executes code with access to your company session. Trust its publisher as a software supplier. Pin a release for controlled updates. This is not a zero-knowledge arrangement or a cross-origin API relay. If the publisher is unavailable, dashboard loads may fail; the backend does not fall back to Argos-managed workspaces.

## One company per Node installation

Use a separate installation, data volume, hostname, company UUID and keyrings for each company. Cloudflare's managed deployment instead uses a separate Durable Object database per company. Neither model protects against an administrator who controls the host or application updates.

1. Register a Google OAuth **Web application** with the exact redirect `https://argos.company.com/auth/google/callback`. Download its JSON to a secure location outside the repository.
2. Install Docker with Compose, clone the backend, and configure it:

   ```sh
   node scripts/configure-self-host.mjs https://argos.company.com owner@example.com /secure/google-client.json "Company name"
   docker compose up -d --build
   ```

   The script creates ignored mode-600 `.data/self-host.secrets.json` and `.data/self-host.env`. It preserves existing keys and refuses to overwrite another installation's identity. Never commit either file. The default provider vault is disabled.
3. Put an HTTPS reverse proxy in front of `127.0.0.1:4180`. Preserve the original Host header, support streaming MCP responses and disable logging of query strings, Authorization headers and cookies. The included Compose file exposes the backend only on host loopback; configure TLS before sending users to it.
4. Open your company URL, sign in with the configured owner's Google account, and create the workspace. Invite colleagues explicitly. The backend will not grant membership to anyone merely because they have a Google account.
5. Pair Argos Personal with this complete URL and connect an AI to `<company URL>/mcp`. Local token custody remains recommended and works with either hosting option.

For Node without Docker: use a supported Node version from package.json, `npm ci`, `npm run build`, load the generated environment securely, set `ARGOS_DATA_DIR` to a private persistent directory, and run `npm start` behind HTTPS. Keep separate processes/directories for separate companies.

## Hosted dashboard and controlled updates

`ARGOS_DASHBOARD_URL=https://argos-dashboard.leraviole.workers.dev` selects the trusted publisher. Its `/manifest.json` returns `apiVersion` and a release identifier. Set `ARGOS_DASHBOARD_VERSION` to that 16-character release identifier to pin it. The backend only fetches validated release HTML/assets; it never forwards incoming credentials or user-supplied destinations. Remove the variable to follow the publisher's latest release.

Edit `.data/self-host.secrets.json`, rerun the configuration command to regenerate the Compose environment, then `docker compose up -d`. Back up this JSON securely. Do not put real credentials in shell arguments or a public issue.

The hosted dashboard landing page accepts a company URL for navigation. That is a convenience, not proof of company ownership: users must verify the address supplied by their administrator. Sign-in happens on that destination.

## Optional provider credentials on the server

Local execution needs an online personal device. Server connections can run while that device is offline. They use the same company allow/approval/deny policies, grant restrictions and expiration settings, but have no second confirmation in Argos Personal.

Three independent steps are required:

1. The operator sets `ARGOS_SERVER_CUSTODY=1` and retains `ARGOS_PROVIDER_VAULT_KEYRING`, a dedicated encryption keyring distinct from `ARGOS_VAULT_KEYRING` for action data.
2. A workspace administrator enables **Security → Server-managed connections**, acknowledging operator access.
3. The user chooses server storage and explicitly consents before provider authorization. Existing local credentials are never transferred.

Notion registers its OAuth client dynamically with the official Notion MCP service. For Slack and Linear, configure a public PKCE OAuth app and set `SLACK_PUBLIC_CLIENT_ID` / `LINEAR_PUBLIC_CLIENT_ID`. Register the exact `<workspace URL>/oauth/callback/slack` or `/oauth/callback/linear`. For `/w/<UUID>` workspaces, the callback includes that prefix. Slack must enable PKCE and token rotation and allow the user scopes `channels:history,groups:history,chat:write`. Linear requests `read,write`. Provider registration/consent restrictions still apply; showing a connector does not mean its provider app has been configured.

OAuth state is short-lived, encrypted, single-use, and bound to the same signed-in account and browser. Tokens are encrypted with company/connection-associated data. Refresh never extends the company's lease. Authorization is checked again after refresh and immediately before tool dispatch. Disabling server custody blocks future dispatch and attempts upstream revocation. If a provider cannot confirm revocation, the dashboard reports a retry requirement; revoke access directly in provider settings. Already-dispatched writes cannot be recalled.

**The backend operator can decrypt server-held tokens.** At-rest encryption and separate vault keys do not prevent a compromised application/operator from using those tokens. Choose local custody when reducing centralized token exposure is the priority. Company rules cannot prevent a user from modifying their own local software or using tokens outside Argos.

## Operations

Persist `/data` and back up the database and both keyrings with restricted access. Losing a key makes its encrypted records unusable; deleting a key does not revoke a token at its provider. Preserve existing key IDs when rotating and migrate records before retiring old keys. The current active key ID is `v1`; do not blindly replace it. Test restoration before relying on backups.

Use least-privilege operator access, timely dependency updates and a reviewed release process. Monitor revocation failures without logging credentials, OAuth callback query strings, action bodies or returned documents. Define retention, deletion and incident response before commercial use. See [SECURITY.md](../SECURITY.md).

## Company Cloudflare and generic MCP connections

See [DEPLOYMENT_OPTIONS.md](DEPLOYMENT_OPTIONS.md) for company-owned Cloudflare deployment, remote MCP OAuth/bearer connections, independent action review and portal integration limits. Server custody is disabled by default for new generated deployments.
