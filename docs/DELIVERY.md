# Delivery — 2026-11-18

- Public backend/local runtime: https://github.com/RavioleLabs/argosmcp
- Private presentation repository: `RavioleLabs/argos-dashboard` (verified private).
- Managed backend: https://argosmcp.leraviole.workers.dev
- Hosted dashboard publisher: https://argos-dashboard.leraviole.workers.dev
- Pinned dashboard release: `8a12895591aa3e77`.
- Backend Worker version: `7675bbe0-35cb-4ef2-af9a-b311a0c70cf6`.

Implemented: local custody recommendation and explanation; optional server vault with operator/admin/user opt-ins; company-bound OAuth; immediate authorization checks; separate publisher and backend; Docker self-hosting with same-origin dashboard; protected local UI installation for the public runtime.

Verified: 86 backend tests, 16 Cloudflare runtime tests, five dashboard onboarding tests, both type checks/builds, production dependency audit (zero advisories), Docker startup/static delivery under non-root/read-only restrictions, Mac package/signature build, and signed-in LeRavio browser screens. Native Windows Credential Manager integration was verified separately on the Windows CI runner.

Remaining release work: real test-account consent/refresh/revoke for each provider; registered Slack/Linear public OAuth apps and exact callbacks; Apple Developer ID/notarization; a native Windows installer; argosnode.ai DNS migration; independent security review before commercial rollout. Server vault availability does not turn it on for existing workspaces or migrate local tokens. The new feature was left disabled in LeRavio.

Previously published frontend/native MIT code stays available under its original license in repository history. New private dashboard commits are not in the public branch ancestry.
