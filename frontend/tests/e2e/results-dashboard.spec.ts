import { expect, test } from '@playwright/test';

function resultsViewPayload(empty = false) {
  const rows = empty
    ? []
    : [
        {
          run_id: 'run-dashboard-1',
          status: 'pass',
          started_at: '2026-02-08T00:00:00.000Z',
          ended_at: '2026-02-08T00:00:10.000Z',
          duration_ms: 10000,
          server_id: 'srv-local',
          server_name: 'Local Server',
          model_name: 'mistral:latest',
          template_id: 'latency-benchmark',
          template_label: 'latency-benchmark',
          score: 100,
          latency_ms: 80,
          cost: 0.001,
          tags: ['nightly'],
          result_count: 1
        },
        {
          run_id: 'run-dashboard-2',
          status: 'pass',
          started_at: '2026-02-08T01:00:00.000Z',
          ended_at: '2026-02-08T01:00:11.000Z',
          duration_ms: 11000,
          server_id: 'srv-remote',
          server_name: 'Remote Server',
          model_name: 'qwen:latest',
          template_id: 'tool-calling',
          template_label: 'tool-calling',
          score: 92,
          latency_ms: 120,
          cost: 0.002,
          tags: ['nightly'],
          result_count: 1
        }
      ];

  return {
    filters_applied: {
      date_from: '2026-02-01T00:00:00.000Z',
      date_to: '2026-02-09T00:00:00.000Z',
      server_ids: [],
      model_names: [],
      template_ids: [],
      statuses: [],
      tags: [],
      score_min: null,
      score_max: null,
      sort_by: 'started_at',
      sort_dir: 'desc',
      page: 1,
      page_size: 50
    },
    filter_options: {
      servers: [
        { id: 'srv-local', label: 'Local Server', count: 1 },
        { id: 'srv-remote', label: 'Remote Server', count: 1 }
      ],
      models: [
        { id: 'mistral:latest', label: 'mistral:latest', count: 1, server_ids: ['srv-local'] },
        { id: 'qwen:latest', label: 'qwen:latest', count: 1, server_ids: ['srv-remote'] }
      ],
      templates: [
        { id: 'latency-benchmark', label: 'latency-benchmark', kind: 'JSON', count: 1, server_ids: ['srv-local'], model_names: ['mistral:latest'] },
        { id: 'tool-calling', label: 'tool-calling', kind: 'PY', count: 1, server_ids: ['srv-remote'], model_names: ['qwen:latest'] }
      ],
      statuses: [{ id: 'pass', label: 'pass', count: rows.length }],
      tags: [{ id: 'nightly', label: 'nightly', count: 1 }],
      date_bounds: {
        min: empty ? null : '2026-02-08T00:00:00.000Z',
        max: empty ? null : '2026-02-08T00:00:00.000Z'
      }
    },
    dashboard: {
      scorecards: {
        total_runs: rows.length,
        pass_rate: rows.length ? 100 : null,
        median_latency_ms: rows.length ? 80 : null,
        median_cost: rows.length ? 0.001 : null
      },
      pass_rate_series: rows.length
        ? [{ label: 'mistral:latest', points: [{ x: '2026-02-08', y: 100 }] }]
        : [],
      latency_series: rows.length
        ? [{ label: 'mistral:latest', points: [{ x: '2026-02-08T00:00:00.000Z', y: 80 }] }]
        : [],
      model_summary: rows.length
        ? [
            { model_name: 'mistral:latest', run_count: 1, pass_rate: 100, median_latency_ms: 80, median_cost: 0.001 },
            { model_name: 'qwen:latest', run_count: 1, pass_rate: 100, median_latency_ms: 120, median_cost: 0.002 }
          ]
        : [],
      performance_comparison: {
        default_metric: 'cold_penalty_ms',
        metrics: [
          { metric_key: 'cold_penalty_ms', label: 'Cold penalty', unit: 'ms' },
          { metric_key: 'cold_total_ms', label: 'Cold total', unit: 'ms' },
          { metric_key: 'hot_total_ms', label: 'Hot total', unit: 'ms' }
        ],
        groups: rows.length
          ? [
              {
                group_id: 'srv-local|mistral:latest|latency-benchmark',
                server_id: 'srv-local',
                server_name: 'Local Server',
                model_name: 'mistral:latest',
                template_id: 'latency-benchmark',
                template_label: 'latency-benchmark',
                metrics: {
                  cold_penalty_ms: {
                    metric_key: 'cold_penalty_ms',
                    label: 'Cold penalty',
                    unit: 'ms',
                    samples: [70, 80, 90],
                    stats: { count: 3, min: 70, q1: 75, median: 80, q3: 85, p95: 89, max: 90, mean: 80 }
                  },
                  cold_total_ms: {
                    metric_key: 'cold_total_ms',
                    label: 'Cold total',
                    unit: 'ms',
                    samples: [150, 160, 170],
                    stats: { count: 3, min: 150, q1: 155, median: 160, q3: 165, p95: 169, max: 170, mean: 160 }
                  },
                  hot_total_ms: {
                    metric_key: 'hot_total_ms',
                    label: 'Hot total',
                    unit: 'ms',
                    samples: [80, 80, 80],
                    stats: { count: 3, min: 80, q1: 80, median: 80, q3: 80, p95: 80, max: 80, mean: 80 }
                  }
                }
              }
            ]
          : []
      },
      recent_runs: rows
    },
    history: {
      rows,
      page: 1,
      page_size: 50,
      total: rows.length,
      total_pages: 1
    }
  };
}

