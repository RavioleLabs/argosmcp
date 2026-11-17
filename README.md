# ArgosMCP + Argos Personal

Company policy for AI tools, with provider credentials kept on the user's device.

```text
Claude / Codex / Gemini → ArgosMCP → Argos Personal → Slack / Notion / Linear
                       ←          ←                ← result
```

ArgosMCP is a remote MCP server and company dashboard. Argos Personal is a local connector with a macOS menu-bar application. The connector makes outbound authenticated requests; it does not expose a public listener. Its temporary OAuth callback and local UI listen on loopback only.

This is an independent project at `~/raviolelabs/argosmcp`. It is not part of clawbots.

## What works

- Google sign-up, self-service workspace creation and switching, with a separate company database for every workspace.
- Mandatory company allow / approval / deny policies, with personal restrictions.
- Device pairing through the signed-in dashboard, with a fingerprint comparison and explicit company selection.
- Ed25519 device request proofs binding the full workspace URL, request path, timestamp, nonce and body. Replay protection persists across server restarts.
- Provider OAuth code exchange and refresh on the personal device: Slack and Linear PKCE; Notion's official MCP OAuth with public-client registration and PKCE.
- Provider credentials and the device private key encrypted in a local SQLite database. Its wrapping key is in macOS Keychain, Windows Credential Manager or Linux Secret Service. No plaintext-file fallback or iCloud synchronization setting.
- Local approvals showing the agent, company, account, exact arguments and expiry. A dashboard approval alone does not authorize local writes. Reads may be explicitly delegated locally.
- A final server policy/membership/grant/expiry check immediately before dispatch, atomic one-time claims, and a local durable journal. Ambiguous operations become `unknown`; they are not replayed automatically.
- Result delivery back through Argos, with known provider credentials redacted. Requests and results are not hidden from the hosted platform.
- Encrypted Engram contexts on the hosting device, private to one user or shared with current team members. Save, BM25 search with source references, and delete through `/mcp/engram`.
- Immediate server-side access revocation. Upstream token revocation happens from the online device and may require manual action in provider settings.

## Start locally

```sh
npm install
npm run build
npm run demo
```

The demo dashboard runs at `http://127.0.0.1:4180`. Its sample tool connections are simulations. Do not deploy demo mode publicly.

In a second terminal:

```sh
npm run local
```

On macOS, build and open the desktop app instead:

```sh
npm run build:desktop
open "build/Argos Personal.app"
```

The app includes the Node runtime and production dependencies for the Mac on which it is built. It has a **local ad-hoc signature**, not an Apple Developer ID signature or notarization. Windows/Linux can run the connector with Node; native installers for them are not included.

### Guided setup and Mac download

New workspaces open **Getting started**. The guide explains the browser dashboard and companion app before asking users to install anything, then walks through installation, pairing, a first tool and MCP client authorization. It remains available in the sidebar. Each teammate follows it with their own account and computer.

