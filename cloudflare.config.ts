import { defineConfig, bindings, exports } from 'cf/config';
export default defineConfig({
  worker: {
    name: 'argosmcp',
    workersDev: true,
    previewUrls: false,
    entrypoint: './cloudflare/worker.ts',
    compatibilityDate: '2026-11-17',
    compatibilityFlags: ['nodejs_compat'],
    assets: { runWorkerFirst: true },
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
      ASSETS: bindings.assets(),
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
