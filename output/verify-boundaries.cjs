const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1500,height:1000}}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await context.addInitScript(()=>Object.defineProperty(window,'THREE',{configurable:true,set(api){delete window.THREE;window.THREE=api;const Base=api.WebGLRenderer;api.WebGLRenderer=class extends Base{constructor(...args){super(...args);const render=this.render.bind(this);this.render=(scene,camera)=>{window.testScene=scene;return render(scene,camera);};}};}}));
 try{
  await page.goto('http://127.0.0.1:4174/');await page.locator('[data-action=viewer3d]').click();await page.locator('.warehouse-3d-viewport canvas').waitFor();
  await page.evaluate(async()=>{
   const data=WmsWarehouseLocalData.convert(WMS_REFERENCE_SEED);
   data.workOrders=[];data.operationRoutes=[];data.racks=[];data.equipment=[];data.equipmentStatuses=[];data.inventory=[];data.locations=[];
   data.meta={...data.meta,source:'drawing',floorWidth:14000,floorDepth:11000,dockRegions:[],truckSchedules:[],actors:[],warnings:[],passageCells:[],shuttlePassageCells:[],conveyorCells:[],stationCells:[],bufferCells:[],dockCells:[],barcodeTunnelCells:[],plan:{name:'Boundary check',width:14,height:11,objects:[
    {id:'T1',kind:'T',width:2,points:[{x:2,y:2},{x:7,y:2},{x:10,y:5}]},
    {id:'T2',kind:'T',width:.2,points:[{x:2,y:4},{x:6,y:4}]},
    {id:'D1',kind:'D',x:2,y:6,w:3,h:2,angle:0},{id:'B1',kind:'B',x:8,y:7,w:3,h:2,angle:30}
   ]}};
   window.boundaryPlan=data.meta.plan;await wmsWarehouse3D.mount(document.querySelector('.warehouse-3d-shell'),{loadData:()=>data});
  });
  await page.waitForTimeout(300);
  const checked=await page.evaluate(()=>{
   const close=(a,b)=>{if(Math.abs(a-b)>1e-7)throw Error('Boundary mismatch '+a+' / '+b);};let count=0;
   const root=testScene.getObjectByName('DRAWING-EXACT-GEOMETRY');
   for(const o of boundaryPlan.objects){const group=root.getObjectByName(o.id);
    if(o.kind==='T')for(const segment of group.children)for(const line of segment.children){close(Math.abs(line.position.z)+line.scale.z/2,o.width/2);count++;}
    else for(const line of group.children.filter(o=>o.isMesh)){
     if(line.scale.x===o.w)close(Math.abs(line.position.z)+line.scale.z/2,o.h/2);
     else close(Math.abs(line.position.x)+line.scale.x/2,o.w/2);count++;
    }
   }return count;
  });
  assert.equal(checked,14);await page.locator('[data-warehouse-camera-view=top]').click();await page.waitForTimeout(300);await page.locator('.warehouse-3d-viewport').screenshot({path:'output/boundaries-no-margin.png'});
  assert.deepEqual(errors,[]);console.log('PASS: 14 boundary lines flush with drawing extents: straight/diagonal/narrow routes, dock and rotated buffer; no browser errors');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
