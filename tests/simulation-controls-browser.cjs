const {chromium}=require('playwright');
const assert=require('node:assert/strict'),path=require('node:path');
const fixture=require('./fixtures/drawing-connected.cjs');
const target=process.env.WMS_TEST_URL||require('node:url').pathToFileURL(path.resolve(__dirname,'../index.html')).href;
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});const errors=[];
 async function setup(data=fixture()){
  const context=await browser.newContext({viewport:{width:1600,height:1000},offline:target.startsWith('file:')});
  await context.addInitScript(({book,plan})=>{
   localStorage.setItem('gics-standalone-reference-data-v1',JSON.stringify({schemaVersion:1,revision:'controls',name:'검증',book}));
   localStorage.setItem('gics-standalone-drawing-v2:local-editor:tabs-v1',JSON.stringify({version:2,activeId:'tab1',nextDocumentId:2,nextDrawingNumber:0,documents:[{id:'tab1',plan,savedPlan:plan}]}));
  },data);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(target);const saved=await page.evaluate(()=>({...localStorage}));
  const play=page.locator('#editor [data-simulation-play]'),pause=page.locator('#editor [data-simulation-pause]'),stop=page.locator('#editor [data-simulation-stop]'),state=()=>page.evaluate(()=>WmsSimulationSession.snapshot());
  return {context,page,play,pause,stop,state,saved,mode:page.locator('select[data-simulation-mode]')};
 }
 const frozen=async test=>{const before=await test.state();await test.page.waitForTimeout(250);assert.deepEqual(await test.state(),before);};
 const inventory=page=>page.locator('.warehouse-3d-viewport').getAttribute('data-operation-inventory').then(JSON.parse);
 try{
  const a=await setup();
  assert.equal(await a.page.locator('#editor .wms-simulation-button').count(),3);
  for(const button of [a.play,a.pause,a.stop]){assert.equal(await button.innerText(),'');assert.equal(await button.locator('svg').count(),1);}
  assert.equal(await a.stop.getAttribute('aria-pressed'),'true');
  const positions=await Promise.all([a.play,a.pause,a.stop].map(button=>button.boundingBox()));
  await a.play.click();await a.page.waitForFunction(()=>WmsSimulationSession.snapshot()?.elapsed>.2);
  assert.equal(await a.play.getAttribute('aria-pressed'),'true');assert.equal(await a.play.isDisabled(),true);
  await a.page.locator('.fp-equipment-list [data-select=FA01]').click();await a.page.locator('[data-field=w]').fill('');
  await a.pause.click();assert.equal((await a.state()).status,'paused');await frozen(a);
  assert.equal(await a.pause.getAttribute('aria-pressed'),'true');assert.equal(await a.play.getAttribute('aria-pressed'),'false');
  assert.deepEqual(await Promise.all([a.play,a.pause,a.stop].map(button=>button.boundingBox())),positions);
  await a.page.screenshot({path:path.resolve(__dirname,'../output/simulation-icons-2d.png')});
  await a.play.click();assert.equal((await a.state()).status,'running');await a.pause.click();await frozen(a);
  await a.stop.click();assert.equal((await a.state()).status,'stopped');assert.equal((await a.state()).elapsed,0);assert.equal((await a.state()).actors.find(actor=>actor.id==='FA01').position.x,3);await frozen(a);
  assert.equal(await a.stop.getAttribute('aria-pressed'),'true');await a.play.click();await a.pause.click();
  // Restore the unchanged valid field; this must not reset the existing run.
  await a.page.locator('[data-field=w]').fill('.5');await a.page.locator('[data-field=w]').press('Tab');
  assert.equal((await a.state()).status,'paused');
  const old=await a.state();await a.mode.selectOption('orders');const switched=await a.state();
  assert.deepEqual(switched.actors.map(a=>a.position),old.actors.map(a=>a.position));assert.equal(switched.elapsed,old.elapsed);assert.equal(switched.status,'ready');await frozen(a);
  await a.page.locator('[data-action=viewer3d]').click();await a.page.locator('#viewer3d canvas').waitFor();
  assert.deepEqual(await a.state(),switched);
  await a.page.locator('#viewer3d').getByRole('button',{name:'재생',exact:true}).click();
  await a.page.waitForFunction(()=>WmsSimulationSession.snapshot()?.elapsed>.2);
  await a.page.locator('#viewer3d').getByRole('button',{name:'일시정지',exact:true}).click();await frozen(a);
  assert.equal(await a.page.locator('#viewer3d [data-simulation-pause]').getAttribute('aria-pressed'),'true');
  await a.page.screenshot({path:path.resolve(__dirname,'../output/simulation-icons-3d.png')});
  await a.page.locator('[data-wms-workspace=drawing]').click();assert.equal(await a.pause.getAttribute('aria-pressed'),'true');await frozen(a);
  await a.play.click();await a.page.waitForFunction(()=>WmsSimulationSession.snapshot()?.status==='completed',null,{timeout:60000});
  assert.equal(await a.stop.getAttribute('aria-pressed'),'true');assert.equal(await a.play.isDisabled(),false);await frozen(a);assert.equal((await inventory(a.page)).quantity,1);
  await a.play.click();assert.equal((await a.state()).status,'running');assert.equal((await a.state()).jobs[0].done,false);assert.equal((await inventory(a.page)).quantity,0);
  await a.page.waitForTimeout(150);await a.pause.click();await frozen(a);
  assert.equal(await a.page.locator('.warehouse-3d-viewport').getAttribute('data-barcode-tunnel-scans'),'0');
  const cargoBefore=await a.state();await a.mode.selectOption('routes');assert.deepEqual((await a.state()).jobs,cargoBefore.jobs);await a.mode.selectOption('orders');
  assert.deepEqual(await a.page.evaluate(()=>({...localStorage})),a.saved);
  // Modifying a paused plan explicitly invalidates the run and retains the selected mode.
  await a.page.locator('[data-field=w]').fill('.6');await a.page.locator('[data-field=w]').press('Tab');assert.equal(await a.state(),null);
  assert.match(await a.page.locator('[data-simulation-status]').innerText(),/변경.*초기화/);await a.play.click();assert.equal((await a.state()).mode,'orders');
  await a.context.close();console.log('PASS invalid input pause/resume, frozen mode switch, 2D/3D controls, completed/restart, storage preservation, edit notice and mode retention');

  // Both original failures must allow a valid inbound order to complete now.
  const data=fixture();data.plan.objects.find(o=>o.id==='FA01').y-=.5;
  data.plan.objects.push({id:'CV99',kind:'CV',points:[{x:17,y:12},{x:19,y:12}],width:.1,cap:'butt',locked:false});
  const b=await setup(data);await b.mode.selectOption('orders');await b.play.click();
  await b.page.waitForFunction(()=>WmsSimulationSession.snapshot()?.status==='completed',null,{timeout:60000});assert.equal((await b.state()).jobs[0].done,true);
  await b.context.close();console.log('PASS off-center start and unrelated narrow conveyor allow inbound completion');

  const narrow=fixture();narrow.plan.objects.find(o=>o.id==='CV01').width=.1;
  const c=await setup(narrow);await c.play.click();await c.mode.selectOption('orders');await c.play.click();
  assert.equal((await c.state()).status,'blocked');assert.equal(await c.stop.getAttribute('aria-pressed'),'true');assert.match((await c.state()).jobs[0].status,/D01 → B01: 화물 폭/);await frozen(c);
  assert.doesNotMatch((await c.state()).jobs[0].status,/로케이션 마스터/);
  await c.page.locator('[data-action=viewer3d]').click();await c.page.locator('#viewer3d canvas').waitFor();
  await c.page.screenshot({path:path.resolve(__dirname,'../output/simulation-blocked-3d.png')});await c.context.close();console.log('PASS used narrow conveyor gives accurate reason and stops clock');

  const empty=fixture();empty.book.sheets.find(s=>s.name==='작업지시').cells=empty.book.sheets.find(s=>s.name==='작업지시').cells.filter(cell=>cell[0]===1);
  const d=await setup(empty);await d.page.locator('[data-action=viewer3d]').click();await d.page.waitForFunction(()=>WmsSimulationSession.snapshot());
  assert.equal((await d.state()).status,'ready');assert.equal((await d.state()).elapsed,0);await frozen(d);
  await d.page.locator('#viewer3d [aria-label="모의 운행 방식"]').selectOption('orders');await d.page.locator('#viewer3d').getByRole('button',{name:'재생',exact:true}).click();
  assert.equal((await d.state()).status,'blocked');assert.match((await d.state()).message,/작업지시가 없습니다/);await frozen(d);await d.context.close();
  assert.deepEqual(errors,[]);console.log('PASS explicit 3D start, empty orders and no browser exceptions',target);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
