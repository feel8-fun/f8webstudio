import { expect, test } from '@playwright/test';
import type { GraphNode, ProjectRecord } from '../src/api/contracts';

test('resizes visualizations, renders Note Markdown and moves a Backdrop group atomically', async ({ page }, testInfo) => {
  const created = await page.request.post('/api/projects', { data: { name: 'Canvas layout' } });
  expect(created.ok()).toBe(true);
  const { projectId } = await created.json() as ProjectRecord;
  await page.addInitScript((id) => localStorage.setItem('f8studio.selectedProjectId', id), projectId);
  await page.goto('/');
  await expect(page.locator('.connection-online')).toBeVisible();
  await expect(page.locator('#project-select')).toHaveValue(projectId);
  const ids = await page.evaluate(async (projectId) => {
    async function node(payload: Record<string, unknown>): Promise<GraphNode> {
      const response = await fetch('/api/catalog/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(await response.text());
      return response.json() as Promise<GraphNode>;
    }
    const studio = await node({ kind: 'service', nodeId: 'studio', serviceClass: 'f8.pystudio' });
    const engine = await node({ kind: 'service', nodeId: 'layout_engine', serviceClass: 'f8.pyengine' });
    const tick = await node({ kind: 'operator', nodeId: 'layout_tick', serviceId: engine.serviceId, serviceClass: engine.serviceClass, operatorClass: 'f8.tick' });
    const viz = await node({ kind: 'operator', nodeId: 'layout_viz', serviceId: 'studio', serviceClass: 'f8.pystudio', operatorClass: 'f8.viz.text' });
    const noteDefinition = await node({ kind: 'operator', nodeId: 'layout_note', serviceId: 'studio', serviceClass: 'f8.pystudio', operatorClass: 'f8.note' });
    const note: GraphNode = { ...noteDefinition, stateValues: { content: '# Group instructions\n\n- **Read me** before deployment.\n\n| Input | Use |\n| --- | --- |\n| Tick | Clock |' } };
    const backdrop = await node({ kind: 'operator', nodeId: 'layout_backdrop', serviceId: 'studio', serviceClass: 'f8.pystudio', operatorClass: 'f8.backdrop' });
    const partial = await node({ kind: 'operator', nodeId: 'layout_partial', serviceId: 'studio', serviceClass: 'f8.pystudio', operatorClass: 'f8.note' });
    const positions = [
      { x: -300, y: -100 }, { x: 80, y: 100, width: 524, height: 300 }, { x: 140, y: 220 },
      { x: 650, y: 140, width: 340, height: 260 }, { x: 650, y: 440, width: 320, height: 260 },
      { x: 20, y: 20, width: 1100, height: 780 }, { x: 1040, y: 690, width: 320, height: 240 },
    ];
    const project = await (await fetch(`/api/projects/${projectId}`)).json() as ProjectRecord;
    const response = await fetch(`/api/projects/${projectId}/patch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      requestId: 'seed_layout', expectedGraphRevision: project.document.graphRevision, expectedLayoutRevision: project.document.layoutRevision,
      operations: [studio, engine, tick, viz, note, backdrop, partial].map((node, index) => ({ op: 'createNode', node, layout: { nodeId: node.nodeId, ...positions[index] } })),
    }) });
    if (!response.ok) throw new Error(await response.text());
    return { backdrop: backdrop.nodeId, engine: engine.nodeId, tick: tick.nodeId, viz: viz.nodeId, note: note.nodeId, partial: partial.nodeId };
  }, projectId);
  // Seeded nodes may be outside the empty project's initial viewport.
  await page.reload();
  await expect(page.locator('#project-select')).toHaveValue(projectId);
  const flowNode = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(flowNode(ids.note).getByRole('heading', { name: 'Group instructions' })).toBeVisible();
  await expect(flowNode(ids.note).locator('table')).toBeVisible();
  await page.locator('.react-flow__controls-fitview').click();
  const read = async () => page.evaluate(async (id) => (await (await fetch(`/api/projects/${id}`)).json()) as ProjectRecord, projectId);
  const before = await read();
  const beforeTick = await flowNode(ids.tick).boundingBox();
  const header = await flowNode(ids.backdrop).locator('header').boundingBox();
  if (header === null || beforeTick === null) throw new Error('Missing group geometry');
  const start = { x: header.x + 30, y: header.y + header.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 55, start.y + 40, { steps: 12 });
  await expect.poll(async () => (await flowNode(ids.tick).boundingBox())!.x).toBeGreaterThan(beforeTick.x + 40);
  // Children move during the gesture, before any persisted layout revision.
  expect((await read()).document.layoutRevision).toBe(before.document.layoutRevision);
  await page.mouse.up();
  await expect.poll(async () => (await read()).document.layoutRevision).toBe(before.document.layoutRevision + 1);
  const moved = await read();
  const originalLayout = new Map(before.document.layout.map((item) => [item.nodeId, item]));
  const movedLayout = new Map(moved.document.layout.map((item) => [item.nodeId, item]));
  const delta = { x: movedLayout.get(ids.backdrop)!.x - originalLayout.get(ids.backdrop)!.x,
    y: movedLayout.get(ids.backdrop)!.y - originalLayout.get(ids.backdrop)!.y };
  for (const id of [ids.engine, ids.tick, ids.viz, ids.note]) {
    expect(movedLayout.get(id)!.x - originalLayout.get(id)!.x).toBeCloseTo(delta.x);
    expect(movedLayout.get(id)!.y - originalLayout.get(id)!.y).toBeCloseTo(delta.y);
  }
  expect(movedLayout.get(ids.partial)).toEqual(originalLayout.get(ids.partial));
  expect(moved.document.graphRevision).toBe(before.document.graphRevision);
  await flowNode(ids.viz).locator('header').click();
  const handle = flowNode(ids.viz).locator('.service-resize-handle.bottom.right');
  await expect(handle).toBeVisible();
  const handleBox = await handle.boundingBox();
  const previewBefore = await flowNode(ids.viz).locator('.studio-node-inline-text').boundingBox();
  if (handleBox === null || previewBefore === null) throw new Error('Missing resize geometry');
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 50, handleBox.y + handleBox.height / 2 + 45, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await read()).document.layoutRevision).toBe(moved.document.layoutRevision + 1);
  const previewAfter = await flowNode(ids.viz).locator('.studio-node-inline-text').boundingBox();
  expect(previewAfter!.height).toBeGreaterThan(previewBefore.height + 25);
  expect(previewAfter!.width).toBeGreaterThan(previewBefore.width + 30);
  const resized = await read();
  expect(resized.document.graphRevision).toBe(before.document.graphRevision);
  await page.reload();
  await expect(page.locator('#project-select')).toHaveValue(projectId);
  await expect(flowNode(ids.note).getByRole('heading', { name: 'Group instructions' })).toBeVisible();
  expect((await read()).document.layout).toEqual(resized.document.layout);
  await page.screenshot({ path: testInfo.outputPath('canvas-layout.png'), fullPage: true });
  await page.request.delete(`/api/projects/${projectId}`);
});
