import { expect, test } from '@playwright/test';
import {
  buildOrthogonalRoute,
  computeCanvasExtent,
  createFlowSnapshot,
  flowSnapshotsEqual,
  type FlowNode,
} from '../src/lib/bot-flow';

const node = (id: string, x: number, y: number, type = 'action_message'): FlowNode => ({
  id,
  type,
  label: id,
  config: {},
  x,
  y,
});

test('saved snapshots detect name, configuration, position, node, and edge changes structurally', () => {
  const baseline = createFlowSnapshot(7, 'Welcome flow', [node('source', 40, 80)], []);
  expect(flowSnapshotsEqual(baseline, createFlowSnapshot(7, 'Welcome flow', [node('source', 40, 80)], []))).toBe(true);
  expect(flowSnapshotsEqual(baseline, createFlowSnapshot(7, 'Renamed', [node('source', 40, 80)], []))).toBe(false);
  expect(flowSnapshotsEqual(baseline, createFlowSnapshot(7, 'Welcome flow', [{ ...node('source', 40, 80), config: { message: 'Hi' } }], []))).toBe(false);
  expect(flowSnapshotsEqual(baseline, createFlowSnapshot(7, 'Welcome flow', [node('source', 41, 80)], []))).toBe(false);
  expect(flowSnapshotsEqual(baseline, createFlowSnapshot(7, 'Welcome flow', [node('source', 40, 80), node('added', 300, 80)], []))).toBe(false);
  expect(flowSnapshotsEqual(baseline, createFlowSnapshot(7, 'Welcome flow', [node('source', 40, 80)], [{ id: 'edge', source: 'source', sourcePort: 'out', target: 'target', targetPort: 'in' }]))).toBe(false);
});

test('flow snapshots are immutable copies of the editor state', () => {
  const nodes = [node('source', 40, 80)];
  const snapshot = createFlowSnapshot(7, 'Welcome flow', nodes, []);
  nodes[0].config.message = 'later edit';
  expect(snapshot.nodes[0].config).toEqual({});
});

test('ordinary and vertically offset forward routes are deterministic rounded orthogonal paths', () => {
  const straight = buildOrthogonalRoute({ x: 180, y: 32 }, { x: 400, y: 32 }, []);
  expect(straight.points).toEqual([{ x: 180, y: 32 }, { x: 400, y: 32 }]);
  expect(straight.path).toBe('M 180 32 L 400 32');

  const offset = buildOrthogonalRoute({ x: 180, y: 32 }, { x: 400, y: 232 }, []);
  expect(offset.points).toEqual([
    { x: 180, y: 32 },
    { x: 290, y: 32 },
    { x: 290, y: 232 },
    { x: 400, y: 232 },
  ]);
  expect(offset.path).toBe('M 180 32 L 278 32 Q 290 32 290 44 L 290 220 Q 290 232 302 232 L 400 232');
  expect(offset.path).not.toContain('C');
});

test('close and backward routes leave source right and enter target left without crossing node rectangles', () => {
  const sourceRect = { x: 0, y: 0, width: 180, height: 64 };
  const closeTarget = { x: 220, y: 100, width: 180, height: 64 };
  const close = buildOrthogonalRoute({ x: 180, y: 32 }, { x: 220, y: 132 }, [sourceRect, closeTarget]);
  expect(close.points).toEqual([
    { x: 180, y: 32 }, { x: 212, y: 32 }, { x: 212, y: 196 },
    { x: 188, y: 196 }, { x: 188, y: 132 }, { x: 220, y: 132 },
  ]);

  const backwardTarget = { x: 40, y: 100, width: 180, height: 64 };
  const backward = buildOrthogonalRoute({ x: 380, y: 32 }, { x: 40, y: 132 }, [
    { x: 200, y: 0, width: 180, height: 64 }, backwardTarget,
  ]);
  expect(backward.points).toEqual([
    { x: 380, y: 32 }, { x: 412, y: 32 }, { x: 412, y: 196 },
    { x: 8, y: 196 }, { x: 8, y: 132 }, { x: 40, y: 132 },
  ]);
});

