import { expect, test, type Page } from '@playwright/test';

const detail = {
  test_result_id: 'queue-result-1',
  run_id: 'run-queue-1',
  test_id: 'template-queue-active',
  template_id: 'tool-calling',
  template_label: 'Tool calling',
  model_name: 'mistral:latest',
  server_id: 'srv-local',
  server_name: 'Local Server',
  verdict: 'pass',
  status: 'pending',
  started_at: '2026-05-09T10:00:00.000Z',
  ended_at: '2026-05-09T10:00:01.000Z',
  inference_config: { temperature: 0.2, top_p: 0.9, max_tokens: 128, quantization_level: 'Q4', stream: true },
  prompt_text: 'What is the weather in Paris?',
  answer_text: 'Paris is rainy.',
  metrics: { latency_ms: 42, total_tokens: 16 },
  artefacts: { response_body: 'Paris is rainy.' },
  raw_events: [],
  document: { prompt: 'What is the weather in Paris?' },
  evaluation_id: null,
  skipped_at: null
};

async function mockPresets(page: Page) {
  await page.route('**/inference-param-presets', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
}

test.describe('Evaluate queue', () => {
  test('shows the queue empty state', async ({ page }) => {
    await mockPresets(page);
    await page.route('**/evaluation-queue?status=pending', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ counts: { pending: 0, done: 0, skipped: 0 }, items: [] })
      });
    });

    await page.goto('/evaluate');

    await expect(page.getByRole('heading', { name: 'Evaluate' })).toBeVisible();
    await expect(page.locator('.merged-page-header').getByRole('heading', { name: 'Evaluate' })).toBeVisible();
    await expect(page.locator('.evaluate-header')).toHaveCount(0);
    await expect(page.getByText('Params')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible();
  });

  test('scores, skips, and advances queue items', async ({ page }) => {
    await mockPresets(page);
    let pending = [detail];
    let done = 0;
    let skipped = 0;

    await page.route('**/evaluation-queue**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const parts = url.pathname.split('/').filter(Boolean);

      if (request.method() === 'GET' && parts.length === 1) {
        const status = url.searchParams.get('status') ?? 'pending';
        const items = status === 'pending' ? pending : [];
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ counts: { pending: pending.length, done, skipped }, items })
        });
        return;
      }

      if (request.method() === 'GET' && parts[1] === detail.test_result_id) {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(detail) });
        return;
      }

      if (request.method() === 'POST' && parts[2] === 'score') {
        pending = [];
        done = 1;
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'eval-1', source_test_result_id: detail.test_result_id }) });
        return;
      }

      if (request.method() === 'POST' && parts[2] === 'skip') {
        pending = [];
        skipped = 1;
        await route.fulfill({ status: 204 });
        return;
      }

      await route.fallback();
    });

    await page.goto('/evaluate');
    await expect(page.locator('.evaluate-queue-list').getByText('mistral:latest', { exact: true })).toBeVisible();
    await expect(page.locator('.run-detail-columns section').nth(1).getByText('Paris is rainy.', { exact: true })).toBeVisible();

    await page.keyboard.press('5');
    await expect(page.locator('.score-row').first()).toContainText('5/5');
    await page.getByRole('button', { name: 'Save & Next' }).click();
    await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible();

    pending = [detail];
    done = 0;
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('.evaluate-queue-list').getByText('mistral:latest', { exact: true })).toBeVisible();
    await expect(page.locator('.run-detail-columns section').nth(1).getByText('Paris is rainy.', { exact: true })).toBeVisible();
    const skipResponse = page.waitForResponse((response) => (
      response.url().includes(`/evaluation-queue/${detail.test_result_id}/skip`) && response.status() === 204
    ));
    await page.locator('.evaluate-rubric').getByRole('button', { name: 'Skip', exact: true }).click();
    await skipResponse;
    await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible();
  });
});
