const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const THREE=require('../output/three-0.185.1.cjs'),M=require('../js/floor-plan-model.js'),Ops=require('../js/warehouse-operations.js');
const window={WmsFloorPlanModel:M,WmsWarehouseOperations:Ops};
let session;
window.WmsWarehouseConveyorLayout={build:()=>({models:[]})};
window.WmsWarehouseShuttleRails={build:()=>({pieces:[]})};
window.WmsSimulationControls={markup:()=>'',update:()=>{}};
window.WmsSimulationSession={attach(value){session=value;return ()=>{};},publish(){}};
class Element{
 constructor(){this.dataset={};this.classList={add(){}};this.style={setProperty(){}};}
 append(){}prepend(){}setAttribute(){}addEventListener(){}
 querySelector(){return new Element();}
}
const panel=new Element(),util=new Element(),available=new Element(),shellRoot={querySelector(selector){
 if(selector==='[data-warehouse-kpi="utilization"]')return util;
 if(selector.startsWith('[data-warehouse-kpi="available"]'))return available;
 if(selector==='.warehouse-3d-bottom-panel')return panel;
 return null;
}};
const viewport=new Element();viewport.closest=()=>shellRoot;
const document={hidden:false,createElement:()=>new Element()};
const context=vm.createContext({window,document,console});
for(const file of ['warehouse-drawing','warehouse-route-preview','warehouse-drawing-scene'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/'+file+'.js'),'utf8'),context);
const objects=[
 {id:'D01',kind:'D',x:1,y:9,w:2,h:2,angle:0},
 {id:'B01',kind:'B',x:1,y:5,w:2,h:2,angle:0},
 {id:'CV01',kind:'CV',points:[{x:2,y:9},{x:2,y:7}],width:1.2},
 {id:'T01',kind:'T',points:[{x:3,y:6},{x:5,y:6}],width:1.5},
 {id:'FA01',kind:'FA',x:3,y:5.75,w:.5,h:.5,height:1,angle:0,routeId:'T01'}
];
const actor={...objects[4],code:'AMR-001',master:{enabled:true,configuredSpeed:1},status:{communicationStatus:'ONLINE'}};
const data={meta:{plan:{objects},actors:[actor]},rackTypes:[],racks:[],items:[],workOrders:[],operationRoutes:[
 {code:'IN01',enabled:true,direction:'입고',dock:'D01',buffer:'B01',station:'S01',amr:'AMR-001'}]};
const scene=new THREE.Group(),shell={viewport,zoneButtons:new Element()};
const label=()=>{const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.Texture()}));return sprite;};
const env={THREE,shell,data,scene,signal:new AbortController().signal,rackEntries:[],warehouseFloorElevation:0,
 amrFleet:[],shuttleFleet:[],originalShuttleFrame:{frameHeight:.1,frameOffset:0,frameMaterial:new THREE.MeshStandardMaterial(),deckMaterial:new THREE.MeshStandardMaterial()},
 createLabel:label,createTaskLoad({loadAnchor}){const load=new THREE.Group();load.add(new THREE.Mesh(new THREE.BoxGeometry(.8,.7,.8),new THREE.MeshStandardMaterial()));
 load.setStorageState=()=>{};loadAnchor.add(load);return load;},
 createDrawingEquipment(){const group=new THREE.Group(),tag=label();tag.userData.amr={state:'대기',equipmentStatus:'대기'};scene.add(group);return {group,label:tag};},
 setSlotInstanceVisible(){},isLevelFocused:()=>false};
