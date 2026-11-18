# Company Cloudflare portals

Argos Personal remains the recommended path: AI → Argos policies and approvals → personal device → provider. Provider tokens never transit the Argos backend in that credential flow. Requests and results do.

Cloud access uses AI → Argos policies and approvals → company Cloudflare MCP Portal → provider. Cloudflare holds the provider tokens. Argos holds an encrypted, personal OAuth grant to the portal. That grant can invoke providers: its backend operator is still trusted. Moving token custody to Cloudflare does not remove Argos's security responsibilities.

## Hosting choices

| Backend | Local direct execution | Cloud execution |
| --- | --- | --- |
| Managed Argos backend on Cloudflare | Recommended | Portal in Argos's account, separately provisioned per company; or company-owned portal |
| Open-source backend in company Cloudflare | Recommended | Company-owned portal |
| Open-source backend on Docker / Node | Recommended | Company-owned Cloudflare portal |

The dashboard is delivered at the selected backend origin; API requests do not relay through the dashboard publisher. Pin and trust its release. The backend and local runtime are MIT; the current dashboard and native presentation source are private. Deploying the company portal alone does not move the Argos backend or eliminate its operator's access.

## Administrator setup

1. In **Connections → Cloudflare MCP Portals**, choose the account. Managed addresses are assigned per workspace. For a company account, enter its HTTPS portal URL ending in `/mcp`.
2. Prepare and download the setup plan. It contains company/member identifiers, emails, provider endpoints and the exact callback, but no OAuth tokens. Treat the member list as private. For an existing portal, use the Cloudflare dashboard instructions below instead of the create-only CLI.
3. Install dependencies in a reviewed checkout of this backend. Sign in locally using `npx cf auth login`; verify `npx cf auth whoami` and the selected account. Use the supported Node version from `package.json`. No Cloudflare account API token is uploaded to Argos.
4. Preview the provisioning operations:

   ```sh
   node scripts/provision-cloudflare-portal.mjs /secure/argos-portal-plan.json ACCOUNT_ID ZONE_ID company.com
   ```

5. Review the account, company, emails, endpoints and callback. Re-run the same command with `--apply` to create resources. This requires an active Cloudflare zone and a Zero Trust identity provider. The CLI refuses a pre-existing portal/hostname and does not overwrite other companies' resources. A private `.state.json` next to the plan records created IDs for resuming the same plan after a partial failure. Inspect the account before retrying ambiguous API failures. This is a create-only provisioning helper, not a reconciliation controller or an automatic rollback system.
6. Review Cloudflare Access policies, DNS and Managed OAuth. The helper creates a separate reusable email allow-policy, separate upstream server objects, per-server Access apps, a portal with `on_behalf: true` and `code_mode: off`, a portal Access app, and proxied DNS last. Public client registration accepts only the exact Argos callback, with PKCE, five-minute access tokens and a 24-hour grant. Provider-specific manual OAuth configuration may still be required in Cloudflare. Changes in membership must also be maintained in Cloudflare; the snapshot is not SCIM synchronization.
7. For a managed portal only, the operator adds the verified `{ "organization UUID": "https://assigned-host/mcp" }` entry to `ARGOS_PROVISIONED_PORTALS_JSON` and deploys the backend configuration. `ARGOS_MANAGED_PORTAL_DOMAIN` reserves this namespace; company administrators cannot claim another managed hostname. Save existing mappings and vault keys when updating configuration.
8. Back in Argos, select **Verify and link portal**. Argos discovers the portal's protected resource and OAuth metadata, requires PKCE S256, registers a public client and creates a draft connector. This verifies OAuth configuration, not every provider integration. Enable Cloudflare connections in **Security**, then sign in personally.
9. Open the portal homepage to connect/select your provider accounts. Review discovered tools in **Company connectors** and publish the exact approved manifest. New tools require approval. Members can then connect their own portal accounts. An administrator's provider credentials are never intended to be shared with the company.
10. Test one read and one approval-gated write with a pilot account. Confirm denial, expired grants, removed members and independent approvals. A real provider round-trip is required before calling that provider production-ready.

## Existing portal requirements

