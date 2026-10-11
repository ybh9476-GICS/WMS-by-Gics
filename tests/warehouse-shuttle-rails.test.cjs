const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const M=require('../js/floor-plan-model.js'),window={};
for(const file of ['warehouse-conveyor-layout','warehouse-shuttle-rails'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/'+file+'.js'),'utf8'),{window});
const G=window.WmsWarehouseConveyorLayout,api=window.WmsWarehouseShuttleRails;
const gr=(id,points,width=1)=>({id,kind:'GR',width,points:points.map(([x,y])=>({x,y}))});
const cases={straight:[gr('GR1',[[0,0],[5,0]])],corner:[gr('GR1',[[0,0],[5,0],[5,5]])],
 diagonal:[gr('GR1',[[0,0],[5,0],[8,4]])],short:[gr('GR1',[[0,0],[.3,0],[.3,.3],[.6,.3]])],
 tee:[gr('GR1',[[0,0],[5,0],[10,0]]),gr('GR2',[[5,0],[5,5]])],
 branches:[{...gr('GR1',[[0,0],[5,0],[10,0]]),branches:[{id:'B1',from:1,points:[{x:5,y:5}]}]}],
 loop:[{...gr('GR1',[[0,0],[5,0],[5,5],[0,5]]),closed:true}],
 duplicate:[gr('GR1',[[0,0],[5,0]]),gr('GR2',[[5,0],[0,0]])],
 unequal:[gr('GR1',[[0,0],[5,0]],1.5),gr('GR2',[[5,0],[5,5]],.8)]};
const sum=polys=>polys.reduce((a,p)=>a+G.area(p),0);
const intersect=(a,b)=>G.area(a)-sum(G.subtract(a,b));
const contains=(poly,p)=>poly.every((a,i)=>{const b=poly[(i+1)%poly.length];return (b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x)>=-1e-8;});
for(const [name,objects] of Object.entries(cases)){
 const before=JSON.stringify(objects),result=api.build(objects,M.pathSegments),polys=result.pieces.map(p=>p.poly);
 assert.equal(JSON.stringify(objects),before);assert.ok(polys.length);
 for(let i=0;i<polys.length;i++){
  let outside=[polys[i]];for(const p of result.outer)outside=outside.flatMap(q=>G.subtract(q,p));assert.ok(sum(outside)<1e-7,name+': rail protrudes');
  for(const p of result.inner)assert.ok(intersect(polys[i],p)<1e-7,name+': rail blocks travel corridor');
  for(let j=0;j<i;j++)assert.ok(intersect(polys[i],polys[j])<1e-7,name+': overlapping rails');
 }
 // Every boundary band must be filled, including outside corners and junctions.
 for(const outer of result.outer){let missing=[outer];for(const p of [...result.inner,...polys])missing=missing.flatMap(q=>G.subtract(q,p));assert.ok(sum(missing)<1e-7,name+': disconnected rail');}
 if(name==='corner'){
  for(const p of [{x:5.465,y:-.465},{x:4.535,y:.535}])assert.ok(polys.some(poly=>contains(poly,p)),'corner joint must close');
  for(const p of [{x:4.5,y:.2},{x:4.9,y:.5}])assert.ok(!polys.some(poly=>contains(poly,p)),'old crossing ends must be removed');
  assert.ok(Math.abs(sum(polys)-1.4)<1e-7);
 }
 console.log('PASS GR rails:',name,'connected, contained, non-overlapping');
}
