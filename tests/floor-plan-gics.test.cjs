const assert=require('assert/strict'),M=require('../js/floor-plan-model.js');
const plan=M.sample();plan.name='창고 1';plan.objects[0].x=2.123;plan.objects[0].snapAnchor='center';plan.objects[0].rowGap=.25;
const bytes=M.serializeFile(plan),file=JSON.parse(bytes);assert.equal(file.format,'gics-floor-plan');assert.equal(file.version,1);assert.deepEqual(M.readFile(file),M.read(plan));assert.deepEqual(M.readFile(plan),M.read(plan));assert.equal(file.documents,undefined);assert.equal(M.fileName(plan),'창고 1.gics');assert.equal(M.fileName({...plan,name:'A/B\\C:*?<>|". '}),'A_B_C_______.gics');
const legacy=require('./fixtures/floor-plan-v1.json');assert.deepEqual(M.readFile(legacy),M.read(legacy));
assert.throws(()=>M.readFile({...file,version:2}),/gics/);assert.throws(()=>M.readFile({...file,documents:[]}),/gics/);assert.throws(()=>M.readFile({...file,plan:null}),/gics/);assert.throws(()=>M.readFile({...file,plan:{...plan,objects:[plan.objects[0],plan.objects[0]]}}),/중복/);assert.throws(()=>M.readFile({format:'other',version:1}),/지원/);
console.log('GICS single-drawing format: roundtrip geometry/rack/axis, version guards, legacy JSON, duplicate rejection and filename passed.');
