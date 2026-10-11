const { chromium } = require(process.env.WMS_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'output');
fs.mkdirSync(out, { recursive: true });
const target = process.env.WMS_TEST_URL || pathToFileURL(path.join(root, 'index.html')).href;
const fileMode = target.startsWith('file:');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, offline: fileMode });
  const page = await context.newPage(), errors = [], requests = [], checks = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => requests.push(request.url()));
  page.on('dialog', dialog => dialog.accept());
  const record = message => { checks.push(message); console.log('PASS', message); };
  const ready = async () => {
    await page.locator('.warehouse-3d-viewport canvas').waitFor();
    await page.waitForFunction(()=>window.WmsSimulationSession?.snapshot());
    assert.equal(await page.locator('.warehouse-3d-error').count(), 0);
  };
  const to3d = async () => { await page.locator('[data-action=viewer3d]').click(); await ready(); };
  const from3d = mode => page.locator('[data-wms-workspace=' + mode + ']').click();
  try {
    await page.goto(target);
    await page.locator('[data-rack-count=bays]').fill('2');
    await page.locator('[data-rack-count=bays]').press('Tab');
    const drawingBefore = await page.evaluate(() => localStorage.getItem('gics-standalone-drawing-v2:local-editor:tabs-v1'));
    await to3d();
    assert.equal(await page.evaluate(() => window.THREE.REVISION), '185');
    assert.equal(await page.locator('[data-warehouse-object-kind=rack]').count(), 6);
    const drawingRacks=JSON.parse(await page.locator('.warehouse-3d-viewport').getAttribute('data-drawing-racks'));
    assert.equal(drawingRacks.find(r=>r.code==='W01').slots.length,16);
    const pauseBounds=await page.locator('#viewer3d').getByRole('button',{name:'재생',exact:true}).boundingBox();
    assert.ok(pauseBounds.y+pauseBounds.height<=1000,'Operation controls stay inside the viewport');
    await page.screenshot({ path: path.join(out, fileMode ? '3d-file.png' : '3d-server.png') });
    record('Active drawing renders with 6 racks and the bundled Three.js library');

    await page.locator('#viewer3d').getByRole('button', { name: '재생', exact: true }).click();
    const operationStatus=await page.evaluate(()=>WmsSimulationSession.snapshot().status);
    if(operationStatus==='running'){
      await page.getByRole('button', { name: '일시정지', exact: true }).click();
      assert.equal(await page.locator('#viewer3d [data-simulation-pause]').getAttribute('aria-pressed'),'true');
      await page.getByRole('button', { name: '재생', exact: true }).click();
      await page.getByRole('button', { name: '일시정지', exact: true }).click();
    }else{assert.equal(operationStatus,'blocked');assert.equal(await page.locator('#viewer3d [data-simulation-stop]').getAttribute('aria-pressed'),'true');}
    const projection = page.locator('[data-warehouse-projection-toggle]');
    await projection.click(); assert.equal(await projection.getAttribute('data-projection'), 'orthographic');
    await projection.click(); assert.equal(await projection.getAttribute('data-projection'), 'perspective');
    await page.locator('[data-warehouse-camera-view=top]').click();
    assert.equal(await page.locator('[data-warehouse-camera-view=top]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-warehouse-camera-view=quarter]').click();
    const canvas = page.locator('.warehouse-3d-viewport canvas');
    const bounds = await canvas.boundingBox();
    const beforeDrag = await canvas.screenshot();
    await page.mouse.move(bounds.x + bounds.width * .6, bounds.y + bounds.height * .6);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .7, bounds.y + bounds.height * .65, { steps: 12 });
    await page.mouse.up();
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(250);
    assert.ok(!beforeDrag.equals(await canvas.screenshot()));
    await page.locator('[data-warehouse-object-kind=rack][data-warehouse-object-code=W01]').click();
    assert.match(await page.locator('.warehouse-3d-inspector').innerText(), /W01/);
    await page.locator('.warehouse-3d-object-search').fill('W02');
    assert.equal(await page.locator('[data-warehouse-object-kind=rack]:visible').count(), 1);
    await page.locator('.warehouse-3d-object-search').fill('');
    record('Simulation pause/resume, camera projection/views, drag/zoom, selection and search respond');

    await page.locator('.warehouse-3d-reload').click(); await ready();
    assert.equal(await page.locator('[data-wms-workspace=drawing]').count(), 1);
    await from3d('reference');
    await page.getByRole('tab', { name: '구역설정', exact: true }).click();
    await page.locator('[data-reference-row="5"][data-reference-column="2"]').dblclick();
    await page.locator('.fp-reference-cell-input').fill('독립 3D 구역');
    // Switching must commit the active reference cell before the renderer reads it.
    await to3d();
    assert.match(await page.locator('[data-warehouse-zone-code=A01]').innerText(), /독립 3D 구역/);
    assert.equal(await page.evaluate(() => localStorage.getItem('gics-standalone-drawing-v2:local-editor:tabs-v1')), drawingBefore);
    await from3d('drawing');
    assert.equal(await page.locator('[data-field=w]').inputValue(), '5.00');
    await page.locator('[data-action=undo]').click();
    assert.equal(await page.locator('[data-field=w]').inputValue(), '2.50');
    assert.equal(await page.locator('.warehouse-3d-shell').count(), 0);
    record('Reload retains navigation; reference edits feed 3D while drawing edits and undo history survive round trips');

    for (let i = 0; i < 2; i++) { await to3d(); await from3d('drawing'); }
    await to3d();
    await page.setViewportSize({ width: 900, height: 800 });
    const controls=await page.locator('#viewer3d .warehouse-operation-controls').boundingBox();
    assert.ok(controls.y+controls.height<=800,'All playback controls remain visible at compact width');
    const modeBounds=await page.locator('#viewer3d [aria-label="모의 운행 방식"]').boundingBox();
    assert.ok(modeBounds.y+modeBounds.height<=800,'Mode selector remains visible at compact width');
    await page.screenshot({ path: path.join(out, fileMode ? '3d-file-compact.png' : '3d-server-compact.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await from3d('drawing');
    assert.equal(await page.locator('.warehouse-3d-shell').count(), 1);
    assert.equal(await page.locator('#viewer3d').isVisible(), false);
    const storageKeys = await page.evaluate(() => Object.keys(localStorage));
    assert.ok(storageKeys.every(key => key.startsWith('gics-standalone-')));
    assert.ok(requests.every(url => url.startsWith(new URL('.', target).href) || url.startsWith('blob:') || url.startsWith('data:')));
    assert.deepEqual(errors, []);
    record('Repeated transitions and compact layout work with no external requests, original storage keys or JavaScript errors');
    fs.writeFileSync(path.join(out, fileMode ? '3d-file-checks.json' : '3d-server-checks.json'), JSON.stringify({ target, offline: fileMode, checks, errors, storageKeys, requests }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(out, '3d-failure.png') });
    console.error('Browser errors', errors);
    console.error((await page.locator('body').innerText()).slice(-1700));
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
