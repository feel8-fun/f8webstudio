import { expect, test } from '@playwright/test';
import type { ProjectRecord } from '../src/api/contracts';

test('renames the selected project and persists its metadata without changing the graph', async ({ page }) => {
  const response = await page.request.post('/api/projects', { data: { name: 'Rename test', description: 'Keep the description' } });
  expect(response.ok()).toBe(true);
  const original = await response.json() as ProjectRecord;
  const projectId = original.projectId;
  try {
    await page.addInitScript((id) => localStorage.setItem('f8studio.selectedProjectId', id), projectId);
    await page.goto('/');
    const controls = page.locator('.project-control');
    await expect(page.locator('#project-select')).toHaveValue(projectId);
    await controls.getByRole('button', { name: 'Rename project', exact: true }).click();
    const input = controls.getByRole('textbox', { name: 'Project name' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(original.name);
    await input.fill('   ');
    await expect(controls.getByRole('button', { name: 'Save project name' })).toBeDisabled();
    await input.fill('Cancel this draft');
    await input.press('Escape');
    await expect(page.locator('#project-select option:checked')).toHaveText(original.name);
    await controls.getByRole('button', { name: 'Rename project', exact: true }).click();
    await input.fill('  中文 Project  ');
    await input.press('Enter');
    await expect(page.locator('#project-select option:checked')).toHaveText('中文 Project');
    const renamedResponse = await page.request.get(`/api/projects/${projectId}`);
    const renamed = await renamedResponse.json() as ProjectRecord;
    expect(renamed.projectId).toBe(projectId);
    expect(renamed.name).toBe('中文 Project');
    expect(renamed.description).toBe(original.description);
    expect(renamed.document).toEqual(original.document);
    await page.reload();
    await expect(page.locator('#project-select')).toHaveValue(projectId);
    await expect(page.locator('#project-select option:checked')).toHaveText('中文 Project');
  } finally {
    await page.request.delete(`/api/projects/${projectId}`);
  }
});
