# Product and distribution model

Decision recorded from Emeric on 2026-11-18.

Argos sells managed company policy/MCP hosting and a separately maintained dashboard service. The open-source distribution is the backend and local connector runtime. New dashboard and native presentation development lives in the private `argos-dashboard` repository. Previously published MIT source/history remains MIT; no history is rewritten.

## Product scope

Argos is the company control layer for AI tool calls: provider connections, mandatory access rules, exact-action approvals, expiring grants and audit. It does not provide a memory store or RAG product. Engram and Telegram ingestion are removed from the Argos roadmap. Third-party knowledge services may be connected as tools when their integrations are implemented; no generic remote MCP connector is claimed yet.

The built-in Engram tools and local memory creation are retired. Existing encrypted data is retained in place, but old clients and grants cannot execute retired tools. No standalone Engram repository, cloud database or domain is deleted by this change.

## Independent choices

| Choice                 | Recommended / managed option                                 | Alternative                                                          |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Backend hosting        | Argos-operated MCP/policy service                            | Company-operated backend, one Node installation/database per company |
| Provider-token custody | Argos Personal, credentials encrypted on the user's computer | Explicitly enabled server vault, available for Notion/Slack/Linear   |
| Dashboard updates      | Hosted versioned assets                                      | Operator-pinned hosted release                                       |

Self-hosting does not imply server custody. The dashboard is delivered at the company's backend origin, with same-origin sign-in/API calls. Argos's asset publisher is a trusted software supplier, not an API relay. See [SELF_HOSTING.md](SELF_HOSTING.md).

Server custody supports execution without an online personal device. It requires deployment configuration, workspace admin acknowledgment and per-connection user consent. Its operator can decrypt tokens; it has no local approval step. Existing local connections are never migrated.

## Native storage and distribution

macOS Keychain, Windows Credential Manager and Linux Secret Service hold the wrapping key. Provider credentials/private keys are encrypted in the local database. Missing OS credentials fail closed, with no plaintext fallback, iCloud guarantee, biometric gate or hardware attestation claim.

The Mac preview is Apple silicon/macOS 26+, ad-hoc signed, not notarized. Windows/Linux run the Node runtime with an explicitly downloaded presentation bundle. A Windows installer remains separate future distribution work. Native Windows persistence and missing-key refusal passed on the actual GitHub Windows runner: https://github.com/RavioleLabs/argosmcp/actions/runs/44199396279.

Tests use fixture provider responses. Real Google sign-in was observed; real Slack/Notion/Linear consent, refresh and revocation still require provider test-account verification before commercial release. See SECURITY.md for the remaining release gates.
