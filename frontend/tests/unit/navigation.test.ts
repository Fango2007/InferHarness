import { expect, test } from 'vitest';

import {
  catalogSearch,
  normalizeCatalogTab,
  normalizeResultsTab,
  resultsSearch
} from '../../src/navigation.js';

test('catalog tabs default to servers and accept models', () => {
  expect(normalizeCatalogTab(null)).toBe('servers');
  expect(normalizeCatalogTab('bad-tab')).toBe('servers');
  expect(normalizeCatalogTab('models')).toBe('models');
});

test('results tabs default to dashboard and accept known tabs', () => {
  expect(normalizeResultsTab(null)).toBe('dashboard');
  expect(normalizeResultsTab('invalid')).toBe('dashboard');
  expect(normalizeResultsTab('leaderboard')).toBe('leaderboard');
  expect(normalizeResultsTab('history')).toBe('history');
});

test('catalog detail search keeps slash-bearing model ids in query params', () => {
  expect(catalogSearch('models', { serverId: 'local', modelId: 'org/model/name' })).toBe(
    '?tab=models&serverId=local&modelId=org%2Fmodel%2Fname'
  );
});

test('results search encodes tab state', () => {
  expect(resultsSearch('history')).toBe('?tab=history');
});
