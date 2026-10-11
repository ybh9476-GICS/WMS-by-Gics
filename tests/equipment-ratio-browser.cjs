const {chromium}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path'),M=require('../js/floor-plan-model.js');
const target=process.env.WMS_TEST_URL||require('node:url').pathToFileURL(path.resolve(__dirname,'../index.html')).href;
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},offline:target.startsWith('file:')});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const plan=M.blank();plan.objects=[{id:'FA01',kind:'FA',w:1.5,h:1,height:2,x:3,y:4,angle:30,routeId:''},{id:'SH01',kind:'SH',w:1,h:.8,height:.2,x:8,y:4,angle:0,routeId:''},{id:'AMR01',kind:'AMR',w:1,h:.6,height:.3,x:11,y:4,angle:0,routeId:''}];
 const storageKey='gics-standalone-drawing-v2:local-editor:tabs-v1';
 await context.addInitScript(({plan,key})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:2,activeId:'tab1',nextDocumentId:2,nextDrawingNumber:0,documents:[{id:'tab1',plan,savedPlan:plan}]}));},{plan,key:storageKey});
 const input=key=>page.locator('[data-field='+key+']'),check=page.locator('[data-equipment-ratio]');
 const dimensions=()=>page.evaluate(key=>{const o=JSON.parse(localStorage.getItem(key)).documents[0].plan.objects.find(o=>o.id===document.querySelector('[data-field=id]').value);return [o.w,o.h,o.height];},storageKey);
 const edit=async(key,value)=>{await input(key).fill(String(value));await input(key).press('Tab');};
 try{
  await page.goto(target);assert.equal(await check.isChecked(),false);await check.check();
  await edit('w',3);assert.deepEqual(await dimensions(),[3,2,4]);
  await edit('height',6);assert.deepEqual(await dimensions(),[4.5,3,6]);
  await edit('h',1);assert.deepEqual(await dimensions(),[1.5,1,2]);
  await edit('w',1.01);assert.deepEqual(await dimensions(),[1.01,.673,1.347]);
  await edit('w',3);assert.deepEqual(await dimensions(),[3,2,4]); // no accumulated rounding drift
  await page.locator('[data-action=undo]').click();assert.deepEqual(await dimensions(),[1.01,.673,1.347]);
  await page.locator('[data-action=redo]').click();assert.deepEqual(await dimensions(),[3,2,4]);
  await check.uncheck();await edit('w',1.5);assert.deepEqual(await dimensions(),[1.5,2,4]);
  await check.check();await edit('height',2);assert.deepEqual(await dimensions(),[.75,1,2]);
  await edit('w',200);assert.deepEqual(await dimensions(),[.75,1,2]);assert.match(await page.locator('.fp-prop-error').innerText(),/0.01~200/);
  await edit('w',.75);await edit('height',.01);assert.deepEqual(await dimensions(),[.75,1,2]);
  await edit('height',2);
  await page.locator('[data-action=toggleObjectLock]').click();assert.equal(await check.isDisabled(),true);await page.locator('[data-action=toggleObjectLock]').click();
  // Number scrub uses the same input path, and commits the entire resize as one undo step.
  const scrub=input('h').locator('..').locator('[data-number-scrub]'),b=await scrub.boundingBox();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+20,b.y+b.height/2,{steps:5});await page.mouse.up();
  assert.deepEqual(await dimensions(),[.825,1.1,2.2]);await page.locator('[data-action=undo]').click();assert.deepEqual(await dimensions(),[.75,1,2]);
  for(const [id,expected] of [['SH01',[2,1.6,.4]],['AMR01',[2,1.2,.6]]]){
   await page.locator('.fp-equipment-list [data-select='+id+']').click();assert.equal(await check.isChecked(),true);await edit('w',2);assert.deepEqual(await dimensions(),expected);
  }
  await page.locator('.fp-equipment-list [data-select=FA01]').click();await page.locator('.fp-inspector').screenshot({path:path.resolve(__dirname,'../output/equipment-ratio.png')});
  await page.locator('[data-action=viewer3d]').click();await page.locator('.warehouse-3d-viewport canvas').waitFor();
  const objects=JSON.parse(await page.locator('.warehouse-3d-viewport').getAttribute('data-drawing-geometry')).objects;
  assert.deepEqual(objects.filter(o=>['FA','SH','AMR'].includes(o.kind)).map(o=>[o.w,o.h,o.height]),[[.75,1,2],[2,1.6,.4],[2,1.2,.6]]);
  await page.locator('[data-wms-workspace=drawing]').click();await page.reload();assert.equal(await check.isChecked(),false);assert.deepEqual(await dimensions(),[.75,1,2]);
  // Creation templates also have ratio locking, without writing editor preferences into .gics.
  await page.locator('[data-tool=SH]').click();await check.check();await edit('w',2);assert.equal(await input('h').inputValue(),'2.00');assert.equal(await input('height').inputValue(),'0.24');
  assert.deepEqual(errors,[]);console.log('PASS equipment ratio: three dimensions/kinds, stable ratio, independent mode, range checks, scrub, undo/redo, lock, creation, persistence and 3D',target);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
