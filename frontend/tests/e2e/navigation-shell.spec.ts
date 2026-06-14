import { expect, test, type Page } from '@playwright/test';

function catalogServer(serverId: string, name: string, modelId: string) {
  return {
    inference_server: {
      server_id: serverId,
      display_name: name,
      active: true,
      archived: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      archived_at: null as string | null
    },
    runtime: {
      retrieved_at: '2026-01-01T00:00:00.000Z',
      source: 'server',
      server_software: { name: 'inferencer', version: '1.0.0', build: null },
      api: { schema_family: ['openai-compatible'], api_version: null },
      platform: { os: { name: 'macos', version: null, arch: 'arm64' }, container: { type: 'none', image: null } },
      hardware: { cpu: { model: null, cores: null }, gpu: [{ vendor: 'apple', model: 'Metal', vram_mb: null }], ram_mb: null }
    },
    endpoints: { base_url: `http://${serverId}.local`, health_url: null, https: false },
    auth: { type: 'none', header_name: 'Authorization', token_env: null },
    capabilities: {
      server: { streaming: true, models_endpoint: true },
      generation: { text: true, json_schema_output: true, tools: true, embeddings: false },
      multimodal: { vision: { input_images: false, output_images: false }, audio: { input_audio: false, output_audio: false } },
      reasoning: { exposed: false, token_budget_configurable: false },
      concurrency: { parallel_requests: true, parallel_tool_calls: false, max_concurrent_requests: null },
      enforcement: 'server'
    },
    discovery: {
      retrieved_at: '2026-01-01T00:00:00.000Z',
      ttl_seconds: 3600,
      model_list: {
        raw: {},
        normalised: [{ model_id: modelId, display_name: modelId, context_window_tokens: 4096, quantisation: { method: 'mlx', bits: null, group_size: null, weight_format: 'MLX' } }]
      }
    },
    raw: {}
  };
}

function catalogModel(serverId: string, modelId: string, provider: string, format: string) {
  return {
    model: {
      server_id: serverId,
      model_id: modelId,
      display_name: modelId,
      active: true,
      archived: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      archived_at: null,
      base_model_name: modelId
    },
    identity: {
      provider,
      family: null,
      version: null,
      revision: null,
      checksum: null,
      quantized_provider: null
    },
    architecture: {
      type: 'unknown',
      parameter_count: null as number | null,
      parameter_count_label: null as string | null,
      active_parameter_label: null,
      precision: 'unknown',
      quantisation: { method: 'mlx', bits: null as number | null, group_size: null, weight_format: 'MLX' as string | null },
      format
    },
    capabilities: {
      generation: { text: true, json_schema_output: false, tools: false, embeddings: false },
      multimodal: { vision: false, audio: false },
      reasoning: { supported: false, explicit_tokens: false },
      use_case: { thinking: false, coding: false, instruct: false, mixture_of_experts: false }
    },
    limits: {
      context_window_tokens: 4096,
      max_output_tokens: null,
      max_images: null,
      max_batch_size: null
    },
    raw: {}
  };
}

type CatalogServerFixture = ReturnType<typeof catalogServer>;
type CatalogModelFixture = ReturnType<typeof catalogModel>;

async function mockCatalogRoutes(
  page: Page,
  servers: CatalogServerFixture[],
  models: CatalogModelFixture[],
  health: Record<string, boolean> = {}
) {
  await page.route('**/system/connectivity-config', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ poll_interval_ms: 60000 }) });
  });
  await page.route('**/inference-servers/health', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: servers.map((server) => ({
          server_id: server.inference_server.server_id,
          ok: health[server.inference_server.server_id] ?? true,
          status_code: (health[server.inference_server.server_id] ?? true) ? 200 : 503,
          response_time_ms: 12,
          checked_at: '2026-01-01T00:00:00.000Z'
        }))
      })
    });
  });
  await page.route('**/inference-servers?*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(servers) });
  });
  await page.route('**/inference-servers', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(servers) });
  });
  await page.route('**/models', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(models) });
  });
}

