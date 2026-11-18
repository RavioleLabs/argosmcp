# Argos deployment and credential storage

See [Cloudflare portal setup and current delivery status](CLOUDFLARE_PORTALS.md). Backend hosting and credential storage are independent choices. Local custody is recommended in every hosting model. The same company policies, scoped AI grants, lease limits and action approvals apply to requests that pass through Argos.

| Backend | Operator | Local connections | Server connections | Dashboard |
| --- | --- | --- | --- | --- |
| Managed Argos backend | Argos, on Cloudflare | Recommended | Optional, explicit consent | Included |
| Company Cloudflare | Your company | Recommended | Optional, in your account | Delivered at your backend origin |
| Self-hosted Docker or Node | Your company | Recommended | Optional, on your host | Delivered at your backend origin |

The backend and local connector runtime are MIT open source. The separately maintained dashboard and native presentation are proprietary. Their public compiled assets do not make their source open source. Existing MIT history remains MIT.

## Managed Argos backend

Open https://argosmcp.leraviole.workers.dev/, sign in with Google, create a workspace and invite colleagues. Each company has a separate Cloudflare Durable Object database. Membership, connector definitions, team scopes, devices, policies and grants are checked within that company. Infrastructure operators still control the application and encryption keys.

1. Follow **Getting started** to install Argos Personal, pair the computer and connect tools.
2. Administrators enable company MCP connectors in **Connections → Company connectors**. Members may request additional connectors.
3. Add the workspace's `/mcp` URL to your AI client. Use the exact company URL, including `/w/<UUID>` when present.
4. Review actions in Argos. Keep the personal computer online for local connections.

Cloudflare portal access is an alternative, not a migration of local tokens: the operator provisions a dedicated encrypted store for portal access, an administrator enables it in **Security**, and each user explicitly consents before connecting an account on the backend. Local connections stay local.

## Company Cloudflare

Your administrator deploys from their own computer into their own Cloudflare account. Do not upload a Cloudflare account API key to Managed Argos backend. Argos does not need an administrative Cloudflare role.

1. Check out a reviewed backend release and install the supported Node version and dependencies with `npm ci`.
2. Sign in with the included CLI: `npx cf auth login`, then `npx cf auth whoami`. Verify the selected account before deployment. Use a separate CLI profile for each company. Do not deploy over an existing unrelated Worker named `argosmcp`.
3. Set up a Google OAuth Web application for your backend's HTTPS origin. Register the exact `/auth/google/callback` URL. Keep the downloaded client JSON outside the repository.
4. Generate private configuration:

   ```sh
   node scripts/configure-hosted.mjs https://argos.company.com owner@example.com /secure/google-client.json "Company name"
   ```

   The generated `.data/cloudflare.secrets.json` preserves existing company IDs and encryption keys. A new installation disables server custody by default. `ARGOS_DEPLOYMENT=company-cloudflare` labels this deployment; it is descriptive, not a security boundary.
5. Validate and deploy with the authenticated company account:

   ```sh
   npx cf deploy --mode cloudflare --dry-run
   npx cf deploy --mode cloudflare --secrets-file .data/cloudflare.secrets.json
   ```

6. Configure the Worker custom domain in that same account and verify DNS/TLS. The origin must exactly match the configured tenant and Google redirect. A `workers.dev` origin is also usable if configured consistently from the beginning. The company controls its Cloudflare billing and any plan prerequisites.
7. Open the backend, sign in, invite the team and pair devices. Review the deployment label and server-custody state in **Security**.

Cloudflare Worker hosting does not automatically create MCP Portals. Follow [the portal setup guide](CLOUDFLARE_PORTALS.md) for managed or company-owned portals. Local connections remain direct; new cloud connections require a linked company portal.

## Self-hosted

Follow [SELF_HOSTING.md](SELF_HOSTING.md) for Docker Compose or Node, HTTPS, Google login, persistent volumes and keyrings. Each Node installation serves one company. Use a separate installation/database/hostname for another company. Cloudflare deployments use separate company Durable Objects.

The dashboard runs at your backend origin. Its API calls, login cookies and tool payloads are not relayed through the Argos asset publisher. Pin `ARGOS_DASHBOARD_VERSION` to a reviewed immutable release. The publisher remains a trusted software supplier: executing its JavaScript at your origin gives that code access to the user session. Owning the account alone is not a zero-knowledge guarantee.

## Legacy direct remote MCP on the backend

The following is compatibility documentation for existing connections or operators explicitly enabling `ARGOS_ALLOW_DIRECT_SERVER_CUSTODY=1`. The current dashboard routes new cloud connections through [company Cloudflare portals](CLOUDFLARE_PORTALS.md).

