const {chromium}=require('playwright'),assert=require('node:assert/strict');
const fixture=require('./fixtures/drawing-connected.cjs');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1200,height:900}});
 try{
  await context.addInitScript(({book,plan})=>{
   localStorage.setItem('gics-standalone-reference-data-v1',JSON.stringify({schemaVersion:1,revision:'stop',name:'검증',book}));
   localStorage.setItem('gics-standalone-drawing-v2:local-editor:tabs-v1',JSON.stringify({version:2,activeId:'tab1',nextDocumentId:2,nextDrawingNumber:0,documents:[{id:'tab1',plan,savedPlan:plan}]}));
  },fixture());
  const page=await context.newPage();await page.goto(process.env.WMS_TEST_URL||'http://127.0.0.1:4174/');
  await page.locator('[data-action=viewer3d]').click();await page.waitForFunction(()=>WmsSimulationSession.snapshot());
  const state=()=>page.evaluate(()=>WmsSimulationSession.snapshot()),buttons=page.locator('#viewer3d .wms-simulation-button');
  assert.equal(await buttons.count(),3);const initial=(await state()).actors.map(a=>a.position);
  await page.locator('#viewer3d [data-simulation-play]').click();await page.waitForFunction(()=>WmsSimulationSession.snapshot().elapsed>.3);
  assert.equal(await page.locator('#viewer3d [data-simulation-play]').getAttribute('aria-pressed'),'true');
  await page.locator('#viewer3d [data-simulation-stop]').click();const stopped=await state();
  assert.equal(stopped.status,'stopped');assert.equal(stopped.elapsed,0);assert.deepEqual(stopped.actors.map(a=>a.position),initial);
  await page.waitForTimeout(250);assert.deepEqual(await state(),stopped);
  assert.equal(await page.locator('#viewer3d [data-simulation-stop]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-wms-workspace=drawing]').click();assert.equal(await page.locator('#editor [data-simulation-stop]').getAttribute('aria-pressed'),'true');
  await page.locator('#editor [data-simulation-play]').click();await page.waitForFunction(()=>WmsSimulationSession.snapshot().elapsed>.1);
  assert.equal((await state()).status,'running');console.log('PASS 3D Stop resets positions/time, remains stopped, synchronizes 2D and starts again');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
