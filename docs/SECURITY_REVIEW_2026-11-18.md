# Security review, 18 November 2026

Internal review and controlled testing, not an independent penetration test, certification or proof of absence of vulnerabilities. This preview is not ready to protect financial assets.

## Scope and evidence

Reviewed backend isolation, OAuth grants, device protocol, local runtime, dashboard and macOS launcher. Disposable databases, generated keys and fake credentials only. ZAP used a loopback fixture with outbound fetch disabled. No production tenant was attacked, no real keychain secret was read, and no provider account was changed. The installed app was not replaced or stopped.

| Area | Change and verification |
| --- | --- |
| Native environment | Allowlisted environment and fixed child paths. A disposable NODE_OPTIONS preload executes with the old inherited environment and is blocked by the new environment. Does not protect an already compromised parent process. |
| Launch capability | One use, 60-second expiry and constant-time digest comparison. Concurrent replay accepts exactly one request. |
| Local session | Absolute 12-hour expiry; HttpOnly and SameSite=Strict cookie. Expired-cookie replay rejected. Quit/reopen after expiry. Ephemeral native WebKit storage. |
| Credential files | Repair existing directory to 0700 and DB/sidecars to 0600; reject symlinks and multiply linked database files. Windows ACL hardening is separate; POSIX modes are not a Windows isolation guarantee. |
| Bundle integrity | Verify signed resources before opening the credential runtime. Modified generated JavaScript fails verification; restoring it passes. An attacker can replace/re-sign an ad-hoc app, so this is not publisher attestation. |
| Refresh replay | Keep only consumed refresh-token hashes until expiry. Matching client/resource reuse revokes the entire grant and its tokens, with an audit event. Tests cover unrelated grants, wrong clients and Durable Object eviction. Duplicate legitimate refreshes now require reauthorization. |
| Vault | Explicit 16-byte GCM tags. The original slicing already enforced that length, so this is scanner-driven hardening, not a demonstrated short-tag vulnerability. |
| Remote MCP | Deadline includes DNS and HTTPS. Cancelling stalled DNS opens no socket even if resolution finishes later. Private or mixed public/private DNS answers fail before credentials are sent. |
| Resource policy | Private APIs/assets declare same-origin; public MCP/OAuth remains cross-origin. Metadata CORS is anonymous, not credentialed. |
| Publisher | Missing release assets use no-store instead of year-long immutable caching; regression test added. |

Existing adversarial suites exercise cross-company/team references, personal privacy, removed memberships, policy precedence, changed arguments, stale/expired approvals, signed-request replay, revocation, concurrent dispatch and ambiguous writes. Controlled cases are not exhaustive coverage.

## Scanners and limitations

- Semgrep CE 1.186.0, p/security-audit and p/typescript, metrics disabled: one initial finding, zero after explicit GCM configuration; 96 applicable rules across 37 files in that scan. No cloud account/source upload. Does not comprehensively audit Swift. Scheduled CI intentionally fetches updated registry rules.
- Gitleaks 8.30.1, full redaction: initial histories clean (18 backend commits, 5 private dashboard commits). Final changes scanned before publication. Not every credential format is detectable.
- Backend production dependency audit: zero known advisories. Development dependencies still report GHSA-fc5q-39xc-vjpf (picomatch ReDoS, seven affected dependency entries). Latest published picomatch checked here is 4.0.7, also affected. Globs are repository-controlled. Keep dev servers private, avoid untrusted patterns/repositories and recheck before release. Do not downgrade to incompatible toolchains to silence the warning.
- ZAP official stable image sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af: bounded authenticated OpenAPI active scan. First run: 118 rules passed, three warning categories, no FAIL-class findings. Public CORS warnings concern anonymous OAuth metadata. The fixture root returns 503 because no publisher is configured. Missing resource-policy headers were fixed and rescanned. WARN is not a clean bill of health.

Artifacts stay in ignored .data/security-audit; never publish raw session/request captures. Coverage excludes complete browser workflows, real provider OAuth, native keychain extraction, every API route and production edge configuration.

## Remaining trust boundaries

An unrestricted agent running as the credential owner is inside the trusted endpoint boundary. It can modify writable app files, replace/re-sign an ad-hoc app, steal accessible sessions or automate approvals. It may be able to use the unlocked keyring. No real credentials were extracted to demonstrate this. A button click is not proof of a physical human; device signatures prove key possession, not approved software execution.

The current keyring does not provide biometric-gated use, a Secure Enclave broker, hardware attestation or an independent approval channel. Containers help only when the agent cannot access host files, credentials, Docker sockets, privileged capabilities or host UI. A container cannot protect a connector from its host administrator.

Control-plane operators can change policies and see tool results; server custody additionally places provider tokens in their trust domain. Tenant databases share infrastructure and administration. An operator-writable hash-linked audit log is not immutable evidence against that operator. None of these designs is zero knowledge.

## Finance and crypto release gates

Required future work, not implemented features:

