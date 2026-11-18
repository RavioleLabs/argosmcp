# Product and distribution model

## Current connection modes (18 November 2026)

Local remains recommended and connects directly from Argos Personal to providers. New cloud connections use a company Cloudflare MCP Portal, either in Argos’s account or the company’s account. Backend hosting is independent: managed Argos on Cloudflare, company Cloudflare, or MIT self-hosted Docker/Node. Cloudflare holds cloud provider tokens; the Argos backend holds encrypted portal access that its operator can use. Existing direct server connections are retained for explicit migration, not silently transferred. See [the portal setup and delivery status](CLOUDFLARE_PORTALS.md).


Decision recorded from Emeric on 2026-11-18.

Argos sells managed company policy/MCP hosting and a separately maintained dashboard service. The open-source distribution is the backend and local connector runtime. New dashboard and native presentation development lives in the private `argos-dashboard` repository. Previously published MIT source/history remains MIT; no history is rewritten.

## Product scope

Argos is the company control layer for AI tool calls: provider connections, mandatory access rules, exact-action approvals, expiring grants and audit. It does not provide a memory store or RAG product. Engram and Telegram ingestion are removed from the Argos roadmap. Third-party knowledge services may be connected as tools when their integrations are implemented; generic remote MCP connectors support reviewed public HTTPS endpoints with OAuth PKCE, bearer or unauthenticated access, locally; cloud execution uses the linked company portal. Compatibility with each provider must be verified.

The built-in Engram tools and local memory creation are retired. Existing encrypted data is retained in place, but old clients and grants cannot execute retired tools. No standalone Engram repository, cloud database or domain is deleted by this change.

## Independent choices

| Choice                 | Recommended / managed option                                 | Alternative                                                          |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Backend hosting        | Argos-operated MCP/policy service                            | Company Cloudflare account or self-hosted Node/Docker, isolated per company |
| Provider-token custody | Argos Personal, credentials encrypted on the user's computer | Company Cloudflare MCP Portal; backend holds encrypted portal access   |
| Dashboard updates      | Hosted versioned assets                                      | Operator-pinned hosted release                                       |

Self-hosting does not imply server custody. The dashboard is delivered at the company's backend origin, with same-origin sign-in/API calls. Argos's asset publisher is a trusted software supplier, not an API relay. See [SELF_HOSTING.md](SELF_HOSTING.md).

Cloudflare portal access supports execution without an online personal device. It requires deployment configuration, workspace admin acknowledgment and per-connection user consent. Cloudflare holds provider tokens; the Argos operator can decrypt portal access. Dashboard approvals apply without a local confirmation. Existing local connections stay local, and legacy direct server credentials require explicit migration.

## Native storage and distribution

macOS Keychain, Windows Credential Manager and Linux Secret Service hold the wrapping key. Provider credentials/private keys are encrypted in the local database. Missing OS credentials fail closed, with no plaintext fallback, iCloud guarantee, biometric gate or hardware attestation claim.

The Mac preview is Apple silicon/macOS 26+, ad-hoc signed, not notarized. Windows/Linux run the Node runtime with an explicitly downloaded presentation bundle. A Windows installer remains separate future distribution work. Native Windows persistence and missing-key refusal passed on the actual GitHub Windows runner: https://github.com/RavioleLabs/argosmcp/actions/runs/44199396279.

Tests use fixture provider responses. Real Google sign-in was observed; real Slack/Notion/Linear consent, refresh and revocation still require provider test-account verification before commercial release. See SECURITY.md for the remaining release gates.

All hosting and custody paths, Cloudflare MCP Portals constraints and independent review are described in [DEPLOYMENT_OPTIONS.md](DEPLOYMENT_OPTIONS.md).