test('merged Results dashboard filter and render flow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  const longRawValue = `raw-payload-${'x'.repeat(3000)}`;

  await page.route('**/results-view/query', async (route) => {
    const payload = route.request().postDataJSON() as { date_from?: string };
    const isFutureRange = payload.date_from
      ? Date.parse(payload.date_from) >= Date.parse('2029-12-31T00:00:00.000Z')
      : false;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(resultsViewPayload(isFutureRange))
    });
  });

  await page.route('**/results-view/runs/run-dashboard-1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run: resultsViewPayload().history.rows[0],
        raw_run: { id: 'run-dashboard-1', status: 'completed' },
        results: [
          {
            id: 'result-dashboard-1',
            test_id: 'latency-benchmark',
            template_label: 'latency-benchmark',
            verdict: 'pass',
            metrics: { latency_ms: 80 },
            raw_payload: longRawValue
          }
        ],
        documents: [{ summary: { passed_steps: 1, failed_steps: 0 }, raw_payload: longRawValue }]
      })
    });
  });
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('results-funnel-e2e-ready')) {
      window.localStorage.removeItem('results.funnelCollapsedStages');
      window.sessionStorage.setItem('results-funnel-e2e-ready', 'true');
    }
  });

  await page.goto('/results?tab=dashboard');

  await expect(page.getByRole('heading', { name: 'Results' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Dashboard/ })).toHaveAttribute('aria-selected', 'true');
  const resultsPage = page.locator('.results-page');
  await expect(resultsPage).toBeVisible();
  const resultsRail = page.locator('[aria-label="Results filters"]');
  await expect(resultsRail).toBeVisible();
  await expect(resultsRail.locator('.results-funnel-stage')).toHaveCount(1);
  await expect(resultsRail.locator('.catalog-stage-number')).toHaveText(['1']);
  await expect(resultsRail.getByText('Servers')).toBeVisible();
  await expect(resultsRail.getByText('Models')).toHaveCount(0);
  await expect(resultsRail.getByText('Tests & range')).toHaveCount(0);
  await expect(page.locator('.results-funnel-stage--collapsed')).toHaveCount(0);
  const railOffset = await page.evaluate(() => {
    const pageRect = document.querySelector('.results-page')?.getBoundingClientRect();
    const headerRect = document.querySelector('.merged-page-header')?.getBoundingClientRect();
    return pageRect && headerRect ? Math.abs(pageRect.left - headerRect.left) : 999;
  });
  expect(railOffset).toBeLessThan(2);

  await expect(page.getByLabel('Local Server')).toBeVisible();
  await expect(page.getByLabel('mistral:latest')).toHaveCount(0);
  await expect(page.getByLabel('latency-benchmark')).toHaveCount(0);
  await page.getByLabel('Local Server').check();
  await expect(resultsRail.locator('.results-funnel-stage')).toHaveCount(2);
  await expect(resultsRail.locator('.catalog-stage-number')).toHaveText(['1', '2']);
  await expect(resultsRail.getByText('Models')).toBeVisible();
  await expect(resultsRail.getByText('Tests & range')).toHaveCount(0);
  await expect(page.getByLabel('mistral:latest')).toBeVisible();
  await expect(page.getByLabel('qwen:latest')).toHaveCount(0);

  await page.getByRole('button', { name: 'Collapse Servers filters' }).click();
  await expect(page.locator('[aria-label="Servers collapsed"]')).toBeVisible();
  await expect(page.locator('.results-rail')).toHaveClass(/results-rail--servers-collapsed/);
  await page.reload();
  await expect(page.locator('[aria-label="Servers collapsed"]')).toBeVisible();
  await page.getByRole('button', { name: 'Expand Servers filters' }).click();
  await expect(page.getByRole('button', { name: 'Collapse Servers filters' })).toBeVisible();

  await page.getByLabel('mistral:latest').check();
  await expect(resultsRail.locator('.results-funnel-stage')).toHaveCount(3);
  await expect(resultsRail.locator('.catalog-stage-number')).toHaveText(['1', '2', '3']);
  await expect(resultsRail.getByText('Tests & range')).toBeVisible();
  await expect(page.getByLabel('latency-benchmark')).toBeVisible();
  await expect(page.getByLabel('tool-calling')).toHaveCount(0);

  const selectedUrl = page.url();
  await page.getByRole('button', { name: 'Collapse Models filters' }).click();
  await expect(page.locator('[aria-label="Models collapsed"]')).toBeVisible();
  await expect(page.getByLabel('mistral:latest')).toHaveCount(0);
  expect(page.url()).toBe(selectedUrl);
  await page.getByRole('button', { name: 'Expand Models filters' }).click();

  await page.getByRole('button', { name: 'Collapse Tests & range filters' }).click();
  await expect(page.locator('[aria-label="Tests & range collapsed"]')).toBeVisible();
  await expect(page.getByLabel('From')).toHaveCount(0);
  await expect(page.getByLabel('latency-benchmark')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand Tests & range filters' }).click();
  expect(page.url()).toBe(selectedUrl);

  await expect(page.getByLabel('latency-benchmark')).toBeVisible();
  await page.getByLabel('latency-benchmark').check();
  const testsStage = resultsRail.locator('.results-funnel-stage').filter({ hasText: 'Tests & range' });
  await expect(testsStage.getByText('1 selected')).toBeVisible();
  await testsStage.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByLabel('Local Server')).toBeChecked();
  await expect(page.getByLabel('mistral:latest')).toBeChecked();
  await expect(page.getByLabel('latency-benchmark')).not.toBeChecked();
  await expect(testsStage.getByText('0 selected')).toBeVisible();
  await page.getByLabel('Local Server').uncheck();
  await expect(resultsRail.locator('.results-funnel-stage')).toHaveCount(1);
  await expect(resultsRail.getByText('Models')).toHaveCount(0);
  await expect(resultsRail.getByText('Tests & range')).toHaveCount(0);
  await page.getByLabel('Local Server').check();
  await page.getByLabel('mistral:latest').check();

  await expect(page.getByText('Total runs')).toBeVisible();
  await expect(page.getByText('Pass rate')).toBeVisible();
  await expect(page.locator('[data-panel-type="adaptive-chart"]')).toBeVisible();
  await expect(page.getByLabel('View')).toHaveValue('auto');
  await expect(page.getByText('Auto selected: Cold-start comparison')).toBeVisible();
  await expect(page.locator('[data-panel-type="performance-comparison"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cold-start comparison' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'mistral:latest' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '80.00 ms' }).first()).toBeVisible();
  await page.getByLabel('View').selectOption('latency-histogram');
  await expect(page.locator('[data-panel-type="adaptive-chart"] p.muted')).toHaveText('Latency histogram');
  await page.getByLabel('View').selectOption('model-summary');
  await expect(page.getByRole('columnheader', { name: 'Runs' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '1' }).first()).toBeVisible();
  await page.getByLabel('View').selectOption('auto');
  await expect(page.getByRole('heading', { name: 'Recent runs' })).toBeVisible();

  const recentRun = page.locator('.results-run-row').filter({ hasText: 'latency-benchmark' });
  await expect(recentRun).toBeVisible();
  await recentRun.hover();
  await expect(page.getByText('Auto selected: Latency trend')).toBeVisible();
  await recentRun.click();
  await expect(page.getByText('Run detail')).toBeVisible();
  await expect(page.getByText('run-dashboard-1')).toBeVisible();
  const drawerSizing = await page.evaluate(() => {
    const drawer = document.querySelector<HTMLElement>('.results-drawer');
    const detailBlock = document.querySelector<HTMLElement>('.results-detail-block');
    const rawPre = detailBlock?.querySelector<HTMLElement>('pre');
    const scrollingElement = document.scrollingElement;
    if (!drawer || !detailBlock || !rawPre || !scrollingElement) {
      return null;
    }
    return {
      viewportWidth: window.innerWidth,
      drawerWidth: drawer.getBoundingClientRect().width,
      drawerClientWidth: drawer.clientWidth,
      drawerScrollWidth: drawer.scrollWidth,
      detailClientWidth: detailBlock.clientWidth,
      detailScrollWidth: detailBlock.scrollWidth,
      preClientWidth: rawPre.clientWidth,
      preScrollWidth: rawPre.scrollWidth,
      pageClientWidth: scrollingElement.clientWidth,
      pageScrollWidth: scrollingElement.scrollWidth
    };
  });
  expect(drawerSizing).not.toBeNull();
  expect(drawerSizing!.drawerWidth).toBeGreaterThan(640);
  expect(drawerSizing!.drawerWidth).toBeLessThanOrEqual(drawerSizing!.viewportWidth);
  expect(drawerSizing!.drawerScrollWidth).toBeLessThanOrEqual(drawerSizing!.drawerClientWidth + 1);
  expect(drawerSizing!.detailScrollWidth).toBeLessThanOrEqual(drawerSizing!.detailClientWidth + 1);
  expect(drawerSizing!.preScrollWidth).toBeLessThanOrEqual(drawerSizing!.preClientWidth + 1);
  expect(drawerSizing!.pageScrollWidth).toBeLessThanOrEqual(drawerSizing!.pageClientWidth + 1);

  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await page.goto('/results?tab=dashboard&date_from=2030-01-01T00%3A00%3A00.000Z');
  await expect(page.locator('[aria-label="Results filters"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No runs in the selected range' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go to Run page' })).toBeVisible();
});

