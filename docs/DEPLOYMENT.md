# Hosted deployment

The repository is public at https://github.com/RavioleLabs/argosmcp. The Worker is deployed at https://argosmcp.leraviole.workers.dev in setup-only mode. Its landing page is public; unconfigured workspace APIs return 503. GitHub Actions verifies the source on every push.

## Company provisioning

The RavioleLabs company configuration has been prepared locally for `https://raviolelabs.argosnode.ai`. The owner identity and encryption keys live only in the ignored `.data/cloudflare.secrets.json`. Every company gets a distinct UUID and canonical HTTPS origin. The root platform hostname is not a shared company database.

1. Google Cloud is activated and the dedicated `argosmcp-raviolelabs` project and ArgosMCP consent profile have been created. The audience is External, in Testing mode.
2. The ArgosMCP Google OAuth **Web application** has been created with both `https://raviolelabs.argosnode.ai/auth/google/callback` and `https://argosmcp.leraviole.workers.dev/auth/google/callback` as authorized redirects. Argos login requests only `openid email profile`.
3. **Pending:** save the Google client JSON locally in the ignored `.data` directory, then run `scripts/configure-hosted.mjs` as described in README. This preserves the keyring and company UUID. Never paste the secret into chat or commit it.
4. Complete the DNS migration below, then bind the workspace hostname as a Worker custom domain.
5. Deploy with the secrets file, without `ARGOS_SETUP_ONLY=1`. Verify sign-in with the designated owner before inviting members.
6. Pair Argos Personal, compare fingerprints, create an agent grant, and test an Engram context. Real provider connections require separate local consent.

The ignored configuration also contains an isolated RavioleLabs preview workspace at the workers.dev origin, with a **different company UUID**. This allows testing Google login before the production DNS migration. Neither workspace is active until the complete secrets are deployed. Do not reuse the preview UUID for production.

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
