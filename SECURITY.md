# Security model

## The boundary

The hosted service does not receive provider access tokens, refresh tokens or local device private keys in normal operation. The local connector obtains OAuth credentials directly from the provider and uses them at fixed provider endpoints. Cloud login for Argos itself is a separate Google OIDC flow.

The hosted service necessarily sees the approved tool arguments and returned results. Encryption at rest is not a claim that the operator cannot read them. Result redaction covers known credentials, not all possible secrets inside user documents.

A user who administers their machine can modify the connector or reuse a bearer token outside Argos. That boundary was explicitly accepted. This system governs actions through the official connector; it is not an anti-tampering product or a restriction on every possible way to use Slack/Notion.

## Local storage and approval

A random AES wrapping key is generated once and stored using the OS credential store. Per-record envelope encryption binds data to its local profile or execution ID. Keychain unavailability fails closed; no password file fallback is created. OAuth and refresh tokens are encrypted within the local profile. The same device can hold independent profiles for multiple companies.

Cloud synchronization is not requested. The current implementation uses the OS keyring binding; it does not claim Secure Enclave execution, biometric-gated key access, zero knowledge, hardware attestation, or protection against local administrator/malware access. An unlocked connector can use its credentials. Do not advertise iCloud storage or passkey-protected decryption.

All writes require local confirmation even if the dashboard already approved them. Automatic reads require explicit per-connection local delegation. A compromised Argos server can request actions, access transit results, deny service and abuse any reads that the user delegated. It cannot silently expand the official connector's write delegation. A malicious software update could compromise that boundary; production releases require an independently reviewed update process.

## Server controls

Pairing binds the device public key to one company/user after a signed-in fingerprint check. Ed25519 request signatures cover the exact origin, path, method, body digest, timestamp and one-time nonce. Signature checks are not proof that the software is unmodified.

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

## Local memory

Engram records are encrypted with context-bound associated data. The context binds canonical workspace origin, company, scope and user/team ID. There is no plaintext search index. Team access is rechecked before dispatch, and results are readable only by the original requester and grant. The host device user can access its team data directly; this is part of the accepted local trust boundary. Removing membership cannot retract copies previously delivered. The built-in backend uses lexical BM25 retrieval, with a 10,000-record limit per context.

## Dependency audit and telemetry

As of 2026-11-17, the production dependency audit reports zero known advisories. The development toolchain has the unpatched picomatch ReDoS advisory GHSA-fc5q-39xc-vjpf, propagated through Vite/Vitest. It consumes repository-controlled glob patterns, not tool arguments; development servers must stay local. The latest published picomatch is still affected. Do not downgrade the Cloudflare toolchain to incompatible versions just to suppress the audit. Recheck before releases.

Cloudflare automatic tracing includes full request URLs, so trace sampling is explicitly zero and invocation logs are disabled. Application failure logs omit requests with query strings. Company decision auditing remains enabled in the database. Review any new telemetry exporter before enabling it on OAuth routes.
