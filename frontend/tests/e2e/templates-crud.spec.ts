import { expect, test } from '@playwright/test';

import { cleanupTemplateIds } from './helpers.js';

test('creates, updates, and deletes templates from the redesigned Templates page', async ({ page }) => {
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
      input_contract: {
        required_fields: ['prompt'],
        optional_fields: ['system_prompt'],
        min_items: 1
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
    await page.getByRole('button', { name: 'Advanced form' }).click();
    const createForm = page.locator('.template-advanced-panel form');
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

    await page.getByRole('button', { name: 'Raw JSON' }).click();
    await expect(page.locator('.template-raw-json')).toHaveValue(/"embedding": true/);
    await expect(page.locator('.template-raw-json')).toHaveValue(/"pair": \[/);
    await expect(page.locator('.template-raw-json')).toHaveValue(/"cold_penalty_ms"/);
    await page.getByRole('button', { name: 'Live JSON' }).click();
    await page.getByRole('button', { name: 'Save template' }).click();

    const createdRow = page.locator('.template-row').filter({ hasText: templateName });
    await expect(createdRow).toBeVisible();
    await expect(createdRow).toContainText(templateName);

    await createdRow.click();
    await expect(page.locator('.template-preview-panel')).toContainText(templateId);
    await page.locator('.template-preview-panel').getByRole('button', { name: 'Modify' }).click();
    await page.getByRole('button', { name: 'Advanced form' }).click();
    const editForm = page.locator('.template-advanced-panel form');
    await expect(editForm).toBeVisible();
    await editForm.getByLabel('Name', { exact: true }).fill(updatedName);
    await editForm.getByLabel('Version', { exact: true }).fill(updatedVersion);
    await page.getByRole('button', { name: 'Raw JSON' }).click();
    await page.locator('.template-raw-json').fill(updatedContent);
    await page.getByRole('button', { name: 'Update draft' }).click();
    await page.getByRole('button', { name: 'Save template' }).click();

    const updatedRow = page.locator('.template-row').filter({ hasText: updatedName });
    await expect(updatedRow).toBeVisible();
    await expect(updatedRow).toContainText(updatedName);
    await updatedRow.click();
    await page.locator('.template-preview-panel').getByRole('button', { name: 'Modify' }).click();
    await page.getByRole('button', { name: 'Raw JSON' }).click();
    await expect(page.locator('.template-raw-json')).toHaveValue(/"pair": \[/);
    await expect(page.locator('.template-raw-json')).toHaveValue(/"cold_penalty_ms"/);
    await expect(page.locator('.template-raw-json')).toHaveValue(/"observability"/);
    await page.getByRole('button', { name: 'x Close' }).click();

    page.on('dialog', (dialog) => dialog.accept());
    await updatedRow.click();
    await page.locator('.template-preview-panel').getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.template-row').filter({ hasText: updatedName })).toHaveCount(0);
  } finally {
    await cleanupTemplateIds(page.request, [templateId]);
  }
});

test('authors a template through the in-page benchmark agent', async ({ page }) => {
  const suffix = Date.now();
  const templateId = `agent-template-${suffix}`;
  const templateName = `Agent Template ${suffix}`;
  let agentCalls = 0;

  await page.route('**/system/settings', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ template_agent_model: { server_id: 'agent-server', model_id: 'agent-model' } })
    });
  });
  await page.route('**/models', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{
        model: {
          server_id: 'agent-server',
          model_id: 'agent-model',
          display_name: 'Agent model'
        }
      }])
    });
  });
  await page.route('**/benchmark/template-agent', async (route) => {
    agentCalls += 1;
    if (agentCalls === 1) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'needs_input',
          reply: 'I need a few details.',
          questions: ['Which success signal should this benchmark score?']
        })
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'draft_ready',
        reply: 'Draft ready.',
        template: {
          kind: 'test_template',
          schema_version: 'benchmark_test_template_v1',
          template_id: templateId,
          template_version: '1.0.0',
          name: templateName,
          description: 'Created through the e2e agent flow.',
          operation: 'chat_completion',
          required_capabilities: {
            chat_completion: true,
            streaming: false,
            tool_calling: true,
            structured_output: false
          },
          input_contract: {
            required_fields: ['prompt', 'tools'],
            optional_fields: ['system_prompt'],
            min_items: 1
          },
          stages: [{ id: 'chat', type: 'dataset_loop', iterations_per_item: 1, record_metrics: true, order: 'sequential', cooldown_ms: 0, stop_on_error: false }],
          metrics: ['input_tokens', 'output_tokens', 'tool_selected_correctly'],
          aggregations: ['mean', 'count'],
          metadata: { source: 'e2e-agent' }
        },
        validation: { ok: true, issues: [] }
      })
    });
  });

  try {
    await page.goto('/templates');
    await page.getByRole('button', { name: 'New benchmark template' }).first().click();
    await page.getByPlaceholder('Describe what you want...').fill('Create a tool-call benchmark.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Which success signal should this benchmark score?')).toBeVisible();
    await expect(page.locator('.template-json-code')).toContainText('template_id');
    await expect(page.locator('.template-json-code')).toContainText('create-a-tool-call-benchmark-v1');
    await page.getByRole('button', { name: 'Raw JSON' }).click();
    await expect(page.locator('.template-raw-json')).toHaveValue(/"template_id": "create-a-tool-call-benchmark-v1"/);
    await page.getByRole('button', { name: 'Advanced form' }).click();
    await expect(page.locator('.template-advanced-panel').getByLabel('Template ID')).toHaveValue('create-a-tool-call-benchmark-v1');
    await expect(page.getByRole('button', { name: 'Save template' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Live JSON' }).click();

    await page.getByPlaceholder('Describe what you want...').fill('Score whether the correct tool was selected.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.template-agent-draft-card')).toContainText('Validated draft');
    await expect(page.locator('.template-json-code')).toContainText(templateId);
    await page.getByRole('button', { name: 'Raw JSON' }).click();
    await expect(page.locator('.template-raw-json')).toHaveValue(new RegExp(`"template_id": "${templateId}"`));
    await page.getByRole('button', { name: 'Advanced form' }).click();
    await expect(page.locator('.template-advanced-panel').getByLabel('Name', { exact: true })).toHaveValue(templateName);
    await page.getByRole('button', { name: 'Live JSON' }).click();
    await expect(page.locator('.template-json-code')).toContainText(templateId);
    await page.getByRole('button', { name: 'Save template' }).click();

    const row = page.locator('.template-row').filter({ hasText: templateName });
    await expect(row).toBeVisible();
  } finally {
    await cleanupTemplateIds(page.request, [templateId]);
  }
});
