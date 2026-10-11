const {chromium}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const target=process.env.WMS_TEST_URL||pathToFileURL(path.resolve(__dirname,'../index.html')).href;
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1600,height:1000},offline:target.startsWith('file:')});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 // Capture rendered scenes in the isolated test profile; the application needs no test-only scene globals.
 await context.addInitScript(()=>Object.defineProperty(window,'THREE',{configurable:true,set(api){delete window.THREE;window.THREE=api;const Base=api.WebGLRenderer;api.WebGLRenderer=class extends Base{constructor(...args){super(...args);const render=this.render.bind(this);this.render=(scene,camera)=>{if(scene.getObjectByName('WAREHOUSE-RAISED-FLOOR'))window.testScene=scene;return render(scene,camera);};}};}}));
 try{
  await page.goto(target);await page.locator('[data-action=viewer3d]').click();await page.waitForFunction(()=>window.testScene);
  await page.evaluate(async()=>{
   window.originalData=window.WmsWarehouseLocalData.convert(window.WMS_REFERENCE_SEED);
   window.originalData.workOrders=[];window.originalData.operationRoutes=[];
   await window.wmsWarehouse3D.mount(document.querySelector('.warehouse-3d-shell'),{loadData:()=>structuredClone(window.originalData)});
  });
  await page.waitForTimeout(400);
  const result=await page.evaluate(async()=>{
   const scene=window.testScene;
   const amr=scene.children.find(o=>o.name.startsWith('FORKLIFT-AMR-'));
   const shuttle=scene.children.find(o=>o.name.startsWith('FOUR-WAY-SHUTTLE-'));
   const lift=scene.children.find(o=>o.name.startsWith('WAREHOUSE-SHUTTLE-LIFT-'));
   const rack=scene.getObjectByName(originalData.racks[0].code);
   const profile=root=>{const items=[];root.traverse(o=>{if(!o.isMesh)return;for(let p=o;p&&p!==root;p=p.parent)if(p.name==='shuttle-carried-unit-load')return;items.push({name:o.name,type:o.geometry.type,vertices:Array.from(o.geometry.attributes.position.array),color:o.material.color?.getHexString(),position:o.position.toArray().map(n=>+n.toFixed(6)),scale:o.scale.toArray().map(n=>+n.toFixed(6))});});return items;};
   const getLabel=root=>root.children.find(o=>o.isSprite);
   const amrLabel=getLabel(amr),shuttleLabel=getLabel(shuttle);amrLabel.setOperationStatus('대기');shuttleLabel.setOperationStatus('대기');
   window.appearanceBaseline={amr:profile(amr),shuttle:profile(shuttle),lift:profile(lift),rack:profile(rack),amrLabel:amrLabel.material.map.image.toDataURL(),shuttleLabel:shuttleLabel.material.map.image.toDataURL()};
   const conveyor=window.wmsWarehouse3D.createConveyorModel(THREE,{cellSize:500,modules:[{axis:'x',minX:-2000,maxX:2000,minY:-750,maxY:750,length:4000,width:1500}],rails:[-1,1].map(side=>({axis:'x',x:0,y:side*750,dx:0,dy:side,length:4000}))},0);
   window.appearanceBaseline.conveyor=conveyor.group.children.map(mesh=>({name:mesh.name,color:mesh.material.color.getHexString(),vertices:Array.from(mesh.geometry.attributes.position.array),instances:Array.from(mesh.instanceMatrix.array)}));
   conveyor.resources.forEach(r=>r.dispose());
   const amrConfig=originalData.equipment.find(o=>o.code===amr.userData.equipmentCode),shuttleConfig=originalData.equipment.find(o=>o.code===shuttle.userData.equipmentCode);
   const footprint=lift.userData.footprint;
   const data=structuredClone(originalData);
   data.meta.source='drawing';data.meta.dockRegions=[];data.meta.truckSchedules=[];
   data.meta.passageCells=[];data.meta.shuttlePassageCells=[];data.meta.conveyorCells=[];data.meta.stationCells=[];data.meta.bufferCells=[];data.meta.dockCells=[];data.meta.barcodeTunnelCells=[];
   data.equipment=[];data.equipmentStatuses=[];
   data.meta.plan={name:'외형 비교',width:38,height:38.5,objects:[{id:'S01',kind:'S',x:3,y:3,w:footprint[0],h:footprint[1],angle:23},
    {id:'FA01',kind:'FA',x:10,y:25,w:1.5,h:1,height:2.4,angle:0},{id:'SH01',kind:'SH',x:15,y:25,w:1.5,h:1.5,height:.22,angle:0},
    {id:'CV01',kind:'CV',points:[{x:5,y:20},{x:9,y:20}],width:1.5,cap:'butt'}]};
   data.meta.actors=data.meta.plan.objects.filter(o=>['FA','SH'].includes(o.kind)).map(o=>{const master=o.kind==='FA'?amrConfig:shuttleConfig;return {...o,code:master.code,master,status:{communicationStatus:'ONLINE',equipmentStatus:'대기'}};});
   window.appearanceData=data;
   await window.wmsWarehouse3D.mount(document.querySelector('.warehouse-3d-shell'),{loadData:()=>data});
   return {sourceAmrParts:appearanceBaseline.amr.length,sourceShuttleParts:appearanceBaseline.shuttle.length,sourceLiftParts:appearanceBaseline.lift.length};
  });
  await page.waitForTimeout(400);
  const compared=await page.evaluate(()=>{
   const scene=testScene;const amr=scene.children.find(o=>o.name.startsWith('FORKLIFT-AMR-')),shuttle=scene.children.find(o=>o.name.startsWith('FOUR-WAY-SHUTTLE-')),lift=scene.children.find(o=>o.name.startsWith('WAREHOUSE-SHUTTLE-LIFT-'));
   const profile=root=>{const items=[];root.traverse(o=>{if(!o.isMesh)return;for(let p=o;p&&p!==root;p=p.parent)if(p.name==='shuttle-carried-unit-load')return;items.push({name:o.name,type:o.geometry.type,vertices:Array.from(o.geometry.attributes.position.array),color:o.material.color?.getHexString(),position:o.position.toArray().map(n=>+n.toFixed(6)),scale:o.scale.toArray().map(n=>+n.toFixed(6))});});return items;};
   const label=root=>{const sprite=root.children.find(o=>o.isSprite);sprite.setOperationStatus('대기');return sprite.material.map.image.toDataURL();};
   const conveyor=scene.getObjectByName('CV01').getObjectByName('WAREHOUSE-CV-ROLLER-CONVEYORS');
   const conveyorProfile=conveyor.children.map(mesh=>({name:mesh.name,color:mesh.material.color.getHexString(),vertices:Array.from(mesh.geometry.attributes.position.array),instances:Array.from(mesh.instanceMatrix.array)}));
   return {amr:JSON.stringify(profile(amr))===JSON.stringify(appearanceBaseline.amr),shuttle:JSON.stringify(profile(shuttle))===JSON.stringify(appearanceBaseline.shuttle),lift:JSON.stringify(profile(lift))===JSON.stringify(appearanceBaseline.lift),rack:JSON.stringify(profile(scene.getObjectByName(originalData.racks[0].code)))===JSON.stringify(appearanceBaseline.rack),conveyor:JSON.stringify(conveyorProfile)===JSON.stringify(appearanceBaseline.conveyor),amrLabel:label(amr)===appearanceBaseline.amrLabel,shuttleLabel:label(shuttle)===appearanceBaseline.shuttleLabel};
  });
  assert.ok(Object.values(compared).every(Boolean),JSON.stringify(compared));
  await page.screenshot({path:path.resolve(__dirname,'../output/appearance-restored-overview.png')});
  const code=await page.evaluate(()=>appearanceData.meta.actors[0].code);
  await page.locator('[data-warehouse-object-kind=equipment][data-warehouse-object-code="'+code+'"]').click();
  await page.waitForTimeout(700);assert.match(await page.locator('.warehouse-3d-inspector').innerText(),/설비 코드/);
  await page.screenshot({path:path.resolve(__dirname,'../output/appearance-restored-amr.png')});
  await page.getByRole('button',{name:'작업 이력 보기'}).click();assert.ok(await page.locator('dialog[open]').isVisible());await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);console.log('PASS original vs drawing: identical rack, AMR, shuttle, lift and conveyor geometry/materials, billboard pixels; native selection, follow and history',result);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