test('deletes a run from the run detail drawer after confirmation', async ({ page }) => {
  let deleted = false;
  let deleteRequests = 0;
  let dialogCount = 0;

  await page.route('**/results-view/query', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(resultsViewPayload(deleted))
    });
  });

  await page.route('**/results-view/runs/run-dashboard-1', async (route) => {
    if (deleted) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Run not found' })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run: resultsViewPayload().history.rows[0],
        raw_run: { id: 'run-dashboard-1', status: 'completed' },
        results: [
          {
            id: 'result-dashboard-1',
            test_id: 'latency-benchmark',
            template_label: 'latency-benchmark',
            verdict: 'pass',
            metrics: { latency_ms: 80 }
          }
        ],
        documents: [{ summary: { passed_steps: 1, failed_steps: 0 } }]
      })
    });
  });

  await page.route('**/runs/run-dashboard-1', async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback();
      return;
    }
    deleteRequests += 1;
    deleted = true;
    await route.fulfill({ status: 204 });
  });

  page.on('dialog', async (dialog) => {
    dialogCount += 1;
    if (dialogCount === 1) {
      await dialog.dismiss();
      return;
    }
    await dialog.accept();
  });

  await page.goto('/results?tab=dashboard');
  await page.locator('.results-run-row').filter({ hasText: 'latency-benchmark' }).click();
  await expect(page.getByText('Run detail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete run' })).toBeVisible();

  await page.getByRole('button', { name: 'Delete run' }).click();
  expect(deleteRequests).toBe(0);
  await expect(page.getByText('Run detail')).toBeVisible();

  await page.getByRole('button', { name: 'Delete run' }).click();
  await expect(page.getByText('Run detail')).toHaveCount(0);
  expect(deleteRequests).toBe(1);
  expect(page.url()).not.toContain('run=run-dashboard-1');
  await expect(page.getByRole('heading', { name: 'No runs in the selected range' })).toBeVisible();
});
