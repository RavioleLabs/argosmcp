# Connector release verification

2026-11-18. Backend commit ffdae2b; private presentation commit b086dd3. Feature branches pushed; draft PRs: https://github.com/RavioleLabs/argosmcp/pull/2 and https://github.com/RavioleLabs/argos-dashboard/pull/2. Both are stacked on the prior Engram-removal branch; no main merge performed.

- TypeScript: backend and dashboard pass.
- Tests: 96 backend, 17 Cloudflare, 5 dashboard pass (118 total).
- Known-pattern secret scan passes; this is not a complete security audit.
- Browser verification: isolated in-memory dashboard displays 30 catalog entries, company/request tabs and the official Slack OAuth form. Preview servers stopped after verification.
- Live public MCP smoke: Cloudflare Documentation exposes two tools; one search call completed successfully after one dispatch callback. No user provider credentials used.
- Native build: Argos Personal 0.1.3 build 4; branded ICNS and template menu icon. Strict deep code-signature verification passes. Ad-hoc signed, not notarized, Apple silicon/macOS 26+.
- ZIP: 64,202,787 bytes; SHA-256 `fad7467d7192f1fcda69c192cb995c652c5e718437fb69f21037232de80fc5ba`.
- App release: https://github.com/RavioleLabs/argosmcp/releases/tag/personal-v0.1.3-preview.1 . The existing installed 0.1.1 app was not replaced or interrupted; users must install the update.
- Dashboard immutable release `ceca330d9c784719`; publisher Worker version `32e90a23-9521-40ed-809e-8b7fc13af085`.
- Backend Worker version `c373e46d-99de-4581-9a41-e36a586d057d` at https://argosmcp.leraviole.workers.dev . Health returned OK; delivered HTML references the new pinned release and its JavaScript contains the new catalog. Current delivered HTML/JS contains no em dashes.
- Managed Slack OAuth client ID remains unconfigured. Actual Slack sign-in requires an eligible app/client ID, desktop PKCE setup and any Slack administrator approval. No Slack, Drive, Attio or BonDossier account connection was activated by this release.
