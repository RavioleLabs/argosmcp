# Security model

The [18 November 2026 security review](docs/SECURITY_REVIEW_2026-11-18.md) records scope, mitigations, scanner limitations and outstanding finance/crypto release gates. An unrestricted agent running as the credential owner is not isolated from the local client. Previews must not be advertised as tamper-proof, independently audited or suitable for custody of financial assets.

## The boundary

For local-custody connections, the hosted service does not receive provider access tokens, refresh tokens or local device private keys through the credential flow. The local connector obtains OAuth credentials directly from the provider and uses them at fixed provider endpoints. Cloud login for Argos itself is a separate Google OIDC flow.

The hosted service necessarily sees the approved tool arguments and returned results. Encryption at rest is not a claim that the operator cannot read them. Result redaction covers known credentials, not all possible secrets inside user documents.

A user who administers their machine can modify the connector or reuse a bearer token outside Argos. That boundary was explicitly accepted. This system governs actions through the official connector; it is not an anti-tampering product or a restriction on every possible way to use Slack/Notion.

## Local storage and approval

A random AES wrapping key is generated once and stored using the OS credential store. Per-record envelope encryption binds data to its local profile or execution ID. Keychain unavailability fails closed; no password file fallback is created. OAuth and refresh tokens are encrypted within the local profile. The same device can hold independent profiles for multiple companies.

Cloud synchronization is not requested. The current implementation uses the OS keyring binding; it does not claim Secure Enclave execution, biometric-gated key access, zero knowledge, hardware attestation, or protection against local administrator/malware access. An unlocked connector can use its credentials. Do not advertise iCloud storage or passkey-protected decryption.

All local-connector writes require local confirmation even if the dashboard already approved them. Automatic reads require explicit per-connection local delegation. A compromised Argos server can request actions, access transit results, deny service and abuse any reads that the user delegated. It cannot silently expand the official connector's write delegation. A malicious software update could compromise that boundary; production releases require an independently reviewed update process.

## Server controls

Every self-service company has a separate SQLite Durable Object bound immutably to its UUID, platform origin and founding Google subject. Google identity sessions live at the platform entry point. The Worker resolves the session and passes identity via internal RPC and a request-local Symbol; no client header establishes identity. A private account directory stores only workspace hints and checks live membership before returning them. Invitations and removal cannot grant or preserve access through a stale directory entry. All workspaces on one platform share a web origin; this is application/database isolation, not browser-origin isolation or isolation from a compromised operator. The CSP disallows third-party scripts and framing.

Workspace creation requires a signed-in Google account, an exact same-origin JSON request and a bounded validated body. A durable idempotency key prevents duplicate creation after a lost response, and each account may create at most 20 workspaces. Browser cookies never authenticate MCP or native device endpoints. MCP audiences, authorization metadata, consent, codes and device signatures bind the full workspace URL.

Pairing binds the device public key to one company/user after a signed-in fingerprint check. Ed25519 request signatures cover the exact workspace URL (including its company prefix), request path, method, body digest, timestamp and one-time nonce. Signature checks are not proof that the software is unmodified.

The server rechecks live memberships, company and personal policies, grant allowlists, connection/device lifetimes, exact argument digest, policy revision, and current approver authority at dispatch. Once dispatched, an in-flight provider call cannot reliably be recalled. The maximum dispatch permit is 30 seconds, with no automatic retry. Receipts are device-bound and hashed at rest; results are only returned to the original user/grant.

A durable local journal prevents the official connector from executing an invocation again after a crash or lost network response. Uncertain results remain `unknown`. This does not provide exactly-once semantics across a provider's API; users must inspect the external service before requesting a new write.

Device and connection revocation immediately block future server authorizations. A disconnected/offline device cannot be forced to erase credentials or revoke upstream tokens until it reconnects. Revoke directly in the provider if urgent. Provider refresh never extends the enterprise authorization lifetime.

The local HTTP UI binds only to loopback, checks Host and Origin, uses an HttpOnly SameSite cookie established from a random launch token, and renders remote action content as text. The loopback API grants no cross-origin access. No remote shell, arbitrary tool URL or generic HTTP execution tool is exposed. The remote MCP endpoint allows bearer-authenticated cross-origin MCP clients.

