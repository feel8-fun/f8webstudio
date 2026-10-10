import { expect, test } from '@playwright/test';
import type { AssetRecord, GraphNode, ProjectRecord } from '../src/api/contracts';
test.use({ actionTimeout: 15_000 });

test('offline state edits synchronize authored controls and Variants despite stale runtime values', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  const response = await page.request.post('/api/projects', { data: { name: 'Offline state authoring' } });
  expect(response.ok()).toBe(true);
  const project = await response.json() as ProjectRecord;
  const assetName = `Offline-Tick-${project.projectId}`;
  try {
    const createNode = async (data: Record<string, unknown>): Promise<GraphNode> => {
      const response = await page.request.post('/api/catalog/nodes', { data });
      expect(response.ok()).toBe(true);
      return response.json() as Promise<GraphNode>;
    };
    const engine = await createNode({ kind: 'service', nodeId: 'offline_engine', serviceClass: 'f8.pyengine' });
    const definition = await createNode({ kind: 'operator', nodeId: 'offline_tick', serviceId: engine.serviceId,
      serviceClass: 'f8.pyengine', operatorClass: 'f8.tick', name: 'Offline Tick' });
    // Mobile exposes the numeric control; the saved boolean must still win over
    // the retained sample when captured and restored through a Variant.
    const tick: GraphNode = { ...definition, stateValues: { tickMs: 100, hiResTimer: !mobile } };
    const seed = await page.request.post(`/api/projects/${project.projectId}/patch`, { data: {
      requestId: 'seed_offline_tick', expectedGraphRevision: project.document.graphRevision,
      expectedLayoutRevision: project.document.layoutRevision, operations: [
        { op: 'createNode', node: engine, layout: { nodeId: engine.nodeId, x: 0, y: 0, width: 600, height: 300 } },
        { op: 'createNode', node: tick, layout: { nodeId: tick.nodeId, x: 40, y: 100 } },
      ],
    } });
    expect(seed.ok()).toBe(true);
    // Simulate a retained sample from an earlier run. No service is deployed.
    await page.routeWebSocket('**/api/live', (socket) => socket.send(JSON.stringify({ type: 'live.snapshot', values: {
      'state/offline_engine/offline_tick/tickMs': { field: 'tickMs', found: true, value: 100, tsMs: 1 },
      'state/offline_engine/offline_tick/hiResTimer': { field: 'hiResTimer', found: true, value: true, tsMs: 1 },
    } })));
    await page.addInitScript((id) => localStorage.setItem('f8studio.selectedProjectId', id), project.projectId);
    await page.goto('/');
    const node = page.locator('.react-flow__node[data-id="offline_tick"]');
    await node.locator('header').click();
    const inline = node.getByRole('spinbutton');
    const inspector = page.locator('.graph-inspector');
    const inspected = mobile ? inline : inspector.getByRole('spinbutton', { name: 'Tick (ms)' });
    await expect(inline).toHaveValue('100');
    await inline.fill('250');
    await inline.press('Enter');
    await expect(inspected).toHaveValue('250');
    await expect(inline).toHaveValue('250');
    const readProject = async () => (await (await page.request.get(`/api/projects/${project.projectId}`)).json()) as ProjectRecord;
    await expect.poll(async () => (await readProject()).document.nodes.find((item) => item.nodeId === tick.nodeId)?.stateValues.tickMs).toBe(250);
    // Matching the stale runtime sample must still save the changed configuration.
    await inspected.fill('100');
    await inspected.press('Enter');
    await expect(inline).toHaveValue('100');
    const highRes = mobile ? null : inspector.getByRole('checkbox', { name: 'High-res Timer (Windows)' });
    if (highRes !== null) {
      await highRes.click();
      await expect(highRes).not.toBeChecked();
    }
    await expect.poll(async () => (await readProject()).document.nodes.find((item) => item.nodeId === tick.nodeId)?.stateValues)
      .toEqual({ tickMs: 100, hiResTimer: false });
    await node.locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Save as Variant…', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Offline Tick.tickMs' })).toBeEnabled();
    await expect(page.getByRole('checkbox', { name: 'Offline Tick.tickMs' })).toBeChecked();
    await page.getByRole('textbox', { name: 'Variant name', exact: true }).fill(assetName);
    await page.getByRole('button', { name: 'Save as Variant', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Save as Variant', exact: true })).toBeHidden();
    await page.reload();
    await node.locator('header').click();
    await expect(inspected).toHaveValue('100');
    if (highRes !== null) await expect(highRes).not.toBeChecked();
    await node.locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add node…', exact: true }).click();
    const assets = await (await page.request.get('/api/assets')).json() as AssetRecord[];
    const asset = assets.find((item) => item.name === assetName);
    if (!asset) throw new Error('Offline Tick Variant was not saved');
    const search = page.getByRole('textbox', { name: 'Quick node search', exact: true });
    await search.fill(asset.name);
    await search.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Quick node search', exact: true })).toBeHidden();
    const nodes = (await readProject()).document.nodes.filter((item) => item.kind === 'operator');
    expect(nodes).toHaveLength(2);
    expect(nodes.every((item) => item.stateValues.tickMs === 100 && item.stateValues.hiResTimer === false)).toBe(true);
  } finally {
    const assets = await (await page.request.get('/api/assets')).json() as AssetRecord[];
    for (const asset of assets.filter((item) => item.name === assetName)) await page.request.delete(`/api/assets/${asset.assetId}`);
    await page.request.delete(`/api/projects/${project.projectId}`);
  }
});