1. An administrator creates a connector with its public HTTPS Streamable HTTP endpoint and authentication settings. OAuth uses a pre-registered public client, PKCE S256 and pinned authorization/token/issuer URLs. Obtain these from the provider; do not guess endpoints or paste a client secret.
2. Register the backend callback `<workspace URL>/oauth/callback/mcp`. A local connection instead uses the callback shown by Argos Personal. Both redirect URLs may need registration. A provider requiring a confidential client, automatic DCR, custom authentication headers or interactive MCP elicitation is not supported by this generic flow. The built-in Notion adapter has its own DCR support.
3. In **Company connectors**, choose **Connect on backend** and consent. OAuth opens the provider, a bearer connector asks for a personal token, and an unauthenticated connector needs no token. These connections are personal, not shareable service accounts.
4. Administrators discover the tools with their own connection, review their schemas and enable a selected set. A draft permits discovery but no tool execution. Other members connect after enablement. **Refresh server tools** repeats discovery using the administrator's own connection.
5. Tools start with company approval required. A fresh upstream tool list is checked against the approved definition before each dispatch. Schema changes, company policy changes, expired leases and disabled connectors fail closed. Calls are not automatically retried after an uncertain write outcome.

Credentials are encrypted with company and connection binding and a separate provider keyring. Requests have deadlines, bounded responses, public HTTPS destinations and no redirects. Cloudflare uses `global_fetch_strictly_public`; Node resolves and pins public IPv4 addresses. The backend operator can use server-held credentials. Refresh does not extend the company lease. Generic MCP upstream revocation is not implemented: Argos blocks further execution and reports manual revocation required. Remove the grant in the provider or portal too. Previously dispatched actions cannot be recalled.

## Cloudflare MCP Portals

The integration path is a company remote MCP connector, not an HTTP redirect:

```text
AI client → Argos policy + approvals → executor → Cloudflare portal → provider
                                     local or server
```

Cloudflare stores upstream provider authorization. Argos Personal or the Argos backend holds portal authorization. That portal credential can exercise the permitted upstream access even though it is not the raw Slack/Notion token. Do not describe this as the backend having no usable access.

Configure the portal in the infrastructure owner's account. Keep separate company portal configuration and access policies. Cloudflare provides its own administrative and user dashboards; Argos adds its own company workflow and exact-action approvals.

- Start with a verified active domain and a configured Cloudflare Access identity provider.
- Enable user authorization for upstream servers when personal OAuth is required. A Cloudflare service token uses administrator/shared upstream authorization instead; it does not represent a user's personal OAuth grants. Custom service-token headers are not supported by Argos's generic bearer input.
- Disable Code Mode and expose individual tools. Argos rejects the documented `portal_codemode_*` tools. Do not alias a bulk executor or arbitrary-code tool to bypass that check. Approval of a generic execution tool cannot promise per-inner-action approval.
- Configure the portal's public OAuth client and the Argos executor callback using the provider's supported registration flow. Test the complete login, discovery, approval, refresh and revocation sequence in that company's portal before making it available.
- Give the AI only Argos access. Giving it a usable direct portal credential also gives it a route around Argos. Users or host operators with other credentials can still act outside Argos; managed devices and provider/network policies are separate controls.
- Do not grant Argos administrative access to a customer's Cloudflare account. Deployment and portal administration happen in the customer's account. A mutable dashboard publisher remains part of the software trust boundary.

**Current verification:** generic remote MCP OAuth/bearer/public flows are tested with fixtures, including company isolation, changed tools and policy races. No production Cloudflare Portal has yet completed a real end-to-end OAuth test in the Argos account. On 2026-11-18 that account had no portals and `argosnode.ai` was still awaiting DNS delegation. Present portal connectivity as configuration-dependent until this test is completed, not as an activated managed vault.

Official reference: [Cloudflare MCP server portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/).

## Independent review

In **Security → Independent action review**, two administrators approve enabling or disabling the mode. With it enabled, writes require two distinct reviewers even if an access rule says Allow. Personal actions require the owner to explicitly share the exact arguments before another administrator can see and approve them. This does not share the connection, credential or tool result with that reviewer. Revision, expiry, membership and action digest are rechecked before dispatch.

Use a reviewer account and device outside the AI agent's control. Two accounts alone do not prove human presence or stop a machine administrator modifying their local client. Local signing/hash checks are tamper detection, not remote attestation. The control applies to the Argos execution path; it cannot revoke permissions held independently at a provider.
