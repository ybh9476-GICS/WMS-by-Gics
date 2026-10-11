const {chromium}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path'),fixture=require('./fixtures/drawing-connected.cjs');
const target=process.env.WMS_TEST_URL||require('node:url').pathToFileURL(path.resolve(__dirname,'../index.html')).href;
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1600,height:1000},offline:target.startsWith('file:')});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await context.addInitScript(({book,plan})=>{
  localStorage.setItem('gics-standalone-reference-data-v1',JSON.stringify({schemaVersion:1,revision:'fixture',name:'검증 기준정보',book}));
  localStorage.setItem('gics-standalone-drawing-v2:local-editor:tabs-v1',JSON.stringify({version:2,activeId:'tab1',nextDocumentId:3,nextDrawingNumber:0,documents:[{id:'tab1',plan,savedPlan:plan},{id:'tab2',plan:{...plan,name:'빈 도면',objects:[]},savedPlan:null}]}));
  window.renderCount=0;Object.defineProperty(window,'THREE',{configurable:true,set(api){delete window.THREE;window.THREE=api;const Base=api.WebGLRenderer;api.WebGLRenderer=class extends Base{constructor(...args){super(...args);const render=this.render.bind(this);this.render=(...args)=>{window.renderCount++;return render(...args);};}};}});
 },fixture());
 const state=()=>page.evaluate(()=>WmsSimulationSession.snapshot()),play=page.locator('#editor [data-simulation-play]'),pause=page.locator('#editor [data-simulation-pause]');
 try{
  await page.goto(target);const saved=await page.evaluate(()=>({...localStorage}));
  assert.equal(await play.getAttribute('aria-label'),'재생');await play.click();
  await page.waitForFunction(()=>WmsSimulationSession.snapshot()?.elapsed>.3);
  assert.equal(await page.locator('#viewer3d').isVisible(),false);const a=await state();assert.equal(a.mode,'routes');assert.equal(a.paused,false);
  const drawCount=await page.evaluate(()=>renderCount);await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>renderCount),drawCount);
  const b=await state();assert.ok(b.elapsed>a.elapsed);assert.notDeepEqual(b.actors.find(a=>a.id==='FA01').position,a.actors.find(a=>a.id==='FA01').position);
  await pause.click();const paused=await state();await page.waitForTimeout(250);assert.deepEqual(await state(),paused);
  await page.locator('[data-action=viewer3d]').click();await page.locator('#viewer3d canvas').waitFor();assert.deepEqual(await state(),paused);
  await page.locator('#viewer3d').getByRole('button',{name:'재생',exact:true}).click();await page.waitForTimeout(250);
  await page.locator('[data-wms-workspace=drawing]').click();assert.ok((await state()).elapsed>paused.elapsed);assert.equal(await play.getAttribute('aria-pressed'),'true');
  const t=(await state()).elapsed;await page.waitForTimeout(250);assert.ok((await state()).elapsed>t);
  await pause.click();const current=await state();
  const overlay=JSON.parse(await page.locator('.fp-editor').getAttribute('data-simulation-actors'));assert.deepEqual(overlay,current.actors);
  assert.equal(await page.locator('[data-simulation-equipment]').count(),3);
  await page.screenshot({path:path.resolve(__dirname,'../output/simulation-sync-2d.png')});
  assert.deepEqual(await page.evaluate(()=>({...localStorage})),saved);
  await page.locator('select[data-simulation-mode]').selectOption('orders');await play.click();
  await page.waitForFunction(()=>WmsSimulationSession.snapshot().jobs[0]?.status!=='대기');
  await page.locator('[data-action=viewer3d]').click();await page.locator('#viewer3d canvas').waitFor();
  assert.equal((await state()).mode,'orders');await page.locator('#viewer3d').getByRole('button',{name:'일시정지',exact:true}).click();
  const orderPaused=await state();await page.locator('[data-wms-workspace=drawing]').click();assert.deepEqual(await state(),orderPaused);
  await play.click();await page.waitForFunction(()=>WmsSimulationSession.snapshot().jobs[0]?.done,{},{timeout:45000});
  assert.deepEqual(await page.evaluate(()=>({...localStorage})),saved);
  await page.locator('[data-tab-select=tab2]').click();assert.equal(await state(),null);assert.equal(await page.locator('#editor [data-simulation-stop]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-simulation-equipment]').count(),0);
  await page.locator('[data-tab-select=tab1]').click();await play.click();await page.waitForFunction(()=>WmsSimulationSession.snapshot()?.elapsed>.1);
  await page.locator('.fp-equipment-list [data-select=FA01]').click();await page.locator('[data-field=w]').fill('.6');await page.locator('[data-field=w]').press('Tab');assert.equal(await state(),null);
  assert.deepEqual(errors,[]);console.log('PASS simulation synchronization: 2D start, shared motion/pause/mode, view retention, hidden GPU idle, transport completion, unchanged storage, tab/edit invalidation',target);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
