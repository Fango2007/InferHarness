import { expect, test } from '@playwright/test';

test('Run uses inline benchmark prompt inputs instead of template selection', async ({ page }) => {
  await page.goto('/run');

  await expect(page.locator('.merged-page-header').getByRole('heading', { name: 'Run', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'System prompt', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Dataset mode' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Prompt' })).toHaveClass(/is-active/);
  await expect(page.getByRole('button', { name: 'Server dataset' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run benchmark' })).toBeDisabled();
  await expect(page.getByRole('listbox', { name: 'Templates', exact: true })).toHaveCount(0);
});

test('Run lets users choose server dataset mode before selecting a model', async ({ page }) => {
  await page.goto('/run');

  await page.getByRole('button', { name: 'Server dataset' }).click();

  await expect(page.getByRole('combobox', { name: 'Dataset mode' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Server dataset' })).toHaveClass(/is-active/);
  await expect(page.getByRole('textbox', { name: 'Dataset id' })).toBeEnabled();
  await expect(page.getByRole('combobox', { name: 'Format' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Path' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Run benchmark' })).toBeDisabled();
});

test('Run segmented dataset mode control still switches to server dataset', async ({ page }) => {
  await page.goto('/run');

  await page.getByRole('button', { name: 'Server dataset' }).click();

  await expect(page.getByRole('button', { name: 'Server dataset' })).toHaveClass(/is-active/);
  await expect(page.getByRole('textbox', { name: 'Dataset id' })).toBeEnabled();
});