## Before commercial release

- Independent security review of pairing, OAuth, storage, isolation and dispatch.
- Real test-account integration checks for each provider, including refresh and revoke.
- Apple Developer ID signing, notarization, and a reviewed update/recovery process. The locally built app is ad-hoc signed only.
- Defined access/result retention, backup, deletion and incident-response procedures; rate and resource limits appropriate to deployed scale.
- Harden operator and CI permissions. Operators of the control plane can access tool results and change company policy; do not advertise otherwise.
- Recovery design for a lost keychain or expired pairing. Deleting files is not secure erasure of backups.

Report a vulnerability privately to the deployment owner. Do not include real OAuth tokens in issues or logs. No public security-report address has been configured yet.

## Retired providers

The built-in memory provider is retired. Unsupported providers fail closed before execution, even when an old connection or grant is still present. Old memory data is retained without a new read, write or delete API. Local provider refresh/revocation must never send credentials for an unsupported provider to a fallback endpoint.

## Dependency audit and telemetry

As of 2026-11-17, the production dependency audit reports zero known advisories. The development toolchain has the unpatched picomatch ReDoS advisory GHSA-fc5q-39xc-vjpf, propagated through Vite/Vitest. It consumes repository-controlled glob patterns, not tool arguments; development servers must stay local. The latest published picomatch is still affected. Do not downgrade the Cloudflare toolchain to incompatible versions just to suppress the audit. Recheck before releases.

Cloudflare automatic tracing includes full request URLs, so trace sampling is explicitly zero and invocation logs are disabled. Application failure logs omit requests with query strings. Company decision auditing remains enabled in the database. Review any new telemetry exporter before enabling it on OAuth routes.

## Optional server custody and hosted dashboard

Server credentials use a dedicated AES vault keyring with workspace/company/connection-associated data. Deployment enablement, administrator acknowledgment and explicit user consent are all required. Encrypted OAuth state is bound to the signed-in account and a scoped HttpOnly browser cookie, consumed once and checked again after token exchange. Cancellation or membership changes during exchange trigger token revocation. Token refresh and revocation are serialized per connection; current policy and membership are rechecked immediately before provider dispatch.

The operator can decrypt server-held tokens. This optional mode concentrates exposure and does not provide local confirmation. Company disabling/expiry blocks new dispatch immediately, with upstream revocation attempted and failures retained for retry. Removing vault keys prevents use but cannot revoke provider access; retain keys until revocation is confirmed, and manually revoke upstream when needed.

Self-hosted Node deployments require a separate installation/data volume/company identity per tenant. The hosted dashboard is served through the backend's origin from a trusted, optionally version-pinned publisher. Only public static files are fetched; no incoming session cookies, API bodies, provider tokens or tool results are forwarded to the publisher. Nevertheless its JavaScript runs with the user's dashboard privileges: a compromised publisher/update can compromise dashboard sessions. Pinning controls update timing, not publisher trust. Browser/API origin remains the self-hosted backend; there is no generic relay or permissive credentialed CORS.

Company-defined MCP servers are opt-in and require administrator tool review. Their credentials stay in the local encrypted store. Endpoint configuration is immutable and fingerprint-bound; arbitrary stdio commands and private network destinations are not supported. The local HTTPS transport pins public DNS results, refuses redirects, bounds responses and rechecks the discovered tool before acquiring a dispatch permit. Every custom MCP action requires local confirmation. See [company connector boundaries](docs/COMPANY_CONNECTORS.md#security-boundaries-and-supported-transport) for supported authentication, schema constraints and manual upstream revocation.

## Deployment choices and independent review

See [DEPLOYMENT_OPTIONS.md](docs/DEPLOYMENT_OPTIONS.md) for the supported hosting/custody paths, the optional two-reviewer mode, and Cloudflare MCP Portals prerequisites. Local custody is recommended. Independent review requires an approver identity/device outside the agent’s control and does not attest the local executable. Company-owned hosting does not remove software-publisher trust. Generic remote MCP revocation currently requires removing authorization at the upstream provider as well.