const mounted=window.WmsWarehouseDrawingScene.mount(env);
const cartons=scene.children.filter(child=>child.name.startsWith('operation-pallet-route-'));
assert.equal(cartons.length,3,'Repeat driving creates three dock cartons without work orders.');
assert.equal(session.snapshot().mode,'orders','Work orders are the default driving mode.');
session.setMode('routes');
session.play();
for(let time=0;time<=3600;time+=100)mounted.update(time);
assert.ok(cartons.every(carton=>carton.visible),'The truck unloads and stacks all cartons at the dock.');
assert.equal(mounted.truckProgress('D01','입고'),'하차 완료');
for(let time=3700;time<=7200;time+=100)mounted.update(time);
assert.ok(cartons.some(carton=>carton.position.z<9.9),'A carton travels from the stack onto the conveyor.');
session.pause();const held=cartons.map(carton=>carton.position.z);mounted.update(8200);
assert.deepEqual(cartons.map(carton=>carton.position.z),held,'Pause freezes the carton movement.');
session.stop();mounted.update(8300);assert.ok(cartons.every(carton=>!carton.visible),'Stop clears the visual preview.');
mounted.dispose();
const rackGroup=new THREE.Group();rackGroup.position.set(10.5,0,3.6);rackGroup.updateMatrixWorld(true);
const slots=Array.from({length:7},(_,index)=>({locationCode:`W01-${index+1}`,group:rackGroup,position:[0,0,index*.08],palletBaseY:.1,
 boxSize:[.8,.7,.8],level:1,type:{levelHeight:1000},location:{capacity:10},occupied:false,stock:null}));
const orderObjects=[
 {id:'W01',kind:'W',x:10,y:3.1,w:1,h:1,angle:0},
 {id:'D01',kind:'D',x:1,y:9,w:2,h:2,angle:0},
 {id:'B01',kind:'B',x:1,y:5,w:2,h:2,angle:0},
 {id:'S01',kind:'S',x:8,y:5,w:2,h:2,angle:0},
 {id:'CV01',kind:'CV',points:[{x:2,y:9},{x:2,y:7}],width:1.2},
 {id:'T01',kind:'T',points:[{x:3,y:6},{x:6,y:6},{x:8,y:6}],width:1.5},
 {id:'GR01',kind:'GR',points:[{x:9,y:7},{x:10.5,y:7},{x:10.5,y:4.2}],width:1.2},
 {id:'FA01',kind:'FA',x:2.75,y:5.75,w:.5,h:.5,height:1,angle:0,routeId:'T01'},
 {id:'SH01',kind:'SH',x:8.75,y:6.75,w:.5,h:.5,height:.15,angle:0,routeId:'GR01'}
];
const enabled={enabled:true,configuredSpeed:5},online={communicationStatus:'ONLINE'};
const actors=[{...orderObjects[7],code:'AMR-001',master:enabled,status:online},{...orderObjects[8],code:'SHUTTLE-001',master:enabled,status:online}];
const workOrders=slots.map((_,index)=>({code:`JOB${index+1}`,direction:'입고',status:'대기',equipmentCode:'AMR-001',itemCode:'ITEM1',quantity:1,routeCode:'IN01'}));
const orderData={meta:{plan:{objects:orderObjects},actors},rackTypes:[{levels:1,levelHeight:1000}],racks:[{code:'W01'}],items:[{code:'ITEM1',color:'#c79555'}],
 workOrders,operationRoutes:[{code:'IN01',enabled:true,direction:'입고',dock:'D01',buffer:'B01',station:'S01',amr:'AMR-001'}]};
const orderScene=new THREE.Group(),orderViewport=new Element();orderViewport.closest=()=>shellRoot;
const orderEnv={...env,data:orderData,scene:orderScene,shell:{viewport:orderViewport,zoneButtons:new Element()},rackEntries:[{rack:{code:'W01'},group:rackGroup,slots}],
 createDrawingLift:()=>({platform:new THREE.Group()}),slotVisualState:()=>({visible:true,opacity:1,color:'#c79555'})};
