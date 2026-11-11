const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),M=require('../js/floor-plan-model.js');
const window={WmsFloorPlanModel:M};for(const file of ['warehouse-drawing','warehouse-route-preview'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/'+file+'.js'),'utf8'),{window});
const plan={objects:[{id:'T1',kind:'T',width:2,points:[{x:0,y:0},{x:2,y:0},{x:4,y:0}],branches:[{id:'B1',from:1,points:[{x:2,y:2}]}]},{id:'GR1',kind:'GR',width:1,points:[{x:0,y:5},{x:3,y:5}]}]};
const actors=[{id:'A1',code:'A1',kind:'AMR',x:0,y:0,w:.5,h:.5,angle:0,routeId:'T1'},{id:'S1',code:'S1',kind:'SH',x:0,y:5,w:.5,h:.5,angle:0,routeId:'GR1'},{id:'A2',code:'A2',kind:'AMR',x:0,y:0,w:3,h:3,angle:0,routeId:'T1'},{id:'A3',code:'A3',kind:'AMR',x:9,y:9,w:1,h:1,angle:0,routeId:''}];
const before=JSON.stringify({plan,actors}),sim=window.WmsWarehouseRoutePreview.create(plan,actors,.2);let branch=false,left=false,right=false;
for(let i=0;i<400;i++){sim.tick(.1);const p=sim.actors.get('A1').position;assert.ok((Math.abs(p.z)<1e-8&&p.x>=0&&p.x<=4)||(Math.abs(p.x-2)<1e-8&&p.z>=0&&p.z<=2));branch||=p.z>1.5;left||=p.x<.1;right||=p.x>3.9;const s=sim.actors.get('S1').position;assert.equal(s.z,5);assert.ok(s.x>=0&&s.x<=3);}
assert.ok(branch&&left&&right,'all connected branches repeat');assert.match(sim.actors.get('A2').status,/폭/);assert.match(sim.actors.get('A3').status,/미지정/);assert.equal(JSON.stringify({plan,actors}),before);assert.equal(sim.actors.get('A1').speed,1);
assert.equal(sim.actors.get('S1').speed,1.3,'Only the shuttle moves 30% faster in route preview.');
const stationPlan={objects:[1,2,3].flatMap(index=>{
 const y=index*5-.5;
 return [{id:`S0${index}`,kind:'S',x:13.5,y:y-.5,w:1,h:1,angle:0},
  {id:`T0${index}`,kind:'T',width:1.5,points:[{x:14.5,y},{x:22,y}]}];
})};
const forklifts=[1,2,3].map(index=>({id:`FA0${index}`,code:`FA0${index}`,kind:'FA',x:-3,y:index*5-1.5,w:1.5,h:1,angle:0,routeId:`T0${index}`,master:{configuredSpeed:2}}));
const stationRun=window.WmsWarehouseRoutePreview.create(stationPlan,forklifts,0);
const clearance=Math.hypot(1.5,1)/2;
for(let i=0;i<600;i++){
 stationRun.tick(.1);
 for(const forklift of forklifts){
  const p=stationRun.actors.get(forklift.code).position;
  assert.ok(p.x-clearance>14.5,`${forklift.id} must stay wholly outside its shuttle station`);
 }
}
const crossingPlan={objects:[{id:'S01',kind:'S',x:13.5,y:4,w:1,h:1,angle:0},
 {id:'T01',kind:'T',width:1.5,points:[{x:12,y:4.5},{x:16,y:4.5}]}]};
const safeGraph=window.WmsWarehouseDrawing.amrGraph(crossingPlan,['T01'],forklifts[0]);
assert.ok(safeGraph.nodes.every(node=>Math.abs(node.x/1000-14)>.5+clearance),
 'AMR route graph excludes nodes that put any part of the vehicle inside a station.');
assert.ok(safeGraph.nodes.every(node=>node.neighbors.every(key=>{
 const other=safeGraph.nodesByKey.get(key);return !(node.x<13500&&other.x>14500||other.x<13500&&node.x>14500);
})), 'AMR links cannot cut through a station.');
const cargo=window.WmsWarehouseRoutePreview.createCargo([{code:'IN1',dock:'D01',direction:'입고',width:.8,height:.6,
 source:{x:0,y:.1,z:0},target:{x:4,y:.1,z:0},path:[{x:1,y:1,z:0},{x:3,y:1,z:0}]}]);
assert.equal(cargo.loads.length,3);assert.ok(cargo.loads.every(load=>!load.visible));assert.equal(cargo.truckProgress('D01','입고'),'하차 대기');
cargo.tick(.6);assert.ok(cargo.loads[0].visible);assert.ok(!cargo.loads[1].visible);assert.equal(cargo.truckProgress('D01','입고'),'하차 중');
cargo.tick(3);assert.ok(cargo.loads.every(load=>load.visible));assert.equal(cargo.loads[2].position.y-cargo.loads[1].position.y,.68);assert.equal(cargo.truckProgress('D01','입고'),'하차 완료');
cargo.tick(1.3);assert.ok(cargo.loads[2].position.x>0,'Top pallet leaves the stack first.');assert.equal(cargo.loads[1].position.x,0);
const pausedPosition=cargo.loads[2].position.x;cargo.tick(0);assert.equal(cargo.loads[2].position.x,pausedPosition);
for(let i=0;i<300;i++)cargo.tick(.1);
assert.ok(cargo.loads.some(load=>load.visible),'Preview repeats after reaching the buffer.');
cargo.reset();assert.ok(cargo.loads.every(load=>!load.visible));assert.equal(cargo.truckProgress('D01','입고'),'하차 대기');
assert.equal(cargo.truckProgress('D99','입고'),null);
const outbound=window.WmsWarehouseRoutePreview.createCargo([{code:'OUT1',dock:'D02',direction:'출고',width:.8,height:.6,
 source:{x:4,y:.1,z:0},target:{x:0,y:.1,z:0},path:[{x:3,y:1,z:0},{x:1,y:1,z:0}]}]);
assert.equal(outbound.truckProgress('D02','출고'),'상차 대기');
let loading=false,loaded=false;
for(let i=0;i<300;i++){outbound.tick(.1);loading||=outbound.truckProgress('D02','출고')==='상차 중';loaded||=outbound.truckProgress('D02','출고')==='상차 완료';}
assert.ok(loading&&loaded,'Outbound preview reaches the truck and completes loading.');
console.log('PASS route preview: repeat/end reversal/branches, T vs GR, no master requirement, width/unassigned guards, source preservation');
