const assert=require('node:assert/strict');
const M=require('../js/floor-plan-model.js');

const plan=M.blank();
plan.objects=[
 {id:'GR01',kind:'GR',points:[{x:3,y:6},{x:12,y:6}],width:1.5,locked:false},
 {id:'T01',kind:'T',points:[{x:3,y:12},{x:20,y:12}],width:1.5,locked:false},
 {id:'SH01',kind:'SH',x:6,y:5.5,w:1,h:1,height:.12,angle:0,routeId:'GR01',locked:false},
 {id:'FA01',kind:'FA',x:7,y:11.5,w:1.5,h:1,height:2,angle:0,routeId:'T01',locked:false},
 {id:'AMR01',kind:'AMR',x:12,y:11.5,w:1,h:1,height:.25,angle:0,routeId:'T01',locked:false}
];
const normalized=M.read(plan);
assert.deepEqual(M.equipmentKinds,['SH','FA','AMR']);
assert.deepEqual(M.validate(normalized),[],'equipment may occupy its track without a collision warning');
assert.deepEqual(M.readFile(JSON.parse(M.serializeFile(normalized))).objects.slice(2),normalized.objects.slice(2),'dimensions, height and route survive .gics save/open');

const outside=M.clone(normalized);
outside.objects[2].x=-2;
outside.objects[3].x=outside.width+2;
outside.objects[4].y=outside.height+2;
const outsideRead=M.read(outside);
assert.deepEqual(M.readFile(JSON.parse(M.serializeFile(outsideRead))).objects.slice(2),outsideRead.objects.slice(2),'equipment outside the grid survives .gics save/open');
const facilityOutside=M.clone(normalized);facilityOutside.objects[0].points[0].y=.1;facilityOutside.objects[0].points[1].y=.1;
assert.throws(()=>M.read(facilityOutside),/도면 경계/,'facilities remain inside the grid');

const missing=M.clone(normalized);missing.objects[1].id='T02';
assert.match(M.validate(missing).find(issue=>issue.id==='AMR01').message,/이동할 T 경로/);
const invalid=M.clone(normalized);invalid.objects[2].height=0;
assert.throws(()=>M.read(invalid),/높이/);
console.log('Logistics equipment: outside-grid placement, facility boundary, route overlay, height validation and .gics roundtrip passed.');
