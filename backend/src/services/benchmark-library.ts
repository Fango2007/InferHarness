import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  BenchmarkDocumentKind,
  benchmarkDocumentNaturalId,
  deleteBenchmarkDocument,
  getBenchmarkDocumentOrNull,
  putBenchmarkDocument
} from './benchmark-document-store.js';
import { BenchmarkValidationError, validateAnyBenchmarkDocument } from './benchmark-foundation.js';
import { benchmarkKindFromDocument, sha256Document } from './benchmark-schemas.js';

export const BENCHMARK_LIBRARY_ROOT_ENV = 'INFERHARNESS_BENCHMARK_LIBRARY_ROOT';
export const BENCHMARK_LIBRARY_AUTOSEED_ENV = 'INFERHARNESS_BENCHMARK_LIBRARY_AUTOSEED';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..', '..');
const builtInLibraryRoot = path.resolve(moduleDir, '../benchmark-library/documents');
const defaultUserLibraryRoot = path.join(repoRoot, 'backend', 'data', 'benchmark-library', 'documents');
const documentKinds: BenchmarkDocumentKind[] = ['test_template', 'dataset_manifest', 'runtime_profile', 'benchmark_plan'];

type LibrarySource = 'built_in' | 'user';
type LibraryStatus = 'built_in' | 'user' | 'customized' | 'deleted' | 'invalid' | 'conflict';

export interface BenchmarkLibraryEntry {
  kind: BenchmarkDocumentKind;
  id: string;
  status: LibraryStatus;
  source: LibrarySource | 'tombstone';
  path: string;
  hash?: string;
  db_hash?: string | null;
  message?: string;
}

export interface BenchmarkLibraryInstallReport {
  installed: BenchmarkLibraryEntry[];
  skipped: BenchmarkLibraryEntry[];
  invalid: BenchmarkLibraryEntry[];
  deleted: BenchmarkLibraryEntry[];
}

export interface BenchmarkLibraryStatusReport {
  built_in_root: string;
  user_root: string;
  entries: BenchmarkLibraryEntry[];
}

interface LoadedDocument {
  kind: BenchmarkDocumentKind;
  id: string;
  source: LibrarySource;
  path: string;
  document: Record<string, unknown>;
  hash: string;
}

interface DiscoveredLibrary {
  builtIn: Map<string, LoadedDocument>;
  user: Map<string, LoadedDocument>;
  tombstones: Set<string>;
  invalid: BenchmarkLibraryEntry[];
  conflicts: BenchmarkLibraryEntry[];
}

function keyFor(kind: BenchmarkDocumentKind, id: string): string {
  return `${kind}:${id}`;
}

function encodedDocumentFileName(id: string): string {
  return `${encodeURIComponent(id)}.json`;
}

function documentPath(root: string, kind: BenchmarkDocumentKind, id: string): string {
  return path.join(root, kind, encodedDocumentFileName(id));
}

function tombstonePath(kind: BenchmarkDocumentKind, id: string): string {
  return path.join(userBenchmarkLibraryRoot(), '.deleted', kind, encodedDocumentFileName(id));
}

function ensureInsideRoot(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new BenchmarkValidationError(`Benchmark library path escapes configured root: ${candidate}`);
  }
}

function isBackendTestRun(): boolean {
  return process.env.INFERHARNESS_BACKEND_TESTS === '1' || process.env.VITEST === 'true';
}

export function shouldAutoSeedBenchmarkLibrary(): boolean {
  const configured = process.env[BENCHMARK_LIBRARY_AUTOSEED_ENV]?.trim().toLowerCase();
  if (configured === '0' || configured === 'false') {
    return false;
  }
  if (configured === '1' || configured === 'true') {
    return true;
  }
  return !isBackendTestRun();
}

export function userBenchmarkLibraryRoot(): string {
  const configured = process.env[BENCHMARK_LIBRARY_ROOT_ENV]?.trim();
  if (!configured) {
    return defaultUserLibraryRoot;
  }
  return path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
}

