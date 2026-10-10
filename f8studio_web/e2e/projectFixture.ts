import { expect, type Page } from '@playwright/test';

export async function createEmptyProject(page: Page): Promise<string> {
  const previous = await page.locator('#project-select').inputValue();
  const created = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/projects');
  await page.locator('.project-control').getByRole('button', { name: 'New project' }).click();
  expect((await created).status()).toBe(201);
  await expect(page.locator('#project-select')).not.toHaveValue(previous);
  await expect(page.locator('.studio-node')).toHaveCount(0);
  await expect(page.locator('.graph-toolbar')).toContainText('Draft r0');
  return page.locator('#project-select').inputValue();
}
