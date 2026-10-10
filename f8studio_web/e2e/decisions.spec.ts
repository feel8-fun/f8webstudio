import { expect, test } from '@playwright/test';

test('adds a typed Decision node and exposes its separate provider settings', async ({ page, request }, testInfo) => {
  const projectId = `decision-e2e-${testInfo.project.name}-${Date.now()}`;
  expect((await request.post('/api/projects', { data: { projectId, name: 'Decision node test' } })).ok()).toBeTruthy();
  const connection = await request.post('/api/agents/connections', { data: {
    displayName: 'Decision host', protocol: 'systemone', endpoint: 'http://127.0.0.1:11434/v1',
    model: 'decision-model', models: ['decision-model'],
    modelCapabilities: [{ modelId: 'decision-model', imageInput: true, thinking: null }],
  } });
  expect(connection.status()).toBe(201);
  const providerId = (await connection.json() as { providerId: string }).providerId;
  try {
    await page.goto('/');
    await page.locator('#project-select').selectOption(projectId);
    await page.getByLabel('Search nodes').fill('f8.pyengine');
    await page.getByRole('button', { name: /PyEngine/ }).click();
    await expect(page.locator('.flow-node-service')).toHaveCount(1);
    await page.getByLabel('Search nodes').fill('f8.decision');
    await page.getByRole('button', { name: /Decision f8\.decision/ }).click();
    await expect(page.locator('.flow-node-operator')).toHaveCount(1);
    const decision = page.locator('.flow-node-operator');
    await expect(decision).toContainText('decided');
    await expect(decision).toContainText('uncertain');
    await expect(decision).toContainText('probabilities');
    await expect(decision).toContainText('video');
    const response = await request.get(`/api/projects/${projectId}`);
    const project = await response.json() as { document: { nodes: { kind: string; stateValues: Record<string, unknown>; spec: { stateFields: { name: string; valueSchema: { default?: unknown } }[] } }[] } };
    const operator = project.document.nodes.find((node) => node.kind === 'operator');
    expect(operator?.spec.stateFields.find((field) => field.name === 'questions')?.valueSchema.default).toHaveProperty('decision');
    expect(operator?.stateValues).not.toHaveProperty('apiKey');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.getByRole('combobox', { name: 'Provider', exact: true }).selectOption(providerId);
    await expect(dialog.getByLabel('Decision node provider ID')).toHaveValue(providerId);
    await expect(dialog.getByLabel('Default model')).toHaveValue('decision-model');
    await expect(dialog.getByLabel('Image input')).toHaveValue('yes');
    await expect(dialog.getByLabel('API key', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('decision-provider.png') });
    const chatProviders = await (await request.get('/api/agents/providers')).json() as { providerId: string }[];
    expect(chatProviders.some((provider) => provider.providerId === providerId)).toBe(false);
  } finally {
    expect((await request.delete(`/api/agents/providers/${providerId}`)).status()).toBe(204);
    expect((await request.delete(`/api/projects/${projectId}`)).status()).toBe(204);
  }
});
