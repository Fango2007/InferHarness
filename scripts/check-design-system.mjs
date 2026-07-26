import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const documentedTokens = path.join(root, 'docs/design-system/tokens');
const runtimeTokens = path.join(root, 'frontend/src/styles/tokens');
const stylesRoot = path.join(root, 'frontend/src/styles');
const colorTokenFile = path.join(runtimeTokens, 'colors_and_type.css');
const errors = [];

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return files.flat().sort();
}

function relative(file) {
  return path.relative(root, file);
}

const documentedFiles = await listFiles(documentedTokens);
const runtimeFiles = await listFiles(runtimeTokens);
const documentedNames = documentedFiles.map((file) => path.relative(documentedTokens, file));
const runtimeNames = runtimeFiles.map((file) => path.relative(runtimeTokens, file));

if (documentedNames.join('\n') !== runtimeNames.join('\n')) {
  errors.push('Token snapshot file lists differ between docs/design-system/tokens and frontend/src/styles/tokens.');
}

for (const name of documentedNames) {
  const documented = await readFile(path.join(documentedTokens, name));
  const runtime = await readFile(path.join(runtimeTokens, name)).catch(() => null);
  if (runtime === null || !documented.equals(runtime)) {
    errors.push(`Token snapshot drift: ${name}`);
  }
}

const cssFiles = (await listFiles(stylesRoot)).filter((file) => file.endsWith('.css'));
const parsedFiles = await Promise.all(cssFiles.map(async (file) => ({
  file,
  root: postcss.parse(await readFile(file, 'utf8'), { from: file })
})));
const definitions = new Set();
const usages = [];
const hardcodedColor = /(?:#[\da-f]{3,8}\b|(?:rgb|hsl)a?\()/i;
const rawPixelValue = /(?:^|\s)\d*\.?\d+px(?:\s|$)/;

for (const parsed of parsedFiles) {
  parsed.root.walkDecls((declaration) => {
    if (declaration.prop.startsWith('--')) {
      definitions.add(declaration.prop);
    }

    for (const match of declaration.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      usages.push({
        name: match[1],
        file: parsed.file,
        line: declaration.source?.start?.line ?? 0
      });
    }

    if (parsed.file !== colorTokenFile && hardcodedColor.test(declaration.value)) {
      errors.push(
        `${relative(parsed.file)}:${declaration.source?.start?.line ?? 0} uses a hardcoded color in ${declaration.prop}.`
      );
    }

    if (!parsed.file.startsWith(runtimeTokens) && declaration.prop === 'font-size' && rawPixelValue.test(declaration.value)) {
      errors.push(
        `${relative(parsed.file)}:${declaration.source?.start?.line ?? 0} uses a raw pixel font size.`
      );
    }

    if (!parsed.file.startsWith(runtimeTokens) && declaration.prop.endsWith('radius') && rawPixelValue.test(declaration.value)) {
      errors.push(
        `${relative(parsed.file)}:${declaration.source?.start?.line ?? 0} uses a non-token border radius.`
      );
    }
  });
}

for (const usage of usages) {
  if (!definitions.has(usage.name)) {
    errors.push(`${relative(usage.file)}:${usage.line} uses unresolved variable ${usage.name}.`);
  }
}

const frontendSourceFiles = (await listFiles(path.join(root, 'frontend/src')))
  .filter((file) => /\.(?:css|ts|tsx)$/.test(file) && file !== colorTokenFile);
for (const file of frontendSourceFiles) {
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.forEach((line, index) => {
    if (hardcodedColor.test(line)) {
      errors.push(`${relative(file)}:${index + 1} uses a hardcoded color.`);
    }
  });
}

if (errors.length > 0) {
  console.error('Design-system conformance check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Design-system conformance check passed (${documentedFiles.length} token assets, ${cssFiles.length} CSS files).`);
}
