import { expect, type Locator, type Page } from '@playwright/test';

export async function exposeResizeHandle(page: Page, handle: Locator, delta: { readonly x: number; readonly y: number }): Promise<void> {
  const viewport = page.locator('.react-flow__viewport');
  const zoomOut = page.locator('.react-flow__controls-zoomout');
  const geometry = () => handle.evaluate((element, delta) => {
    const bounds = element.getBoundingClientRect();
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    const hit = document.elementFromPoint(x, y);
    const canvas = element.closest('.react-flow')?.getBoundingClientRect();
    if (canvas === undefined) throw new Error('Resize handle is outside the graph canvas');
    const left = Math.max(0, canvas.left);
    const top = Math.max(0, canvas.top);
    const right = Math.min(window.innerWidth, canvas.right);
    const bottom = Math.min(window.innerHeight, canvas.bottom);
    return { x, y, left, top, right, bottom,
      reachable: (hit === element || (hit !== null && element.contains(hit))) &&
        x + delta.x < right - 8 && y + delta.y < bottom - 8 };
  }, delta);
  for (let attempt = 0; attempt < 8; attempt++) {
    if ((await geometry()).reachable) return;
    if (!await zoomOut.isEnabled()) break;
    const before = await viewport.getAttribute('style');
    await zoomOut.click();
    await expect(viewport).not.toHaveAttribute('style', before ?? '');
  }
  // At minimum zoom, pan with the middle button so the node itself does not move.
  const header = handle.locator('..').locator('header').first();
  await header.hover();
  const anchor = await header.boundingBox();
  if (anchor === null) throw new Error('Node header is not visible for panning');
  const current = await geometry();
  const offset = {
    x: (current.left + current.right - delta.x) / 2 - current.x,
    y: (current.top + current.bottom - delta.y) / 2 - current.y,
  };
  const before = await viewport.getAttribute('style');
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(anchor.x + anchor.width / 2 + offset.x, anchor.y + anchor.height / 2 + offset.y, { steps: 12 });
  await page.mouse.up({ button: 'middle' });
  await expect(viewport).not.toHaveAttribute('style', before ?? '');
  await expect.poll(async () => (await geometry()).reachable).toBe(true);
}

export async function resizeWithHandle(page: Page, handle: Locator, delta: { readonly x: number; readonly y: number }): Promise<void> {
  // Hover waits for a stable, unobstructed handle before starting the gesture.
  await handle.hover();
  const bounds = await handle.boundingBox();
  if (bounds === null) throw new Error('Resize handle is not visible');
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + delta.x, bounds.y + bounds.height / 2 + delta.y, { steps: 12 });
  await page.mouse.up();
}
