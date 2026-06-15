import { expect, test } from '@playwright/test';

import { cleanupTemplateIds } from './helpers.js';

test('creates, updates, and deletes templates from the Templates page', async ({ page }) => {
  const suffix = Date.now();
  const templateId = `e2e-template-${suffix}`;
  const templateName = `E2E Template ${suffix}`;
  const updatedName = `E2E Template Updated ${suffix}`;
  const version = '1.0.0';
  const updatedVersion = '1.0.1';

  const updatedContent = JSON.stringify(
    {
      kind: 'test_template',
      schema_version: 'benchmark_test_template_v1',
      template_id: templateId,
      template_version: updatedVersion,
      name: updatedName,
      description: 'E2E benchmark template updated',
      operation: 'chat_completion',
      required_capabilities: {
        chat_completion: true,
        completion: false,
        embedding: false,
        list_models: false,
        healthcheck: false,
        streaming: false,
        tool_calling: false,
        structured_output: false
      },
      stages: [{
        id: 'cold-hot',
        type: 'paired_request_loop',
        iterations_per_item: 1,
        record_metrics: true,
        pre_iteration_delay_ms: 0,
        intra_pair_delay_ms: 0,
        pair: [
          { id: 'cold', role: 'baseline', request: { reuse: 'default' } },
          { id: 'hot', role: 'comparison', request: { reuse: 'default' } }
        ],
        derived_metrics: [
          { id: 'cold_penalty_ms', type: 'difference', left: 'cold.elapsed_ms', right: 'hot.elapsed_ms' }
        ],
        observability: { intent: 'paired e2e preservation' }
      }],
      metrics: ['pair.cold.elapsed_ms', 'pair.hot.elapsed_ms', 'cold_penalty_ms'],
      aggregations: ['mean', 'count']
    },
    null,
    2
  );

  try {
    await page.goto('/templates');
    await page.getByRole('button', { name: 'New benchmark template' }).first().click();
    const createForm = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create benchmark template' }) });
    await expect(createForm).toBeVisible();

    await createForm.getByLabel('Template ID').fill(templateId);
    await createForm.getByLabel('Name', { exact: true }).fill(templateName);
    await createForm.getByLabel('Operation').selectOption('embedding');
    await createForm.getByLabel('Version', { exact: true }).fill(version);
    await createForm.getByLabel('Description').fill('E2E benchmark template');
    await createForm.getByLabel('Stage type').selectOption('paired_request_loop');
    await createForm.getByRole('button', { name: 'Add metric' }).click();
    await createForm.getByLabel('Metric ID', { exact: true }).fill('cold_penalty_ms');
    await createForm.getByLabel('Left metric').fill('cold.elapsed_ms');
    await createForm.getByLabel('Right metric').fill('hot.elapsed_ms');
    await createForm.getByLabel('Unit').fill('ms');
    await createForm.getByLabel('elapsed_ms').check();
    await createForm.getByLabel('Additional metric IDs').fill('pair.cold.elapsed_ms, pair.hot.elapsed_ms, cold_penalty_ms');
    await createForm.getByLabel('mean').check();
    await createForm.getByRole('button', { name: 'Raw JSON' }).click();
    const createDrawer = page.getByRole('dialog', { name: /Raw template JSON/ });
    await expect(createDrawer).toBeVisible();
    await expect(createDrawer.getByRole('textbox')).toHaveValue(/"chat_completion": false/);
    await expect(createDrawer.getByRole('textbox')).toHaveValue(/"embedding": true/);
    await expect(createDrawer.getByRole('textbox')).toHaveValue(/"pair": \[/);
    await expect(createDrawer.getByRole('textbox')).toHaveValue(/"cold_penalty_ms"/);
    await createDrawer.getByRole('button', { name: 'Cancel' }).click();
    await createForm.getByRole('button', { name: 'Save' }).click();

    const createdRow = page.locator('.template-row').filter({ hasText: templateName });
    await expect(createdRow).toBeVisible();
    await expect(createdRow).toContainText(templateName);

    await createdRow.click();
    await expect(page.locator('.template-preview-panel')).toContainText(templateId);
    await page.locator('.template-preview-panel').getByRole('button', { name: 'Edit' }).click();
    const editForm = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Edit benchmark template' }) });
    await expect(editForm).toBeVisible();
    await editForm.getByLabel('Name', { exact: true }).fill(updatedName);
    await editForm.getByLabel('Version', { exact: true }).fill(updatedVersion);
    await editForm.getByRole('button', { name: 'Raw JSON' }).click();
    const drawer = page.getByRole('dialog', { name: /Raw template JSON/ });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('textbox').fill(updatedContent);
    await drawer.getByRole('button', { name: 'Apply JSON' }).click();
    await editForm.getByRole('button', { name: 'Save' }).click();

    const updatedRow = page.locator('.template-row').filter({ hasText: updatedName });
    await expect(updatedRow).toBeVisible();
    await expect(updatedRow).toContainText(updatedName);
    await expect(updatedRow).toContainText(updatedVersion);
    await updatedRow.click();
    await page.locator('.template-preview-panel').getByRole('button', { name: 'Edit' }).click();
    const preservedForm = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Edit benchmark template' }) });
    await preservedForm.getByRole('button', { name: 'Raw JSON' }).click();
    const preservedDrawer = page.getByRole('dialog', { name: /Raw template JSON/ });
    await expect(preservedDrawer.getByRole('textbox')).toHaveValue(/"pair": \[/);
    await expect(preservedDrawer.getByRole('textbox')).toHaveValue(/"cold_penalty_ms"/);
    await expect(preservedDrawer.getByRole('textbox')).toHaveValue(/"observability"/);
    await preservedDrawer.getByRole('button', { name: 'Cancel' }).click();

    page.on('dialog', (dialog) => dialog.accept());
    await updatedRow.click();
    await page.locator('.template-preview-panel').getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.template-row').filter({ hasText: updatedName })).toHaveCount(0);
  } finally {
    await cleanupTemplateIds(page.request, [templateId]);
  }
});
