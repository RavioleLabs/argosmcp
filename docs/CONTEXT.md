# ArgosMCP · product decisions

Recorded 2026-11-17 from Emeric's instructions. This file preserves the scope across sessions.

## Current scope, superseding the historical Engram decisions below

2026-11-18: Emeric removed Engram entirely from the Argos product. Argos focuses on tool connections, enterprise permissions, approvals, expiry and audit. Remove built-in memory and its UI/MCP tools. Do not develop or market an Argos-owned RAG product or Telegram memory pipeline. Existing standalone Engram deployments and stored data are retained pending a separate retirement decision. Third-party knowledge tools can be future integrations, not a reason to build our own memory service. All Argos interface text, including browser titles, must avoid em dashes.

The following notes are historical where they mention Engram.

- Open source MCP gateway, with a paid RavioleLabs-hosted offering. Model-independent: Claude, Codex, Gemini and custom bots that support the protocol.
- Google OAuth identifies users. Users connect their own Slack, Notion, Linear and other accounts separately. Never pass provider credentials to AI clients.
- Company architecture with owners, administrators, members and teams. Company tool rules are mandatory: allow, require approval, deny. Personal preferences can only tighten company rules.
- Approvals authorize one exact action and argument snapshot, not a whole conversation. Enforce policy on the server on every call, including after approval, with revocation, expiration and membership checks.
- OAuth connections and agent grants expire after an administrator-configured interval (one week by default). Refreshing a provider token does not extend this interval. Block locally at expiration even if upstream revocation fails; report and retry revocation.
- Encrypt provider credentials at rest using envelope encryption and tenant/record-bound authenticated encryption. Keep wrapping keys outside the database, version keys and never log credentials.
- EngramMCP is a separate RAG MCP integration. Personal memory belongs only to its owner; team memory is accessible only to current team members. Company administrators do not automatically gain personal-memory access. Existing Engram needs dedicated upstream storage and credentials per context until true upstream tenant isolation is available.
- MCP endpoints: `/mcp` aggregates authorized services; `/mcp/slack`, `/mcp/notion`, `/mcp/linear`, `/mcp/engram` restrict the tool surface. Tools are discovered/called via MCP `tools/list` and `tools/call`, not REST paths for each tool.
- Entire product UI in English, calm and ergonomic, inspired by Apple. Logo direction: `AI < tools`, one agent branching to several controlled tools, replacing the initial A/funnel proposal.
- Deploy ArgosMCP on Cloudflare. Use the RavioleLabs Google account/project for OAuth, not BonDossier. Never assume credentials are configured merely because the UI exists.

## Workspace boundary

Implementation is an independent project in `~/raviolelabs/argosmcp`, moved out of clawbots on 2026-11-17 at Emeric’s explicit request. Do not move it back or create a copy. The old Argos repository has unrelated edits; preserve them. Existing Engram is in `engram/public/engram-mcp`; its source has not been changed or relicensed. Do not modify BonDossier.

## Delivery checks

Track actual deployment, OAuth setup, provider integration checks, isolation tests and limitations in README. Do not describe simulated demo connections as live connections. Open source publishing and commercial hosting are distinct from a local build.

## Domain decision

Emeric owns `argosnode.ai`. ArgosMCP is the product; RavioleLabs is only his customer workspace, not the platform-wide tenant. Self-service companies use independent `/w/<UUID>` URLs on the configured platform origin, with one database per company and a private account directory. This removes the need to provision DNS for every customer. Existing reserved root workspaces remain compatible. `raviolelabs.argosnode.ai` is prepared but its DNS migration is pending; Google login currently works at the workers.dev entry point. Company separation is enforced in server authorization and storage; path routing does not create separate browser origins.

## Personal connector · accepted security model

