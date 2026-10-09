import { expect, test } from '@playwright/test';
import type { AssetRecord, GraphNode, ProjectRecord } from '../src/api/contracts';

test('uses the right-clicked node to save, add, update and fork customized Variants', async ({ page }) => {
  const response = await page.request.post('/api/projects', { data: { name: 'Variant authoring' } });
  expect(response.ok()).toBe(true);
  const { projectId } = await response.json() as ProjectRecord;
  const names = [`Smooth-${projectId}`, `Fork-${projectId}`, `Engine-${projectId}`];
  try {
    await page.addInitScript((id) => localStorage.setItem('f8studio.selectedProjectId', id), projectId);
    await page.goto('/');
    await expect(page.locator('#project-select')).toHaveValue(projectId);
    await page.evaluate(async (projectId) => {
      const create = async (body: Record<string, unknown>): Promise<GraphNode> => {
        const response = await fetch('/api/catalog/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<GraphNode>;
      };
      const engine = await create({ kind: 'service', nodeId: 'variant_engine', serviceClass: 'f8.pyengine' });
      const script = await create({ kind: 'operator', nodeId: 'variant_script', serviceId: engine.serviceId, serviceClass: 'f8.pyengine', operatorClass: 'f8.python_script' });
      if (script.kind !== 'operator') throw new Error('Expected script operator');
      const spec = { ...script.spec,
        stateFields: [...(script.spec.stateFields ?? []), { name: 'alpha', access: 'rw', persistent: true, publishable: true, showOnNode: false, valueSchema: { type: 'number', default: 0.5 } }],
        dataInPorts: [{ name: 'value', payload: { kind: 'json', valueSchema: { type: 'number' } } }],
        dataOutPorts: [{ name: 'smoothed', payload: { kind: 'json', valueSchema: { type: 'number' } } }],
      };
      const project = await (await fetch(`/api/projects/${projectId}`)).json() as ProjectRecord;
      const response = await fetch(`/api/projects/${projectId}/patch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        requestId: 'seed_variant', expectedGraphRevision: project.document.graphRevision, expectedLayoutRevision: project.document.layoutRevision,
        operations: [{ op: 'createNode', node: engine, layout: { nodeId: engine.nodeId, x: 0, y: 0, width: 780, height: 600 } },
          { op: 'createNode', node: script, layout: { nodeId: script.nodeId, x: 50, y: 160 } },
          { op: 'setOperatorSpec', nodeId: script.nodeId, spec },
          { op: 'setNodeState', nodeId: script.nodeId, field: 'code', value: 'def onMsg(ctx, inputs):\n    ctx.emit("smoothed", inputs.value * ctx.states.alpha)\n' },
          { op: 'setNodeState', nodeId: script.nodeId, field: 'alpha', value: 0.25 }],
      }) });
      if (!response.ok) throw new Error(await response.text());
    }, projectId);
    await page.reload();
    const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(node('variant_script')).toBeVisible();
    const readProject = async () => (await (await page.request.get(`/api/projects/${projectId}`)).json()) as ProjectRecord;
    const readAssets = async () => (await (await page.request.get('/api/assets')).json()) as AssetRecord[];
    const before = await readProject();
    // A different node stays selected; the menu must target the node under the pointer.
    await node('variant_engine').locator('header').click();
    await node('variant_script').locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Save as Variant…', exact: true }).click();
    await page.getByRole('textbox', { name: 'Variant name', exact: true }).fill(names[0]!);
    await page.getByRole('button', { name: 'Save as Variant', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Save as Variant', exact: true })).toBeHidden();
    const summary = (await readAssets()).find((asset) => asset.name === names[0]);
    if (!summary) throw new Error('Variant not saved');
    const variantId = summary.assetId;
    expect((await readProject()).document).toEqual(before.document);
    await page.getByRole('textbox', { name: 'Search nodes', exact: true }).fill(names[0]!);
    const libraryVariant = page.locator('.catalog-variants').getByRole('button', { name: new RegExp(names[0]!) }).filter({ hasNotText: 'Versions' });
    await libraryVariant.click();
    await expect(page.getByRole('dialog', { name: 'Quick node search', exact: true })).toBeHidden();
    const inserted = await readProject();
    const copy = inserted.document.nodes.find((item) => item.nodeId !== 'variant_script' && item.kind === 'operator');
    if (!copy) throw new Error('Missing Variant instance');
    expect(copy.stateValues.alpha).toBe(0.25);
    expect(copy.spec).toEqual(before.document.nodes.find((item) => item.nodeId === 'variant_script')!.spec);
    // Modify the original node; saving a template version must leave the instance alone.
    const change = await page.request.post(`/api/projects/${projectId}/patch`, { data: {
      requestId: 'change_variant', expectedGraphRevision: inserted.document.graphRevision, expectedLayoutRevision: inserted.document.layoutRevision,
      operations: [{ op: 'setNodeState', nodeId: 'variant_script', field: 'alpha', value: 0.8 }],
    } });
    expect(change.ok()).toBe(true);
    await node('variant_script').locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Update Variant…' }).click();
    await expect(page.getByRole('combobox', { name: 'Variant to update' })).toHaveValue(variantId);
    await expect(page.getByRole('button', { name: 'Update Variant', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Update Variant', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Update Variant', exact: true })).toBeHidden();
    const updated = await (await page.request.get(`/api/assets/${variantId}`)).json() as AssetRecord;
    expect(updated.currentVersion).toBe(2);
    expect((await readProject()).document.nodes.find((item) => item.nodeId === copy.nodeId)!.stateValues.alpha).toBe(0.25);
    await node('variant_script').locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Save as new Variant…', exact: true }).click();
    await page.getByRole('textbox', { name: 'Variant name', exact: true }).fill(names[1]!);
    await page.getByRole('button', { name: 'Save as Variant', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Save as Variant', exact: true })).toBeHidden();
    await node('variant_engine').locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Save as Variant…', exact: true }).click();
    await page.getByRole('textbox', { name: 'Variant name', exact: true }).fill(names[2]!);
    await page.getByRole('button', { name: 'Save as Variant', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Save as Variant', exact: true })).toBeHidden();
    const saved = await readAssets();
    expect(saved.filter((asset) => names.includes(asset.name)).map((asset) => asset.currentVersion).sort()).toEqual([1, 1, 2]);
    await page.reload();
    await expect(node('variant_script')).toBeVisible();
    await node('variant_script').locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Update Variant…' }).click();
    const fork = saved.find((asset) => asset.name === names[1])!;
    await expect(page.getByRole('combobox', { name: 'Variant to update' })).toHaveValue(fork.assetId);
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.locator('.graph-toolbar').getByRole('button', { name: 'Save selection as component' })).toHaveCount(0);
    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 20, y: 20 } });
    await page.getByRole('menuitem', { name: 'Add node…', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Quick node search', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Quick node search', exact: true }).fill(names[0]!);
    await page.getByRole('button', { name: `Choose version for ${names[0]}` }).click();
    await expect(page.getByRole('combobox', { name: 'Variant version' }).locator('option[value="1"]')).toHaveCount(1);
    await page.getByRole('combobox', { name: 'Variant version' }).selectOption('1');
    await expect(page.getByRole('button', { name: 'Add node', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Add node', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Quick node search', exact: true })).toBeHidden();
    const final = await readProject();
    const operators = final.document.nodes.filter((item) => item.kind === 'operator');
    expect(operators).toHaveLength(3);
    expect(operators.filter((item) => item.stateValues.alpha === 0.25)).toHaveLength(2);
  } finally {
    for (const asset of (await (await page.request.get('/api/assets')).json()) as AssetRecord[]) {
      if (names.includes(asset.name)) await page.request.delete(`/api/assets/${asset.assetId}`);
    }
    await page.request.delete(`/api/projects/${projectId}`);
  }
});