test('a forward route takes a deterministic basic detour around an obstacle', () => {
  const obstacle = { x: 260, y: 60, width: 80, height: 100 };
  const route = buildOrthogonalRoute({ x: 180, y: 100 }, { x: 420, y: 100 }, [obstacle]);
  expect(route.points).toEqual([
    { x: 180, y: 100 }, { x: 212, y: 100 }, { x: 212, y: 192 },
    { x: 388, y: 192 }, { x: 388, y: 100 }, { x: 420, y: 100 },
  ]);
});

test('canvas extent follows real node and route bounds instead of a fixed 2000 by 1200 canvas', () => {
  const extent = computeCanvasExtent({
    nodes: [node('far', 2200, 1300)],
    routeBounds: [{ minX: 100, minY: 100, maxX: 2420, maxY: 1420 }],
    viewportWidth: 900,
    viewportHeight: 600,
  });
  expect(extent).toEqual({ width: 2548, height: 1548 });
  expect(computeCanvasExtent({ nodes: [], routeBounds: [], viewportWidth: 900, viewportHeight: 600 })).toEqual({ width: 900, height: 600 });
});

async function signInAsAdmin(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

test('large legacy flows render past x=2000/y=1200 with aligned scroll extent and orthogonal hit paths', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/bots/1');
  const canvas = page.locator('.flow-canvas');
  await expect(canvas.locator('.flow-node[data-node-id="far"]')).toBeVisible();
  expect(await canvas.evaluate((element) => ({ scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight }))).toEqual({ scrollWidth: expect.any(Number), scrollHeight: expect.any(Number) });
  expect(await canvas.evaluate((element) => element.scrollWidth > 2380 && element.scrollHeight > 1460)).toBe(true);
  const svg = canvas.locator('svg').first();
  expect(Number(await svg.getAttribute('width'))).toBeGreaterThan(2380);
  expect(Number(await svg.getAttribute('height'))).toBeGreaterThan(1460);
  const paths = await canvas.locator('svg g path').evaluateAll((items) => items.map((item) => item.getAttribute('d')));
  expect(paths.length).toBeGreaterThanOrEqual(4);
  expect(paths.every((path) => path && !path.includes('C'))).toBe(true);
  await expect(canvas.locator('svg g[aria-label="True connection"] text')).toHaveText('True');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('dirty Bot Flow navigation offers Stay and Discard & continue', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/bots/1');
  const name = page.getByLabel('Bot flow name');
  await name.fill('Unsaved draft');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Back to bot flows' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL('/bots/1');
  await expect(name).toHaveValue('Unsaved draft');
  await page.getByRole('link', { name: 'Bot Flows', exact: true }).click();
  await page.getByRole('button', { name: 'Discard & continue' }).click();
  await expect(page).toHaveURL('/bots');
});

test('dirty editor protects unload and query refetch while a clean editor adopts server refresh', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/bots/1');
  const name = page.getByLabel('Bot flow name');
  await name.fill('Local draft');
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);

  await request.post('/__test/bots?scenario=server-update');
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(150);
  await expect(name).toHaveValue('Local draft');

  await page.getByRole('button', { name: 'Back to bot flows' }).click();
  await page.getByRole('button', { name: 'Discard & continue' }).click();
  await page.goto('/bots/1');
  await expect(name).toHaveValue('Server refreshed');
});

test('save uses one immutable snapshot and retains edits made during a slow request', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await request.post('/__test/bots?scenario=slow-save');
  await page.goto('/bots/1');
  const name = page.getByLabel('Bot flow name');
  await name.fill('First snapshot');
  await page.getByRole('button', { name: 'Save' }).dblclick();
  await name.fill('Edited while saving');
  await expect(page.getByText('Flow saved')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  const state = await request.get('/__test/bots').then((response) => response.json());
  expect(state.botUpdateRequests).toHaveLength(1);
  expect(state.botUpdateRequests[0].name).toBe('First snapshot');
  expect(await name.inputValue()).toBe('Edited while saving');
});

