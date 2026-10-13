const {chromium}=require('playwright');
const fs=require('node:fs');
const fixture=require('../tests/fixtures/drawing-connected.cjs');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});const results={};
 async function setup(data=fixture()){
  const context=await browser.newContext({viewport:{width:1600,height:1000}});
  await context.addInitScript(({book,plan})=>{
   localStorage.setItem('gics-standalone-reference-data-v1',JSON.stringify({schemaVersion:1,revision:'audit',name:'검증',book}));
   localStorage.setItem('gics-standalone-drawing-v2:local-editor:tabs-v1',JSON.stringify({version:2,activeId:'tab1',nextDocumentId:2,nextDrawingNumber:0,documents:[{id:'tab1',plan,savedPlan:plan}]}));
  },data);
  const page=await context.newPage();await page.goto('http://127.0.0.1:4174/');
  const play=page.locator('[data-simulation-toggle]');await play.click();
  await page.waitForFunction(()=>WmsSimulationSession.snapshot()?.elapsed>.3);
  return {context,page,play,state:()=>page.evaluate(()=>WmsSimulationSession.snapshot())};
 }
 try{
  if(!process.env.AUDIT_EXTRA){
  const a=await setup();
  await a.play.click();const before=await a.state();await a.page.waitForTimeout(400);results.normalPause={before,after:await a.state()};
  await a.play.click();await a.page.locator('.fp-equipment-list [data-select=FA01]').click();
  await a.page.locator('[data-field=w]').fill('');
  const beforeInvalid=await a.state();await a.play.click();await a.page.waitForTimeout(500);
  results.invalidInputPause={before:beforeInvalid,after:await a.state(),button:await a.play.innerText(),notice:await a.page.locator('.fp-notice').allTextContents()};
  await a.context.close();
  const b=await setup();await b.page.waitForTimeout(600);await b.play.click();const routes=await b.state();
  await b.page.locator('select[data-simulation-mode]').selectOption('orders');
  results.pausedModeSwitch={before:routes,after:await b.state()};
  await b.play.click();await b.page.waitForFunction(()=>WmsSimulationSession.snapshot()?.jobs[0]?.done,null,{timeout:60000});
  const finished=await b.state();await b.play.click();await b.play.click();await b.page.waitForTimeout(500);
  results.completedResume={before:finished,after:await b.state(),button:await b.play.innerText()};await b.context.close();
  const offset=fixture();offset.plan.objects.find(o=>o.id==='FA01').y-=.5;
  const c=await setup(offset);const preview=await c.state();await c.page.locator('select[data-simulation-mode]').selectOption('orders');await c.page.waitForTimeout(500);
  results.offRouteOrder={preview,orders:await c.state(),button:await c.play.innerText()};await c.context.close();
  }else{
   const data=fixture();data.plan.objects.push({id:'CV99',kind:'CV',points:[{x:17,y:12},{x:19,y:12}],width:.1,cap:'butt',locked:false});
   const d=await setup(data);await d.page.locator('select[data-simulation-mode]').selectOption('orders');await d.page.waitForTimeout(500);
   results.unusedNarrowConveyor={state:await d.state()};
   await d.page.locator('[data-action=viewer3d]').click();await d.page.locator('#viewer3d canvas').waitFor();
   await d.page.locator('#viewer3d').getByRole('button',{name:'일시정지',exact:true}).click();const before=await d.state();await d.page.waitForTimeout(400);
   results.threeDPause={before,after:await d.state()};
   await d.page.locator('[data-wms-workspace=drawing]').click();await d.page.locator('.fp-equipment-list [data-select=FA01]').click();await d.page.locator('[data-field=w]').fill('.6');await d.page.locator('[data-field=w]').press('Tab');
   results.editWhilePaused={state:await d.state(),button:await d.play.innerText()};await d.context.close();
  }
 }finally{await browser.close();fs.writeFileSync(process.env.AUDIT_EXTRA?'output/audit-simulation-extra.json':'output/audit-simulation.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1;});
