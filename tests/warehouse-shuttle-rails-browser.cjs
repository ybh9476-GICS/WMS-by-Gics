const {chromium}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path');
const target=process.env.WMS_TEST_URL||require('node:url').pathToFileURL(path.resolve(__dirname,'../index.html')).href;
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1600,height:1100},offline:target.startsWith('file:')});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await context.addInitScript(()=>Object.defineProperty(window,'THREE',{configurable:true,set(api){delete window.THREE;window.THREE=api;const Base=api.WebGLRenderer;api.WebGLRenderer=class extends Base{constructor(...args){super(...args);const render=this.render.bind(this);this.render=(scene,camera)=>{window.testScene=scene;return render(scene,camera);};}};}}));
 try{
  await page.goto(target);await page.locator('[data-action=viewer3d]').click();await page.locator('.warehouse-3d-viewport canvas').waitFor();
  await page.evaluate(async()=>{
   const data=WmsWarehouseLocalData.convert(WMS_REFERENCE_SEED),gr=(id,points)=>({id,kind:'GR',width:1.4,points:points.map(([x,y])=>({x,y}))});
   data.workOrders=[];data.operationRoutes=[];data.racks=[];data.equipment=[];data.equipmentStatuses=[];data.inventory=[];data.locations=[];
   data.rackTypes=[{...data.rackTypes[0],levels:3,levelHeight:1500}];
   data.meta={...data.meta,source:'drawing',floorWidth:20000,floorDepth:16000,dockRegions:[],truckSchedules:[],actors:[],warnings:[],passageCells:[],shuttlePassageCells:[],conveyorCells:[],stationCells:[],bufferCells:[],dockCells:[],barcodeTunnelCells:[],plan:{name:'GR rail joints',width:20,height:16,objects:[
    gr('GR-L',[[2,2],[7,2],[7,7]]),gr('GR-diagonal',[[2,10],[7,10],[10,13]]),
    {...gr('GR-branch',[[11,2],[14,2],[18,2]]),branches:[{id:'B1',from:1,points:[{x:14,y:7}]}]}
   ]}};
   window.railData=data;await wmsWarehouse3D.mount(document.querySelector('.warehouse-3d-shell'),{loadData:()=>structuredClone(data)});
  });
  await page.waitForTimeout(350);
  const result=await page.evaluate(()=>{
   const root=testScene.getObjectByName('GR-CONNECTED-RAILS'),levels=[...new Set(root.children.map(o=>o.userData.level))];
   const up=new THREE.Vector3(0,1,0),check=(x,z,level)=>{
    const mesh=root.children.find(o=>o.userData.level===level),height=mesh.position.y;
    const ray=new THREE.Raycaster(new THREE.Vector3(x,height+1,z),up.clone().negate(),0,2);
    return ray.intersectObjects(root.children.filter(o=>o.userData.level===level),false).length>0;
   };
   // These points are the two corners marked by the user, and the former overhanging ends.
   for(const h of levels){
    for(const [x,z] of [[7.665,1.335],[6.335,2.665]])if(!check(x,z,h))throw Error('Open GR corner at level '+h);
    for(const [x,z] of [[6.3,2.2],[6.9,2.7]])if(check(x,z,h))throw Error('Protruding GR end at level '+h);
   }
   return{levels,count:root.children.length,finite:root.children.every(o=>Array.from(o.geometry.attributes.position.array).every(Number.isFinite))};
  });
  assert.deepEqual(result.levels,[0,1.5,3]);assert.ok(result.finite&&result.count>0);
  await page.locator('.warehouse-3d-viewport').screenshot({path:path.resolve(__dirname,'../output/gr-rails-quarter.png')});
  await page.locator('[data-warehouse-camera-view=top]').click();await page.waitForTimeout(300);
  await page.locator('.warehouse-3d-viewport').screenshot({path:path.resolve(__dirname,'../output/gr-rails-top.png')});
  assert.deepEqual(errors,[]);console.log('PASS actual GR mesh intersections: connected inner/outer corners, no overhanging ends on all 3 levels, L/diagonal/branch rendering',target);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
