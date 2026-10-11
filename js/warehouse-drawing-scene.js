(function () {
  'use strict';
  const M=window.WmsFloorPlanModel, Ops=window.WmsWarehouseOperations;
  const radians=angle=>angle*Math.PI/180;
  const center=o=>({x:o.x+o.w/2,y:o.y+o.h/2});
  function tunnels(plan) {
    return plan.objects.filter(o=>o.kind==='BT').map(o=>{
      const p=center(o), bounds=M.bounds(o);
      return {code:o.id,axis:'x',x:p.x,z:p.y,width:o.h,length:o.w,yaw:Math.PI/2-radians(o.angle),
        angle:radians(o.angle),minX:bounds.x,maxX:bounds.x+bounds.w,minZ:bounds.y,maxZ:bounds.y+bounds.h};
    });
  }
  function nearest(graph,p,maxDistance=Infinity) {
    let result=null,distance=maxDistance;
    for(const n of graph.nodes){const d=Math.hypot(n.x/1000-p.x,n.y/1000-p.y);if(d<=distance){distance=d;result=n;}}
    return result;
  }
  function access(graph,o,gap=.15) {
    if(!o)return null;
    const c=center(o),a=-radians(o.angle),cos=Math.cos(a),sin=Math.sin(a);
    return graph.nodes.filter(n=>{
      const dx=n.x/1000-c.x,dy=n.y/1000-c.y,x=dx*cos-dy*sin,y=dx*sin+dy*cos;
      return Math.hypot(Math.max(Math.abs(x)-o.w/2,0),Math.max(Math.abs(y)-o.h/2,0))<=gap;
    }).sort((a,b)=>Math.hypot(a.x/1000-c.x,a.y/1000-c.y)-Math.hypot(b.x/1000-c.x,b.y/1000-c.y))[0]||null;
  }
  function mount(env) {
    const {THREE,shell,data,scene,signal,rackEntries,createTaskLoad,setSlotInstanceVisible,warehouseFloorElevation:floorY}=env;
    const plan=data.meta.plan, resources=new Set(), root=new THREE.Group(), models=new Map(), cargoModels=new Map(), lifts=new Map();
    root.name='DRAWING-EXACT-GEOMETRY';scene.add(root);
    const boxGeometry=new THREE.BoxGeometry(1,1,1);resources.add(boxGeometry);
    const materials=new Map();
    function material(color){if(!materials.has(color)){const m=new THREE.MeshStandardMaterial({color,roughness:.6,metalness:.3});materials.set(color,m);resources.add(m);}return materials.get(color);}
    function box(parent,size,position,color){const mesh=new THREE.Mesh(boxGeometry,material(color));mesh.scale.set(...size);mesh.position.set(...position);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;}
    function boundary(parent,size,position,color){const key='line:'+color;if(!materials.has(key)){const lineMaterial=new THREE.MeshBasicMaterial({color});materials.set(key,lineMaterial);resources.add(lineMaterial);}const mesh=box(parent,size,position,color);mesh.material=materials.get(key);mesh.castShadow=false;return mesh;}
    function group(o){const g=new THREE.Group(),c=center(o);g.name=o.id;g.position.set(c.x,floorY,c.y);g.rotation.y=-radians(o.angle);g.userData={drawingId:o.id,kind:o.kind};root.add(g);return g;}
    function label(parent,text,height){const sprite=env.createLabel(text);sprite.position.y=height;resources.add(sprite.material);resources.add(sprite.material.map);parent.add(sprite);}
    const levels=[...new Set([0,...data.rackTypes.flatMap(t=>Array.from({length:t.levels},(_,i)=>i*t.levelHeight/1000))])];
    const conveyors=window.WmsWarehouseConveyorLayout.build(plan.objects,M.pathSegments,M.segmentDirection);
    for(const entry of conveyors.models){
      const geometryGroup=new THREE.Group();geometryGroup.name=entry.id;geometryGroup.position.set(entry.position[0],floorY,entry.position[1]);geometryGroup.rotation.y=-entry.angle;root.add(geometryGroup);
      const model=env.createConveyor(entry.layout);geometryGroup.add(model.group);model.resources.forEach(resource=>resources.add(resource));
    }
    const shuttleRails=window.WmsWarehouseShuttleRails.build(plan.objects,M.pathSegments),railGroup=new THREE.Group(),frame=env.originalShuttleFrame;
    railGroup.name='GR-CONNECTED-RAILS';root.add(railGroup);
    for(const piece of shuttleRails.pieces){
      const shape=new THREE.Shape(piece.poly.map(p=>new THREE.Vector2(p.x,-p.y)));
      const geometry=new THREE.ExtrudeGeometry(shape,{depth:frame.frameHeight,bevelEnabled:false,steps:1});
      geometry.rotateX(-Math.PI/2);resources.add(geometry);
      for(const h of levels){
        const beam=new THREE.Mesh(geometry,frame.frameMaterial);beam.position.y=floorY+h+frame.frameOffset-frame.frameHeight/2;
        beam.userData={drawingId:piece.id,level:h};beam.castShadow=true;beam.receiveShadow=true;railGroup.add(beam);
      }
    }
    for(const o of plan.objects) {
      if(o.kind==='BT'||o.kind==='CV')continue;
      if(o.kind==='W'&&data.racks.some(r=>r.code===o.id))continue;
      if(o.points) {
        const geometryGroup=new THREE.Group();geometryGroup.name=o.id;root.add(geometryGroup);
        for(const edge of M.pathSegments(o)) {
          const dx=edge.b.x-edge.a.x,dy=edge.b.y-edge.a.y,length=Math.hypot(dx,dy),angle=Math.atan2(dy,dx);
          const segment=new THREE.Group();segment.position.set((edge.a.x+edge.b.x)/2,floorY,(edge.a.y+edge.b.y)/2);segment.rotation.y=-angle;geometryGroup.add(segment);
          if(o.kind==='T') {
            const lineWidth=Math.min(.1,o.width/4);
            for(const side of [-1,1])boundary(segment,[length,.012,lineWidth],[0,.006,side*(o.width-lineWidth)/2],'#facc15');
          }else {
            const frame=env.originalShuttleFrame;
            for(const h of levels){
              const count=Math.max(1,Math.ceil(length/.5)),columns=Math.max(1,Math.ceil(o.width/.5)),tileLength=length/count,tileWidth=o.width/columns;
              for(let i=0;i<count;i++)for(let j=0;j<columns;j++){const tile=new THREE.Mesh(boxGeometry,frame.deckMaterial);tile.scale.set(Math.max(.04,tileLength-.04),.055,Math.max(.04,tileWidth-.04));tile.position.set(-length/2+tileLength*(i+.5),h+.04,-o.width/2+tileWidth*(j+.5));tile.receiveShadow=true;segment.add(tile);}
            }
          }
        }
        continue;
      }
      if(M.equipmentKinds.includes(o.kind)){
        const actor=data.meta.actors.find(a=>a.id===o.id),native=env.createDrawingEquipment(actor,models.size);
        models.set(actor.code,{...native,actor});
      }else{
        const g=group(o);
        if(o.kind==='S'){
          lifts.set(o.id,env.createDrawingLift(o));
          for(const side of [-1,1])box(g,[o.w+.08,.065,.065],[0,.22,side*o.h/2],'#435466');
        }else{
          const lineWidth=Math.min(.1,o.w,o.h);
          for(const side of [-1,1]){boundary(g,[o.w,.012,lineWidth],[0,.008,side*(o.h-lineWidth)/2],'#ffffff');boundary(g,[lineWidth,.012,o.h],[side*(o.w-lineWidth)/2,.008,0],'#ffffff');}
          if(o.kind!=='D')label(g,o.id,1.4); // Dock billboards are created by the original truck/dock renderer.
        }
      }
    }
    const slots=rackEntries.flatMap(r=>r.slots);
    shell.viewport.dataset.amrCount=String(env.amrFleet.length);
    shell.viewport.dataset.shuttleCount=String(env.shuttleFleet.length);
    shell.viewport.dataset.shuttleLiftCount=String(lifts.size);
    shell.viewport.dataset.shuttleStatusBillboardCount=String(env.shuttleFleet.length);
    shell.viewport.dataset.drawingGeometry=JSON.stringify({name:plan.name,width:plan.width,height:plan.height,objects:plan.objects});
    shell.viewport.dataset.drawingRacks=JSON.stringify(rackEntries.map(r=>({code:r.rack.code,position:r.group.position.toArray(),angle:r.group.rotation.y,slots:r.slots.map(s=>({code:s.locationCode,position:s.group.localToWorld(new THREE.Vector3(...s.position)).toArray()}))})));
    const actors=data.meta.actors.map(o=>({code:o.code,kind:o.kind==='SH'?'shuttle':'amr',enabled:o.master?.enabled===true,online:o.status?.communicationStatus==='ONLINE',speed:o.master?.configuredSpeed||0,radius:Math.max(o.w,o.h)/2,yaw:-radians(o.angle),position:{x:o.x+o.w/2,y:floorY,z:o.y+o.h/2}}));
    const graphCache=new Map();
    const graph=(ids,diameter=0,directed=false)=>{const key=ids.join('|')+':'+diameter+':'+directed;if(!graphCache.has(key))graphCache.set(key,window.WmsWarehouseDrawing.graph(plan,ids,diameter,directed));return graphCache.get(key);};
    const cv=graph(plan.objects.filter(o=>o.kind==='CV').map(o=>o.id),0,true);
    const byId=id=>plan.objects.find(o=>o.id===id);
    const point=(n,h=floorY)=>({x:n.x/1000,y:h,z:n.y/1000});
    const routePoints=(g,a,b,h=floorY)=>Ops.pathBetween(g,a,b).map(n=>point(n,h));
    const move=(actor,path,label)=>({actor,path,label});
    const transfer=(owner,position,label,effect)=>({owner,position,label,effect,duration:1});
    const jobs=data.workOrders.filter(w=>!['완료','취소'].includes(w.status)).map(w=>({id:w.code,order:w,route:data.operationRoutes.find(r=>r.enabled&&r.code===w.routeCode),itemCode:w.itemCode,quantity:w.quantity}));
    function prepare(job,sim) {
      // Every trip reserves the shared CV network. While occupied, none of the
      // waiting jobs can start; do not rebuild hundreds of rack routes each frame.
      if(sim.locks.has('CV:network')&&sim.locks.get('CV:network')!==job.id)return {error:'공용 컨베이어 사용 대기'};
      const r=job.route;
      if(!r)return {error:`${job.id}: 운영 경로 ${job.order.routeCode||'(미지정)'}의 코드·사용 여부 확인`};
      if(job.order.direction!==r.direction||job.order.equipmentCode!==r.amr)return {error:`${job.id}: ${r.code}의 작업 구분(${r.direction})·배정 설비(${r.amr})와 일치해야 합니다.`};
      if(!(job.quantity>0)||!data.items.some(i=>i.code===job.itemCode))return {error:`${job.id}: 품목 ${job.itemCode} 등록·수량 확인`};
      const dock=byId(r.dock),buffer=byId(r.buffer),station=byId(r.station);
      if(dock?.kind!=='D'||buffer?.kind!=='B'||station?.kind!=='S')return {error:`${r.code}: 평면도의 도크 ${r.dock}·버퍼 ${r.buffer}·스테이션 ${r.station} 코드 확인`};
      const amr=models.get(r.amr)?.actor;
      if(!amr||amr.kind==='SH')return {error:`${r.amr}: 3D 연결 시트의 설비 코드·평면도 AMR 배치 확인`};
      const ready=code=>{const a=sim.actors.get(code);return a?.enabled&&a.online&&a.speed>0;};
      if(!ready(amr.code))return {error:amr.id+': 사용·통신·속도 확인'};
      if(byId(amr.routeId)?.kind!=='T')return {error:amr.id+': T 이동 경로 지정 확인'};
      const ag=graph([amr.routeId],Math.max(amr.w,amr.h)*1000),ab=access(ag,buffer),as=access(ag,station);
      const cb=access(cv,buffer),cd=access(cv,dock),inbound=r.direction==='입고';
      const connectedCvPath=routePoints(cv,inbound?cd:cb,inbound?cb:cd,floorY+1),amrPath=routePoints(ag,inbound?ab:as,inbound?as:ab);
      if(!connectedCvPath.length)return {error:`${inbound?dock.id:buffer.id} → ${inbound?buffer.id:dock.id}: CV 연결·진행 방향 확인`};
      if(!amrPath.length)return {error:`${amr.routeId}: ${buffer.id} ↔ ${station.id} 연결·${amr.id} 장비 폭 확인`};
      const amrState=sim.actors.get(amr.code),start=nearest(ag,{x:amrState.position.x,y:amrState.position.z});
      if(!start)return {error:amr.id+': 지정 경로에 이동 가능한 구간이 없습니다.'};
      const approach=routePoints(ag,start,inbound?ab:as);
      if(!approach.length)return {error:'AMR 현재 위치 연결 확인'};
      approach.unshift({...amrState.position});
      const choices=[],failures=new Set();let failureStage=0;
      // Report the furthest usable candidate, so unrelated empty racks do not obscure a precise CV error.
      const fail=(stage,reason)=>{if(stage>failureStage){failures.clear();failureStage=stage;}if(stage===failureStage)failures.add(reason);};
      for(const candidate of data.meta.actors.filter(o=>o.kind==='SH'&&ready(o.code)&&byId(o.routeId)?.kind==='GR')){
        // A station meets the edge of the guide rail, not necessarily its centerline.
        const stationGap=.15+byId(candidate.routeId).width/2;
        const sg=graph([candidate.routeId],Math.max(candidate.w,candidate.h)*1000),sn=access(sg,station,stationGap);
        const state=sim.actors.get(candidate.code),current={x:state.position.x,y:state.position.z};
        const atStation=plan.objects.find(o=>o.kind==='S'&&access({nodes:[{x:current.x*1000,y:current.y*1000}]},o,0));
        const home=(atStation&&access(sg,atStation,stationGap))||nearest(sg,current);
        if(!sn||!home){fail(1,`${candidate.id}: ${candidate.routeId}와 ${station.id} 연결·장비 폭 확인`);continue;}
        const arrive=routePoints(sg,home,sn);
        if(!arrive.length){fail(1,`${candidate.id}: 현재 위치에서 ${station.id}까지 GR 연결 확인`);continue;}
        arrive.unshift({x:current.x,y:floorY,z:current.y});
        const stationCenter=center(station);arrive.push({x:stationCenter.x,y:floorY,z:stationCenter.y});
        for(const slot of slots){
          if(sim.locks.has('slot:'+slot.locationCode))continue;
          if(inbound?slot.occupied||slot.location?.capacity<job.quantity||!slot.location:!slot.occupied||slot.stock.itemCode!==job.itemCode||slot.stock.quantity<job.quantity||['hold','defect'].includes(slot.stock.status)){fail(2,inbound?'로케이션 마스터: 빈 로케이션·최대수량 확인':'재고 현황: '+job.itemCode+'의 출고 가능 재고·수량 확인');continue;}
          const world=slot.group.localToWorld(new THREE.Vector3(slot.position[0],slot.palletBaseY,slot.position[2]));
          const rn=nearest(sg,{x:world.x,y:world.z},Math.max(slot.boxSize[0],slot.boxSize[2])/2+byId(candidate.routeId).width/2+.2);
          const h=(slot.level-1)*slot.type.levelHeight/1000,path=routePoints(sg,sn,rn,floorY+h);
          if(!path.length){fail(3,`${candidate.routeId} → ${slot.locationCode}: 랙 접근 연결 확인`);continue;}
          path.unshift({x:stationCenter.x,y:floorY+h,z:stationCenter.y});
          const cargoWidth=slot.boxSize[2],cargoLength=slot.boxSize[0];
          const small=[dock,buffer,station].find(o=>Math.min(o.w,o.h)<Math.min(cargoWidth,cargoLength)+.02);
          if(small){fail(4,`${small.id}: 화물 크기보다 인계 영역이 작습니다.`);continue;}
          // Search only traversable conveyor routes; unrelated narrow conveyors must not block this job.
          const loadGraph=graph(plan.objects.filter(o=>o.kind==='CV').map(o=>o.id),cargoWidth*1000,true);
          const from=access(loadGraph,inbound?dock:buffer),to=access(loadGraph,inbound?buffer:dock);
          const cvPath=routePoints(loadGraph,from,to,floorY+1);
          if(!cvPath.length){fail(5,`${inbound?dock.id:buffer.id} → ${inbound?buffer.id:dock.id}: 화물 폭 ${cargoWidth.toFixed(2)}m 이상인 CV 연결·진행 방향 확인`);continue;}
          choices.push({slot,world,shuttle:candidate,arrive,path,h,cvPath});
        }
      }
      if(!choices.length)return {error:[...failures].join(' / ')||`${station.id}: 셔틀 설비의 사용·통신·속도·GR 지정 및 랙 로케이션 배치 확인`};
      choices.sort((a,b)=>a.slot.level-b.slot.level);const chosen=choices[0],{slot,world,shuttle,arrive,path,h,cvPath}=chosen;
      job.slot=slot;job.shuttle=shuttle.code;job.order.finalLocationCode=slot.locationCode;
      const stationBase=path[0],stationLow={...stationBase,y:floorY},rackNode=path[path.length-1],rackPosition={x:world.x,y:world.y,z:world.z};
      const returnPath=path.slice().reverse(),amrStart=amrPath[0],amrEnd=amrPath[amrPath.length-1];
      const cvFirst=cvPath[0],cvLast=cvPath[cvPath.length-1];
      const liftUp=move(shuttle.code,[stationLow,stationBase],'리프트 상승'),liftDown=move(shuttle.code,[stationBase,stationLow],'리프트 하강');
      const cvMove={path:cvPath,speed:1.5,label:'컨베이어 운반',startOwner:'conveyor',conveyor:true,lanePath:cvPath,clearance:Math.max(slot.boxSize[0],slot.boxSize[2])+.3};
      const fork=(height)=>({actor:amr.code,pose:{forkHeight:height},label:'포크 높이 조정'});
      const handoff=(actor,owner,position,text,effect)=>({...transfer(owner,position,text,effect),actor});
      const steps=inbound?[
        cvMove,transfer('buffer:'+buffer.id,cvLast,'버퍼 인계'),move(amr.code,approach,'상차지 이동'),
        fork(1),handoff(amr.code,amr.code,amrStart,'AMR 상차'),fork(.08),move(amr.code,amrPath,'운반'),fork(shuttle.height+.01),handoff(amr.code,'station:'+station.id,stationLow,'스테이션 인계'),fork(.08),
        move(shuttle.code,arrive,'셔틀 접근'),handoff(shuttle.code,shuttle.code,stationLow,'셔틀 상차'),liftUp,move(shuttle.code,path,'적치 이동'),
        handoff(shuttle.code,'rack:'+slot.locationCode,rackPosition,'적치','putaway'),move(shuttle.code,returnPath,'복귀'),liftDown
      ]:[
        move(shuttle.code,arrive,'셔틀 접근'),liftUp,move(shuttle.code,path,'피킹 이동'),handoff(shuttle.code,shuttle.code,rackNode,'피킹','pick'),
        move(shuttle.code,returnPath,'운반'),liftDown,handoff(shuttle.code,'station:'+station.id,stationLow,'스테이션 인계'),move(amr.code,approach,'상차지 이동'),
        fork(shuttle.height+.01),handoff(amr.code,amr.code,amrStart,'AMR 상차'),fork(.08),move(amr.code,amrPath,'운반'),fork(1),handoff(amr.code,'buffer:'+buffer.id,cvFirst,'버퍼 인계'),fork(.08),cvMove,transfer('truck:'+dock.id,cvLast,'출고 완료')
      ];
      // Reserve the complete connected route so branches, opposing traffic and handoffs cannot overlap.
      return {reservations:['actor:'+amr.code,'actor:'+shuttle.code,'slot:'+slot.locationCode,'T:'+amr.routeId,'GR:'+shuttle.routeId,'CV:network','station:'+station.id,'buffer:'+buffer.id],
        transports:[{actor:amr.code,from:inbound?buffer.id:station.id,to:inbound?station.id:buffer.id},{actor:shuttle.code,from:inbound?station.id:slot.locationCode,to:inbound?slot.locationCode:station.id}].map(t=>({...t,itemInfo:job.itemCode+' · '+job.quantity+'개',barcode:job.order.barcode||'HU-'+job.id})),
        cargo:{owner:inbound?'dock:'+dock.id:'rack:'+slot.locationCode,position:inbound?cvFirst:rackPosition},steps};
    }
    const onEvent=(event,job)=>{
      const slot=job.slot;
      if(event==='started'){
        const load=createTaskLoad({loadAnchor:new THREE.Group()},{slot:{...slot,item:data.items.find(i=>i.code===job.itemCode)}});
        const copies=new Map();load.traverse(part=>{if(!part.material)return;if(!copies.has(part.material)){const copy=part.material.clone();copies.set(part.material,copy);resources.add(copy);}part.material=copies.get(part.material);});
        load.removeFromParent();load.name='operation-pallet-'+job.id;load.userData.jobCode=job.id;load.userData.operationMaterials=[...copies.values()];scene.add(load);cargoModels.set(job.id,load);
      }
      if(event==='putaway'){slot.occupied=true;slot.stock={...slot.location,itemCode:job.itemCode,quantity:job.quantity,status:'normal'};slot.item=data.items.find(item=>item.code===job.itemCode);setSlotInstanceVisible(slot,false);}
      if(event==='pick'){slot.stock.quantity-=job.quantity;slot.occupied=slot.stock.quantity>0;if(!slot.occupied){setSlotInstanceVisible(slot,false);for(const previous of simulation.jobs)if(previous!==job&&previous.cargo?.owner==='rack:'+slot.locationCode)previous.cargo.owner='consumed';}}
    };
    const initialSlots=slots.map(slot=>({slot,occupied:slot.occupied,stock:slot.stock?{...slot.stock}:slot.stock,item:slot.item}));
    let routePreview=window.WmsWarehouseRoutePreview.create(plan,data.meta.actors,floorY);
    const initialActors=()=>actors.map(actor=>({...actor,position:{...routePreview.actors.get(actor.code).position}}));
    let simulation=new Ops.Simulation({actors:initialActors(),jobs,prepare,onEvent});
    simulation.paused=true;
    let mode='routes',pendingMode=null,status='ready';
    const activeActors=()=>mode==='routes'?routePreview.actors:simulation.actors;
    const actorStatus=actor=>actor.job&&status==='stopped'?'정지':actor.job&&status==='ready'?'준비':actor.job&&status==='paused'?'일시정지':actor.status;
    const panel=shell.viewport.closest('.warehouse-3d-shell').querySelector('.warehouse-3d-bottom-panel');panel.classList.add('has-operations');
    const controls=document.createElement('div');controls.className='warehouse-operation-controls';
    const title=document.createElement('span');title.textContent='도면 물류 흐름 · 모의 운행';
    controls.innerHTML=window.WmsSimulationControls.markup();controls.prepend(title);
    for(const action of ['play','pause','stop'])controls.querySelector('[data-simulation-'+action+']').addEventListener('click',()=>session[action](),{signal});
    const modeSelect=document.createElement('select');modeSelect.setAttribute('aria-label','모의 운행 방식');modeSelect.innerHTML='<option value="routes">지정 경로 반복 주행</option><option value="orders">입출고 작업지시</option>';modeSelect.addEventListener('change',()=>window.WmsSimulationSession.setMode(modeSelect.value),{signal});
    controls.append(modeSelect);panel.append(controls);
    const stateMessage=document.createElement('div');stateMessage.setAttribute('role','status');panel.append(stateMessage);
    const list=document.createElement('div');list.className='warehouse-operation-list';panel.append(list);
    const jobRows=jobs.map(job=>{const row=document.createElement('div');list.append(row);return {job,row};});
    const routeStatus=document.createElement('div');panel.append(routeStatus);
    let previous=null,lastUi=-Infinity;
    function reset(nextMode){
      for(const model of cargoModels.values()){model.removeFromParent();for(const material of model.userData.operationMaterials||[]){resources.delete(material);material.dispose();}}cargoModels.clear();
      for(const saved of initialSlots){Object.assign(saved.slot,{occupied:saved.occupied,stock:saved.stock?{...saved.stock}:saved.stock,item:saved.item});setSlotInstanceVisible(saved.slot,saved.occupied);}
      for(const lift of lifts.values())lift.platform.position.y=.08;
      env.resetSimulationExtras?.();
      routePreview=window.WmsWarehouseRoutePreview.create(plan,data.meta.actors,floorY);
      simulation=new Ops.Simulation({actors:initialActors(),jobs,prepare,onEvent});simulation.paused=true;
      mode=nextMode;pendingMode=null;status='ready';previous=null;
    }
    function start(){
      if(pendingMode)reset(pendingMode);
      if(status==='completed')return;
      if(mode==='orders'){
        let runnable=false;
        for(const job of simulation.jobs){
          if(job.done)continue;
          if(job.steps){runnable=true;continue;}
          const result=prepare(job,simulation);job.status=result.error||'대기';if(!result.error)runnable=true;
        }
        if(!runnable){status='blocked';simulation.paused=true;return;}
      }else if(![...routePreview.actors.values()].some(actor=>actor.graph?.nodes.some(node=>node.neighbors.length))){status='blocked';simulation.paused=true;return;}
      status='running';simulation.paused=false;previous=null;
    }
    function settle(){
      if(mode!=='orders'||status!=='running')return;
      const unfinished=simulation.jobs.filter(job=>!job.done);
      if(!unfinished.length){status='completed';simulation.paused=true;}
      else if(unfinished.every(job=>!job.steps&&job.status!=='대기')){status='blocked';simulation.paused=true;}
      return simulation.paused;
    }
    const message=()=>pendingMode?'운행 방식이 변경되었습니다. 재생하면 초기 배치에서 새로 시작합니다.':({ready:'준비 · 재생하면 지정 경로의 중심선에 맞춰 시작합니다.',stopped:'정지 · 초기 상태로 돌아왔습니다. 재생하면 처음부터 시작합니다.',running:'운행 중',paused:'일시정지 · 운행 재개 시 현재 위치부터 이어집니다.',blocked:mode==='orders'?(jobs.length?'실행 불가 · 아래 작업별 원인을 확인하세요. 수정한 도면·기준정보는 다시 재생할 때 반영됩니다.':'실행 불가 · 작업지시가 없습니다.'):'실행 불가 · 장비에 이동 가능한 T 또는 GR 경로를 지정하세요.',completed:'완료 · 모든 작업이 끝났습니다. 재생하면 처음부터 다시 실행합니다.'}[status]);
    const session={
      snapshot:()=>({mode:pendingMode||mode,status:pendingMode?'ready':status,transportState:pendingMode||status==='paused'?'pause':status==='running'?'play':'stop',actionLabel:pendingMode?'재생':({ready:'재생',running:'일시정지',paused:'운행 재개',blocked:'다시 검사',completed:'완료'}[status]),message:message(),paused:simulation.paused,elapsed:mode==='routes'?routePreview.elapsed:simulation.elapsed,actors:[...activeActors().values()].map(a=>{const model=models.get(a.code);return {id:model.actor.id,code:a.code,position:{...a.position},angle:a.job?(Math.PI/2-a.yaw)*180/Math.PI:model.actor.angle,state:actorStatus(a)};}),jobs:mode==='orders'?simulation.jobs.map(j=>({id:j.id,status:j.status,done:j.done,cargo:j.cargo?{owner:j.cargo.owner,position:{...j.cargo.position}}:null})):[]}),
      toggle(){if(status==='running'&&!pendingMode){status='paused';simulation.paused=true;}else start();previous=null;refresh();},
      play(){if(status==='running'&&!pendingMode)return;if(status==='completed'&&!pendingMode)reset(mode);start();previous=null;refresh();},
      pause(){if(status!=='running'||pendingMode)return;status='paused';simulation.paused=true;previous=null;refresh();},
      stop(){reset(pendingMode||mode);status='stopped';refresh();},
      setMode(value){if(!['routes','orders'].includes(value)||value===(pendingMode||mode))return;if(status==='running')status='paused';simulation.paused=true;pendingMode=value===mode?null:value;previous=null;refresh();},
      restart(){reset(pendingMode||mode);start();refresh();}
    };
    let detachSession=()=>{};
    function refresh(){
      const current=session.snapshot();window.WmsSimulationControls.update(controls,current);modeSelect.value=current.mode;stateMessage.textContent=current.message;
      list.hidden=!!pendingMode||mode!=='orders';routeStatus.hidden=!!pendingMode||mode!=='routes';
      routeStatus.textContent=[...routePreview.actors.values()].map(a=>models.get(a.code).actor.id+' · '+actorStatus(a)).join(' / ')||'평면도에 장비를 배치하고 이동 경로를 지정하세요.';
      if(!jobs.length&&mode==='orders')list.textContent='작업지시가 없습니다. 지정 경로 반복 주행을 선택할 수 있습니다.';
      for(const {job,row} of jobRows){const current=simulation.jobs.find(j=>j.id===job.id);row.textContent=job.id+' · '+current.status;}
      shell.viewport.dataset.operationJobs=JSON.stringify(simulation.jobs.map(j=>({id:j.id,route:j.route?.code||j.order.routeCode,direction:j.order.direction,status:j.status,stage:j.stage,total:j.steps?.length||0,done:j.done,cargoOwner:j.cargo?.owner||'',cargoPosition:j.cargo?.position||null})));shell.viewport.dataset.operationActors=JSON.stringify([...activeActors().values()].map(a=>({code:a.code,state:a.status,position:a.position,speed:a.speed})));
      shell.viewport.dataset.operationElapsed=(mode==='routes'?routePreview.elapsed:simulation.elapsed).toFixed(3);shell.viewport.dataset.operationInventoryPolicy='simulation-only';
      shell.viewport.dataset.simulationMode=current.mode;shell.viewport.dataset.simulationPaused=String(simulation.paused);shell.viewport.dataset.simulationStatus=current.status;
      window.WmsSimulationSession?.publish();
      const occupied=slots.filter(s=>s.occupied).length,free=slots.length-occupied,rate=slots.length?occupied/slots.length*100:0;
      shell.viewport.dataset.operationInventory=JSON.stringify({occupied,free,quantity:slots.reduce((sum,s)=>sum+(s.occupied?s.stock.quantity:0),0)});
      const shellRoot=shell.viewport.closest('.warehouse-3d-shell'),set=(key,value)=>{const e=shellRoot.querySelector('[data-warehouse-kpi="'+key+'"] .warehouse-3d-kpi-value');if(e)e.textContent=value;};
      const waitingStatuses=['대기','목적지 대기','설비·목적지 대기','공용 컨베이어 사용 대기'];
      set('utilization',rate.toFixed(1)+'%');set('available',free+' 셀');set('alerts',simulation.jobs.filter(j=>!j.done&&!j.steps&&!waitingStatuses.includes(j.status)).length+' 건');
      const util=shellRoot.querySelector('[data-warehouse-kpi="utilization"]');util.querySelector('small').textContent=occupied+' / '+slots.length+' 셀';util.querySelector('i').style.setProperty('--warehouse-kpi-progress',rate+'%');util.querySelector('[role=progressbar]').setAttribute('aria-valuenow',rate.toFixed(1));
      shellRoot.querySelector('[data-warehouse-kpi="available"] small').textContent=(100-rate).toFixed(1)+'%';
      for(const [kind,prefix] of [['입고','inbound'],['출고','outbound']]){const subset=simulation.jobs.filter(j=>j.order.direction===kind);for(const [suffix,count] of [['complete',subset.filter(j=>j.done).length],['progress',subset.filter(j=>j.steps&&!j.done).length],['request',subset.filter(j=>!j.steps).length]])set(prefix+'-'+suffix,count+' 건');}
    }
    detachSession=window.WmsSimulationSession?.attach(session)||detachSession;refresh();
    return {get elapsed(){return mode==='orders'?simulation.elapsed:routePreview.elapsed;},truckProgress:(dock,direction)=>mode==='orders'?Ops.truckProgress(simulation.jobs.filter(j=>j.route),dock,direction):null,update(timestamp){
      if(document.hidden){previous=null;return true;}
      const dt=previous===null?0:Math.min(.1,Math.max(0,(timestamp-previous)/1000));previous=timestamp;if(mode==='orders')simulation.tick(dt);else if(!simulation.paused)routePreview.tick(dt);const settled=settle();
      root.visible=!env.isLevelFocused();
      for(const [code,model] of models){const a=activeActors().get(code);model.group.position.set(a.position.x,a.position.y,a.position.z);model.group.rotation.y=a.job?a.yaw-Math.PI/2:-radians(model.actor.angle);
        const displayed=model.label.userData.amr;displayed.state=actorStatus(a);displayed.equipmentStatus=mode==='routes'||a.enabled?displayed.state:(model.actor.status?.equipmentStatus||'미설정');displayed.currentSpeed=!simulation.paused&&a.job&&/이동|운반|복귀|주행/.test(a.status)?a.speed:0;displayed.transportHistory=a.transportHistory||[];
        model.label.setOperationStatus?.(displayed.equipmentStatus);
        const button=shell.zoneButtons.querySelector('[data-warehouse-object-code="'+code+'"] .warehouse-3d-object-status');if(button){button.textContent=displayed.equipmentStatus;button.style.setProperty('--warehouse-equipment-status-color',model.label.userData.equipmentStatusColor);}
        if(model.carriage)env.setForkHeight(model,(a.forkHeight??.08)/model.visualScaleY);
        model.group.updateMatrixWorld(true);
        if(model.actor.kind==='SH')for(const [id,lift] of lifts){const c=center(plan.objects.find(o=>o.id===id));if(Math.hypot(a.position.x-c.x,a.position.z-c.y)<.05)lift.platform.position.y=a.position.y-floorY+.08;}
      }
      for(const job of simulation.jobs){
        const visual=cargoModels.get(job.id);if(!visual||!job.cargo)continue;if(mode!=='orders'){visual.visible=false;continue;}
        const a=simulation.actors.get(job.cargo.owner),stored=job.cargo.owner.startsWith('rack:');
        const appearance=stored?env.slotVisualState(job.slot):{visible:!env.isLevelFocused(),opacity:1};
        visual.setStorageState(stored,appearance.color);
        visual.visible=appearance.visible&&!job.cargo.owner.startsWith('truck:')&&job.cargo.owner!=='consumed'&&!(job.order.direction==='출고'&&stored);
        if(visual.userData.operationOpacity!==appearance.opacity){visual.traverse(part=>{if(part.material){part.material.transparent=appearance.opacity<1;part.material.opacity=appearance.opacity;part.material.depthWrite=appearance.opacity===1;part.material.needsUpdate=true;}});visual.userData.operationOpacity=appearance.opacity;}
        if(a){const model=models.get(a.code);visual.position.copy(model.loadAnchor?model.loadAnchor.getWorldPosition(new THREE.Vector3()):new THREE.Vector3(a.position.x,a.position.y+model.actor.height+.01,a.position.z));}
        else{const p=job.cargo.position;visual.position.set(p.x,p.y,p.z);}
        visual.rotation.y=stored?job.slot.group.rotation.y:a?a.yaw-Math.PI/2:0;
      }
      if(settled||timestamp-lastUi>80){refresh();lastUi=timestamp;}return true;
    },dispose(){detachSession();root.removeFromParent();resources.forEach(r=>r.dispose());cargoModels.forEach(m=>m.removeFromParent());}};
  }
  window.WmsWarehouseDrawingScene={mount,tunnels,access,nearest};
})();
