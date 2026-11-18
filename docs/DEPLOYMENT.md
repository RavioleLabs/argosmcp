# Hosted deployment

The repository is public at https://github.com/RavioleLabs/argosmcp. The hosted entry point is https://argosmcp.leraviole.workers.dev with Google OAuth secrets configured. Real Google sign-in has been observed. The self-service flow creates independent companies without an invitation; runtime tests cover the full creation, invitation, device and MCP OAuth lifecycle. GitHub Actions verifies the source on every push.

## Company provisioning

The RavioleLabs company configuration has been prepared locally for `https://raviolelabs.argosnode.ai`. The owner identity and encryption keys live only in the ignored `.data/cloudflare.secrets.json`. Each new company gets a random UUID, its own SQLite Durable Object, and a canonical HTTPS URL at `/w/<UUID>`. The root object authenticates Google identities and retains the legacy reserved company; it does not hold the new companies’ data. The account directory is a separate private object per Google subject and platform origin.

1. Google Cloud is activated and the dedicated `argosmcp-raviolelabs` project and ArgosMCP consent profile have been created. The audience is External, in Testing mode.
2. The ArgosMCP Google OAuth **Web application** has been created with both `https://raviolelabs.argosnode.ai/auth/google/callback` and `https://argosmcp.leraviole.workers.dev/auth/google/callback` as authorized redirects. Argos login requests only `openid email profile`.
3. The Google client configuration was saved locally with mode 600, imported with `scripts/configure-hosted.mjs`, and deployed as Worker secrets. The existing keyring and company UUIDs were preserved. Never paste the secret into chat or commit it.
4. Complete the DNS migration below, then bind the workspace hostname as a Worker custom domain.
5. Deploy with the secrets file, without `ARGOS_SETUP_ONLY=1`. Sign in with Google, create a named workspace from the welcome screen, and verify the Owner role before inviting members. Any signed-in account can create its own company.
6. Pair Argos Personal, compare fingerprints, create an agent grant, and test a supported provider connection. Real provider connections require separate local consent.

The ignored configuration also contains an isolated RavioleLabs preview workspace at the workers.dev origin, with a **different company UUID**. This allows testing Google login before the production DNS migration. The preview configuration is deployed. The production hostname still needs its DNS/custom-domain binding. Do not reuse the preview UUID for production.

## DNS migration

A free Cloudflare zone exists for `argosnode.ai`, currently **pending**. Assigned nameservers:

- `isaac.ns.cloudflare.com`
- `robin.ns.cloudflare.com`

The authoritative DNS is still OVH (`dns14.ovh.net`, `ns14.ovh.net`). Public lookups show an existing Vercel A record, OVH MX records and SPF. These lookups are **not a full DNS inventory**. The new Cloudflare zone is empty; changing nameservers now would interrupt existing services.

Export the **complete** authoritative zone from OVH, including all subdomains, mail, DKIM, DMARC, TXT, CAA and verification records. Import it into Cloudflare, compare the record sets, keep existing records DNS-only unless intentionally changing them, and check DNSSEC/DS before changing delegation. Then add the new workspace Worker custom domain and switch nameservers. Confirm authoritative resolution and TLS before enabling real clients.

The repository does not contain an OVH API credential. No registrar delegation has been changed.

## Recovery and releases

Back up the server encryption keyring and local OS keychain through your controlled backup process. Losing a wrapping key makes encrypted records unreadable. Code signing is local ad-hoc only; Apple Developer ID signing and notarization remain required for a normal public macOS installer. No provider secrets are embedded in the app bundle.

The current development toolchain has the unpatched picomatch advisory documented in SECURITY.md. Production dependencies have no known npm advisories in the recorded verification. No external security audit or production readiness certification is claimed.

## First sign-in

Google login creates an identity and session, not membership in another company. The welcome screen offers workspace creation, existing workspaces, invitation acceptance and account switching. Creating a workspace atomically establishes its Google-subject-bound owner and isolated database; retries with the same request ID resume the same creation. Changing the name with a reused request ID returns 409. Accounts may create up to 20 companies.

Workspace URLs are `/w/<UUID>/`; invitation, device pairing, MCP discovery, authorization and token URLs preserve that prefix. The Google callback remains at the platform root and validates its return path. Browser identity is passed internally by Worker RPC; caller-supplied identity headers are ignored. MCP endpoints still require their own bearer grants and local devices their signed proofs. Directory entries never authorize access: current membership is checked on every listing and company request.

The macOS app must be rebuilt with this version to accept workspace paths. Existing root-company profiles continue to work. Custom domains and a normal notarized public installer remain separate deployment steps.

## Release verification · 2026-11-18

Self-service release deployed as Worker version `71456e2d-7efd-4df4-b0a1-1f317a39dc6c`. Type checks, 78 Node tests, 15 Workers runtime tests and the web build pass. The rebuilt Argos Personal macOS bundle passes local ad-hoc signature verification.

Public HTTP checks confirm the HTML and bundled assets load, `/api/session` reports Google and self-service enabled, anonymous `/api/workspaces` and `/mcp` return 401, and unknown workspace APIs return 404. The browser was signed in with a non-reserved Google account before deployment, but native browser control stopped exposing page contents after refresh. A real user submitting the new workspace form and reaching the owner dashboard has not yet been observed. This limitation must not be represented as a verified live end-to-end signup.

## Guided installation release · 2026-11-18

Worker version `5165124f-32d3-47e2-a3b0-d4ec5719ebb0` deploys the installation guide, the pre-creation explanation of the companion app, and workspace-preserving navigation. The macOS Apple silicon preview is published as GitHub release `personal-v0.1.0-preview.1`, with an archive checksum matching GitHub’s uploaded asset digest. It requires macOS 26 or later and is not notarized.

82 Node tests, 15 Workers tests, type checks, builds and CI pass. Live browser inspection confirms the pre-creation explanation, an existing user-created workspace with the Owner role, and the full Getting started page with the download button, installation steps and companion-app explanation. This supersedes the previous browser-inspection blocker for these screens; device installation and real provider consent have not been verified by that inspection.
