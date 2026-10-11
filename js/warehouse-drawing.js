(function () {
  'use strict';
  const M = window.WmsFloorPlanModel;
  const mm = value => value * 1000;
  const numeric = (value, fallback=0) => String(value ?? '').trim()==='' ? fallback : Number(value);
  function convert(book, source) {
    const plan = M.read(source), api = window.wmsWarehouse3D, local = window.WmsWarehouseLocalData;
    const warnings = [];
    const rows = (name, range, required=true) => {
      try { return local.records(api, local.sheetCsv(book,name,range)); }
      catch(error) { if(required)throw error;warnings.push(error.message);return []; }
    };
    const csv = {};
    for (const [key,name,range] of [['rackTypes','랙타입 마스터','A4:H'],['zones','구역설정','A4:D'],['locations','로케이션 마스터','A4:ALL'],['items','품목 마스터','A4:C'],['inventory','재고 현황','A4:D'],['workOrders','작업지시','A1:R']]) {
      const sheet=book.sheets.find(s=>s.name===name);
      csv[key]=local.sheetCsv(book,name,range==='A4:ALL'?'A4:'+columnName(sheet?.columns||7):range);
    }
    // Read business tables through the established parser, without reading either legacy layout sheet.
    csv.floorPlan='Y\\X';
    csv.racks='랙코드,구역코드,랙타입코드,방향,베이 수(가로 칸 수),평면도 랙 전체 길이(m),평면도 랙 깊이(m)';
    const data=api.convertGoogleSheetCsv(csv), originalLocations=data.locations, originalInventory=data.inventory;
    const mappings=rows('3D 연결','A4:D',false).filter(r=>r['대상 코드'] && ['*',plan.name].includes(r['도면 이름']));
    const seen=new Set();
    mappings.forEach(r=>{const key=r['도면 이름']+'|'+r['대상 코드'];if(seen.has(key))throw Error('3D 연결: 중복 연결 '+key);seen.add(key);});
    const mapping=id=>mappings.find(r=>r['대상 코드']===id&&r['도면 이름']===plan.name)||mappings.find(r=>r['대상 코드']===id)||{};
    const types=new Map();
    data.racks=[]; data.locations=[];
    if(!data.zones.some(z=>z.code==='__UNASSIGNED__')) data.zones.push({code:'__UNASSIGNED__',name:'구역 미지정',purpose:''});
    for(const object of plan.objects.filter(o=>o.kind==='W')) {
      const layout=M.rackLayout(object,plan);
      if(!layout?.bays||!layout.rows) { warnings.push(object.id+': 랙 규격이 없어 배치 영역만 표시합니다.');continue; }
      const t=layout.type;
      types.set(t.id,{code:t.id,name:t.name,bayWidth:mm(t.bayWidth),depth:mm(t.depth),height:mm(t.height),levels:t.levels,levelHeight:mm(t.levelHeight||t.height/t.levels),depthCount:t.depthCount});
      let zone=mapping(object.id)['구역코드'];
      if(!data.zones.some(z=>z.code===zone)) { warnings.push(object.id+': 3D 연결 시트에서 구역코드를 지정하세요.');zone='__UNASSIGNED__'; }
      const actual={...object,x:object.x+(object.w-layout.actualW)/2,y:object.y+(object.h-layout.actualH)/2,w:layout.actualW,h:layout.actualH};
      const footprint=M.rectPolygon(actual), origin=footprint[0];
      const rack={code:object.id,zoneCode:zone,rackTypeCode:t.id,startX:mm(origin.x),startY:mm(origin.y),angle:object.angle,
        bayCount:layout.bays,rackRowCount:layout.rows,bayGap:mm(object.bayGap||0),rowGap:mm(object.rowGap||0),layoutSource:'drawing',
        footprint:{minX:mm(Math.min(...footprint.map(p=>p.x))),maxX:mm(Math.max(...footprint.map(p=>p.x))),minY:mm(Math.min(...footprint.map(p=>p.y))),maxY:mm(Math.max(...footprint.map(p=>p.y)))}};
      data.racks.push(rack);
      const configured=originalLocations.filter(l=>l.rackCode===object.id);
      if(object.locationPlan) {
        if(!M.sameLocationLayout(object.locationPlan.layout,M.locationLayout(layout))) {
          warnings.push(object.id+': 도면 로케이션 규격이 현재 랙과 달라 재고 연결을 보류했습니다.');continue;
        }
        for(const cell of object.locationPlan.cells) {
          const matches=originalLocations.filter(l=>l.locationCode===cell.code);
          if(matches.length>1)throw Error('중복 로케이션코드: '+cell.code);
          data.locations.push({locationCode:cell.code,rackCode:object.id,rackRow:cell.y+1,bay:cell.x+1,level:cell.level,depth:cell.depth,capacity:matches[0]?.capacity||0});
        }
      } else {
        data.locations.push(...configured.filter(l=>Number.isInteger(l.bay)&&l.bay>=1&&l.bay<=layout.bays&&Number.isInteger(l.rackRow)&&l.rackRow>=1&&l.rackRow<=layout.rows&&Number.isInteger(l.level)&&l.level>=1&&l.level<=t.levels&&Number.isInteger(l.depth)&&l.depth>=1&&l.depth<=t.depthCount));
      }
    }
    data.rackTypes=[...types.values()];
    if(data.racks.reduce((sum,r)=>{const t=types.get(r.rackTypeCode);return sum+r.bayCount*r.rackRowCount*t.levels*t.depthCount;},0)>100000)throw Error('3D는 도면당 100,000셀까지 표시합니다. 도면을 나누어 주세요.');
    const locations=new Map(),positions=new Set();
    for(const l of data.locations) {
      const key=[l.rackCode,l.rackRow,l.bay,l.level,l.depth].join('|');
      if(locations.has(l.locationCode)||positions.has(key))throw Error('로케이션 마스터: 중복 코드 또는 셀 위치 '+l.locationCode);
      locations.set(l.locationCode,l);positions.add(key);
    }
    const stockCodes=new Set();
    data.inventory=originalInventory.flatMap(stock=>{
      const l=locations.get(stock.locationCode);
      if(!l||!data.items.some(item=>item.code===stock.itemCode))return [];
      if(stockCodes.has(stock.locationCode))throw Error('재고 현황: 중복 로케이션 '+stock.locationCode);
      stockCodes.add(stock.locationCode);return [{...stock,...l,quantity:stock.quantity}];
    });
    const omitted=originalInventory.length-data.inventory.length;
    if(omitted)warnings.push('현재 도면에 연결되지 않은 재고 '+omitted+'건은 표시하지 않습니다. 원본 기준정보는 보존됩니다.');
    let equipment=[],statuses=[];
    try{equipment=api.parseEquipmentMaster(local.sheetCsv(book,'설비 마스터','A1:F1000'));}catch(e){warnings.push(e.message);}
    try{statuses=api.parseEquipmentStatus(local.sheetCsv(book,'설비 상태 정보','A2:O1000'));}catch(e){warnings.push(e.message);}
    const equipmentCodes=new Set();
    const actors=plan.objects.filter(o=>M.equipmentKinds.includes(o.kind)).map(o=>{
      const code=mapping(o.id)['기준정보 코드']||o.id, master=equipment.find(e=>e.code===code), status=statuses.find(e=>e.equipmentCode===code);
      if(equipmentCodes.has(code))throw Error('3D 연결: 여러 장비에 같은 설비 코드가 연결되었습니다: '+code);
      equipmentCodes.add(code);
      if(!master)warnings.push(o.id+': 입출고 작업용 설비 마스터 '+code+'가 없습니다. 지정 경로 반복 주행은 사용할 수 있습니다.');
      if(!status)warnings.push(o.id+': 설비 상태 정보 '+code+'가 없습니다.');
      if(!plan.objects.some(p=>p.id===o.routeId&&p.kind===(o.kind==='SH'?'GR':'T')))warnings.push(o.id+': 평면도에서 이동 경로를 지정하세요.');
      return {...o,code,master,status};
    });
    data.equipment=[];data.equipmentStatuses=[]; // Exact drawing actors replace the legacy automatically placed fleet.
    try{data.operationRoutes=window.WmsWarehouseOperations.parseRoutes(rows('운영 경로','A1:I500'));}catch(e){warnings.push(e.message);data.operationRoutes=[];}
    data.workOrders=data.workOrders.filter(w=>w.code);
    const orderCodes=new Set();
    for(const order of data.workOrders){if(orderCodes.has(order.code))throw Error('작업지시: 중복 작업 코드 '+order.code);orderCodes.add(order.code);}
    for(const order of data.workOrders.filter(w=>!['완료','취소'].includes(w.status)))if(!data.operationRoutes.some(r=>r.enabled&&r.code===order.routeCode))warnings.push(order.code+': 사용 가능한 운영 경로가 없습니다.');
    const truckSchedules=data.meta.truckSchedules.map(schedule=>{const route=data.operationRoutes.find(r=>r.code===schedule.routeCode&&r.enabled);return route?{...schedule,dockCode:route.dock,workType:route.direction}:schedule;});
    const dockRegions=plan.objects.filter(o=>o.kind==='D').map(o=>{const b=M.bounds(o);return {code:o.id,bounds:{minX:mm(b.x),maxX:mm(b.x+b.w),minZ:mm(b.y),maxZ:mm(b.y+b.h)}};});
    data.meta={name:plan.name,source:'drawing',floorWidth:mm(plan.width),floorDepth:mm(plan.height),floorPlanCellSize:mm(plan.grid),
      passageCells:[],shuttlePassageCells:[],conveyorCells:[],barcodeTunnelCells:[],dockCells:[],bufferCells:[],stationCells:[],truckSchedules,dockRegions,
      warnings,plan,actors,warehouseCellCount:0,warehouseGapCount:0};
    return data;
  }
  function columnName(n) {let result='';while(n){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;}
  // Continuous centerlines, subdivided only for motion. Width and endpoints are never snapped to cells.
  function graph(plan, ids, diameter=0, directed=false) {
    const paths=plan.objects.filter(o=>ids.includes(o.id)&&o.points), edges=[];
    for(const path of paths)for(const edge of M.pathSegments(path)) {
      if(path.width*1000+1e-6<diameter)continue;
      const direction=directed?M.segmentDirection(path,edge.lineId,edge.index):'both';
      edges.push({...edge,width:path.width,pathId:path.id,direction});
    }
    const nodes=[],nodesByKey=new Map(), links=[];
    const add=(p,suffix)=>{const key=p.x.toFixed(6)+':'+p.y.toFixed(6)+suffix;if(!nodesByKey.has(key)){const n={key,x:p.x*1000,y:p.y*1000,neighbors:[]};nodesByKey.set(key,n);nodes.push(n);}return nodesByKey.get(key);};
    for(const [edgeIndex,edge] of edges.entries()) {
      const {a,b}=edge,dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy),cuts=[0,1],junctions=[0,1];
      // Join an endpoint on another line; mere crossings without a point are not invented junctions.
      for(const other of edges)for(const p of [other.a,other.b]){
        const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/(len*len);
        if(t>0&&t<1&&Math.hypot(a.x+t*dx-p.x,a.y+t*dy-p.y)<1e-6){cuts.push(t);junctions.push(t);}
      }
      for(let i=1;i<Math.ceil(len/.25);i++)cuts.push(i/Math.ceil(len/.25));
      const values=[...new Set(cuts)].sort((a,b)=>a-b);
      const line=values.map(t=>add({x:a.x+dx*t,y:a.y+dy*t},junctions.some(j=>Math.abs(j-t)<1e-9)?'':':edge'+edgeIndex));
      for(let i=1;i<line.length;i++)links.push([line[i-1],line[i],edge.direction]);
    }
    for(const [a,b,direction] of links) {
      if(direction!=='reverse'&&!a.neighbors.includes(b.key))a.neighbors.push(b.key);
      if(direction!=='forward'&&!b.neighbors.includes(a.key))b.neighbors.push(a.key);
    }
    return {nodes,nodesByKey,step:250,vehicleDiameter:diameter,edges};
  }
  window.WmsWarehouseDrawing={convert,graph};
})();
