# ArgosMCP — product decisions

Recorded 2026-11-17 from Emeric's instructions. This file preserves the scope across sessions.

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

## Personal connector — accepted security model

- Claude → Argos server → personal connector → provider; results return through Argos to Claude.
- OAuth access and refresh tokens stay on the user’s device in its OS credential store. No iCloud synchronization by default. Google login to Argos is separate.
- The personal app pairs with one user and company per profile, receives actions through outbound authenticated requests, and handles approvals. No inbound Internet port.
- Enterprise policy is checked on the server, including immediately before dispatch. Local restrictions only tighten permissions.
- A user controlling their device can modify the connector or use their tokens outside Argos. This is an explicitly accepted boundary, not tamper-proof enterprise enforcement.
- Requests/results transit Argos. This design prevents central custody of provider tokens, not access to all tool results.
- Code signing supports trusted distribution; it is not hardware attestation. No passkey/Touch ID protection should be claimed until implemented and verified.

## Built-in local memory backend

The personal connector now includes encrypted personal/team memory with explicit remember/recall/forget tools and BM25 retrieval. It is separate from the existing Engram repository. Team requests route to the hosting device; both requester membership and host access are checked at dispatch. No automatic conversation capture, embeddings, or off-device memory replication is claimed.

## Self-service onboarding — 2026-11-18

A new Google account must be able to create its own company without an invitation or operator intervention. Creating a company establishes its owner; joining an existing company requires an invitation. Users can belong to and switch between several companies. RavioleLabs is one customer workspace, never an implicit membership granted to all users.

## Installation onboarding — 2026-11-18

Explain ArgosMCP (browser workspace and company rules) and Argos Personal (companion app on each user’s computer) before workspace creation. After creation, guide installation, device pairing, provider connection and AI authorization. The Getting started page remains accessible; connection buttons return to the relevant guide instead of an unexplained modal. Progress reflects the signed-in user’s current device, connection and grant, not other members. Keep the workspace URL prefix through navigation and pairing. Never present a download click as successful installation. macOS preview distribution is Apple silicon/macOS 26+, ad-hoc signed and not notarized; the UI must disclose this limitation.