function parseBenchmarkDocument(filePath: string, source: LibrarySource): LoadedDocument | BenchmarkLibraryEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    return {
      kind: 'test_template',
      id: path.basename(filePath),
      status: 'invalid',
      source,
      path: filePath,
      message: `Invalid JSON: ${(error as Error).message}`
    };
  }

  const kind = benchmarkKindFromDocument(parsed);
  if (!kind || !documentKinds.includes(kind as BenchmarkDocumentKind)) {
    return {
      kind: 'test_template',
      id: path.basename(filePath),
      status: 'invalid',
      source,
      path: filePath,
      message: 'Unsupported benchmark document kind.'
    };
  }
  const supportedKind = kind as BenchmarkDocumentKind;
  const document = parsed as Record<string, unknown>;
  const validation = validateAnyBenchmarkDocument(document, supportedKind);
  if (!validation.ok) {
    return {
      kind: supportedKind,
      id: path.basename(filePath),
      status: 'invalid',
      source,
      path: filePath,
      message: validation.issues.map((issue) => issue.message).join('; ')
    };
  }

  return {
    kind: supportedKind,
    id: benchmarkDocumentNaturalId(supportedKind, document),
    source,
    path: filePath,
    document,
    hash: sha256Document(document)
  };
}

function discoverRoot(root: string, source: LibrarySource): { docs: LoadedDocument[]; invalid: BenchmarkLibraryEntry[]; conflicts: BenchmarkLibraryEntry[] } {
  const docs: LoadedDocument[] = [];
  const invalid: BenchmarkLibraryEntry[] = [];
  const conflicts: BenchmarkLibraryEntry[] = [];
  const seen = new Map<string, LoadedDocument>();
  if (!fs.existsSync(root)) {
    return { docs, invalid, conflicts };
  }
  for (const kind of documentKinds) {
    const kindDir = path.join(root, kind);
    if (!fs.existsSync(kindDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(kindDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(kindDir, entry.name);
      const parsed = parseBenchmarkDocument(filePath, source);
      if ('document' in parsed) {
        const key = keyFor(parsed.kind, parsed.id);
        const existing = seen.get(key);
        if (existing) {
          conflicts.push({
            kind: parsed.kind,
            id: parsed.id,
            status: 'conflict',
            source,
            path: parsed.path,
            hash: parsed.hash,
            message: `Duplicate document also found at ${existing.path}`
          });
          continue;
        }
        seen.set(key, parsed);
        docs.push(parsed);
      } else {
        invalid.push(parsed);
      }
    }
  }
  return { docs, invalid, conflicts };
}

function discoverTombstones(root: string): Set<string> {
  const deleted = new Set<string>();
  const deletedRoot = path.join(root, '.deleted');
  if (!fs.existsSync(deletedRoot)) {
    return deleted;
  }
  for (const kind of documentKinds) {
    const kindDir = path.join(deletedRoot, kind);
    if (!fs.existsSync(kindDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(kindDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(kindDir, entry.name);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { id?: unknown };
        if (typeof parsed.id === 'string' && parsed.id.trim()) {
          deleted.add(keyFor(kind, parsed.id));
        }
      } catch {
        deleted.add(keyFor(kind, decodeURIComponent(entry.name.replace(/\.json$/, ''))));
      }
    }
  }
  return deleted;
}

function discoverBenchmarkLibrary(): DiscoveredLibrary {
  const builtIn = discoverRoot(builtInLibraryRoot, 'built_in');
  const userRoot = userBenchmarkLibraryRoot();
  const user = discoverRoot(userRoot, 'user');
  return {
    builtIn: new Map(builtIn.docs.map((doc) => [keyFor(doc.kind, doc.id), doc])),
    user: new Map(user.docs.map((doc) => [keyFor(doc.kind, doc.id), doc])),
    tombstones: discoverTombstones(userRoot),
    invalid: [...builtIn.invalid, ...user.invalid],
    conflicts: [...builtIn.conflicts, ...user.conflicts]
  };
}

function entryForDocument(doc: LoadedDocument, status: LibraryStatus, message?: string): BenchmarkLibraryEntry {
  const db = getBenchmarkDocumentOrNull(doc.kind, doc.id);
  return {
    kind: doc.kind,
    id: doc.id,
    status,
    source: doc.source,
    path: doc.path,
    hash: doc.hash,
    db_hash: db ? sha256Document(db.document) : null,
    message
  };
}

export function installBenchmarkLibraryDocuments(): BenchmarkLibraryInstallReport {
  const discovered = discoverBenchmarkLibrary();
  const installed: BenchmarkLibraryEntry[] = [];
  const skipped: BenchmarkLibraryEntry[] = [];
  const deleted: BenchmarkLibraryEntry[] = [];
  const effective = new Map<string, LoadedDocument>();

  for (const [key, doc] of discovered.builtIn) {
    if (discovered.tombstones.has(key)) {
      deleteBenchmarkDocument(doc.kind, doc.id);
      deleted.push(entryForDocument(doc, 'deleted', 'Built-in document hidden by user tombstone.'));
      continue;
    }
    effective.set(key, doc);
  }
  for (const [key, doc] of discovered.user) {
    effective.set(key, doc);
  }

  for (const doc of effective.values()) {
    putBenchmarkDocument(doc.document);
    const entry = entryForDocument(doc, doc.source === 'user' && discovered.builtIn.has(keyFor(doc.kind, doc.id)) ? 'customized' : doc.source);
    installed.push(entry);
  }

  for (const [key, doc] of discovered.builtIn) {
    if (discovered.user.has(key)) {
      skipped.push(entryForDocument(doc, 'customized', 'User document overrides built-in document.'));
    }
  }

  return {
    installed,
    skipped,
    invalid: [...discovered.invalid, ...discovered.conflicts],
    deleted
  };
}

export function benchmarkLibraryStatus(): BenchmarkLibraryStatusReport {
  const discovered = discoverBenchmarkLibrary();
  const entries: BenchmarkLibraryEntry[] = [];
  const keys = new Set([...discovered.builtIn.keys(), ...discovered.user.keys(), ...discovered.tombstones]);

  for (const key of [...keys].sort()) {
    const builtIn = discovered.builtIn.get(key);
    const user = discovered.user.get(key);
    if (discovered.tombstones.has(key) && builtIn && !user) {
      entries.push(entryForDocument(builtIn, 'deleted', 'Built-in document hidden by user tombstone.'));
      continue;
    }
    if (user) {
      entries.push(entryForDocument(user, builtIn ? 'customized' : 'user'));
      continue;
    }
    if (builtIn) {
      entries.push(entryForDocument(builtIn, 'built_in'));
    }
  }

  entries.push(...discovered.invalid, ...discovered.conflicts);
  return {
    built_in_root: builtInLibraryRoot,
    user_root: userBenchmarkLibraryRoot(),
    entries
  };
}

export function saveBenchmarkDocumentToUserLibrary(document: Record<string, unknown>): void {
  const kind = benchmarkKindFromDocument(document);
  if (!kind || !documentKinds.includes(kind as BenchmarkDocumentKind)) {
    throw new BenchmarkValidationError('Unsupported benchmark document kind for library persistence.');
  }
  const supportedKind = kind as BenchmarkDocumentKind;
  const validation = validateAnyBenchmarkDocument(document, supportedKind);
  if (!validation.ok) {
    throw new BenchmarkValidationError(`Invalid benchmark ${supportedKind} document`, validation.issues);
  }
  const id = benchmarkDocumentNaturalId(supportedKind, document);
  const root = userBenchmarkLibraryRoot();
  const filePath = documentPath(root, supportedKind, id);
  ensureInsideRoot(root, filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  const deletedPath = tombstonePath(supportedKind, id);
  if (fs.existsSync(deletedPath)) {
    fs.rmSync(deletedPath, { force: true });
  }
}

export function putBenchmarkDocumentWithLibrary(document: Record<string, unknown>) {
  saveBenchmarkDocumentToUserLibrary(document);
  return putBenchmarkDocument(document);
}

export function deleteBenchmarkDocumentWithLibrary(kind: BenchmarkDocumentKind, id: string): boolean {
  const userRoot = userBenchmarkLibraryRoot();
  const userPath = documentPath(userRoot, kind, id);
  ensureInsideRoot(userRoot, userPath);
  if (fs.existsSync(userPath)) {
    fs.rmSync(userPath, { force: true });
  }

  const builtInPath = documentPath(builtInLibraryRoot, kind, id);
  if (fs.existsSync(builtInPath)) {
    const deletedPath = tombstonePath(kind, id);
    fs.mkdirSync(path.dirname(deletedPath), { recursive: true });
    fs.writeFileSync(
      deletedPath,
      `${JSON.stringify({ kind, id, deleted_at: new Date().toISOString(), source: 'user' }, null, 2)}\n`,
      'utf8'
    );
  }

  return deleteBenchmarkDocument(kind, id);
}
