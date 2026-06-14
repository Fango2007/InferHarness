export type CatalogTab = 'servers' | 'models';
export type ResultsTab = 'dashboard' | 'leaderboard' | 'history';

export function normalizeCatalogTab(value: string | null): CatalogTab {
  return value === 'models' ? 'models' : 'servers';
}

export function normalizeResultsTab(value: string | null): ResultsTab {
  if (value === 'leaderboard' || value === 'history') {
    return value;
  }
  return 'dashboard';
}

export function catalogSearch(tab: CatalogTab, params?: { serverId?: string | null; modelId?: string | null }): string {
  const search = new URLSearchParams({ tab });
  if (params?.serverId) {
    search.set('serverId', params.serverId);
  }
  if (params?.modelId) {
    search.set('modelId', params.modelId);
  }
  return `?${search.toString()}`;
}

export function resultsSearch(tab: ResultsTab): string {
  return `?${new URLSearchParams({ tab }).toString()}`;
}
