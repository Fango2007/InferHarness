import { ensureLocalApiTokenEnv } from '../services/env-bootstrap.js';

const result = ensureLocalApiTokenEnv();

for (const warning of result.warnings) {
  console.warn(`[env] ${warning}`);
}

if (result.generated) {
  console.info('[env] Generated local API token in .env');
} else if (result.changed) {
  console.info('[env] Synchronized local API token entries in .env');
}