1. Isolate the agent on another host/VM or restricted OS identity, with no connector files, shared home/keychain, host socket, accessibility automation or approval session. Scoped MCP is its action channel. Independently test escapes.
2. Provide a company-managed executor outside agent control, application control/MDM, admin-owned installation and least-privilege service identity. A separately protected secrets broker verifies callers and exact operations without returning raw credentials to the agent.
3. Use phishing-resistant step-up authentication and two authorized people on independent devices for sensitive actions. Bind approval to company, actor, connector, exact arguments, policy revision, deadline and nonce. Require dual control to weaken policy or enable powerful connectors. Current single approval does not do this.
4. Keep financial signing separate. Never put seed phrases or wallet keys in a generic OAuth store. Use a reviewed HSM, hardware wallet or multisig service, transaction simulation, recipient/asset/network allowlists, amount/velocity limits and independent transaction-hash confirmation. Argos approval alone does not secure transfers.
5. Developer ID signing, Hardened Runtime with reviewed entitlements, notarization/stapling and rollback-resistant updates. Protect the signing process and publish build provenance plus an SBOM. The 0.1.4 preview remains ad-hoc signed and unnotarized; no signing identity is available here.
6. Separate production roles, hardware-backed admin MFA, audited break-glass access, restricted CI credentials, independently controlled append-only audit storage and incident/revocation drills. Dedicated deployments/customer keys are options; BYOK cannot alone prevent a compromised runtime from using a key.
7. Independent review/pentest, real provider refresh/revocation tests, Windows/macOS endpoint tests, recovery drills, retention/deletion procedures and a disclosure channel. Compliance depends on jurisdiction/use case. ISO 27001 and SOC 2 require separate scoped assessments; scanners issue neither.

## Reproduce

Run npm run check, npm test, npm run test:cloudflare, npm run check:secrets and npm audit --omit=dev. Run Semgrep locally with the registry packs above and metrics disabled; run gitleaks git . --redact=100.

In the private dashboard, run npm run check and npm test. Compile desktop/RuntimeSecurity.swift plus desktop/RuntimeSecurityTests.swift with swiftc and -framework Security, then pass the absolute Node binary and generated app bundle to the resulting test executable.

For ZAP, run tsx scripts/security-fixture.ts and mount only .data/security-audit/zap at /zap/wrk in the official container. Use zap-api-scan.py with -t /zap/wrk/openapi.json -f openapi -J zap.json -r zap.html -s -T 3 -z '-configfile /zap/wrk/fixture.properties'. The properties contain a disposable fake-account session only. Never substitute production URLs/accounts. Stop the fixture and container afterward.

## Final local validation

105 backend tests, 18 Cloudflare runtime tests and 6 private dashboard tests passed (129 total), plus native environment-injection and signed-resource tampering checks. Final ZAP rescan: 119 rules passed, no FAIL-class findings and two remaining warning categories, the documented public OAuth metadata CORS and fixture-only root 503. The missing resource-policy warning is resolved. Test servers and scanner containers were stopped.

Final staged Gitleaks initially flagged ordinary prose about signing in this report as a generic API key. The text contained no secret; it was reworded and rescanned without adding an exclusion. Native ZIP SHA-256: ee961430ed2839daab7445595995d1989958e37b77ea69d2fc41b5063ef862f4.

## Publication and live verification

- Backend source: 0a7d5e3; draft PR https://github.com/RavioleLabs/argosmcp/pull/3.
- Private dashboard/native source: ce1109b; draft PR https://github.com/RavioleLabs/argos-dashboard/pull/3.
- Personal 0.1.4 build 5: https://github.com/RavioleLabs/argosmcp/releases/tag/personal-v0.1.4-preview.1. Uploaded ZIP size: 64,210,085 bytes. Signature verification passed locally; this remains an unnotarized ad-hoc preview.
- Dashboard release a59bcfcf3be9de6e, Worker 55bd6bb1-eb08-47d7-ba14-c21298e6efba.
- Backend Worker 67e25be4-8e8a-4984-9e83-5cb240488688 at https://argosmcp.leraviole.workers.dev.
- Live read-only checks passed for health, anonymous session, public OAuth discovery, pinned dashboard HTML and the JavaScript containing the 0.1.4 download link. Missing publisher assets return 404 with no-store. Public metadata stays anonymous/cross-origin; private API resources are same-origin.
- Native update is published, not installed over the user's existing application. Existing accounts, paired devices and real provider tokens were not changed by the test campaign.

## Hosting and independent-review follow-up

Added three explicit hosting paths with local custody recommended, optional generic remote MCP server execution, Cloudflare public-only bounded transport, pinned OAuth endpoints/PKCE, and refusal of the documented portal Code Mode executors. Remote schemas are compared before dispatch; credentials never appear in company connector definitions. Generic remote provider revocation remains manual and is reported accordingly.

The opt-in independent-review mode requires two distinct reviewers for writes and two administrators to change the mode. Personal argument sharing requires explicit owner consent, and reviewers do not gain connection/result access. Approval identity, revision, expiry and argument digest are checked again. This is not proof of a human, executable attestation or protection against a malicious host administrator.

Validation: 120 backend tests, 19 Cloudflare runtime tests and 6 dashboard tests (145 total); TypeScript checks and both deployment dry-runs passed. Semgrep follow-up found zero findings/errors in backend, Workers and scripts. Staged Gitleaks found no secrets. Native environment injection, launch URL and bundle validation passed on 0.1.5 build 6, followed by strict recursive signature verification. The preview is still ad-hoc signed and not notarized. ZIP SHA-256: a8f9e026cbbee96a4d98b2e57e1cc8205254dda61674e3fc5368e0f724c7e007.

Visual checks used an isolated, in-memory demo with external provider calls disabled. Hosting comparison, company connectors and server-storage consent rendered correctly. No existing production company's custody setting or credentials were changed. Real Cloudflare Portal OAuth remains unverified: the account has no portal and argosnode.ai DNS delegation is pending. The previous ZAP results above apply to the earlier security release, not a new ZAP scan of this follow-up.
