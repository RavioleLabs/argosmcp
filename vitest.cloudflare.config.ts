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
          ARGOS_TENANTS_JSON: JSON.stringify(tenants),
          ARGOS_VAULT_KEYRING: JSON.stringify({ v1: Buffer.alloc(32, 7).toString('base64') }),
          GOOGLE_CLIENT_ID: '',
          GOOGLE_CLIENT_SECRET: '',
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
