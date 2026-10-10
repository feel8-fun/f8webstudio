import { expect, test } from '@playwright/test';
import type { AssetRecord, GraphNode, ProjectRecord } from '../src/api/contracts';
import type { ProjectVersion } from '../src/api/contracts.gen';
test.use({ actionTimeout: 15_000 });

test('groups global settings, filters My Local, edits a draft and manages named graph snapshots', async ({ page }, testInfo) => {
  const created = await page.request.post('/api/projects', { data: { name: `Timing workspace ${testInfo.project.name} ${Date.now()}` } });
  expect(created.ok()).toBe(true);
  const project = await created.json() as ProjectRecord;
  const draftName = `Timing component ${project.projectId.slice(0, 6)}`;
  let assetId: string | undefined;
  try {
    const service = await page.request.post('/api/catalog/nodes', { data: { kind: 'service', nodeId: 'ux_engine', serviceClass: 'f8.pyengine' } });
    const operator = await page.request.post('/api/catalog/nodes', { data: { kind: 'operator', nodeId: 'ux_tick', serviceId: 'ux_engine', serviceClass: 'f8.pyengine', operatorClass: 'f8.tick' } });
    expect(service.ok()).toBe(true); expect(operator.ok()).toBe(true);
    const host = await service.json() as GraphNode;
    const tick = await operator.json() as GraphNode;
    expect((await page.request.post(`/api/projects/${project.projectId}/patch`, { data: {
      requestId: 'ux-seed', expectedGraphRevision: 0, expectedLayoutRevision: 0,
      operations: [{ op: 'createNode', node: host }, { op: 'createNode', node: tick }],
    } })).ok()).toBe(true);
    const current = await (await page.request.get(`/api/projects/${project.projectId}`)).json() as ProjectRecord;
    const capture = await page.request.post(`/api/projects/${project.projectId}/components`, { data: {
      name: draftName, description: 'Reusable clock for a graph.', nodeIds: ['ux_tick'],
      expectedGraphRevision: current.document.graphRevision, expectedLayoutRevision: current.document.layoutRevision,
    } });
    expect(capture.ok()).toBe(true); assetId = (await capture.json() as AssetRecord).assetId;
    await page.addInitScript((id) => localStorage.setItem('f8studio.selectedProjectId', id), project.projectId);
    await page.goto('/?view=assets');
    const local = page.getByRole('complementary', { name: 'Local library sidebar' });
    const results = local.getByLabel('Local results');
    const types = local.getByRole('group', { name: 'Local asset type' });
    await expect(page.getByRole('heading', { name: 'My Local', exact: true })).toBeVisible();
    await expect(results.getByRole('button').filter({ hasText: project.name })).toBeVisible();
    await expect(results.getByRole('button').filter({ hasText: draftName })).toBeVisible();
    await types.getByRole('button', { name: 'Components', exact: true }).click();
    await expect(results.getByRole('button').filter({ hasText: project.name })).toHaveCount(0);
    await types.getByRole('button', { name: 'Variants', exact: true }).click();
    await expect(local.getByText('No local works match your search and type filter.', { exact: true })).toBeVisible();
    await types.getByRole('button', { name: 'All', exact: true }).click();
    expect(await types.getByRole('button').evaluateAll((buttons) => buttons.every((button) => button.scrollWidth <= button.clientWidth))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByLabel('Cloud URL', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    const categories = settings.getByRole('navigation', { name: 'Settings categories' });
    await expect(categories.getByRole('button', { name: 'AI', exact: true })).toHaveAttribute('aria-current', 'page');
    await categories.getByRole('button', { name: 'Cloud', exact: true }).click();
    await expect(settings.getByLabel('Cloud URL', { exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/f8-settings-${testInfo.project.name}.png`, fullPage: true });
    await settings.getByRole('button', { name: 'Close Settings' }).click();

    await page.locator('.asset-browser .asset-list button').filter({ hasText: draftName }).click();
    await expect(page.getByLabel('Graph preview')).toBeVisible();
    await expect(page.getByLabel('Content JSON', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Publish template/i)).toHaveCount(0);
    await page.getByLabel('Description', { exact: true }).fill('A reusable timing component with a saved Tick configuration.');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByText('Draft saved · v1', { exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/f8-local-drafts-${testInfo.project.name}.png`, fullPage: true });
    await page.getByRole('button', { name: 'More draft actions' }).click();
    await page.getByRole('menuitem', { name: 'Edit content JSON' }).click();
    await expect(page.getByLabel('Content JSON', { exact: true })).toBeVisible();

    await types.getByRole('button', { name: 'Graphs', exact: true }).click();
    await expect(results.getByRole('button').filter({ hasText: draftName })).toHaveCount(0);
    await local.getByLabel('Search My Local', { exact: true }).fill(project.name);
    await results.getByRole('button').filter({ hasText: project.name }).click();
    await expect(page.getByRole('button', { name: 'Open in Graph', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save snapshot', exact: true }).click();
    await page.getByLabel('Snapshot name').fill('Before demo');
    await page.getByLabel('Snapshot notes').fill('Clock configuration checked.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Before demo', exact: true })).toBeVisible();
    const snapshotsPath = `/api/projects/${project.projectId}/versions`;
    const original = (await (await page.request.get(snapshotsPath)).json() as ProjectVersion[])[0]!;
    await page.getByRole('button', { name: 'Edit Before demo', exact: true }).click();
    await page.getByLabel('Snapshot name').fill('Known good');
    await page.getByLabel('Snapshot notes').fill('Ready for the live demo.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Ready for the live demo.', { exact: true })).toBeVisible();
    const renamed = (await (await page.request.get(snapshotsPath)).json() as ProjectVersion[])[0]!;
    expect(renamed.document).toEqual(original.document); expect(renamed.createdAt).toBe(original.createdAt);
    await page.screenshot({ path: `/tmp/f8-project-snapshots-${testInfo.project.name}.png`, fullPage: true });
    expect((await page.request.post(`/api/projects/${project.projectId}/patch`, { data: {
      requestId: 'ux-rename', expectedGraphRevision: current.document.graphRevision, expectedLayoutRevision: current.document.layoutRevision,
      operations: [{ op: 'renameNode', nodeId: 'ux_tick', name: 'Changed after checkpoint' }],
    } })).ok()).toBe(true);
    await page.getByRole('button', { name: 'Restore Known good', exact: true }).click();
    await page.getByRole('button', { name: 'Restore snapshot', exact: true }).click();
    await expect(page.getByText('Restored Known good.', { exact: true })).toBeVisible();
    const restored = await (await page.request.get(`/api/projects/${project.projectId}`)).json() as ProjectRecord;
    expect(restored.document.nodes).toEqual(original.document.nodes);
    expect(restored.document.graphRevision).toBeGreaterThan(current.document.graphRevision);
    await page.getByRole('button', { name: 'Delete Known good', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Delete snapshot', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete snapshot', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Known good', exact: true })).toHaveCount(0);
    expect(await (await page.request.get(`/api/projects/${project.projectId}`)).json()).toEqual(restored);
  } finally {
    if (assetId) await page.request.delete(`/api/assets/${assetId}`);
    await page.request.delete(`/api/projects/${project.projectId}`);
  }
});
