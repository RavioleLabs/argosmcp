// Vendor documentation checked 2026-11-18. Listing is not an Argos compatibility certification.
export interface DirectoryEntry {
  id: string;
  name: string;
  category: string;
  endpoint?: string;
  source: string;
  notes: string;
  builtin?: string;
}
const googleSource = 'https://developers.google.com/workspace/guides/configure-mcp-servers';
export const connectorDirectory: DirectoryEntry[] = [
  {
    id: 'cloudflare-mcp-portal',
    name: 'Cloudflare MCP Portal',
    category: 'Gateways',
    source:
      'https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/',
    notes:
      'Bring your own portal HTTPS endpoint and public PKCE client registration. Cloudflare holds upstream provider credentials; Argos holds portal access locally or on your backend. Disable Code Mode and expose individual tools for action approvals. Live portal compatibility must be verified with your configuration.',
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'Communication',
    endpoint: 'https://mcp.slack.com/mcp',
    source: 'https://docs.slack.dev/ai/slack-mcp-server/',
    notes:
      'Official MCP with OAuth. Requires an internal or Marketplace-published Slack app with PKCE enabled for desktop use. Workspace administrators can block the app. DM access depends on selected scopes.',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'Knowledge',
    endpoint: 'https://mcp.notion.com/mcp',
    source: 'https://developers.notion.com/docs/mcp',
    builtin: 'notion',
    notes: 'OAuth. Workspace administrators may restrict connected AI applications.',
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'Projects',
    endpoint: 'https://mcp.linear.app/mcp',
    source: 'https://linear.app/docs/mcp',
    builtin: 'linear',
    notes: 'OAuth or a restricted API key. Argos also includes a focused native adapter.',
  },
  ...[
    ['drive', 'Google Drive', 'drivemcp'],
    ['gmail', 'Gmail', 'gmailmcp'],
    ['calendar', 'Google Calendar', 'calendarmcp'],
    ['chat', 'Google Chat', 'chatmcp'],
    ['classroom', 'Google Classroom', 'classroommcp'],
    ['docs', 'Google Docs', 'docsmcp'],
    ['sheets', 'Google Sheets', 'sheetsmcp'],
    ['slides', 'Google Slides', 'slidesmcp'],
    ['search', 'Google Workspace Search', 'workspacemcp'],
  ].map(([id, name, host]) => ({
    id: 'google-' + id,
    name,
    category: 'Google Workspace',
    endpoint: `https://${host}.googleapis.com/mcp/v1`,
    source: googleSource,
    notes:
      'Developer Preview. Requires Google project setup, eligible access and an OAuth client configured for AI agents. Check current vendor requirements.',
  })),
  {
    id: 'neon',
    name: 'Neon',
    category: 'Development',
    endpoint: 'https://mcp.neon.tech/mcp',
    source: 'https://github.com/neondatabase/mcp-server-neon/blob/main/server.json',
    notes: 'Official remote MCP. Scope database and branch access carefully.',
  },
  {
    id: 'canva',
    name: 'Canva',
    category: 'Design',
    endpoint: 'https://api.canva.com/connect/v1/mcp',
    source: 'https://www.canva.dev/blog/developers/canva-mcp-ga/',
    notes: 'Enable Canva MCP in the Developer Portal and configure the application OAuth client.',
  },
  {
    id: 'paypal',
    name: 'PayPal',
    category: 'Finance',
    source: 'https://developer.paypal.com/ai-tools/mcp-server',
    notes:
      'Official remote MCP. Choose the documented environment and authentication mode; confidential client credentials are not supported by the Argos public-client OAuth flow.',
  },
  {
    id: 'attio',
    name: 'Attio',
    category: 'CRM',
    endpoint: 'https://mcp.attio.com/mcp',
    source: 'https://attio.com/apps/mcp',
    notes: 'Official OAuth MCP for CRM records and workflows.',
  },
  {
    id: 'bondossier',
    name: 'BonDossier',
    category: 'Business',
    endpoint: 'https://bondossier.com/mcp',
    source: 'https://bondossier.com',
    notes:
      'RavioleLabs first-party connector. OAuth or a restricted API key; availability depends on the BonDossier deployment.',
  },
  {
    id: 'atlassian',
    name: 'Atlassian Rovo',
    category: 'Projects',
    endpoint: 'https://mcp.atlassian.com/v2/mcp',
    source: 'https://developer.atlassian.com/cloud/rovo-mcp/',
    notes: 'Jira, Confluence and supported Atlassian tools. OAuth and organization controls apply.',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Development',
    endpoint: 'https://api.githubcopilot.com/mcp/',
    source: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
    notes:
      'OAuth or a fine-grained personal access token. Select repositories and permissions carefully.',
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'CRM',
    endpoint: 'https://mcp.hubspot.com/',
    source:
      'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server',
    notes: 'OAuth with HubSpot application configuration.',
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    category: 'CRM',
    source:
      'https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/servers-reference.html',
    notes:
      'Organization-specific hosted MCP endpoints. A Salesforce administrator must configure access.',
  },
  {
    id: 'asana',
    name: 'Asana',
    category: 'Projects',
    endpoint: 'https://mcp.asana.com/v2/mcp',
    source: 'https://developers.asana.com/docs/using-asanas-mcp-server',
    notes: 'OAuth. Register an application using the current Asana integration guide.',
  },
  {
    id: 'intercom',
    name: 'Intercom',
    category: 'Support',
    endpoint: 'https://mcp.intercom.com/mcp',
    source: 'https://developers.intercom.com/docs/guides/mcp',
    notes: 'US endpoint shown. Choose the endpoint matching your Intercom data region.',
  },
  {
    id: 'figma',
    name: 'Figma',
    category: 'Design',
    endpoint: 'https://mcp.figma.com/mcp',
    source: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
    notes: 'OAuth. Plan and seat limits may apply.',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Finance',
    endpoint: 'https://mcp.stripe.com',
    source: 'https://docs.stripe.com/mcp',
    notes: 'OAuth or a restricted key. Review all financial write operations.',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'Development',
    endpoint: 'https://mcp.supabase.com/mcp',
    source: 'https://supabase.com/docs/guides/getting-started/mcp',
    notes: 'Scope to one project and prefer read-only access where possible.',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    category: 'Development',
    endpoint: 'https://mcp.vercel.com',
    source: 'https://vercel.com/docs/agent-resources/vercel-mcp',
    notes: 'Official remote MCP. Team access and OAuth configuration apply.',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'Development',
    endpoint: 'https://mcp.sentry.dev/mcp',
    source: 'https://mcp.sentry.dev/',
    notes: 'OAuth. Can be scoped to an organization and project.',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'Infrastructure',
    endpoint: 'https://mcp.cloudflare.com/mcp',
    source:
      'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
    notes:
      'Official Cloudflare MCP. Review account scope and permissions before enabling execution.',
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare Documentation',
    category: 'Knowledge',
    endpoint: 'https://docs.mcp.cloudflare.com/mcp',
    source:
      'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
    notes: 'Public documentation search. No account token required.',
  },
];
