const {chromium}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {pathToFileURL}=require('node:url'),fixture=require('./fixtures/drawing-connected.cjs');
const target=process.env.WMS_TEST_URL||pathToFileURL(path.resolve(__dirname,'../index.html')).href;
const key='gics-standalone-drawing-v2:local-editor:tabs-v1';
const outbound=process.env.WMS_TEST_OUTBOUND==='1';
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1600,height:1000},offline:target.startsWith('file:')});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('dialog',d=>d.accept());
 await context.addInitScript(({book,plan,key})=>{localStorage.setItem('gics-standalone-reference-data-v1',JSON.stringify({schemaVersion:1,revision:'fixture',name:'검증 기준정보',book}));localStorage.setItem(key,JSON.stringify({version:2,activeId:'tab1',nextDocumentId:3,nextDrawingNumber:0,documents:[{id:'tab1',plan,savedPlan:plan},{id:'tab2',plan:{...plan,name:'빈 도면',objects:[]},savedPlan:null}]}));},{...fixture(outbound),key});
 try {
  await page.goto(target);await page.locator('[data-action=viewer3d]').click();await page.waitForFunction(()=>window.WmsSimulationSession?.snapshot());
  await page.locator('#viewer3d [aria-label="모의 운행 방식"]').selectOption('orders');
  await page.locator('#viewer3d').getByRole('button',{name:'재생',exact:true}).click();
  const viewport=page.locator('.warehouse-3d-viewport');
  assert.equal(await viewport.getAttribute('data-drawing-name'),'연결 검증 창고');
  assert.equal(await page.locator('[data-warehouse-object-kind=rack]').count(),2);
  const rack=JSON.parse(await viewport.getAttribute('data-drawing-racks')).find(r=>r.code==='W02');assert.ok(Math.abs(rack.angle+33*Math.PI/180)<1e-9);assert.equal(rack.slots.length,4);
  const actors=JSON.parse(await viewport.getAttribute('data-operation-actors'));const idle=actors.find(a=>a.code==='AMR01');assert.equal(idle.position.x,16.35);assert.equal(idle.position.z,11.3);
  await page.waitForFunction(()=>JSON.parse(document.querySelector('.warehouse-3d-viewport').dataset.operationJobs)[0].done,{},{timeout:45000});
  const inventory=JSON.parse(await viewport.getAttribute('data-operation-inventory'));assert.equal(inventory.occupied,outbound?0:1);assert.equal(inventory.quantity,outbound?0:1);
  assert.ok(JSON.parse(await viewport.getAttribute('data-operation-jobs'))[0].cargoOwner.startsWith(outbound?'truck:':'rack:'));
  assert.equal(await viewport.getAttribute('data-barcode-tunnel-scans'),'1');
  const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('gics-standalone-reference-data-v1')).book.sheets.find(s=>s.name==='재고 현황').cells);assert.deepEqual(stored,fixture(outbound).book.sheets.find(s=>s.name==='재고 현황').cells);
  await page.screenshot({path:path.resolve(__dirname,'../output/drawing-connected'+(outbound?'-outbound':'')+'.png')});
  assert.equal(await viewport.getAttribute('data-simulation-status'),'completed');assert.equal(await page.locator('#viewer3d [data-simulation-stop]').getAttribute('aria-pressed'),'true');const time=await viewport.getAttribute('data-operation-elapsed');await page.waitForTimeout(300);assert.equal(await viewport.getAttribute('data-operation-elapsed'),time);
  if(outbound){
    await page.locator('#viewer3d').getByRole('button',{name:'재생',exact:true}).click();
    assert.equal(JSON.parse(await viewport.getAttribute('data-operation-inventory')).quantity,1);
    await page.waitForFunction(()=>JSON.parse(document.querySelector('.warehouse-3d-viewport').dataset.operationJobs)[0].done,null,{timeout:45000});
    assert.equal(JSON.parse(await viewport.getAttribute('data-operation-inventory')).quantity,0);
    assert.equal(await viewport.getAttribute('data-barcode-tunnel-scans'),'1');
  }
  await page.locator('[data-wms-workspace=drawing]').click();await page.locator('[data-tab-select=tab2]').click();await page.locator('[data-action=viewer3d]').click();await page.waitForFunction(()=>document.querySelector('.warehouse-3d-viewport')?.dataset.drawingName==='빈 도면');
  assert.equal(await page.locator('[data-warehouse-object-kind=rack]').count(),0);assert.equal(JSON.parse(await viewport.getAttribute('data-drawing-geometry')).objects.length,0);
  assert.deepEqual(errors,[]);console.log('PASS exact rotated rack, active tab, unchanged idle equipment, connected '+(outbound?'outbound':'inbound')+' transport, scan, pause, reference preservation and empty drawing',target);
 }catch(e){console.error('Browser errors',errors);console.error(await page.locator('#viewer3d').innerText());throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
