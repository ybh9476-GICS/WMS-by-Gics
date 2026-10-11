const M=require('../../js/floor-plan-model.js');
module.exports=function fixture(outbound=false){
  const book=JSON.parse(JSON.stringify(require('../../data/wms-reference-seed.json')));
  const set=(name,headerRow,headers,rows)=>{const s=book.sheets.find(s=>s.name===name);s.cells=[...headers.map((v,c)=>[headerRow,c+1,v]),...rows.flatMap((values,r)=>values.map((v,c)=>[headerRow+r+1,c+1,String(v)]))];s.columns=Math.max(s.columns,headers.length);};
  const plan=M.blank();plan.name='연결 검증 창고';plan.width=20;plan.height=15;
  plan.rackTypes=[{id:'R1',name:'검증 랙',bayWidth:1,depth:1,height:1,levelHeight:1,levels:1,depthCount:1}];
  plan.objects=[
    {id:'W01',kind:'W',x:10,y:3.1,w:1,h:1,angle:0,rackTypeId:'R1',bayGap:0,rowGap:0},
    {id:'W02',kind:'W',x:14,y:2,w:2.4,h:2.6,angle:33,rackTypeId:'R1',bayGap:.2,rowGap:.4,margin:.2},
    {id:'D01',kind:'D',x:1,y:9,w:2,h:2,angle:0},
    {id:'B01',kind:'B',x:1,y:5,w:2,h:2,angle:0},
    {id:'S01',kind:'S',x:8,y:5,w:2,h:2,angle:0},
    {id:'CV01',kind:'CV',points:[{x:2,y:9},{x:2,y:7}],width:1.2,cap:'butt'},
    {id:'T01',kind:'T',points:[{x:3,y:6},{x:6,y:6},{x:8,y:6}],width:1.5,cap:'butt',branches:[{id:'B1',from:1,points:[{x:6,y:8},{x:8,y:9}]}]},
    {id:'GR01',kind:'GR',points:[{x:9,y:7},{x:10.5,y:7},{x:10.5,y:4.2}],width:1.2,cap:'butt'},
    {id:'BT01',kind:'BT',x:1.5,y:7.5,w:1,h:1.2,angle:90,conveyorId:'CV01',offset:1},
    {id:'FA01',kind:'FA',x:2.75,y:5.75,w:.5,h:.5,height:1,angle:0,routeId:'T01'},
    {id:'SH01',kind:'SH',x:8.75,y:6.75,w:.5,h:.5,height:.15,angle:0,routeId:'GR01'},
    {id:'AMR01',kind:'AMR',x:16,y:11,w:.7,h:.6,height:.3,angle:26,routeId:''}
  ];
  for(const o of plan.objects)o.locked=false;
  plan.objects[0].locationPlan=M.generateRackLocations(plan.objects[0],plan);
  const loc=plan.objects[0].locationPlan.cells[0].code;
  set('로케이션 마스터',4,['로케이션코드','랙코드','베이번호','단번호','깊이번호','최대수량','랙열번호'],[[loc,'W01',1,1,1,10,1]]);
  set('재고 현황',4,['로케이션코드','품목코드','재고수량','재고상태'],[]);
  set('품목 마스터',4,['품목코드','품목명','표시색상'],[['ITEM1','검증 상품','#22c55e']]);
  set('설비 마스터',1,['설비 코드','설비명','사용 여부','모델명','타입','설정 이동 속도(m/s)'],[['AMR-001','검증 지게차','Y','F1','AMR',10],['4SHUTTLE-001','검증 셔틀','Y','S1','4WAY',10]]);
  set('설비 상태 정보',2,['설비 코드','통신 연결','설비 상태'],[['AMR-001','ONLINE','대기'],['4SHUTTLE-001','ONLINE','대기']]);
  set('운영 경로',1,['경로 코드','작업 구분','도크 코드','버퍼 코드','스테이션 코드','AMR 코드','사용 여부','버퍼 수용 팔레트','우선순위'],[['IN1','입고','D01','B01','S01','AMR-001','Y',1,1]]);
  set('작업지시',1,['작업 코드','작업 구분','품목코드','수량(개)','배정 설비','경로 코드','작업 상태'],[['JOB1','입고','ITEM1',1,'AMR-001','IN1','대기']]);
  book.sheets.push({name:'3D 연결',rows:200,columns:4,cells:[[4,1,'도면 이름'],[4,2,'대상 코드'],[4,3,'구역코드'],[4,4,'기준정보 코드'],[5,1,'*'],[5,2,'W01'],[5,3,'A01'],[6,1,'*'],[6,2,'W02'],[6,3,'A01'],[7,1,'*'],[7,2,'FA01'],[7,4,'AMR-001'],[8,1,'*'],[8,2,'SH01'],[8,4,'4SHUTTLE-001']]});
  if(outbound){
    plan.objects.find(o=>o.kind==='CV').flowDirection='reverse';
    const inventory=book.sheets.find(s=>s.name==='재고 현황');inventory.cells.push([5,1,loc],[5,2,'ITEM1'],[5,3,'1'],[5,4,'정상']);
    for(const name of ['운영 경로','작업지시'])book.sheets.find(s=>s.name===name).cells.forEach(cell=>{if(cell[0]===2&&cell[1]===2)cell[2]='출고';});
  }
  return {book,plan:M.read(plan),locationCode:loc};
};
