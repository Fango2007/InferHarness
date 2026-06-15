import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedMajor = readFileSync(resolve(rootDir, '.nvmrc'), 'utf8').trim();
const actual = process.versions.node;
const actualMajor = actual.split('.')[0];

if (!/^\d+$/.test(expectedMajor)) {
  console.error(`[node-version] .nvmrc must contain a Node major version, got "${expectedMajor}".`);
  process.exit(1);
}

if (actualMajor !== expectedMajor) {
  console.error(
    `[node-version] InferHarness requires Node ${expectedMajor}.x, but current Node is ${actual}. ` +
      'Run `nvm use`, `mise use`, or your version-manager equivalent before installing or rebuilding dependencies.'
  );
  process.exit(1);
}