const orderMount=window.WmsWarehouseDrawingScene.mount(orderEnv);
assert.equal(session.snapshot().mode,'orders');
orderMount.update(0);
const initialSpeeds=JSON.parse(orderViewport.dataset.operationActors);
assert.equal(initialSpeeds.find(actor=>actor.code==='AMR-001').speed,5);
assert.equal(initialSpeeds.find(actor=>actor.code==='SHUTTLE-001').speed,6.5,
 'Shuttle travel and lift use 130% of the configured speed without changing AMR speed.');
assert.equal(JSON.parse(orderViewport.dataset.operationJobs).filter(job=>job.cargoOwner==='dock:D01').length,7,
 'Inbound cartons are already stacked at the dock before Play.');
assert.equal(orderScene.children.filter(child=>child.name.startsWith('operation-pallet-JOB')&&child.visible).length,7);
session.play();
for(let time=0;time<=2200;time+=100)orderMount.update(time);
const dockJobs=JSON.parse(orderViewport.dataset.operationJobs);
assert.ok(dockJobs.filter(job=>job.cargoOwner==='dock:D01').length>=3,'Real work orders unload into a visible dock queue.');
assert.ok(dockJobs.some(job=>job.cargoOwner==='conveyor'),'The upper dock carton enters the conveyor first.');
let stored=false,storedAt=0,stationWaitJobId=null,shuttlePickedUp=false;
let maxStationPenetration=-Infinity;
for(let time=2300;time<=90000;time+=100){orderMount.update(time);
 const amr=JSON.parse(orderViewport.dataset.operationActors).find(actor=>actor.code==='AMR-001');
 maxStationPenetration=Math.max(maxStationPenetration,amr.position.x);
 const currentJobs=JSON.parse(orderViewport.dataset.operationJobs);
 const waiting=currentJobs.find(job=>job.cargoOwner==='station:S01');
 if(!stationWaitJobId&&waiting&&amr.state==='셔틀 인계 대기')stationWaitJobId=waiting.id;
 const waited=stationWaitJobId&&currentJobs.find(job=>job.id===stationWaitJobId);
 if(waited?.cargoOwner==='station:S01')assert.equal(amr.state,'셔틀 인계 대기',
  'AMR must remain assigned and waiting at the station until shuttle pickup.');
 if(waited?.cargoOwner==='SHUTTLE-001')shuttlePickedUp=true;
 stored||=JSON.parse(orderViewport.dataset.operationJobs).some(job=>job.cargoOwner.startsWith('rack:'));if(stored){storedAt=time;break;}}
assert.ok(stored,'A work-order carton reaches the rack.');
assert.ok(stationWaitJobId&&shuttlePickedUp,'Shuttle pickup occurs after AMR waits outside the station.');
assert.ok(maxStationPenetration+Math.hypot(.5,.5)/2<8,'Fork AMR must stay wholly outside the station at x=8.');
assert.ok(slots.some(slot=>slot.occupied),'Rack inventory changes within the simulation.');
let limited=false;
for(let time=storedAt+100;time<=240000;time+=100){orderMount.update(time);limited=session.snapshot().status==='limited';if(limited)break;}
assert.ok(limited,'After five entries, the remaining cartons wait at the dock without a deadlock.');
assert.equal(session.snapshot().jobs.filter(job=>job.done).length,5);
assert.equal(session.snapshot().jobs.filter(job=>job.cargo?.owner==='dock:D01').length,2);
const entries=JSON.parse(orderViewport.dataset.operationJobs).map(job=>job.conveyorEnteredAt).sort((a,b)=>a-b);
assert.equal(entries.filter(Number.isFinite).length,5);
entries.filter(Number.isFinite).slice(1).forEach((entry,index)=>assert.ok(entry-entries[index]>=4.999,
 'D01 cartons enter the conveyor at least five seconds apart.'));
orderMount.dispose();
const outboundObjects=orderObjects.map(object=>object.id==='CV01'?{...object,flowDirection:'reverse'}:
 object.id==='D01'?{...object,id:'D03'}:object);