test('failed save remains dirty and reports an actionable error', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await request.post('/__test/bots?scenario=failed-save');
  await page.goto('/bots/1');
  await page.getByLabel('Bot flow name').fill('Failed draft');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Failed to save flow; your edits are still here')).toBeVisible();
  await expect(page.getByText('Unsaved changes')).toBeVisible();
});

test('successful save advances the baseline for exactly the unchanged legacy flow schema', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/bots/1');
  await page.getByLabel('Bot flow name').fill('Saved name');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Flow saved')).toBeVisible();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  const state = await request.get('/__test/bots').then((response) => response.json());
  expect(state.botUpdateRequests).toHaveLength(1);
  expect(state.botUpdateRequests[0].flowData).toEqual({
    nodes: [
      { id: 'trigger', type: 'trigger_event', label: 'Trigger', config: {}, x: 80, y: 80 },
      { id: 'condition', type: 'condition', label: 'Condition', config: {}, x: 380, y: 180 },
      { id: 'far', type: 'action_message', label: 'Far action', config: { message: 'legacy' }, x: 2200, y: 1300 },
    ],
    edges: [
      { id: 'edge-trigger-condition', source: 'trigger', sourcePort: 'out', target: 'condition', targetPort: 'in' },
      { id: 'edge-condition-far', source: 'condition', sourcePort: 'true', target: 'far', targetPort: 'in' },
    ],
  });
});

test('property edits, touch connections, and scrolled dragging remain draft-safe', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/bots/1');
  const canvas = page.locator('.flow-canvas');
  await canvas.locator('.flow-node[data-node-id="condition"]').click();
  await page.getByPlaceholder('event.client_type == 0').fill('event.client_type == 1');
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await canvas.locator('.flow-node[data-node-id="trigger"] [aria-label="Start connection from Trigger output out"]').dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 260, clientY: 110 });
  await canvas.locator('.flow-node[data-node-id="far"] [aria-label="Connect to Far action input in"]').dispatchEvent('click', { pointerType: 'touch' });
  await expect(canvas.locator('svg g')).toHaveCount(3);
  await canvas.locator('svg g[aria-label="True connection"]').dispatchEvent('click');
  await expect(canvas.locator('svg g')).toHaveCount(2);
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await canvas.evaluate((element) => { element.scrollLeft = 2100; element.scrollTop = 1100; });
  const far = canvas.locator('.flow-node[data-node-id="far"]');
  const before = await far.evaluate((element) => ({ left: parseFloat((element as HTMLElement).style.left), top: parseFloat((element as HTMLElement).style.top) }));
  const box = await far.boundingBox();
  if (!box) throw new Error('far node was not laid out after scrolling');
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 50);
  await page.mouse.up();
  const after = await far.evaluate((element) => ({ left: parseFloat((element as HTMLElement).style.left), top: parseFloat((element as HTMLElement).style.top) }));
  // Browser layout and synthesized pointer events can differ by a subpixel
  // across runners. Keep this strict enough to catch scroll-coordinate drift
  // while accepting normal CSS pixel rounding.
  expect(after.left).toBeCloseTo(before.left + 40, 0);
  expect(after.top).toBeCloseTo(before.top + 30, 0);
});

test('adding and removing nodes are visible dirty edits without changing the saved JSON contract', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/bots/1');
  await page.getByRole('button', { name: 'Send Message' }).click();
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await page.locator('.flow-node[data-node-id="far"]').click();
  await page.getByRole('button', { name: 'Delete Far action' }).click();
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  const state = await request.get('/__test/bots').then((response) => response.json());
  expect(state.botUpdateRequests).toHaveLength(0);
});
