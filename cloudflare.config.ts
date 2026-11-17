import { defineConfig, bindings, exports } from 'cf/config';
export default defineConfig({
  worker: {
    name: 'argosmcp',
    workersDev: true,
    previewUrls: false,
    entrypoint: './cloudflare/worker.ts',
    compatibilityDate: '2026-11-17',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    assets: { runWorkerFirst: true, htmlHandling: 'none' },
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: false },
      // Automatic spans include full OAuth callback URLs. Keep trace sampling off.
      traces: { enabled: true, headSamplingRate: 0 },
    },
    exports: {
      CompanyWorkspace: exports.durableObject({ storage: 'sqlite' }),
      AccountDirectory: exports.durableObject({ storage: 'sqlite' }),
    },
    env: {
      WORKSPACES: bindings.durableObject({ worker: 'argosmcp', exportName: 'CompanyWorkspace' }),
      ACCOUNTS: bindings.durableObject({ worker: 'argosmcp', exportName: 'AccountDirectory' }),
      ARGOS_DASHBOARD_URL: bindings.secret(),
      ARGOS_DASHBOARD_VERSION: bindings.secret(),
      SLACK_PUBLIC_CLIENT_ID: bindings.secret(),
      LINEAR_PUBLIC_CLIENT_ID: bindings.secret(),
      ARGOS_SERVER_CUSTODY: bindings.secret(),
      ARGOS_PROVIDER_VAULT_KEYRING: bindings.secret(),
      ARGOS_TENANTS_JSON: bindings.secret(),
      ARGOS_VAULT_KEYRING: bindings.secret(),
      ...(process.env.ARGOS_SETUP_ONLY === '1'
        ? {}
        : {
            GOOGLE_CLIENT_ID: bindings.secret(),
            GOOGLE_CLIENT_SECRET: bindings.secret(),
          }),
    },
  },
});
