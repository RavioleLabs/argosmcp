# Delivery · 2026-11-18

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

## Product focus and punctuation cleanup, 2026-11-18

Engram is retired from the Argos product. The dashboard, onboarding, local presentation, MCP catalog and local execution path no longer provide built-in memory. Previously registered memory providers fail closed. Stored data and separate Engram deployments remain intact. Em dashes are removed from active interface text and the browser title.

- Backend commit: `56b1fe8`; Worker version: `d69f54d6-870d-4483-92e8-717dc1155185`.
- Private presentation commit: `a075c49`; release: `0de989fa20c8ec41`; publisher Worker: `9dfb066e-9b21-4fba-b82d-7a8ed9b0ba0d`.
- Argos Personal 0.1.2 preview: https://github.com/RavioleLabs/argosmcp/releases/tag/personal-v0.1.2-preview.1. Existing installations need the update to remove the old form. The server already blocks old memory calls. Ad-hoc signature verified; no Developer ID/notarization claim.
- Validation: 82 backend tests, 16 Cloudflare runtime tests, five dashboard onboarding tests, TypeScript checks, secret-pattern scan, production builds and deployment dry runs passed. Live served HTML/JS/CSS have no Engram feature or em dash. The retired `/mcp/engram` route returns 404. Browser verification covered the new title, Google login and workspace creation/join screen; no new workspace or provider consent was created.
- Source review: backend https://github.com/RavioleLabs/argosmcp/pull/1 and private presentation https://github.com/RavioleLabs/argos-dashboard/pull/1. Deployed changes are on feature branches; main has not been merged.
