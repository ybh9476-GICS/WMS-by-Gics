const {chromium}=require('playwright'),assert=require('node:assert/strict');
const fixture=require('../tests/fixtures/drawing-connected.cjs');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1600,height:1000}});
  await context.addInitScript(({book,plan})=>{
   localStorage.setItem('gics-standalone-reference-data-v1',JSON.stringify({schemaVersion:1,revision:'refresh-test',name:'검증',book}));
   localStorage.setItem('gics-standalone-drawing-v2:local-editor:tabs-v1',JSON.stringify({version:2,activeId:'tab1',nextDocumentId:2,nextDrawingNumber:0,documents:[{id:'tab1',plan,savedPlan:plan}]}));
  },fixture());
  const page=await context.newPage(),errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
  const target=process.env.WMS_TEST_URL||'http://127.0.0.1:4174/';await page.goto(target);
  const plan=await page.evaluate(()=>localStorage.getItem('gics-standalone-drawing-v2:local-editor:tabs-v1'));
  const editZone=name=>page.evaluate(name=>{
   const key='gics-standalone-reference-data-v1',stored=JSON.parse(localStorage.getItem(key)),sheet=stored.book.sheets.find(s=>s.name==='구역설정');
   const row=sheet.cells.find(c=>c[1]===1&&c[2]==='A01')[0];sheet.cells.find(c=>c[0]===row&&c[1]===2)[2]=name;stored.revision=name;localStorage.setItem(key,JSON.stringify(stored));
  },name);
  const reload=page.locator('#editor .fp-toolbar-shortcuts [data-action=reloadMaster]');assert.equal(await reload.getAttribute('aria-label'),'기준정보 새로고침');assert.ok(await reload.isVisible());
  await page.locator('#editor [data-simulation-play]').click();await page.waitForFunction(()=>WmsSimulationSession.snapshot()?.status==='running');
  await editZone('평면도에서 갱신');await reload.click();await page.waitForFunction(()=>WmsSimulationSession.snapshot()===null);
  assert.match(await page.locator('.fp-notice').innerText(),/사이트 기준정보/);
  await page.locator('[data-action=viewer3d]').click();await page.waitForFunction(()=>WmsSimulationSession.snapshot());
  assert.match(await page.locator('[data-warehouse-zone-code=A01]').innerText(),/평면도에서 갱신/);
  await editZone('3D에서 갱신');await page.locator('#viewer3d').getByRole('button',{name:'기준정보 새로고침',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-warehouse-zone-code=A01]')?.textContent.includes('3D에서 갱신'));
  assert.equal((await page.evaluate(()=>WmsSimulationSession.snapshot())).paused,true);
  await page.locator('[data-wms-workspace=drawing]').click();assert.ok(await reload.isVisible());
  assert.equal(await page.evaluate(()=>localStorage.getItem('gics-standalone-drawing-v2:local-editor:tabs-v1')),plan);
  assert.deepEqual(errors,[]);assert.ok(requests.every(url=>url.startsWith(target)||url.startsWith('data:')||url.startsWith('blob:')));
  await page.locator('.fp-toolbar').screenshot({path:'output/reference-refresh-toolbar.png'});
  console.log('PASS both refresh buttons read local reference changes, reset simulation, preserve drawing, and make no external requests');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
