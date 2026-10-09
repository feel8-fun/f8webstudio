import { expect, test } from '@playwright/test';
import type { AssetRecord, GraphNode, ProjectRecord } from '../src/api/contracts';

test('captures, discovers, previews and atomically adds a component with multiple hosts', async ({ page }) => {
  const response = await page.request.post('/api/projects', { data: { name: 'Component Library' } });
  expect(response.ok()).toBe(true);
  const { projectId } = await response.json() as ProjectRecord;
  const name = `Pipeline-${projectId}`;
  const readProject = async () => await (await page.request.get(`/api/projects/${projectId}`)).json() as ProjectRecord;
  try {
    await page.addInitScript((id) => localStorage.setItem('f8studio.selectedProjectId', id), projectId);
    await page.goto('/');
    await page.evaluate(async (projectId) => {
      const create = async (body: Record<string, unknown>): Promise<GraphNode> => {
        const response = await fetch('/api/catalog/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<GraphNode>;
      };
      const firstHost = await create({ kind: 'service', nodeId: 'engine_a', serviceClass: 'f8.pyengine' });
      const secondHost = await create({ kind: 'service', nodeId: 'engine_b', serviceClass: 'f8.pyengine' });
      const first = await create({ kind: 'operator', nodeId: 'script_a', serviceId: firstHost.serviceId, serviceClass: 'f8.pyengine', operatorClass: 'f8.python_script' });
      const second = await create({ kind: 'operator', nodeId: 'script_b', serviceId: secondHost.serviceId, serviceClass: 'f8.pyengine', operatorClass: 'f8.python_script' });
      if (first.kind !== 'operator' || second.kind !== 'operator') throw new Error('Expected operators');
      const customize = (node: typeof first) => ({ ...node.spec,
        dataInPorts: [{ name: 'value', payload: { kind: 'json', valueSchema: { type: 'number' } } }],
        dataOutPorts: [{ name: 'result', payload: { kind: 'json', valueSchema: { type: 'number' } } }],
      });
      const project = await (await fetch(`/api/projects/${projectId}`)).json() as ProjectRecord;
      const patched = await fetch(`/api/projects/${projectId}/patch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        requestId: 'seed_component', expectedGraphRevision: project.document.graphRevision, expectedLayoutRevision: project.document.layoutRevision,
        operations: [
          { op: 'createNode', node: firstHost, layout: { nodeId: 'engine_a', x: 0, y: 0, width: 780, height: 600 } },
          { op: 'createNode', node: secondHost, layout: { nodeId: 'engine_b', x: 1000, y: 0, width: 780, height: 600 } },
          { op: 'createNode', node: first, layout: { nodeId: 'script_a', x: 60, y: 180 } },
          { op: 'createNode', node: second, layout: { nodeId: 'script_b', x: 1060, y: 180 } },
          { op: 'setOperatorSpec', nodeId: 'script_a', spec: customize(first) },
          { op: 'setOperatorSpec', nodeId: 'script_b', spec: customize(second) },
          { op: 'connectEdge', edge: { edgeId: 'pipeline_edge', fromNodeId: 'script_a', fromPortId: 'data:output:result',
            toNodeId: 'script_b', toPortId: 'data:input:value', kind: 'data' } },
        ],
      }) });
      if (!patched.ok) throw new Error(await patched.text());
    }, projectId);
    await page.reload();
    const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(node('script_a')).toBeVisible();
    await node('script_a').locator('header').click();
    await node('script_b').locator('header').click({ modifiers: ['Control'] });
    await node('script_b').locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Save selection as Component…', exact: true }).click();
    await page.getByRole('textbox', { name: 'Component name', exact: true }).fill(name);
    await page.getByRole('textbox', { name: 'Component description', exact: true }).fill('# Reusable pipeline\n\n**Two** processing stages.');
    await page.getByRole('textbox', { name: 'Component tags', exact: true }).fill('pipeline, reusable');
    await page.getByRole('button', { name: 'Save selection as component', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Save selection as component', exact: true })).toBeHidden();
    const assets = await (await page.request.get('/api/assets?kind=component')).json() as AssetRecord[];
    const asset = assets.find((item) => item.name === name);
    if (!asset) throw new Error('Component not saved');
    const before = await readProject();
    await page.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } });
    await page.getByRole('textbox', { name: 'Search nodes', exact: true }).fill(name);
    await page.locator('.catalog-list').getByRole('button', { name: `Details for ${name}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Quick node search', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Reusable pipeline' })).toBeVisible();
    await expect(dialog.getByLabel('Graph preview', { exact: true })).toBeVisible();
    await expect(dialog.getByText('2 node(s) · 1 internal connection(s)')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Add node', exact: true })).toBeDisabled();
    await dialog.getByRole('combobox', { name: 'Host for engine_a', exact: true }).selectOption('engine_a');
    await dialog.getByRole('combobox', { name: 'Host for engine_b', exact: true }).selectOption('engine_b');
    await page.screenshot({ path: '/tmp/f8-library-desktop.png' });
    await dialog.getByRole('button', { name: 'Add node', exact: true }).click();
    await expect(dialog).toBeHidden();
    const inserted = await readProject();
    expect(inserted.document.nodes).toHaveLength(before.document.nodes.length + 2);
    expect(inserted.document.edges).toHaveLength(before.document.edges.length + 1);
    for (const host of ['engine_a', 'engine_b']) {
      expect(inserted.document.nodes.filter((item) => item.kind === 'operator' && item.serviceId === host)).toHaveLength(2);
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await readProject()).document.nodes.length).toBe(before.document.nodes.length);
    expect((await readProject()).document.edges).toEqual(before.document.edges);
    await page.reload();
    await page.locator('.graph-toolbar').getByRole('button', { name: 'Quick node search', exact: true }).click();
    await page.getByRole('textbox', { name: 'Quick node search', exact: true }).fill('reusable pipeline');
    await page.getByRole('button', { name: 'Components', exact: true }).click();
    await expect(page.getByRole('option', { name: new RegExp(name) })).toBeVisible();
    await page.getByRole('textbox', { name: 'Quick node search', exact: true }).press('Enter');
    await expect(page.getByRole('combobox', { name: 'Host for engine_a', exact: true })).toBeVisible();
    expect((await readProject()).document.nodes).toHaveLength(before.document.nodes.length);
  } finally {
    const assets = await (await page.request.get('/api/assets?kind=component')).json() as AssetRecord[];
    for (const asset of assets.filter((item) => item.name === name)) await page.request.delete(`/api/assets/${asset.assetId}`);
    await page.request.delete(`/api/projects/${projectId}`);
  }
});
