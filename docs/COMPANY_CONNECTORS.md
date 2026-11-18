# Company connectors

Argos is an open MCP gateway. The directory is a curated starting point, not an exhaustive list of every MCP server or a compatibility certification. Vendor documentation is linked for every entry. The official MCP Registry is an additional discovery source; registry publication does not establish vendor endorsement or safety.

## Company setup and personal access

1. An owner or administrator opens Connections, chooses a vendor or adds a custom endpoint, and creates a draft.
2. The administrator connects that draft from their paired Argos Personal app. OAuth credentials and bearer tokens remain encrypted on that device using the OS credential store. Only tool definitions and connection metadata reach the workspace.
3. The administrator reviews the discovered descriptions and input schemas, selects tools, and enables the connector. New tools require company approval by default. Access rules can allow, require approval or deny each tool.
4. Members see enabled company connectors in Argos Personal and connect their own accounts. They do not configure the application's OAuth client ID.
5. Members can request a vendor or custom connector. Administrators can decline with a reason or approve against an enabled connector. Approval does not create a provider connection or grant credentials automatically.

The aggregate `/mcp` endpoint exposes the selected tools through the requesting user's authorized connections. Custom tool arguments are nested under `arguments`; `connection_id` and `request_id` remain gateway fields. Existing service-specific endpoints retain their existing native-adapter behavior. Use `/mcp` for official Slack MCP and other company connectors.

## Slack official MCP

The official endpoint is `https://mcp.slack.com/mcp`. This is distinct from the legacy Slack API adapter. Its OAuth issuer is `https://mcp.slack.com`, authorization endpoint is `https://slack.com/oauth/v2_user/authorize`, and token endpoint is `https://slack.com/api/oauth.v2.user.access`.

Slack currently requires an internal application or a Marketplace-published application; unlisted applications cannot use its MCP. Slack workspace app approval remains authoritative. An administrator can block the integration in Slack independently of Argos.

For desktop OAuth, enable PKCE on the Slack app and register the callback shown by Argos Personal (normally `http://localhost:4217/oauth/callback`). Slack documents enabling PKCE as a one-way app setting. Argos sends an S256 challenge, validates a single-use state and exchanges the code on the device. No Slack client secret is accepted by the workspace or required for a supported desktop public-client flow.

For managed deployments, `SLACK_PUBLIC_CLIENT_ID` can preconfigure the application client ID. It is currently unconfigured in the RavioleLabs deployment. Until an eligible Slack application is configured, an administrator must supply their own company's Slack app Client ID from Basic Information → App Credentials. This is an integration setup requirement, not a user credential. Marketplace approval is an external prerequisite for distributing the same Slack application to unrelated companies.

DM read/search access is optional in the Slack setup form. It uses `im:history`, `mpim:history`, `search:read.im`, `search:read.mpim` and relevant discovery scopes. Sending uses the distinct `chat:write` scope. Defaults include public-channel read/search only. Private channels, DMs and sending require explicit selections by the administrator and subsequent user OAuth consent. Argos policy can further restrict calls; it cannot expand Slack's granted permissions.

Sources: [Slack MCP](https://docs.slack.dev/ai/slack-mcp-server/), [desktop PKCE](https://docs.slack.dev/authentication/using-pkce), [authorization metadata](https://mcp.slack.com/.well-known/oauth-authorization-server).

## Security boundaries and supported transport

Company connector definitions, tool manifests, requests, policies and connection bindings are company-scoped. Members see their own requests; administrators see requests within their company. Administrators do not receive personal provider tokens.

Endpoint and OAuth configuration is immutable after creation. The device binds its encrypted connection to the configuration fingerprint and company connector ID. Each call requires a current server permit bound to the exact arguments. A tool from another connector cannot use the connection. Disabling a connector blocks new dispatch and cancels pending approvals. It cannot undo an already-dispatched external operation.

A newly discovered tool is never enabled automatically. Schema or description drift blocks execution until local rediscovery and administrator review. Republishing changed tools resets their company policy to approval. Custom MCP tools always require local confirmation; upstream read-only hints do not bypass this rule.

Supported: public HTTPS Streamable HTTP MCP, no-auth endpoints, personal bearer tokens and registered public OAuth clients with PKCE S256. Generic OAuth settings support distinct issuer, authorization and token origins when explicitly configured by the administrator. Server custody for these custom MCP connectors is not implemented; existing optional server custody remains limited to the native adapters.

Not supported: private-network endpoints, stdio executable servers, SSE-only transports, query-string credentials/configuration, confidential-client OAuth, automatic OAuth dynamic client registration, or arbitrary vendor-specific authentication headers. Some vendors require a published client or prior approval, so a directory entry may require additional setup or be incompatible with this transport/auth subset. Do not claim all listed vendors have been exercised with real accounts.

The local transport validates and pins public IPv4 DNS results, validates TLS and refuses redirects. Responses, pagination, schemas and tool counts are bounded. JSON Schema references, regular expressions, unsupported validation keywords and overly complex schemas fail closed. JSON Schema defaults never rewrite approved arguments. Limits: 100 definitions per company, 100 discovered tools per connector, 500 enabled custom tools per company.

Generic upstream token revocation is manual: disconnect blocks Argos immediately, but users must also revoke provider access in that provider's settings. A modified local client or a compromised user device can misuse tokens it holds outside Argos. Provider-side restrictions and managed devices remain separate controls.

## Validation

Automated tests cover tenant isolation, member restrictions, request decisions, stale reviews, disabled connectors, tool binding, schema drift, exact dispatch, local token custody, private address rejection, Slack PKCE URLs and Durable Object persistence. A live smoke test uses only the public Cloudflare Documentation MCP. No Slack, Google Drive, Attio or BonDossier account authorization has been performed for this release.