async function mockSettingsRoutes(page: Page) {
  let entries = [
    { key: 'INFERHARNESS_PYTHON_BIN', value: '/opt/python/bin/python3' },
    { key: 'INFERHARNESS_CONTEXT_PADDING', value: '200000' },
    { key: 'VITE_INFERHARNESS_API_TOKEN', value: 'vite-secret-token' },
    { key: 'HF_TOKEN', value: 'hf-secret-token' }
  ];

  await page.route('**/system/env', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries }) });
      return;
    }

    const body = route.request().postDataJSON() as { key: string; value: string | null };
    if (body.value === null) {
      entries = entries.filter((entry) => entry.key !== body.key);
    } else {
      const existing = entries.find((entry) => entry.key === body.key);
      if (existing) {
        existing.value = body.value;
      } else {
        entries.push({ key: body.key, value: body.value });
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries }) });
  });

  await page.route('**/system/clear-db', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        catalogModel('srv-a', 'mistral:latest', 'mistral', 'MLX'),
        catalogModel('srv-b', 'qwen:latest', 'qwen', 'GGUF')
      ])
    });
  });
}

test('sidebar exposes five top-level destinations and follows active routes', async ({ page }) => {
  await page.goto('/catalog?tab=servers');

  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('link')).toHaveCount(5);
  await expect(nav.locator('.sidebar-item__main span:first-child')).toHaveText([
    'Catalog',
    'Templates',
    'Run',
    'Results',
    'Evaluate'
  ]);

  for (const [href, label] of [
    ['/catalog?tab=servers', 'Catalog'],
    ['/templates', 'Templates'],
    ['/run', 'Run'],
    ['/results?tab=dashboard', 'Results'],
    ['/evaluate', 'Evaluate']
  ] as const) {
    await page.goto(href);
    await expect(nav.getByRole('link', { name: new RegExp(`^${label}`) })).toHaveClass(/is-active/);
  }
});

test('merged page sub-tabs preserve route state', async ({ page }) => {
  await page.goto('/catalog?tab=servers');
  await expect(page.locator('.context-bar')).toHaveCount(0);
  await page.getByRole('tab', { name: /Models/ }).click();
  await expect(page).toHaveURL(/\/catalog\?tab=models/);

  await page.goto('/results?tab=dashboard');
  await page.getByRole('tab', { name: /Leaderboard/ }).click();
  await expect(page).toHaveURL(/\/results\?tab=leaderboard/);
  await page.getByRole('tab', { name: /History/ }).click();
  await expect(page).toHaveURL(/\/results\?tab=history/);
});

test('catalog servers header owns actions and conditional filter rail', async ({ page }) => {
  const activeServer = catalogServer('srv-a', 'Inferencer', 'mistral:latest');
  const archivedServer = catalogServer('srv-archived', 'LegacyProd', 'legacy:latest');
  archivedServer.inference_server.active = false;
  archivedServer.inference_server.archived = true;
  archivedServer.inference_server.archived_at = '2026-01-02T00:00:00.000Z';
  const servers = [activeServer, archivedServer];
  const models = [
    catalogModel('srv-a', 'mistral:latest', 'mistral', 'MLX'),
    catalogModel('srv-archived', 'legacy:latest', 'mistral', 'GGUF')
  ];
  await mockCatalogRoutes(page, servers, models);

  await page.goto('/catalog?tab=servers');
  const catalogHeader = page.locator('.merged-page-header');
  const sectionHeader = page.locator('.catalog-section-title').filter({ hasText: 'Inference servers' });

  await expect(catalogHeader.getByRole('button', { name: '+ Add server' })).toHaveCount(0);
  await expect(sectionHeader.getByRole('button', { name: 'Filter' })).toBeVisible();
  await expect(sectionHeader.getByRole('button', { name: 'Archived' })).toBeVisible();
  await expect(sectionHeader.getByRole('button', { name: '+ Add server' })).toBeVisible();
  await expect(catalogHeader.getByRole('button', { name: 'Health' })).toHaveCount(0);
  await expect(catalogHeader.getByRole('button', { name: 'Grid' })).toHaveCount(0);
  await expect(page.locator('.catalog-rail')).toHaveCount(0);
  const serverCardTitles = page.locator('.catalog-server-card .catalog-card-top strong');
  await expect(serverCardTitles.filter({ hasText: /^Inferencer$/ })).toBeVisible();
  await expect(serverCardTitles.filter({ hasText: /^LegacyProd$/ })).toHaveCount(0);

  await sectionHeader.getByRole('button', { name: 'Filter' }).click();
  await expect(page.locator('.catalog-rail')).toBeVisible();
  await expect(sectionHeader.getByRole('button', { name: 'Filter' })).toHaveClass(/is-active/);
  await sectionHeader.getByRole('button', { name: 'Filter' }).click();
  await expect(page.locator('.catalog-rail')).toHaveCount(0);

  await sectionHeader.getByRole('button', { name: 'Archived' }).click();
  await expect(sectionHeader.getByRole('button', { name: 'Archived' })).toHaveClass(/is-active/);
  await expect(serverCardTitles.filter({ hasText: /^Inferencer$/ })).toHaveCount(0);
  await expect(serverCardTitles.filter({ hasText: /^LegacyProd$/ })).toBeVisible();

  await sectionHeader.getByRole('button', { name: '+ Add server' }).click();
  const createDrawer = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Add inference server' }) });
  await expect(createDrawer).toBeVisible();
  await createDrawer.getByRole('button', { name: 'Close' }).click();

  await page.goto('/catalog?tab=models');
  await expect(page.locator('.merged-page-header').getByRole('button', { name: '+ Add server' })).toHaveCount(0);
});

