(function(){
 'use strict';
 function create(plan,actors,floorY){
  const routes=new Map(),states=new Map();let elapsed=0;
  for(const actor of actors){
   const path=plan.objects.find(o=>o.id===actor.routeId&&o.kind===(actor.kind==='SH'?'GR':'T'));
   const state={code:actor.code,drawingId:actor.id,position:{x:actor.x+actor.w/2,y:floorY,z:actor.y+actor.h/2},yaw:-actor.angle*Math.PI/180,status:'이동 경로 미지정',speed:actor.master?.configuredSpeed>0?actor.master.configuredSpeed:1,job:null};
   states.set(actor.code,state);if(!path)continue;
   const key=path.id+':'+Math.max(actor.w,actor.h);
   if(!routes.has(key))routes.set(key,window.WmsWarehouseDrawing.graph(plan,[path.id],Math.max(actor.w,actor.h)*1000));
   const graph=routes.get(key);if(!graph.nodes.length){state.status='경로 폭보다 장비가 큽니다';continue;}
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
 window.WmsWarehouseRoutePreview={create};
})();
