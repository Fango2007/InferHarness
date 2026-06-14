import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';
import {
  configureInferenceProxyFromEnv,
  resolveInferenceProxyConfig,
  shouldDisableInferenceTlsVerification
} from './services/inference-proxy.js';
import { ensureLocalApiTokenEnv } from './services/env-bootstrap.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..');
const envPath = path.join(repoRoot, '.env');

const bootstrapResult = ensureLocalApiTokenEnv({ envPath });
for (const warning of bootstrapResult.warnings) {
  console.warn(`[env] ${warning}`);
}
if (bootstrapResult.generated) {
  console.info(`[env] Generated local API token in ${envPath}`);
} else if (bootstrapResult.changed) {
  console.info(`[env] Synchronized local API token entries in ${envPath}`);
}

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.info(`[env] Loaded ${envPath}`);
} else {
  dotenv.config();
}

if (configureInferenceProxyFromEnv()) {
  if (resolveInferenceProxyConfig()) {
    console.info('[env] Inference server outbound proxy enabled via INFERHARNESS_INFERENCE_PROXY');
  }
  if (shouldDisableInferenceTlsVerification()) {
    console.warn('[env] Inference server TLS certificate verification disabled via INFERHARNESS_INFERENCE_TLS_INSECURE');
  }
}

import { createServer } from './api/server.js';


const app = createServer();
const port = Number(process.env.PORT || 8080);

app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err, 'Failed to start server');
  process.exit(1);
});
