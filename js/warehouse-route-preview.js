(function(){
 'use strict';
 const shuttleSpeedFactor=1.3;
 function create(plan,actors,floorY){
  const routes=new Map(),states=new Map();let elapsed=0;
  for(const actor of actors){
   const path=plan.objects.find(o=>o.id===actor.routeId&&o.kind===(actor.kind==='SH'?'GR':'T'));
   const state={code:actor.code,drawingId:actor.id,position:{x:actor.x+actor.w/2,y:floorY,z:actor.y+actor.h/2},yaw:-actor.angle*Math.PI/180,status:'이동 경로 미지정',speed:(actor.master?.configuredSpeed>0?actor.master.configuredSpeed:1)*(actor.kind==='SH'?shuttleSpeedFactor:1),job:null};
   states.set(actor.code,state);if(!path)continue;
   const key=path.id+':'+actor.kind+':'+actor.w+':'+actor.h;
   if(!routes.has(key))routes.set(key,actor.kind==='SH'
    ?window.WmsWarehouseDrawing.graph(plan,[path.id],Math.max(actor.w,actor.h)*1000)
    :window.WmsWarehouseDrawing.amrGraph(plan,[path.id],actor));
   const graph=routes.get(key);if(!graph.nodes.length){state.status='경로 폭 또는 스테이션 이격 확인';continue;}
   const start=graph.nodes.reduce((best,n)=>Math.hypot(n.x/1000-state.position.x,n.y/1000-state.position.z)<Math.hypot(best.x/1000-state.position.x,best.y/1000-state.position.z)?n:best);
   state.position={x:start.x/1000,y:floorY,z:start.y/1000};state.node=start;state.graph=graph;state.visits=new Map();state.status='경로 주행';state.job='route-preview';
  }
  function tick(dt){
   elapsed+=dt;
   for(const state of states.values()){
    if(!state.graph)continue;let remaining=state.speed*dt;
    while(remaining>1e-9){
     if(!state.target){
      const edgeKey=k=>[state.node.key,k].sort().join('|');
      const choices=state.node.neighbors.slice().sort((a,b)=>(state.visits.get(edgeKey(a))||0)-(state.visits.get(edgeKey(b))||0));
      if(!choices.length){state.status='연결된 경로가 없습니다';break;}
      const key=choices[0];state.visits.set(edgeKey(key),(state.visits.get(edgeKey(key))||0)+1);state.target=state.graph.nodesByKey.get(key);
     }
     const dx=state.target.x/1000-state.position.x,dz=state.target.y/1000-state.position.z,distance=Math.hypot(dx,dz);
     if(distance>1e-9){state.yaw=Math.atan2(dx,dz);state.moving=true;const move=Math.min(distance,remaining);state.position.x+=dx/distance*move;state.position.z+=dz/distance*move;remaining-=move;}
     if(distance<=remaining+1e-9||Math.hypot(state.target.x/1000-state.position.x,state.target.y/1000-state.position.z)<1e-8){state.node=state.target;state.target=null;}else break;
    }
   }
  }
  return {actors:states,tick,get elapsed(){return elapsed;}};
 }
 function createCargo(lanes){
  let elapsed=0;
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
  const layouts=lanes.map((lane,laneIndex)=>{
   const count=3,interval=1.2,unloadDuration=.7,speed=1.5;
   const stackAt=index=>({x:lane.source.x,y:lane.source.y+index*(lane.height+.08),z:lane.source.z});
   const departureOrder=Array.from({length:count},(_,index)=>count-index-1);
   const firstDeparture=.5+(count-1)*interval+unloadDuration+1;
   const loads=Array.from({length:count},(_,index)=>{
    const path=[stackAt(index),...lane.path,lane.target];
    const segments=path.slice(1).map((point,i)=>distance(path[i],point));
    const length=segments.reduce((sum,value)=>sum+value,0);
    return {code:`${lane.code}:${index}`,lane,index,path,segments,length,speed,
     unloadAt:.5+index*interval,departAt:firstDeparture+departureOrder.indexOf(index)*Math.max(interval,lane.width/speed+.3),
     position:stackAt(index),visible:false};
   });
   return {lane,loads,offset:laneIndex*.4,cycle:Math.max(...loads.map(load=>load.departAt+load.length/speed))+2};
  });
  const loads=layouts.flatMap(layout=>layout.loads);
  function update(){
   for(const layout of layouts){
    const time=(elapsed+layout.offset)%layout.cycle;
    for(const load of layout.loads){
     load.visible=time>=load.unloadAt&&time<load.departAt+load.length/load.speed+.8;
     if(time<load.departAt){load.position={...load.path[0]};continue;}
     let remaining=Math.min(load.length,Math.max(0,(time-load.departAt)*load.speed));
     for(let i=0;i<load.segments.length;i++){
      const segment=load.segments[i];
      if(remaining>segment){remaining-=segment;continue;}
      const a=load.path[i],b=load.path[i+1],fraction=segment?remaining/segment:1;
      load.position={x:a.x+(b.x-a.x)*fraction,y:a.y+(b.y-a.y)*fraction,z:a.z+(b.z-a.z)*fraction};
      break;
     }
    }
   }
  }
  function truckProgress(dock,direction){
   const related=layouts.filter(layout=>layout.lane.dock===dock&&layout.lane.direction===direction);
   if(!related.length)return null;
   const action=direction==='출고'?'상차':'하차';
   const states=related.map(layout=>{
    const time=(elapsed+layout.offset)%layout.cycle;
    const completeAt=direction==='출고'?Math.max(...layout.loads.map(load=>load.departAt+load.length/load.speed)):.5+(layout.loads.length-1)*1.2+.7;
    const activeAt=direction==='출고'?Math.min(...layout.loads.map(load=>load.departAt+load.length/load.speed)):.5;
    return time>=completeAt?'complete':time>=activeAt?'active':'waiting';
   });
   return `${action} ${states.every(state=>state==='complete')?'완료':states.some(state=>state!=='waiting')?'중':'대기'}`;
  }
  update();
  return {loads,tick(dt){if(dt>0){elapsed+=dt;update();}},reset(){elapsed=0;update();},truckProgress,get elapsed(){return elapsed;}};
 }
 window.WmsWarehouseRoutePreview={create,createCargo};
})();