const outboundSlot={...slots[0],occupied:true,stock:{itemCode:'ITEM1',quantity:1,status:'normal'}};
const outboundSlot2={...slots[1],occupied:true,stock:{itemCode:'ITEM1',quantity:1,status:'normal'}};
const outboundData={...orderData,meta:{...orderData.meta,plan:{objects:outboundObjects}},workOrders:[1,2].map(index=>({...workOrders[0],code:`OUT${index}`,direction:'출고',routeCode:'OUT01'})),
 operationRoutes:[{...orderData.operationRoutes[0],code:'OUT01',direction:'출고',dock:'D03'}]};
const outboundScene=new THREE.Group(),outboundViewport=new Element();outboundViewport.closest=()=>shellRoot;
const outboundMount=window.WmsWarehouseDrawingScene.mount({...orderEnv,data:outboundData,scene:outboundScene,
 shell:{viewport:outboundViewport,zoneButtons:new Element()},rackEntries:[{rack:{code:'W01'},group:rackGroup,slots:[outboundSlot,outboundSlot2]}]});
session.play();let loaded=false,bufferSeen=false,conveyorAfterBuffer=false,bufferAt=null,conveyorAt=null;
for(let time=0;time<=180000;time+=20){outboundMount.update(time);
 const job=session.snapshot().jobs[0];
 const owner=job.cargo?.owner;
 if(owner==='buffer:B01'){bufferSeen=true;bufferAt??=time;}
 if(bufferSeen&&owner==='conveyor'){conveyorAfterBuffer=true;conveyorAt??=time;}
 loaded=session.snapshot().jobs.every(job=>job.cargo?.owner==='truck:D03');if(loaded)break;}
assert.ok(bufferSeen&&conveyorAfterBuffer,'AMR unload at B01 immediately feeds the conveyor toward D03.');
assert.ok(conveyorAt-bufferAt<=100,'B01 handoff starts the conveyor without another AMR action.');
assert.ok(loaded,'Outbound work-order cargo moves from rack through B01 to D03 truck.');
assert.equal(outboundMount.truckProgress('D03','출고'),'상차 완료');
outboundMount.update(180100);
const stagedLoads=[1,2].map(index=>outboundScene.children.find(child=>child.name===`operation-pallet-OUT${index}`));
assert.ok(stagedLoads.every(load=>load.visible),'Completed outbound cartons remain visible at D03.');
assert.ok(stagedLoads.every(load=>load.position.x>=1&&load.position.x<=3&&load.position.z>=9&&load.position.z<=11));
assert.ok(stagedLoads.some(load=>load.position.x!==stagedLoads[0].position.x||load.position.z!==stagedLoads[0].position.z),
 'Outbound cartons accumulate at distinct D03 stack positions.');
assert.equal(outboundSlot.occupied,false,'The simulated pickup empties the rack slot.');
assert.equal(outboundSlot2.occupied,false);
outboundMount.dispose();
const cycleObjects=[...orderObjects.map(object=>object.id==='T01'?{...object,points:[
 {x:3,y:6},{x:6,y:6},{x:7.5,y:6},{x:7.5,y:4},{x:16,y:4},{x:16,y:6}]}:object),
 {id:'D02',kind:'D',x:4,y:9,w:2,h:2,angle:0},
 {id:'D03',kind:'D',x:15,y:9,w:2,h:2,angle:0},
 {id:'B03',kind:'B',x:15,y:5,w:2,h:2,angle:0},
 {id:'CV02',kind:'CV',points:[{x:5,y:9},{x:5,y:7},{x:2,y:7}],width:1.2},
 {id:'CV03',kind:'CV',points:[{x:16,y:7},{x:16,y:9}],width:1.2}];
const cycleSlots=Array.from({length:12},(_,index)=>({...slots[index%slots.length],locationCode:`CYCLE-${index+1}`,
 position:[0,0,index*.08],occupied:index<6,stock:index<6?{itemCode:'ITEM1',quantity:1,status:'normal'}:null}));
