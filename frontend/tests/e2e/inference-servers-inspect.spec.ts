import { expect, test } from '@playwright/test';

import { archiveInferenceServer, createInferenceServer, dismissOnboarding } from './helpers.js';

test('inspects an inference server', async ({ page, request }) => {
  await dismissOnboarding(page);
  const created = await createInferenceServer(request);

  await page.goto('/');

  const serverCard = page.locator('.catalog-server-card').filter({ hasText: created.inference_server.display_name });
  await expect(serverCard).toBeVisible();
  await serverCard.click();

  const baseUrlRow = page.locator('.kv').filter({
    has: page.getByText('Base URL', { exact: true })
  });

  await expect(page.getByRole('heading', { name: created.inference_server.display_name })).toBeVisible();
  await expect(baseUrlRow.getByText(created.endpoints.base_url, { exact: true })).toBeVisible();

  await archiveInferenceServer(request, created.inference_server.server_id);
});