test('catalog server cards toggle the detail rail', async ({ page }) => {
  const servers = [
    catalogServer('srv-a', 'Inferencer', 'mistral:latest'),
    catalogServer('srv-b', 'InferencerPro', 'qwen:latest')
  ];
  const models = [
    catalogModel('srv-a', 'mistral:latest', 'mistral', 'MLX'),
    catalogModel('srv-b', 'qwen:latest', 'qwen', 'MLX')
  ];
  await mockCatalogRoutes(page, servers, models);

  await page.goto('/catalog?tab=servers');
  const serverCard = page.locator('.catalog-server-card').filter({ hasText: 'Inferencer' }).first();
  const sectionHeader = page.locator('.catalog-section-title').filter({ hasText: 'Inference servers' });

  await expect(page.locator('.catalog-server-card.is-selected')).toHaveCount(0);
  await expect(page.locator('.catalog-detail-rail')).toHaveCount(0);
  const initialBox = await serverCard.boundingBox();
  expect(initialBox).not.toBeNull();

  await serverCard.click();
  await expect(serverCard).toHaveClass(/is-selected/);
  await expect(page.locator('.catalog-detail-rail').filter({ hasText: 'Inferencer' })).toBeVisible();
  const selectedBox = await serverCard.boundingBox();
  expect(selectedBox).not.toBeNull();

  await serverCard.click();
  await expect(page.locator('.catalog-server-card.is-selected')).toHaveCount(0);
  await expect(page.locator('.catalog-detail-rail')).toHaveCount(0);
  const unselectedBox = await serverCard.boundingBox();
  expect(unselectedBox).not.toBeNull();

  expect(selectedBox!.width).toBeCloseTo(initialBox!.width, 1);
  expect(unselectedBox!.width).toBeCloseTo(initialBox!.width, 1);

  await sectionHeader.getByRole('button', { name: 'Filter' }).click();
  await expect(page.locator('.catalog-rail')).toBeVisible();
  const filteredBox = await serverCard.boundingBox();
  expect(filteredBox).not.toBeNull();
  expect(filteredBox!.width).toBeCloseTo(initialBox!.width, 1);
});

test('settings opens from the sidebar footer', async ({ page }) => {
  await mockSettingsRoutes(page);

  await page.goto('/catalog?tab=servers');
  await page.getByRole('button', { name: /Settings/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Database/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Model Selection/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Runtime/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Providers & Auth/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Connectivity/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Frontend/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Advanced/ })).toBeVisible();
  await expect(dialog.locator('.label').filter({ hasText: /^Runtime$/ })).toBeVisible();
});