const cycleOrders=[...Array.from({length:6},(_,index)=>({...workOrders[0],code:`OUT-C${index+1}`,direction:'출고',routeCode:'OUT01'})),
 ...Array.from({length:8},(_,index)=>({...workOrders[0],code:`IN1-C${index+1}`,routeCode:'IN01'})),
 ...Array.from({length:8},(_,index)=>({...workOrders[0],code:`IN2-C${index+1}`,routeCode:'IN02'}))];
const cycleData={...orderData,meta:{...orderData.meta,plan:{objects:cycleObjects},actors:actors.map(actor=>({...actor,
 master:{...actor.master,configuredSpeed:40}}))},workOrders:cycleOrders,
 operationRoutes:[{...orderData.operationRoutes[0]},
  {...orderData.operationRoutes[0],code:'IN02',dock:'D02'},
  {...orderData.operationRoutes[0],code:'OUT01',direction:'출고',dock:'D03',buffer:'B03'}]};
const cycleScene=new THREE.Group(),cycleViewport=new Element();cycleViewport.closest=()=>shellRoot;
const cycleMount=window.WmsWarehouseDrawingScene.mount({...orderEnv,data:cycleData,scene:cycleScene,
 shell:{viewport:cycleViewport,zoneButtons:new Element()},rackEntries:[{rack:{code:'W01'},group:rackGroup,slots:cycleSlots}]});
session.play();let replenished=false,truckBatch=false,maxOnBelt=0,firstTruckAt=null,secondTruckAt=null;
for(let time=0;time<=300000;time+=100){cycleMount.update(time);
 const jobs=JSON.parse(cycleViewport.dataset.operationJobs);
 const queues=JSON.parse(cycleViewport.dataset.operationDockQueues);
 maxOnBelt=Math.max(maxOnBelt,jobs.filter(job=>job.cargoOwner==='conveyor').length);
 replenished||=jobs.some(job=>job.id.startsWith('SIM-D01-'))&&jobs.some(job=>job.id.startsWith('SIM-D02-'));
 const loaded=JSON.parse(cycleViewport.dataset.operationCycleTotals).출고;
 if(loaded>=4)firstTruckAt??=time;
 if(firstTruckAt!==null&&loaded>=8)secondTruckAt??=time;
 if(replenished&&firstTruckAt!==null&&secondTruckAt!==null&&queues.D01>=4&&queues.D02>=4)break;
}
assert.ok(replenished,'D01 and D02 receive simulation-only replenishment after their stacks fall.');
assert.ok(firstTruckAt!==null&&secondTruckAt>firstTruckAt,'D03 loads multiple four-box batches and keeps cycling.');
assert.equal(session.snapshot().status,'running','Work-order simulation stays running after initial jobs finish.');
assert.ok(maxOnBelt<=5,'No more than five cartons occupy the conveyor at once.');
const beforePause=cycleViewport.dataset.operationElapsed,pausedQueues=cycleViewport.dataset.operationDockQueues;
session.pause();cycleMount.update(900100);cycleMount.update(910000);
assert.equal(cycleViewport.dataset.operationElapsed,beforePause,'Pause freezes the continuous clock.');
assert.equal(cycleViewport.dataset.operationDockQueues,pausedQueues,'Pause freezes replenishment and loading.');
session.play();cycleMount.update(910100);cycleMount.update(910200);
assert.equal(session.snapshot().status,'running','Play resumes the same continuous run.');
session.stop();cycleMount.update(910300);
assert.equal(session.snapshot().status,'stopped');
assert.equal(JSON.parse(cycleViewport.dataset.operationJobs).some(job=>job.id.startsWith('SIM-')),false,
 'Stop restores the original work-order set.');
cycleMount.dispose();
console.log('PASS cargo scenes: real work-order dock stack, conveyor-to-rack and rack-to-truck, preview, pause and stop');
