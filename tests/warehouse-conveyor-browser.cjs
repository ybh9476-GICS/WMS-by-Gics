const { chromium } = require('playwright'), assert = require('node:assert/strict'), path = require('node:path');
const target = process.env.WMS_TEST_URL || require('node:url').pathToFileURL(path.resolve(__dirname, '../index.html')).href;
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, offline: target.startsWith('file:') });
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.url())); page.on('dialog', d => d.accept());
  await context.addInitScript(() => Object.defineProperty(window, 'THREE', { configurable: true, set(api) {
    delete window.THREE; window.THREE = api; const Base = api.WebGLRenderer;
    api.WebGLRenderer = class extends Base { constructor(...args) { super(...args); const render = this.render.bind(this); this.render = (scene, camera) => { window.testScene = scene; return render(scene, camera); }; } };
  } }));
  try {
    await page.goto(target); await page.locator('[data-action=viewer3d]').click(); await page.locator('.warehouse-3d-viewport canvas').waitFor();
    await page.evaluate(async () => {
      const cv = (id, points, width = 1) => ({ id, kind: 'CV', width, points: points.map(([x, y]) => ({ x, y })) });
      const data = window.WmsWarehouseLocalData.convert(window.WMS_REFERENCE_SEED);
      data.workOrders = []; data.operationRoutes = []; data.racks = []; data.equipment = []; data.equipmentStatuses = []; data.inventory = []; data.locations = [];
      data.meta = { ...data.meta, source: 'drawing', floorWidth: 21000, floorDepth: 18000, dockRegions: [], truckSchedules: [], actors: [], warnings: [], passageCells: [], shuttlePassageCells: [], conveyorCells: [], stationCells: [], bufferCells: [], dockCells: [], barcodeTunnelCells: [],
        plan: { name: '컨베이어 연결부 비교', width: 21, height: 18, objects: [
          cv('CV-L', [[2, 2], [7, 2], [7, 7]]), cv('CV-T', [[11, 2], [14, 2], [19, 2]]), cv('CV-T-branch', [[14, 2], [14, 7]]),
          cv('CV-angle', [[2, 11], [7, 11], [10, 15]]), cv('CV-overlap', [[12, 11], [18, 11]]), cv('CV-overlap2', [[14, 11], [19, 11]])
        ] } };
      window.conveyorTestData = data; window.fixedConveyorBuild = WmsWarehouseConveyorLayout.build;
      // Reproduce the former renderer exactly: a full independent module for every edge.
      WmsWarehouseConveyorLayout.build = (objects, segments) => ({ models: objects.flatMap(o => segments(o).flatMap(edge => fixedConveyorBuild([{ ...o, points: [edge.a, edge.b] }], segments).models)) });
      await wmsWarehouse3D.mount(document.querySelector('.warehouse-3d-shell'), { loadData: () => structuredClone(data) });
    });
    await page.locator('[data-warehouse-camera-view=top]').click(); await page.waitForTimeout(350);
    await page.locator('.warehouse-3d-viewport').screenshot({ path: path.resolve(__dirname, '../output/conveyor-before-top.png') });
    await page.evaluate(async () => { WmsWarehouseConveyorLayout.build = fixedConveyorBuild; await wmsWarehouse3D.mount(document.querySelector('.warehouse-3d-shell'), { loadData: () => structuredClone(conveyorTestData) }); });
    await page.locator('[data-warehouse-camera-view=top]').click(); await page.waitForTimeout(350);
    await page.locator('.warehouse-3d-viewport').screenshot({ path: path.resolve(__dirname, '../output/conveyor-after-top.png') });
    await page.locator('[data-warehouse-camera-view=quarter]').click(); await page.waitForTimeout(350);
    await page.locator('.warehouse-3d-viewport').screenshot({ path: path.resolve(__dirname, '../output/conveyor-after-quarter.png') });
    const checkTurn = async reverse => {
      const count = await page.evaluate(reverse => {
        const root = testScene.getObjectByName('CV-L'), values = [];
        root.traverse(mesh => {
          if (mesh.name !== 'CONVEYOR-ROLLER') return;
          for (let i = 0; i < mesh.count; i++) {
            const matrix = new THREE.Matrix4(); mesh.getMatrixAt(i, matrix); const m = matrix.elements;
            if (m[12] > 6.5 && m[12] < 7.5 && m[14] > 1.5 && m[14] < 2.5) values.push(reverse ? Math.abs(m[6]) < 1e-6 : Math.abs(m[4]) < 1e-6);
          }
        });
        if (!values.every(Boolean)) throw Error('Rendered corner contains outgoing rollers');
        return values.length;
      }, reverse);
      assert.ok(count >= 4, 'Rendered turn must be filled');
    };
    await checkTurn(false);
    await page.evaluate(async () => {
      conveyorTestData.meta.plan.objects.find(o => o.id === 'CV-L').flowDirection = 'reverse';
      await wmsWarehouse3D.mount(document.querySelector('.warehouse-3d-shell'), { loadData: () => structuredClone(conveyorTestData) });
    });
    await page.waitForTimeout(350); await checkTurn(true);
    await page.locator('.warehouse-3d-viewport').screenshot({ path: path.resolve(__dirname, '../output/conveyor-reverse-quarter.png') });
    const parts = await page.evaluate(() => {
      const meshes = []; testScene.getObjectByName('DRAWING-EXACT-GEOMETRY').traverse(o => { if (o.isInstancedMesh) meshes.push({ name: o.name, count: o.count, finite: Array.from(o.instanceMatrix.array).every(Number.isFinite) }); }); return meshes;
    });
    assert.ok(parts.length > 0 && parts.every(p => p.finite)); assert.ok(parts.some(p => p.name === 'CONVEYOR-ROLLER'));
    assert.deepEqual(errors, []); assert.ok(requests.every(url => url.startsWith(new URL('.', target).href) || /^(blob:|data:)/.test(url)));
    console.log('PASS conveyor browser: before/after L, T, diagonal and overlapping runs; actual corner roller axes follow forward/reverse flow; finite rendered transforms, local assets, no script errors');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
