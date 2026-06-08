import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';

import { archiveInferenceServer, findInferenceServerByName } from './helpers.js';

test('populates safe cloud provider defaults without filling the bearer token', async ({ page }) => {
  await page.goto('/catalog?tab=servers');

  await page.getByRole('button', { name: '+ Add server' }).click();

  const createDrawer = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Add inference server' }) });
  await expect(createDrawer).toBeVisible();
  const createForm = createDrawer.locator('form');
  const presetSelect = createForm.getByTestId('provider-preset-select');

  const providerOptions = await presetSelect.locator('option').evaluateAll((options) => options.map((option) => option.textContent?.trim()));
  expect(providerOptions).toEqual([
    'Local / custom inference server',
    'OpenAI',
    'Mistral',
    'Groq',
    'Together AI',
    'Fireworks AI',
    'OpenRouter',
    'DeepSeek',
    'xAI',
    'Cerebras'
  ]);

  await presetSelect.selectOption('openai');

  await expect(createForm.getByLabel('Display name')).toHaveValue('OpenAI');
  await expect(createForm.getByLabel('Base URL')).toHaveValue('https://api.openai.com/v1');
  await expect(createForm.getByLabel('Software')).toHaveValue('OpenAI');
  await expect(createForm.getByLabel('Auth type')).toHaveValue('bearer');
  await expect(createForm.getByLabel('Auth header name')).toHaveValue('Authorization');
  await expect(createForm.getByLabel('Auth token')).toHaveValue('');
  await expect(createForm.getByLabel('Streaming')).toBeChecked();
  await expect(createForm.getByLabel('Models endpoint')).toBeChecked();
  await expect(createForm.getByLabel('Tool calls')).toBeChecked();
  await expect(createForm.getByLabel('Embeddings')).toBeChecked();
  await expect(createForm.getByLabel('JSON schema')).toBeChecked();
  await expect(createForm.getByLabel('Reasoning')).toBeChecked();
  await expect(createForm.getByLabel('Parallel requests')).toBeChecked();

  await presetSelect.selectOption('mistral');

  await expect(createForm.getByLabel('Display name')).toHaveValue('Mistral');
  await expect(createForm.getByLabel('Base URL')).toHaveValue('https://api.mistral.ai/v1');
  await expect(createForm.getByLabel('Software')).toHaveValue('Mistral');
  await expect(createForm.getByLabel('Auth type')).toHaveValue('bearer');
  await expect(createForm.getByLabel('Auth header name')).toHaveValue('Authorization');
  await expect(createForm.getByLabel('Auth token')).toHaveValue('');
  await expect(createForm.getByLabel('Streaming')).toBeChecked();
  await expect(createForm.getByLabel('Models endpoint')).toBeChecked();
  await expect(createForm.getByLabel('Tool calls')).toBeChecked();
  await expect(createForm.getByLabel('Embeddings')).toBeChecked();
  await expect(createForm.getByLabel('JSON schema')).toBeChecked();
  await expect(createForm.getByLabel('Reasoning')).toBeChecked();
  await expect(createForm.getByLabel('Parallel requests')).toBeChecked();
});

test('creates a new inference server from the dashboard', async ({ page, request }) => {
  const displayName = `E2E Server ${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const baseUrl = 'http://localhost:8080';

  await page.goto('/catalog?tab=servers');

  await page.getByRole('button', { name: '+ Add server' }).click();

  const createDrawer = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Add inference server' }) });
  await expect(createDrawer).toBeVisible();
  const createForm = createDrawer.locator('form');

  // ── Left column: inference server fields ──
  await createForm.getByLabel('Display name').fill(displayName);
  await createForm.getByLabel('Base URL').fill(baseUrl);

  // Enable tool calls and streaming capabilities
  await createForm.getByLabel('Streaming').check();
  await createForm.getByLabel('Tool calls').check();

  // ── Right column: hosting server fields ──
  await createForm.getByLabel('GPU vendor').selectOption('nvidia');
  await createForm.getByLabel('GPU model').fill('RTX 4090');
  await createForm.getByLabel('VRAM (GB)').fill('24');

  await createForm.getByTestId('os-name-select').selectOption('linux');
  await createForm.getByLabel('OS version').fill('Ubuntu 22.04 LTS');
  await createForm.getByTestId('os-arch-select').selectOption('x86_64');

  // Test connection then save
  await createForm.getByRole('button', { name: 'Test connection' }).click();
  await expect(createForm.locator('.probe-panel')).toBeVisible({ timeout: 10000 });
  await createForm.getByRole('button', { name: /Save to Catalog|Save anyway/ }).click();

  await expect(page.locator('.catalog-server-card').filter({ hasText: displayName })).toBeVisible();

  // Verify API record has the submitted hardware and capabilities
  const created = await findInferenceServerByName(request, displayName);
  expect(created).not.toBeNull();
  if (created) {
    expect(created.runtime.hardware.gpu[0]?.vendor).toBe('nvidia');
    expect(created.runtime.hardware.gpu[0]?.model).toBe('RTX 4090');
    expect(created.runtime.hardware.gpu[0]?.vram_mb).toBe(24576);
    expect(created.runtime.platform.os.name).toBe('linux');
    expect(created.runtime.platform.os.version).toBe('Ubuntu 22.04 LTS');
    expect(created.runtime.platform.os.arch).toBe('x86_64');
    expect(created.capabilities.server.streaming).toBe(true);
    expect(created.capabilities.generation.tools).toBe(true);

    await archiveInferenceServer(request, created.inference_server.server_id);
  }
});
