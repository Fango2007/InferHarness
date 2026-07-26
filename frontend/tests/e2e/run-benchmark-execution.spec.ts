import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import {
  archiveInferenceServer,
  createModel,
  createInferenceServer,
  dismissOnboarding,
  findInferenceServerByName
} from './helpers.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '../../..');
const datasetDir = path.join(repoRoot, 'backend/data/datasets');

interface MockChatServer {
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function startMockOpenAiChatServer(): Promise<MockChatServer> {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        data: [{ id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' }]
      }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }

    let rawBody = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', () => {
      requests.push(JSON.parse(rawBody) as Record<string, unknown>);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
      }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to start mock OpenAI chat server.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    })
  };
}

async function mockHealthyServer(page: Page, serverId: string) {
  await page.route('**/inference-servers/health*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [{
          server_id: serverId,
          ok: true,
          status_code: 200,
          response_time_ms: 1,
          checked_at: '2026-01-01T00:00:00.000Z'
        }]
      })
    });
  });
}

async function mockRunCatalog(page: Page, server: unknown, model: unknown) {
  await page.route(/\/inference-servers(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([server])
    });
  });
  await page.route(/\/models(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([model])
    });
  });
}

test('configures a benchmark smoke run from inline prompt inputs', async ({ page, request }) => {
  await dismissOnboarding(page);
  const mockChat = await startMockOpenAiChatServer();
  const serverDisplayName = `E2E Benchmark Run ${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const server = await createInferenceServer(request, {
    display_name: serverDisplayName,
    base_url: mockChat.baseUrl,
    schema_family: ['openai-compatible']
  });
  const model = await createModel(request, server.inference_server.server_id, {
    model_id: 'gpt-4o-mini',
    display_name: 'gpt-4o-mini'
  });
  await mockHealthyServer(page, server.inference_server.server_id);
  await mockRunCatalog(page, server, model);

  try {
    await expect
      .poll(async () => {
        const listed = await findInferenceServerByName(request, serverDisplayName);
        return listed?.inference_server.display_name ?? null;
      })
      .toBe(serverDisplayName);

    const serversResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/inference-servers') &&
        response.ok()
    );
    await page.goto('/run');
    await serversResponse;

    const inferenceServerSelect = page.getByRole('combobox', { name: 'Inference server', exact: true });
    await expect(inferenceServerSelect).toBeVisible();
    const availableServerLabels = await inferenceServerSelect.evaluate((element) => {
      if (!(element instanceof HTMLSelectElement)) {
        return [];
      }
      return Array.from(element.options)
        .map((option) => option.text.trim())
        .filter((label) => label.length > 0 && label !== 'Select an inference server');
    });
    expect(availableServerLabels.length).toBeGreaterThan(0);
    await inferenceServerSelect.selectOption({ label: availableServerLabels.includes(serverDisplayName) ? serverDisplayName : availableServerLabels[0] });
    await page.getByRole('combobox', { name: 'Add model', exact: true }).selectOption({ label: `gpt-4o-mini · ${serverDisplayName}` });
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Reply with exactly: OK');

    await expect(page.getByTitle('gpt-4o-mini')).toBeVisible();
    const runButton = page.getByRole('button', { name: 'Run benchmark' });
    await expect(runButton).toBeEnabled();

    const createPlan = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/benchmark\/plans$/.test(new URL(response.url()).pathname) &&
        response.status() === 201
    );
    const runPlan = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/benchmark\/plans\/[^/]+\/run$/.test(new URL(response.url()).pathname) &&
        response.status() === 201
    );
    await runButton.click();
    await createPlan;
    await runPlan;

    await expect(page.locator('.run-message-card pre')).toHaveText('OK');
    await expect(page.locator('.run-status-pill')).toHaveText('completed');
    const runAudit = page.locator('.run-asserts').filter({
      has: page.getByRole('heading', { name: 'Run audit' })
    });
    await expect(runAudit).toContainText('completed');
    await expect(runAudit).not.toContainText('no-instantiation');
    await expect(runAudit).not.toContainText('no-result');
    await expect(page.locator('.run-metric-grid')).toContainText('5');
    await expect(page.locator('.run-metric-grid')).toContainText('1');
    await expect(page.locator('.run-metric-grid')).toContainText('6');

    expect(mockChat.requests).toHaveLength(1);
    const [chatRequest] = mockChat.requests;
    expect(chatRequest.model).toBe('gpt-4o-mini');
    expect(chatRequest.messages).toEqual([
      { role: 'system', content: 'You are a concise assistant.' },
      { role: 'user', content: 'Reply with exactly: OK' }
    ]);
  } finally {
    await archiveInferenceServer(request, server.inference_server.server_id);
    await mockChat.close();
  }
});

test('runs a server-side JSONL dataset from the Run page', async ({ page, request }) => {
  await dismissOnboarding(page);
  const mockChat = await startMockOpenAiChatServer();
  const serverDisplayName = `E2E Dataset Run ${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const datasetName = `e2e-codegen-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jsonl`;
  const datasetPath = path.join(datasetDir, datasetName);
  fs.mkdirSync(datasetDir, { recursive: true });
  fs.writeFileSync(
    datasetPath,
    [
      JSON.stringify({ id: 'codegen-1', prompt: 'Write a JavaScript add function.' }),
      JSON.stringify({ id: 'codegen-2', prompt: 'Write a Python is_even function.' })
    ].join('\n') + '\n',
    'utf8'
  );
  const server = await createInferenceServer(request, {
    display_name: serverDisplayName,
    base_url: mockChat.baseUrl,
    schema_family: ['openai-compatible']
  });
  const model = await createModel(request, server.inference_server.server_id, {
    model_id: 'gpt-4o-mini',
    display_name: 'gpt-4o-mini'
  });
  await mockHealthyServer(page, server.inference_server.server_id);
  await mockRunCatalog(page, server, model);

  try {
    await page.goto('/run');
    const inferenceServerSelect = page.getByRole('combobox', { name: 'Inference server', exact: true });
    await expect(inferenceServerSelect).toBeVisible();
    await inferenceServerSelect.selectOption({ label: serverDisplayName });
    await page.getByRole('combobox', { name: 'Add model', exact: true }).selectOption({ label: `gpt-4o-mini · ${serverDisplayName}` });
    await page.getByRole('button', { name: 'Server dataset' }).click();
    await page.getByRole('textbox', { name: 'Dataset id' }).fill('e2e-codegen');
    await page.getByRole('textbox', { name: 'Path' }).fill(datasetPath);

    const runButton = page.getByRole('button', { name: 'Run benchmark' });
    await expect(runButton).toBeEnabled();
    const prepareManifest = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/benchmark/datasets/manifest') &&
        response.ok()
    );
    const runPlan = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/benchmark\/plans\/[^/]+\/run$/.test(new URL(response.url()).pathname) &&
        response.status() === 201
    );
    await runButton.click();
    await prepareManifest;
    await runPlan;

    await expect(page.locator('.run-status-pill')).toHaveText('completed');
    await expect(page.locator('.run-message-card pre')).toHaveCount(2);
    const runAudit = page.locator('.run-asserts').filter({
      has: page.getByRole('heading', { name: 'Run audit' })
    });
    await expect(page.locator('.run-prompt-strip')).toContainText('e2e-codegen');
    await expect(runAudit).toContainText('items 2');
    expect(mockChat.requests).toHaveLength(2);
    expect(mockChat.requests.map((entry) => entry.messages)).toEqual([
      [{ role: 'user', content: 'Write a JavaScript add function.' }],
      [{ role: 'user', content: 'Write a Python is_even function.' }]
    ]);
  } finally {
    await archiveInferenceServer(request, server.inference_server.server_id);
    await mockChat.close();
    fs.rmSync(datasetPath, { force: true });
  }
});
