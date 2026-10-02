(function () {
    const pageStates = new WeakMap();
    let rendererPromise;

    function getViewType(menu) { return menu?.viewType === 'warehouse3d' ? 'warehouse3d' : 'cards'; }
    function getOptions(menu) { return menu.viewOptions; }

    function attachWorkspaceModes(mount) {
        const actions = mount.querySelector('.warehouse-3d-toolbar-actions');
        if (!actions) return;
        const modes = document.createElement('div');
        modes.className = 'wms-workspace-modes';
        modes.setAttribute('role', 'group');
        modes.setAttribute('aria-label', 'WMS 화면 전환');
        modes.innerHTML = `<button type="button" data-wms-workspace="drawing" aria-label="평면도" title="평면도"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="2.5" width="15" height="15"/><path d="M7.5 2.5v15 M12.5 2.5v15 M2.5 7.5h15 M2.5 12.5h15"/></svg></button>
            <button type="button" data-wms-workspace="reference" aria-label="기준 정보" title="기준 정보"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 2.5h9l3 3V17.5H4z M13 2.5v3h3 M6.5 8.5h7 M6.5 11.5h7 M6.5 14.5h7 M10 8.5v6"/></svg></button>
            <button type="button" data-wms-workspace="viewer3d" aria-label="3D View" title="3D View" aria-pressed="true"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2 7 4v8l-7 4-7-4V6l7-4Z M3 6l7 4 7-4 M10 10v8"/></svg></button>`;
        actions.insertBefore(modes, actions.querySelector('.warehouse-3d-fullscreen'));
        modes.addEventListener('click', event => {
            const button = event.target.closest('[data-wms-workspace]');
            if (!button || button.dataset.wmsWorkspace === 'viewer3d' || window.wmsPermissions?.isAuthenticated?.() !== true) return;
            window.wmsStandalone.show(button.dataset.wmsWorkspace);
        });
    }

    function loadRenderer() {
        if (window.wmsWarehouse3D) return Promise.resolve(window.wmsWarehouse3D);
        if (rendererPromise) return rendererPromise;
        rendererPromise = (async () => {
            for (const src of ['vendor/three.js', 'js/warehouse-operations.js', 'js/warehouse-operation-scene.js', 'js/warehouse-barcode-tunnel.js']) {
                if (document.querySelector('script[data-local-3d="'+src+'"]')) continue;
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script'); script.src = src;
                    script.dataset.local3d = src;
                    script.onload = resolve;
                    script.onerror = () => { script.remove(); reject(new Error('3D 파일을 불러오지 못했습니다: '+src)); };
                    document.head.appendChild(script);
                });
            }
        })().then(() => new Promise((resolve, reject) => {
            let script = document.querySelector('script[data-wms-warehouse-3d]');
            const created = !script;
            if (created) {
                script = document.createElement('script');
                script.src = 'js/warehouse-3d.js';
                script.dataset.wmsWarehouse3d = 'true';
            }
            const cleanup = () => {
                script.removeEventListener('load', loaded);
                script.removeEventListener('error', failed);
            };
            const loaded = () => {
                cleanup();
                if (window.wmsWarehouse3D) resolve(window.wmsWarehouse3D);
                else reject(new Error('3D 창고 화면을 초기화하지 못했습니다.'));
            };
            const failed = () => {
                cleanup();
                script.remove();
                reject(new Error('3D 창고 화면을 불러오지 못했습니다.'));
            };
            script.addEventListener('load', loaded);
            script.addEventListener('error', failed);
            if (created) document.head.appendChild(script);
        })).catch(error => {
            rendererPromise = null;
            throw error;
        });
        return rendererPromise;
    }

    function dispose(panel) {
        const state = pageStates.get(panel);
        if (!state) return;
        state.active = false;
        state.generation += 1;
        window.wmsWarehouse3D?.disposeWithin(panel);
        panel.replaceChildren();
    }

    async function setActive(panel, active, menu) {
        let state = pageStates.get(panel);
        if (!state) {
            state = { active: false, generation: 0 };
            pageStates.set(panel, state);
        }
        if (!active) {
            if (state.active) dispose(panel);
            return;
        }
        if (state.active || window.wmsPermissions?.isAuthenticated?.() !== true) return;
        state.active = true;
        const generation = ++state.generation;
        const isCurrent = () => state.active && generation === state.generation && panel.isConnected
            && window.wmsPermissions?.isAuthenticated?.() === true;
        const message = document.createElement('div');
        message.className = 'warehouse-page-message';
        message.setAttribute('role', 'status');
        message.textContent = '3D 창고를 불러오는 중입니다.';
        panel.replaceChildren(message);
        try {
            if (!isCurrent()) return;
            const options = getOptions(menu);
            const renderer = await loadRenderer();
            if (!isCurrent()) return;
            const mount = document.createElement('div');
            panel.replaceChildren(mount);
            await renderer.mount(mount, { ...options, onShell: attachWorkspaceModes });
        } catch (error) {
            if (!isCurrent()) return;
            message.textContent = error.message || '3D 창고를 불러오지 못했습니다.';
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.textContent = '다시 시도';
            retry.addEventListener('click', () => {
                dispose(panel);
                setActive(panel, true, menu);
            }, { once: true });
            message.appendChild(retry);
            panel.replaceChildren(message);
        }
    }

    window.wmsWarehousePage = { getViewType, setActive, dispose };
}());
