import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
const tenants = {
  'https://alpha.example.test': {
    id: '00000000-0000-4000-8000-000000000101',
    name: 'Alpha',
    ownerEmail: 'owner@alpha.test',
  },
  'https://beta.example.test': {
    id: '00000000-0000-4000-8000-000000000102',
    name: 'Beta',
    ownerEmail: 'owner@beta.test',
  },
};
export default defineConfig({
  plugins: [
    cloudflareTest({
      config: true,
      miniflare: {
        bindings: {
          ARGOS_DEPLOYMENT: 'company-cloudflare',
          ARGOS_TENANTS_JSON: JSON.stringify(tenants),
          ARGOS_SERVER_CUSTODY: '1',
          ARGOS_PROVIDER_VAULT_KEYRING: JSON.stringify({
            v1: Buffer.alloc(32, 8).toString('base64'),
          }),
          ARGOS_DASHBOARD_URL: 'https://dashboard.example.test',
          ARGOS_DASHBOARD_VERSION: '',
          SLACK_PUBLIC_CLIENT_ID: 'fixture-slack-public',
          LINEAR_PUBLIC_CLIENT_ID: '',
          ARGOS_VAULT_KEYRING: JSON.stringify({ v1: Buffer.alloc(32, 7).toString('base64') }),
          GOOGLE_CLIENT_ID: 'google-test-client',
          GOOGLE_CLIENT_SECRET: 'google-test-secret',
          SLACK_CLIENT_ID: '',
          SLACK_CLIENT_SECRET: '',
          NOTION_CLIENT_ID: '',
          NOTION_CLIENT_SECRET: '',
          LINEAR_CLIENT_ID: '',
          LINEAR_CLIENT_SECRET: '',
          ENGRAM_TARGETS_JSON: '[]',
        },
      },
    }),
  ],
  test: { include: ['tests/cloudflare/**/*.test.ts'], testTimeout: 20000 },
});
