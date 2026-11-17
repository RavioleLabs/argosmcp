# Hosted deployment

The repository is public at https://github.com/RavioleLabs/argosmcp. The Worker is deployed at https://argosmcp.leraviole.workers.dev with the isolated RavioleLabs preview workspace and Google OAuth secrets configured. Its session endpoint reports `googleConfigured: true`; unauthenticated MCP calls return 401. The real login callback exposed an unsupported fetch redirect mode in workerd. The corrected implementation uses manual redirects and rejects 3xx responses before reading the body. Real Google sign-in has been observed for an account without workspace membership. Browser verification of designated-owner workspace creation remains pending. GitHub Actions verifies the source on every push.

## Company provisioning

The RavioleLabs company configuration has been prepared locally for `https://raviolelabs.argosnode.ai`. The owner identity and encryption keys live only in the ignored `.data/cloudflare.secrets.json`. Every company gets a distinct UUID and canonical HTTPS origin. The root platform hostname is not a shared company database.

1. Google Cloud is activated and the dedicated `argosmcp-raviolelabs` project and ArgosMCP consent profile have been created. The audience is External, in Testing mode.
2. The ArgosMCP Google OAuth **Web application** has been created with both `https://raviolelabs.argosnode.ai/auth/google/callback` and `https://argosmcp.leraviole.workers.dev/auth/google/callback` as authorized redirects. Argos login requests only `openid email profile`.
3. The Google client configuration was saved locally with mode 600, imported with `scripts/configure-hosted.mjs`, and deployed as Worker secrets. The existing keyring and company UUIDs were preserved. Never paste the secret into chat or commit it.
4. Complete the DNS migration below, then bind the workspace hostname as a Worker custom domain.
5. Deploy with the secrets file, without `ARGOS_SETUP_ONLY=1`. Sign in with the designated owner, create the workspace from the welcome screen, and verify the Owner role before inviting members.
6. Pair Argos Personal, compare fingerprints, create an agent grant, and test an Engram context. Real provider connections require separate local consent.

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

Google login creates an identity and session, not company membership. A first-time designated owner sees the workspace creation form. An account without membership sees its signed-in email, an invitation form, and an account-switch action. Only the configured owner can initialize the company UUID at this address, and only once. Existing workspaces and memberships are retained. Hosted address provisioning is currently operator-managed; this welcome flow does not yet provision arbitrary new company domains.