Configure a portal Access application, allow only company identities, enable Managed OAuth and public client registration with the exact Argos callback. Require individual user authentication on each upstream server. Do not use service tokens or admin-shared upstream credentials for personal connections. Disable Code Mode and expose individual tools; generic `portal_execute`, query wrappers and Code Mode tools are rejected because they hide the actual approved operation. Portal selection tools are withheld from the AI manifest.

Do not give an agent a separate direct portal grant if it must obey Argos approvals. Cloudflare does not enforce Argos's per-action manual approvals when Argos is bypassed. Users with their own provider tokens can also act outside Argos, including when their local client is modified.

Cloudflare documents session-dependent server selection for older MCP protocol versions. Compatibility of Argos's SDK and each portal/provider configuration must be verified in a real pilot. The current transport reconnects for each operation; it does not promise persistence of old per-session selection or support interactive MCP elicitation.

## Existing direct server credentials

New cloud connections must use the linked company portal. Existing direct provider connections remain encrypted and usable until their existing expiry/revocation; they are not silently copied to Cloudflare or deleted. Reconnect each account through the portal, verify it, then revoke its legacy connection and upstream authorization where required. The explicit backend-only `ARGOS_ALLOW_DIRECT_SERVER_CUSTODY=1` compatibility switch is for operators maintaining legacy integrations; the managed deployment does not enable it and the current dashboard does not offer it as a new product mode.

Disabling cloud access immediately blocks and revokes Argos-side access. Upstream OAuth revocation may require signing out/revoking the grant in Cloudflare or the provider; Argos does not claim a provider token has been destroyed when it cannot confirm that. Company leases and agent grants remain independent of Cloudflare grant lifetimes.

## Delivery status, 18 November 2026

Backend/UI integration, the create-only provisioning helper and security fixtures are implemented. Real Cloudflare/provider end-to-end compatibility is not yet certified. Managed production portal provisioning is blocked while `argosnode.ai` is pending in Cloudflare. The setup screen must remain **Setup required** until provisioning and verification finish. No live provider tokens were migrated as part of this change.

Sources: [MCP Portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/), [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

### Published verification

The dashboard release `3a89ef46b59c47c8` is pinned by the managed backend. Publisher Worker `342f18d6-90e4-437c-80f5-2cdc5823c72f`; backend Worker `7627459b-9e30-458d-a7a0-ac25e09c721d`. Live HTML, JavaScript, stylesheet and authorization metadata return 200; unauthenticated portal settings return 401. The browser fixture showed the new mode choices and the disabled activation button for an unprovisioned managed portal. Test servers were stopped.

Validation: 138 backend tests, 19 Cloudflare tests and 6 dashboard tests passed. All six types of provisioning request were accepted by the real CLI in dry-run mode; mocked provisioning tests cover pending DNS, collisions and resume. Staged source/assets passed Gitleaks. Local ignored deployment credentials are present by design and were excluded from publication. No actual managed portal, real provider OAuth round-trip or independent security certification is claimed.

### Managed pilot provisioned

A real managed pilot is now provisioned on `argos-demo.raviolelabs.com`, using the already active RavioleLabs zone while `argosnode.ai` activation remains pending. It belongs to a separate **RavioleLabs · Cloudflare demo** workspace. Access is restricted to its owner; Code Mode is off, Managed OAuth uses public PKCE clients and the workspace-specific callback, with a 24-hour grant. The upstream is Cloudflare's real public documentation MCP, so this pilot does not require Slack/Notion tokens.

The portal's public OAuth discovery and Argos registration/linking succeeded. Unauthenticated MCP requests return 401. Provisioning exposed an actual Cloudflare API limit of 32 characters for resource identifiers; the helper now generates stable bounded IDs and supports public servers explicitly without sharing provider credentials. An operator-provisioned hostname override is scoped to its assigned company and cannot be claimed through another company's setup.

Personal authorization and the approval-gated end-to-end tool call are pending user consent; infrastructure creation and metadata checks alone are not an end-to-end success claim. Production Worker after this provisioning support update: `b2fe260e-e299-4b9a-83e4-28bd386196c8`. Validation: 141 backend tests and 19 Cloudflare tests passed.
