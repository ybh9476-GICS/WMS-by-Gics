const assert=require('assert/strict');
const M=require('../js/floor-plan-model.js');

const plan=M.blank();plan.width=50;plan.height=50;
const conveyor={id:'CV01',kind:'CV',points:[{x:5,y:10},{x:25,y:10}],branches:[{id:'B1',from:1,points:[{x:25,y:25},{x:35,y:25}]}],segmentDirections:{main:['forward'],B1:['reverse','forward']},width:1.5,cap:'butt',locked:false};
const other={id:'CV02',kind:'CV',points:[{x:40,y:5},{x:40,y:30}],width:1.5,cap:'butt',locked:false};
plan.objects=[conveyor,other];
const tunnel={id:'BT01',kind:'BT',x:0,y:0,w:2,h:1.5,angle:0,conveyorId:'',offset:0,locked:false};

let match=M.closestConveyorSegment(plan,{x:25,y:20});
assert.equal(match.cv.id,'CV01');assert.equal(match.edge.lineId,'B1');
M.placeTunnelOnSegment(tunnel,match);plan.objects.push(tunnel);
assert.deepEqual(tunnel.placement,{lineId:'B1',index:0,position:10});
assert.deepEqual([tunnel.x+tunnel.w/2,tunnel.y+tunnel.h/2,tunnel.angle],[25,20,90]);
assert.equal(tunnel.flowDirection,'reverse','the tunnel follows the selected branch flow');
assert.deepEqual(M.validate(M.read(plan)),[],'branch tunnel has no false main-path warnings');
assert.deepEqual(M.readFile(JSON.parse(M.serializeFile(plan))).objects.find(o=>o.id==='BT01').placement,tunnel.placement,'branch attachment survives .gics save and open');

match=M.closestConveyorSegment(plan,{x:tunnel.x+tunnel.w/2,y:tunnel.y+tunnel.h/2},{conveyorId:'CV02',tunnelLength:tunnel.w,fitOnly:true});
M.placeTunnelOnSegment(tunnel,match);
assert.equal(tunnel.conveyorId,'CV02');assert.equal(tunnel.x+tunnel.w/2,40);
assert.deepEqual(M.validate(M.read(plan)),[],'dropdown reassignment aligns the tunnel');

match=M.closestConveyorSegment(plan,{x:18,y:10});M.placeTunnelOnSegment(tunnel,match);
assert.deepEqual(tunnel.placement,{lineId:'main',index:0,position:13});
assert.equal(tunnel.conveyorId,'CV01');
conveyor.points[1].y=13;
assert.equal(M.followTunnelPlacement(tunnel,plan),true);
assert.equal(tunnel.placement.lineId,'main');
assert.deepEqual(M.validate(M.read(plan)),[],'attached tunnel follows edited conveyor geometry');

const short={id:'CV03',kind:'CV',points:[{x:2,y:35},{x:3,y:35}],width:1.5,cap:'butt'};
plan.objects.push(short);
match=M.closestConveyorSegment(plan,{x:2.5,y:35},{conveyorId:'CV03'});
assert.throws(()=>M.placeTunnelOnSegment(tunnel,match),/직선 구간보다 깁니다/);

const legacy=M.blank();legacy.objects=[{id:'CV01',kind:'CV',points:[{x:5,y:5},{x:5,y:15}],width:1.5,cap:'butt'},{id:'BT01',kind:'BT',x:4,y:9.25,w:2,h:1.5,angle:90,conveyorId:'CV01',offset:5}];
const opened=M.readFile(JSON.parse(M.serializeFile(legacy))).objects[1];
assert.equal(opened.offset,5);assert.deepEqual(opened.placement,{lineId:'main',index:0,position:5},'aligned legacy tunnel gains a main-path attachment');
assert.deepEqual([opened.x,opened.y,opened.angle],[4,9.25,90],'legacy migration does not move or rotate the tunnel');

const legacyBranch=M.blank();legacyBranch.width=50;legacyBranch.height=50;
legacyBranch.objects=[{id:'CV01',kind:'CV',points:[{x:5,y:10},{x:25,y:10}],branches:[{id:'B1',from:1,points:[{x:25,y:25}]}],segmentDirections:{main:['forward'],B1:['reverse']},width:1.5,cap:'butt'},{id:'BT02',kind:'BT',x:24,y:19.25,w:2,h:1.5,angle:270,flowDirection:'forward',conveyorId:'CV01',offset:0}];
const migrated=M.read(legacyBranch),branchTunnel=migrated.objects[1];
assert.deepEqual(branchTunnel.placement,{lineId:'B1',index:0,position:10},'legacy tunnel on a branch gains its actual section');
assert.deepEqual([branchTunnel.x,branchTunnel.y,branchTunnel.angle,branchTunnel.flowDirection],[24,19.25,270,'forward'],'branch migration preserves geometry and flow');
assert.deepEqual(M.validate(migrated),[],'legacy branch placement no longer emits the stale main-path warning');
const branchRoundtrip=M.readFile(JSON.parse(M.serializeFile(migrated))).objects[1];
assert.deepEqual(branchRoundtrip,branchTunnel,'branch migration survives .gics roundtrip');
legacyBranch.objects[1].x=23;
const unaligned=M.read(legacyBranch);
assert.equal(unaligned.objects[1].placement,undefined,'off-path tunnel is not migrated by guesswork');
assert.ok(M.validate(unaligned).some(issue=>issue.id==='BT02'),'off-path tunnel still warns');
legacyBranch.objects[1].x=24;legacyBranch.objects[1].angle=90;
const wrongDirection=M.read(legacyBranch);
assert.equal(wrongDirection.objects[1].placement,undefined,'opposite-flow tunnel is not migrated by guesswork');
assert.ok(M.validate(wrongDirection).some(issue=>issue.id==='BT02'),'opposite-flow tunnel still warns');
console.log('Tunnel placement: branch click, dropdown reassignment, drag-equivalent matching, CV follow, short segment and legacy .gics passed.');