- Claude → Argos server → personal connector → provider; results return through Argos to Claude.
- OAuth access and refresh tokens stay on the user’s device in its OS credential store. No iCloud synchronization by default. Google login to Argos is separate.
- The personal app pairs with one user and company per profile, receives actions through outbound authenticated requests, and handles approvals. No inbound Internet port.
- Enterprise policy is checked on the server, including immediately before dispatch. Local restrictions only tighten permissions.
- A user controlling their device can modify the connector or use their tokens outside Argos. This is an explicitly accepted boundary, not tamper-proof enterprise enforcement.
- Requests/results transit Argos. This design prevents central custody of provider tokens, not access to all tool results.
- Code signing supports trusted distribution; it is not hardware attestation. No passkey/Touch ID protection should be claimed until implemented and verified.

## Built-in local memory backend

The personal connector now includes encrypted personal/team memory with explicit remember/recall/forget tools and BM25 retrieval. It is separate from the existing Engram repository. Team requests route to the hosting device; both requester membership and host access are checked at dispatch. No automatic conversation capture, embeddings, or off-device memory replication is claimed.

## Self-service onboarding · 2026-11-18

A new Google account must be able to create its own company without an invitation or operator intervention. Creating a company establishes its owner; joining an existing company requires an invitation. Users can belong to and switch between several companies. RavioleLabs is one customer workspace, never an implicit membership granted to all users.

## Installation onboarding · 2026-11-18

Explain ArgosMCP (browser workspace and company rules) and Argos Personal (companion app on each user’s computer) before workspace creation. After creation, guide installation, device pairing, provider connection and AI authorization. The Getting started page remains accessible; connection buttons return to the relevant guide instead of an unexplained modal. Progress reflects the signed-in user’s current device, connection and grant, not other members. Keep the workspace URL prefix through navigation and pairing. Never present a download click as successful installation. macOS preview distribution is Apple silicon/macOS 26+, ad-hoc signed and not notarized; the UI must disclose this limitation.

## Why Argos Personal exists · 2026-11-18

Explain the security reason before installation: an OAuth token grants access within its scopes; central custody aggregates users’ tokens and exposure from a vault breach. Argos Personal keeps provider tokens encrypted on individual computers, executes tools after company authorization, and offers local approvals. This reduces centralized token exposure; it does not conceal action arguments/results from Argos or protect a compromised device. Server-managed OAuth storage is technically possible and would allow execution without the user computer online. Emeric wants local custody strongly recommended rather than presenting server custody as impossible. The current product still supports local custody only; no hosted provider vault was implemented or enabled by this copy change.

## Distribution and hosting model · 2026-11-18

Emeric clarified: the intended open-source offering is the backend only. The dashboard is a hosted product/service and should also work with an independently self-hosted ArgosMCP backend. Keep backend hosting (managed or self-hosted) independent from token custody (recommended local OS-backed storage, optional server custody to design). Do not imply the hosted dashboard can already connect to arbitrary self-hosted backends. The repository currently includes previously published MIT frontend/native code; do not describe this as an already completed backend-only distribution. Keep subsequent dashboard source changes local until the private-dashboard/public-backend split is implemented; compiled hosted UI may be deployed. Existing published source/history is preserved.

macOS Keychain and Windows Credential Manager protect the local encryption key; provider tokens are encrypted in the local database. Native Windows storage must be checked on Windows, not inferred from passing macOS tests. A Windows installer remains separate from the working Node connector.

## Implementation superseding the earlier pending items · 2026-11-18

Optional server custody is now implemented behind operator/admin/user opt-ins, with a separate encryption keyring. The public tree now contains only backend/runtime and operational tooling; new dashboard and native presentation source lives in ../argos-dashboard (private). Historic public MIT frontend stays licensed as published.

The hosted dashboard service publishes immutable releases. Self-hosted backends deliver those assets at their own origin, keeping identity/API requests on the company backend. No cross-origin credential relay is introduced. Docker/Compose and a secret-preserving single-company setup command are provided. Local custody remains recommended; native Windows storage is verified, while a native Windows installer is still outstanding. These implementation decisions supersede earlier descriptions of server custody, dashboard self-hosting support and the split as unavailable.

