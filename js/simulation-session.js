(function () {
  'use strict';
  let controller=null,notice='',preferredMode='routes';
  const emit=()=>window.dispatchEvent(new CustomEvent('wms-simulation-update',{detail:controller?.snapshot()||null}));
  window.WmsSimulationSession={
    attach(next){controller=next;notice='';controller.setMode(preferredMode);emit();return()=>{if(controller===next){controller=null;emit();}};},
    snapshot:()=>controller?.snapshot()||null,
    play(){controller?.play();},pause(){controller?.pause();},stop(){controller?.stop();},
    toggle(){controller?.toggle();},setMode(mode){if(!['routes','orders'].includes(mode))return;preferredMode=mode;if(controller)controller.setMode(mode);else emit();},
    get mode(){return preferredMode;},
    restart(){controller?.restart();},
    get notice(){return notice;},
    invalidate(message){notice=message;emit();},
    publish:emit
  };
  // The two views share fixed button order, accessible names and active-state rendering.
  const icons={play:'<path d="M7 4.5 19 12 7 19.5Z"/>',pause:'<rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/>',stop:'<rect x="5" y="5" width="14" height="14" rx="1.5"/>'};
  const labels={play:'재생',pause:'일시정지',stop:'정지'};
  window.WmsSimulationControls={
    markup:()=>'<div class="wms-simulation-buttons" role="group" aria-label="모의 운행 제어">'+Object.keys(icons).map(action=>`<button type="button" class="wms-simulation-button" data-simulation-${action} aria-label="${labels[action]}" title="${labels[action]}" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[action]}</svg></button>`).join('')+'</div>',
    update(container,snapshot,{busy=false,available=true}={}){
      const status=snapshot?.status||'stopped',active=snapshot?.transportState||(status==='running'?'play':status==='paused'?'pause':'stop');
      for(const action of Object.keys(icons)){
        const button=container.querySelector(`[data-simulation-${action}]`);
        button.setAttribute('aria-pressed',String(active===action));
        button.disabled=busy||!available||(action==='play'?status==='running':action==='pause'?status!=='running':!snapshot||status==='stopped');
        button.title=action==='play'?(busy?'모의 운행 준비 중':status==='completed'?'재생 · 처음부터 다시 실행':status==='paused'?'재생 · 현재 위치에서 재개':'재생'):action==='stop'?'정지 · 초기 상태로 되돌리기':'일시정지 · 현재 위치 유지';
      }
      container.querySelector('.wms-simulation-buttons').setAttribute('aria-busy',String(busy));
    }
  };
})();
