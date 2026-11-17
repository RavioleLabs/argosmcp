# ArgosMCP

Independent project at ~/raviolelabs/argosmcp. Do not move it into clawbots or modify the other Argos/BonDossier projects.

Product decisions and current delivery boundaries are in docs/CONTEXT.md, README.md and SECURITY.md. Keep them accurate.

Local provider-token custody is the default recommendation. Emeric explicitly authorized optional server custody on 2026-11-18: require deployment enablement, administrator opt-in and explicit user consent, preserving current local connections. Never expose raw credentials through UI, MCP, logs or test artifacts. Cloud login is separate. Dashboard/native presentation source belongs only in the private ../argos-dashboard repository; this repository publishes the backend/runtime only.

UI language is English. Keep the light, quiet Apple-inspired interface and AI-to-tools branch logo.

Use npm run check, npm test and npm run test:cloudflare for security changes. Do not leave test servers running. Do not claim real provider activation, cloud deployment, Developer ID signing, notarization, biometric gating or hardware attestation without verifying it.