[Download Argos Personal for Apple silicon](https://github.com/RavioleLabs/argosmcp/releases/download/personal-v0.1.0-preview.1/Argos-Personal-macOS-arm64.zip) (macOS 26 or later, preview). Unzip, move the app to Applications, and open it. This is an ad-hoc signed build, **not Apple-notarized**; Gatekeeper may block it. A signed public installer is not available yet. [Release details and SHA-256 checksum](https://github.com/RavioleLabs/argosmcp/releases/tag/personal-v0.1.0-preview.1). Intel Macs, Windows and Linux currently require the source installation above.

### Pair and connect

1. Open Argos Personal and enter the company workspace URL (the demo URL above for a local test).
2. Sign in to the dashboard. Verify the same fingerprint in both places and explicitly pair the device to the chosen company.
3. Return to Argos Personal → Connections. Notion uses its own OAuth registration. Slack/Linear require a registered public OAuth client ID.
4. Authorize each provider in your browser. Tokens are exchanged by the local process, not the dashboard.
5. In the company dashboard, authorize an AI client for these connections. Add the remote `/mcp` URL (or `/mcp/slack`, `/mcp/notion`, `/mcp/linear`) to a client that supports MCP OAuth. For a manual test, create a scoped agent token in Agents & clients.
6. Ask the AI to list `argos_connections`, then call a tool with `connection_id` and a stable `request_id`. Review the request in Argos Personal. The AI checks `argos_result` until the action finishes. `approved` is not `completed`.

A cloud AI cannot reach your localhost MCP server. Use a deployed HTTPS company endpoint for Claude web. Keep the personal app and the device running; requests expire after 15 minutes if they cannot execute.

### Provider setup

- **Slack:** create a public PKCE app, enable token rotation, register `http://localhost:4217/oauth/callback`, and request user scopes `channels:history`, `groups:history`, `chat:write`. No bot scopes or client secret are sent. Enabling PKCE is a provider configuration change; this repository does not perform it automatically. See [Slack PKCE](https://docs.slack.dev/authentication/using-pkce/).
- **Linear:** register the same callback and use the public client ID with PKCE (`read,write`). No client secret is sent. See [Linear OAuth](https://linear.app/developers/oauth-2-0-authentication).
- **Notion:** the connector discovers `https://mcp.notion.com`, requires S256, registers a public client locally and binds tokens to `https://mcp.notion.com/mcp`. See [Notion MCP client integration](https://developers.notion.com/guides/mcp/build-mcp-client). Provider policy may restrict registration or consent.

No real provider authorization has been completed as part of automated tests. Tests use fixtures and fake provider responses, not user accounts. Runtime integration should be verified with a test account before commercial rollout.

## Cloudflare

`cloudflare.config.ts` defines the Worker and one SQLite Durable Object per company. The server now refuses provider OAuth callbacks and cannot execute live provider connections. Google sign-in is separate from tool OAuth.

Required server secrets: `ARGOS_TENANTS_JSON`, `ARGOS_VAULT_KEYRING` (encrypts action arguments/results, not provider tokens), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

```json
{
  "https://raviolelabs.argosnode.ai": {
    "id": "<company UUID>",
    "name": "RavioleLabs",
    "ownerEmail": "<verified owner Google email>"
  }
}
```

Each configured origin is a platform entry point with its own Google identity sessions. Any signed-in user can create a company at `/w/<random UUID>/`, become its owner, and switch between their workspaces. Each company has a separate SQLite Durable Object; a private per-account directory stores navigation hints and rechecks live membership. Existing root workspaces remain accessible only to their members or configured initial owner. New companies do not inherit RavioleLabs membership or data. Creation is idempotent and limited to 20 owned workspaces per account. Configure Google’s redirect as `<platform origin>/auth/google/callback`; new workspaces require no additional Google redirect registration. Custom hostnames still require operator-managed DNS.

```sh
npm run test:cloudflare
npm run build:cloudflare
npm run deploy
```

The Worker is deployed at `https://argosmcp.leraviole.workers.dev` with Google OAuth configured. Real Google sign-in has been observed. The self-service implementation is covered by Workers runtime tests for account separation, creation retries, invitations, revocation, device proofs and MCP OAuth. `argosnode.ai` DNS migration remains pending. Secrets must not be committed; never paste OAuth tokens into the dashboard or CI.

## Verification

```sh
npm run check
npm test
npm run test:cloudflare
npm run build:desktop
```

See [SECURITY.md](SECURITY.md) for the trust model and remaining release requirements. Touch ID/passkey gating and hardware attestation are not implemented.

## Engram memory

In Argos Personal → Connections → Create an Engram context, select **Only me** or **My team**. Team contexts require an administrator who belongs to the team. The hosting device must be running for both personal and team requests. Team members use the shared connection through their own scoped Argos agent grants. Removing team membership prevents future retrieval and execution; it cannot erase data already received by an authorized member.

Memory records are individually encrypted on disk. Retrieval decrypts only the selected context, ranks by BM25, and returns source IDs with content for the calling AI. There is no external embedding API or automatic conversation capture. Agents must explicitly call `engram_remember`. This built-in retrieval backend is separate from the existing full Engram repository; it does not copy or modify that code. Contexts are limited to 10,000 records each. Disconnecting a context revokes access without deleting its memory; reconnecting the same personal/team context on the same device restores access after fresh authorization.

## Configure a hosted workspace

Download the OAuth client JSON for a Google **Web application** registered in your own project. Its authorized redirect must be `<platform origin>/auth/google/callback`. Keep that file out of Git.

```sh
node scripts/configure-hosted.mjs https://raviolelabs.argosnode.ai owner@example.com /secure/path/google-client.json
npx cf deploy --mode cloudflare --secrets-file .data/cloudflare.secrets.json
```

This preserves existing workspace IDs and encryption keys and stores the server secrets in an ignored mode-600 file. Back up the encryption keyring securely. Do not replace it when redeploying an existing workspace. Additional companies created from the dashboard receive independent UUIDs and `/w/<UUID>` URLs automatically. Use this full URL when pairing Argos Personal and append `/mcp` (or `/mcp/notion`, `/mcp/slack`, `/mcp/linear`, `/mcp/engram`) for an AI client. The `argosnode.ai` domain must be configured on Cloudflare before using its custom workspace hostname.

## Open source

MIT licensed. The hosted offering runs the same policy and local-custody model. Native macOS release signing and notarization require the operator's Apple Developer credentials. CI runs type checks, isolation tests, the Workers runtime tests, a cloud build and the production dependency audit.