test('settings supports categorized env panes, folding, secrets, saves, add, removal, and clear confirmation', async ({ page }) => {
  await mockSettingsRoutes(page);

  await page.goto('/catalog?tab=servers');
  await page.getByRole('button', { name: /Settings/ }).click();
  const dialog = page.getByRole('dialog');

  await expect(dialog.locator('.label').filter({ hasText: /^Runtime$/ })).toBeVisible();
  await expect(dialog.getByText('2 keys')).toBeVisible();
  await expect(dialog.getByText('Execution runtime')).toBeVisible();

  await dialog.getByRole('button', { name: /Model Selection/ }).click();
  await expect(dialog.locator('.label').filter({ hasText: /^Model Selection$/ })).toBeVisible();
  const modelSelect = dialog.getByLabel('Model');
  await expect(modelSelect).toBeVisible();
  await expect(modelSelect).toHaveValue('srv-a::mistral:latest');
  await dialog.getByLabel('Model').selectOption('srv-b::qwen:latest');
  const modelSummary = dialog.locator('.settings-model-summary');
  await expect(modelSummary.getByText('srv-b')).toBeVisible();
  await expect(modelSummary.getByText('Qwen')).toBeVisible();

  await dialog.getByRole('button', { name: /Runtime/ }).click();
  await expect(dialog.locator('.label').filter({ hasText: /^Runtime$/ })).toBeVisible();

  const runtimeGroup = dialog.getByRole('button', { name: /Execution runtime/ });
  await expect(runtimeGroup).toHaveAttribute('aria-expanded', 'true');
  await runtimeGroup.click();
  await expect(runtimeGroup).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByText('INFERHARNESS_CONTEXT_PADDING')).toBeHidden();
  await runtimeGroup.click();

  await dialog.getByPlaceholder('Filter runtime keys...').fill('PADDING');
  await expect(runtimeGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByText('INFERHARNESS_CONTEXT_PADDING')).toBeVisible();
  await dialog.getByPlaceholder('Filter runtime keys...').fill('');

  await dialog.getByRole('button', { name: /Frontend/ }).click();
  await expect(dialog.locator('.label').filter({ hasText: /^Frontend$/ })).toBeVisible();
  const frontendGroup = dialog.getByRole('button', { name: /Frontend \(Vite\)/ });
  await expect(frontendGroup).toHaveAttribute('aria-expanded', 'true');
  await frontendGroup.click();
  await expect(frontendGroup).toHaveAttribute('aria-expanded', 'false');
  await dialog.getByPlaceholder('Filter frontend keys...').fill('TOKEN');
  await expect(dialog.getByText('INFERHARNESS_CONTEXT_PADDING')).toHaveCount(0);
  await expect(frontendGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByText('VITE_INFERHARNESS_API_TOKEN')).toBeVisible();
  await dialog.getByPlaceholder('Filter frontend keys...').fill('');
  await expect(frontendGroup).toHaveAttribute('aria-expanded', 'false');
  await frontendGroup.click();
  await expect(frontendGroup).toHaveAttribute('aria-expanded', 'true');

  const tokenRow = dialog.locator('.env-row').filter({ hasText: 'VITE_INFERHARNESS_API_TOKEN' });
  const tokenInput = tokenRow.locator('input.field').first();
  await expect(tokenInput).toHaveAttribute('type', 'password');
  await tokenRow.getByRole('button', { name: /Show VITE_INFERHARNESS_API_TOKEN/ }).click();
  await expect(tokenInput).toHaveAttribute('type', 'text');

  await dialog.getByRole('button', { name: /Runtime/ }).click();
  const paddingRow = dialog.locator('.env-row').filter({ hasText: 'INFERHARNESS_CONTEXT_PADDING' });
  await expect(paddingRow.getByRole('button', { name: 'Saved' })).toBeDisabled();
  await paddingRow.locator('input.field').fill('300000');
  await expect(paddingRow.getByRole('button', { name: 'Save' })).toBeEnabled();
  await paddingRow.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Saved INFERHARNESS_CONTEXT_PADDING.')).toBeVisible();

  await dialog.getByRole('button', { name: /Advanced/ }).click();
  await dialog.getByPlaceholder('NEW_ENV_KEY').fill('vite_new_flag');
  await dialog.getByPlaceholder('value').fill('true');
  await dialog.getByRole('button', { name: 'Add key' }).click();
  await expect(dialog.locator('.label').filter({ hasText: /^Frontend$/ })).toBeVisible();
  await expect(dialog.locator('.env-row').filter({ hasText: 'VITE_NEW_FLAG' })).toBeVisible();
  await expect(dialog.getByText('2 keys')).toBeVisible();

  await dialog.getByRole('button', { name: /Providers & Auth/ }).click();
  const hfRow = dialog.locator('.env-row').filter({ hasText: 'HF_TOKEN' });
  await hfRow.getByRole('button', { name: /Remove HF_TOKEN/ }).click();
  await expect(dialog.getByText('Removed HF_TOKEN.')).toBeVisible();
  await expect(dialog.getByText('0 keys')).toBeVisible();

  await dialog.getByRole('button', { name: /Database/ }).click();
  const emptyDb = dialog.getByRole('button', { name: 'Empty database' });
  await emptyDb.click();
  await expect(dialog.getByRole('button', { name: 'Click again to confirm' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Click again to confirm' }).click();
  await expect(dialog.getByText('Database cleared.')).toBeVisible();
});

test('run keeps page and workspace headers', async ({ page }) => {
  await page.goto('/run');
  await expect(page.locator('.merged-page-header').getByRole('heading', { name: 'Run' })).toBeVisible();
  await expect(page.locator('.context-bar')).toHaveCount(0);
  await expect(page.locator('.run-page-header').getByRole('heading', { name: 'Run' })).toBeVisible();
});

test('run server and model selectors only offer online server models', async ({ page }) => {
  const online = catalogServer('srv-online', 'Online Server', 'online-model');
  const offline = catalogServer('srv-offline', 'Offline Server', 'offline-model');
  const models = [
    catalogModel('srv-online', 'online-model', 'mistral', 'MLX'),
    catalogModel('srv-offline', 'offline-model', 'mistral', 'MLX')
  ];
  await mockCatalogRoutes(page, [online, offline], models, { 'srv-online': true, 'srv-offline': false });

  await page.goto('/run');

  const serverSelect = page.getByRole('combobox', { name: 'Inference server', exact: true });
  await expect(serverSelect).toBeVisible();
  await expect(serverSelect).toContainText('Online Server');
  await expect(serverSelect).not.toContainText('Offline Server');

  const modelSelect = page.getByRole('combobox', { name: 'Add model', exact: true });
  await expect(modelSelect).toContainText('online-model · Online Server');
  await expect(modelSelect).not.toContainText('offline-model');
});

test('catalog models funnel aligns staged rail controls', async ({ page }) => {
  const servers = [
    catalogServer('srv-a', 'Inferencer', 'mistral:latest'),
    catalogServer('srv-b', 'InferencerPro', 'qwen:latest')
  ];
  const models = [
    catalogModel('srv-a', 'mistral:latest', 'mistral', 'MLX'),
    catalogModel('srv-b', 'qwen:latest', 'qwen', 'MLX')
  ];
  await page.addInitScript(() => {
    window.localStorage.removeItem('catalog.serverStageCollapsed');
    window.localStorage.removeItem('catalog.modelFilterStageCollapsed');
  });
  await mockCatalogRoutes(page, servers, models);

  await page.goto('/catalog?tab=models');
  const catalogPage = page.locator('.catalog-models');
  await expect(catalogPage.locator('.catalog-stage-number')).toHaveText(['1']);

  await page.locator('.catalog-server-stage .server-filter-row').filter({ hasText: 'srv-a.local' }).getByRole('checkbox').check();
  await expect(catalogPage.locator('.catalog-stage-number')).toHaveText(['1', '2']);
  const modelFilterRail = page.locator('.catalog-model-filter-stage');
  await expect(modelFilterRail.getByText('Models')).toBeVisible();
  await expect(modelFilterRail.getByText('0 selected')).toBeVisible();
  await expect(modelFilterRail.getByRole('button', { name: 'Collapse' })).toBeVisible();

  await page.getByLabel('Mistral').check();
  await expect(modelFilterRail.getByText('1 selected')).toBeVisible();
  await expect(modelFilterRail.getByRole('button', { name: 'Clear' })).toBeVisible();
  await modelFilterRail.getByRole('button', { name: 'Collapse' }).click();
  await expect(modelFilterRail.getByText('Models · 1 selected')).toBeVisible();
  await modelFilterRail.getByRole('button', { name: '›' }).click();
  await expect(page.getByLabel('Mistral')).toBeChecked();
  await modelFilterRail.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.catalog-server-stage .server-filter-row').filter({ hasText: 'srv-a.local' }).getByRole('checkbox')).toBeChecked();
  await expect(page.getByLabel('Mistral')).not.toBeChecked();
});

test('catalog model cards use model-level provider and capability metadata', async ({ page }) => {
  const servers = [catalogServer('srv-mistral', 'Mistral', 'codestral-latest')];
  const codestral = catalogModel('srv-mistral', 'codestral-latest', 'mistral', 'Unknown');
  codestral.model.base_model_name = 'codestral-2508';
  codestral.capabilities.generation.json_schema_output = true;
  codestral.capabilities.generation.tools = true;
  codestral.capabilities.multimodal.vision = true;
  codestral.capabilities.reasoning.supported = true;
  codestral.capabilities.reasoning.explicit_tokens = true;
  codestral.capabilities.use_case.coding = true;
  codestral.architecture.precision = 'bf16';
  codestral.architecture.quantisation.method = 'none';
  codestral.architecture.quantisation.weight_format = null;
  codestral.limits.context_window_tokens = 256000;
  await mockCatalogRoutes(page, servers, [codestral]);

  await page.goto('/catalog?tab=models&servers=srv-mistral');

  const card = page.locator('.catalog-model-card').filter({ hasText: 'codestral-2508' });
  await expect(card).toBeVisible();
  await expect(card.locator('.catalog-model-pills')).toContainText('Mistral');
  await expect(card.locator('.catalog-model-pills')).toContainText('BF16');
  await expect(card.locator('.catalog-model-pills')).toContainText('256000 ctx');
  await expect(card.locator('.catalog-model-pills')).not.toContainText('Unknown');
  await expect(card).toContainText('coding');
  await expect(card).toContainText('tools');
  await expect(card).toContainText('streaming');

  const modelFilterRail = page.locator('.catalog-model-filter-stage');
  for (const label of ['text', 'json schema output', 'tools', 'embeddings', 'vision', 'audio', 'reasoning', 'explicit tokens', 'thinking', 'coding', 'instruct', 'mixture of experts']) {
    await expect(modelFilterRail.getByLabel(label)).toBeVisible();
  }
  await modelFilterRail.getByLabel('vision').check();
  await expect(card).toBeVisible();
  await modelFilterRail.getByLabel('vision').uncheck();
  await modelFilterRail.getByLabel('audio').check();
  await expect(page.locator('.catalog-model-card')).toHaveCount(0);
});

test('catalog model cards sort by provider taxonomy, date, parameters, and quantization', async ({ page }) => {
  const servers = [catalogServer('srv-sort', 'Sort Server', 'placeholder')];
  servers[0].discovery.model_list.normalised = [];
  const model = (id: string, provider: string, baseName: string, parameterCount: number, parameterLabel: string, quantBits: number) => {
    const record = catalogModel('srv-sort', id, provider, 'MLX');
    record.model.base_model_name = baseName;
    record.architecture.parameter_count = parameterCount;
    record.architecture.parameter_count_label = parameterLabel;
    record.architecture.quantisation.bits = quantBits;
    record.architecture.quantisation.weight_format = `${quantBits}bit`;
    return record;
  };
  const models = [
    model('qwen3.6-27b-mlx-9bit', 'qwen', 'Qwen3.6', 27_000_000_000, '27B', 9),
    model('devstral-2512-24b-mlx-4bit', 'mistral', 'Devstral-2512', 24_000_000_000, '24B', 4),
    model('devstral-2512-7b-mlx-4bit', 'mistral', 'Devstral-2512', 7_000_000_000, '7B', 4),
    model('qwen3-coder-next-6bit', 'qwen', 'Qwen3-Coder-Next', 30_000_000_000, '30B', 6),
    model('devstral-2508-7b-mlx-8bit', 'mistral', 'Devstral-2508', 7_000_000_000, '7B', 8),
    model('devstral-2512-24b-mlx-8bit', 'mistral', 'Devstral-2512', 24_000_000_000, '24B', 8)
  ];
  await mockCatalogRoutes(page, servers, models);

  await page.goto('/catalog?tab=models&servers=srv-sort');
  await expect(page.locator('.catalog-model-card')).toHaveCount(6);

  const cardSummaries = await page.locator('.catalog-model-card').evaluateAll((cards) =>
    cards.map((card) => {
      const title = card.querySelector('.catalog-card-top strong')?.textContent?.trim() ?? '';
      const pills = Array.from(card.querySelectorAll('.catalog-model-pills span')).map((pill) => pill.textContent?.trim() ?? '');
      return `${title} | ${pills.join(' ')}`;
    })
  );

  expect(cardSummaries).toEqual([
    'Devstral-2508 | Mistral 8bit MLX 4096 ctx 7B',
    'Devstral-2512 | Mistral 4bit MLX 4096 ctx 7B',
    'Devstral-2512 | Mistral 8bit MLX 4096 ctx 24B',
    'Devstral-2512 | Mistral 4bit MLX 4096 ctx 24B',
    'Qwen3-Coder-Next | Qwen 6bit MLX 4096 ctx 30B',
    'Qwen3.6 | Qwen 9bit MLX 4096 ctx 27B'
  ]);
});
