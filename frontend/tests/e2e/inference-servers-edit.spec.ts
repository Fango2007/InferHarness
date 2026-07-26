import { expect, test } from '@playwright/test';

import { archiveInferenceServer, createInferenceServer, dismissOnboarding, findInferenceServerByName } from './helpers.js';

test('edits an inference server', async ({ page, request }) => {
  await dismissOnboarding(page);
  // Create server via API with hardware pre-populated to verify edit drawer pre-fills
  const created = await createInferenceServer(request, {
    hardware: {
      gpu: [{ vendor: 'nvidia', model: 'RTX 4090', vram_mb: 24576 }],
      cpu: { model: 'Core i9-14900K', cores: 24 },
      ram_mb: 65536,
    },
    platform: {
      os: { name: 'linux', version: 'Ubuntu 22.04 LTS', arch: 'x86_64' },
      container: { type: 'none', image: null },
    },
  });
  const updatedName = `${created.inference_server.display_name} Updated`;

  await page.goto('/');

  const serverCard = page.locator('.catalog-server-card').filter({ hasText: created.inference_server.display_name });
  await expect(serverCard).toBeVisible();
  await serverCard.click();
  const detailRail = page.locator('.catalog-detail-rail').filter({ hasText: created.inference_server.display_name });
  await expect(detailRail).toBeVisible();
  await detailRail.getByRole('button', { name: 'Edit', exact: true }).click();

  const editDrawer = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: new RegExp(`Edit · ${created.inference_server.display_name}`) }) });
  await expect(editDrawer).toBeVisible();
  const editForm = editDrawer.locator('form');

  // Verify hosting server fields pre-populate from the saved record
  await expect(editForm.getByLabel('GPU vendor')).toHaveValue('nvidia');
  await expect(editForm.getByLabel('GPU model')).toHaveValue('RTX 4090');
  await expect(editForm.getByLabel('VRAM (GB)')).toHaveValue('24');
  await expect(editForm.getByLabel('CPU model')).toHaveValue('Core i9-14900K');
  await expect(editForm.getByTestId('os-name-select')).toHaveValue('linux');
  await expect(editForm.getByLabel('OS version')).toHaveValue('Ubuntu 22.04 LTS');
  await expect(editForm.getByTestId('os-arch-select')).toHaveValue('x86_64');

  // Update display name and save
  await editForm.getByLabel('Display name').fill(updatedName);
  await editForm.getByRole('button', { name: 'Test connection' }).click();
  await expect(editForm.locator('.probe-panel')).toBeVisible({ timeout: 10000 });
  await editForm.getByRole('button', { name: /Save changes|Save anyway/ }).click();

  await expect(page.locator('.catalog-server-card').filter({ hasText: updatedName })).toBeVisible();

  const updated = (await findInferenceServerByName(request, updatedName)) ?? created;
  await archiveInferenceServer(request, updated.inference_server.server_id);
});