Verification: 86 backend tests and 16 Cloudflare runtime tests pass, including company-bound server OAuth callbacks and policy changes during refresh. The private dashboard has five onboarding tests. A non-root, read-only Docker instance successfully served health and the hosted dashboard, and was stopped after the check. The private publisher is deployed at https://argos-dashboard.leraviole.workers.dev (release `8a12895591aa3e77`); the managed backend is pinned to it, Worker version `7675bbe0-35cb-4ef2-af9a-b311a0c70cf6`. The LeRavio onboarding and disabled-by-default server custody controls were verified in the signed-in browser. The rebuilt Mac app's ad-hoc signature verifies; Developer ID/notarization remain unavailable. No real provider authorization was performed during this delivery.

## Engram Cloud and Telegram preparation · 2026-11-18

Emeric confirmed that Engram is a separate product. Prepare company-scoped personal, team and explicitly company-shared contexts in the existing private engram-cloud project. Support multiple distinct context IDs per team/person. Telegram is a separate bot/connector (with an optional messaging MCP): ingestion writes into approved Engram contexts; agents retrieve Telegram context through Engram with the requesting user's permissions. A bot spanning company sources must not expose a global corpus to every employee. Recheck destination audiences before group delivery; default to private delivery if a complete authorized audience cannot be established. This work is preparation only: no cloud context routes, migrations, Telegram collection or new Argos integration are activated. See docs/ENGRAM_CLOUD_INTEGRATION.md.

## Engram independent cloud implementation · 2026-11-18

The separate Engram contexts Worker is now implemented with its own D1 database, dashboard, scoped keys, ingestion and MCP. Public SDK plus a customer-operated Telegram ingestion template are in the Engram public repository. No company-wide Telegram bot is operated by us; customers retain their own tokens. The prepared Argos federation remains future work; this does not change Argos's memory/provider runtime. Emeric prefers Engram’s neural visual identity: connected nodes and context/source/access graphs, with clearly separate audiences. See the Engram contexts service README for actual capabilities and limits.

## 2026-11-18: Open connector directory and official MCPs

Argos must not be limited to native Slack, Notion and Linear adapters. Provide a documented vendor directory including Google Drive, Attio and BonDossier, plus company-defined MCP servers and member requests. Company administrators approve connector availability and tools; users connect their own accounts with OAuth on their devices. Official Slack MCP with OAuth is the preferred Slack path; its app approval, optional DM scopes and Argos policy are separate controls. Keep legacy API connections explicitly separate. See COMPANY_CONNECTORS.md and CONNECTOR_DIRECTORY.md for the implementation and prerequisites. Argos Personal 0.1.3 includes the shared branch logo as its macOS icon and menu bar symbol.

## Security priority, 18 November 2026

Emeric requested security as the central product differentiator for finance and crypto. Same-user autonomous agents are explicitly in the threat model. Do not claim that a local executable/hash check isolates such an agent. See SECURITY_REVIEW_2026-11-18.md for implemented mitigations and separate future release gates: isolated executor, independent strong approvals, financial signing separation, audited distribution and independent review.

## 2026-11-18: hosting paths and independent action review

Emeric reauthorized implementation with “vasy build tout”. Offer Argos-managed Cloudflare, company-owned Cloudflare and the MIT self-hosted backend. Recommend local custody in all three; optional server custody remains gated by operator setup, company opt-in and per-user consent. Never collect a customer's Cloudflare account admin token in the SaaS.

Added generic server-side remote MCP OAuth PKCE/bearer/public connections, administrator tool discovery/publication, exact-definition checks before dispatch, and a Cloudflare public-fetch transport. Company connectors are personal credentials; enabling a connector is separate from connecting each member's account. Portal access is itself a credential even when Cloudflare holds upstream tokens. Reject documented Cloudflare Code Mode tools. No real portal is activated: account portal list was empty and argosnode.ai DNS delegation remained pending.

Optional independent action review requires two distinct reviewers on writes, with explicit owner consent before personal action arguments are shared to another administrator. Enabling/disabling requires a second admin. Local app directs pending independent reviews to the dashboard and still requires final local confirmation. No attestation or human-presence claim.

Dashboard provides hosting comparison during workspace creation/onboarding and in Security, displays current deployment, explains custody and links the operational guide. See DEPLOYMENT_OPTIONS.md for the exact support boundaries.
