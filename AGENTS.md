# ArgosMCP

Independent project at ~/raviolelabs/argosmcp. Do not move it into clawbots or modify the other Argos/BonDossier projects.

Product decisions and current delivery boundaries are in docs/CONTEXT.md, README.md and SECURITY.md. Keep them accurate.

Provider tokens belong on the personal device. Do not restore hosted provider OAuth or expose raw provider credentials through the UI, MCP, logs or test artifacts. Cloud login to Argos is separate.

UI language is English. Keep the light, quiet Apple-inspired interface and AI-to-tools branch logo.

Use npm run check, npm test and npm run test:cloudflare for security changes. Do not leave test servers running. Do not claim real provider activation, cloud deployment, Developer ID signing, notarization, biometric gating or hardware attestation without verifying it.
