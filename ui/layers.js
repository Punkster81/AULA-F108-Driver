// ── Layer System ──────────────────────────────────────────────────────────────
// Layers mode replaces animation mode visually — uses the same keyboard,
// same toolbar, and renders a layer strip at the bottom (where the timeline is).
//
// Each layer: { id, name, type, enabled, opacity, colors, frames, loop, _frameIdx, _timer }
//   type = 'static'    → colors = {idx: {r,g,b}}  (absent key = transparent)
//   type = 'animation' → frames = [{duration, colors}], loop, _frameIdx, _timer
//
// "Empty" key = absent from colors. Black {0,0,0} IS a real color. Only absence = transparent.
// Compositor merges bottom→top. Top enabled layer with a color for a key wins (alpha-blended).

let layers        = [];
let layerIdCtr    = 0;
let activeLayerId = null;
let layerViewMode = 'layer'; // 'composite' | 'layer'
let layersPanelOpen = false;
let compositorTimer = null;
let applyLayersActive = false; // true after APPLY LAYERS — streams animated composite to hardware
const COMPOSITOR_MS = 35;

// ── ID ────────────────────────────────────────────────────────────────────────
function nextLayerId() { return ++layerIdCtr; }

// ── Active layer ──────────────────────────────────────────────────────────────
function getActiveLayer() { return layers.find(l => l.id === activeLayerId) || null; }

function getLayerSnapshot(layer) {
    if (!layer) return {};
    if (layer.type === 'static') return layer.colors || {};
    const frames = layer.frames || [];
    if (!frames.length) return {};
    return frames[layer._frameIdx || 0]?.colors || {};
}

// ── Compositor ────────────────────────────────────────────────────────────────
function startCompositor() {
    if (compositorTimer) return;
    _compositorTick();
}
function stopCompositor() {
    clearTimeout(compositorTimer);
    compositorTimer = null;
}
function _compositorTick() {
    if (layersPanelOpen) {
        if (layerViewMode === 'composite') {
            const merged = compositeLayers();
            _paintKeyboardFromMap(merged);
            // Only send to hardware if apply is active (animation streaming)
            if (applyLayersActive && hasPyAPI()) {
                const payload = {};
                Object.entries(merged).forEach(([idx, {r, g, b}]) => { if (r||g||b) payload[idx]=[r,g,b]; });
                window.pywebview.api.apply_frame(payload);
            }
        } else {
            // Single-layer view: update screen only. Hardware gets a static snapshot via _sendStaticSnapshot().
            const layer = getActiveLayer();
            const snap = layer ? getLayerSnapshot(layer) : {};
            _paintKeyboardFromMap(snap);
        }
    }
    compositorTimer = setTimeout(_compositorTick, COMPOSITOR_MS);
}

// Send a single static frame to hardware — used when not animating
function _sendStaticSnapshot() {
    if (!hasPyAPI()) return;
    const map = layerViewMode === 'composite' ? compositeLayers()
        : (() => { const l = getActiveLayer(); return l ? getLayerSnapshot(l) : {}; })();
    const payload = {};
    Object.entries(map).forEach(([idx, {r, g, b}]) => { if (r||g||b) payload[idx]=[r,g,b]; });
    window.pywebview.api.apply_frame(payload);
}

function compositeLayers() {
    // Iterate top (index 0) → bottom (index length-1)
    // result tracks {r,g,b,a} where a is the accumulated coverage (0..1)
    // Standard alpha-over compositing: top layers occlude lower ones
    const result = {}; // idx → {r,g,b,a}  (a = accumulated alpha)
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        if (!layer.enabled) continue;
        const snap = getLayerSnapshot(layer);
        const layerAlpha = layer.opacity / 100;
        Object.entries(snap).forEach(([idx, {r, g, b}]) => {
            const acc = result[idx];
            if (!acc) {
                result[idx] = { r: r * layerAlpha, g: g * layerAlpha, b: b * layerAlpha, a: layerAlpha };
            } else {
                // Blend this layer under the accumulated result
                const remainingAlpha = (1 - acc.a) * layerAlpha;
                result[idx] = {
                    r: acc.r + r * remainingAlpha,
                    g: acc.g + g * remainingAlpha,
                    b: acc.b + b * remainingAlpha,
                    a: Math.min(1, acc.a + remainingAlpha),
                };
            }
        });
    }
    // Convert to integer RGB
    const out = {};
    Object.entries(result).forEach(([idx, {r, g, b}]) => {
        out[idx] = { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
    });
    return out;
}

function _paintKeyboardFromMap(colorMap) {
    Object.keys(keyEls).forEach(idx => {
        const c = colorMap[idx];
        c ? paintKey(idx, c.r, c.g, c.b) : paintKey(idx, 0, 0, 0);
    });
}

function _stopAllPlayback() {
    applyLayersActive = false;
    isPlaying = false;
    clearTimeout(previewTimer);
    _stopAllLayerAnims();
    if (typeof _syncAllPlayBtns === 'function') _syncAllPlayBtns(false);
}

function _startAllLayerAnims() {
    // Fresh start from frame 0
    layers.forEach(l => {
        if (l.type === 'animation' && l.enabled) {
            l._frameIdx = 0;
            _startLayerAnim(l);
        }
    });
}
function _resumeAllLayerAnims() {
    // Resume from current frame position (used when switching layers mid-play)
    layers.forEach(l => { if (l.type === 'animation' && l.enabled) _startLayerAnim(l); });
}
function _stopAllLayerAnims() {
    layers.forEach(l => _stopLayerAnim(l));
}

// ── Animation layer ticking ───────────────────────────────────────────────────
function _startLayerAnim(layer) {
    if (layer.type !== 'animation') return;
    _stopLayerAnim(layer);
    // Preserve current frame position — don't reset to 0
    if (layer._frameIdx === undefined) layer._frameIdx = 0;
    layer._running = true;
    _scheduleNextTick(layer);
}
function _stopLayerAnim(layer) {
    clearTimeout(layer._timer);
    layer._timer = null;
    layer._running = false;
}
function _scheduleNextTick(layer) {
    if (!layer._running) return;
    const frames = layer.frames || [];
    if (!frames.length) return;
    // Schedule based on the CURRENT frame's duration, then advance BEFORE next read
    const dur = frames[layer._frameIdx]?.duration || 100;
    layer._timer = setTimeout(() => {
        if (!layer._running) return;
        const next = (layer._frameIdx + 1) % frames.length;
        if (!layer.loop && next === 0) { layer._running = false; return; }
        layer._frameIdx = next; // advance atomically
        _scheduleNextTick(layer);
    }, dur);
}

// ── Layer CRUD ────────────────────────────────────────────────────────────────
function _normalizeColor(c) {
    if (!c) return null;
    if (Array.isArray(c)) return { r: c[0] || 0, g: c[1] || 0, b: c[2] || 0 };
    return { r: c.r || 0, g: c.g || 0, b: c.b || 0 };
}
function _normalizeColors(colors) {
    const out = {};
    Object.entries(colors || {}).forEach(([idx, c]) => {
        const n = _normalizeColor(c);
        if (n) out[idx] = n;
    });
    return out;
}

function _makeLayer(type, name, data) {
    const base = {
        id: nextLayerId(), name: name || 'Layer', type,
        enabled: true, opacity: 100,
        _frameIdx: 0, _timer: null, _running: false
    };
    if (type === 'static') {
        return { ...base, colors: _normalizeColors(data.colors || {}) };
    }
    return {
        ...base,
        frames: (data.frames || []).map(f => ({
            duration: f.duration || 100,
            colors: _normalizeColors(f.colors || {})
        })),
        loop: data.loop !== false
    };
}

function addLayer(type, name, data) {
    const layer = _makeLayer(type, name, data);
    layers.push(layer);  // add to end (bottom of stack)
    if (type === 'animation' && applyLayersActive) _startLayerAnim(layer);
    selectLayer(layer.id);
    renderLayerStrip();
    toast(`Layer "${layer.name}" added`);
}

function removeLayer(id) {
    const idx = layers.findIndex(l => l.id === id);
    if (idx < 0) return;
    // If removing the layer currently in the anim editor, unmount first
    if (_layerAnimActive && activeLayerId === id) _unmountLayerAnimEditor(true);
    _stopLayerAnim(layers[idx]);
    layers.splice(idx, 1);
    if (activeLayerId === id) activeLayerId = layers[0]?.id || null;
    renderLayerStrip();
    _refreshKeyboard();
    // Mount anim editor if the newly active layer is animation, unmount if not
    const nowActive = getActiveLayer();
    if (nowActive && nowActive.type === 'animation' && !_layerAnimActive) {
        _mountLayerAnimEditor(nowActive);
    } else if ((!nowActive || nowActive.type !== 'animation') && _layerAnimActive) {
        _unmountLayerAnimEditor(true);
    }
    _syncLayerAnimControls();
}

function selectLayer(id) {
    // Stop all preview and animations when switching layers
    if (applyLayersActive || (typeof isPlaying !== 'undefined' && isPlaying)) {
        _stopAllPlayback();
    }

    // Unmount anim editor from previous layer before switching
    if (_layerAnimActive) _unmountLayerAnimEditor();

    activeLayerId = id;
    deactivateEraser();
    _syncControlsToLayer();
    renderLayerStrip();
    _refreshKeyboard();

    // Mount anim editor if newly selected layer is animation
    const layer = getActiveLayer();
    if (layer && layer.type === 'animation') {
        _mountLayerAnimEditor(layer);
    } else {
        // Switched to a static layer — stop hardware streaming
        if (applyLayersActive && layerViewMode !== 'composite') {
            _stopAllPlayback();
        }
    }
}

function _syncControlsToLayer() {
    const layer = getActiveLayer();
    document.getElementById('layerTypeBtns')?.querySelectorAll('.layer-type-btn').forEach(btn => {
        btn.classList.toggle('active-mode', !!layer && btn.dataset.type === layer.type);
        btn.disabled = !layer;
    });
    const slider = document.getElementById('layerOpacitySlider');
    const val    = document.getElementById('layerOpacityVal');
    if (slider) { slider.value = layer?.opacity ?? 100; slider.disabled = !layer; }
    if (val)    val.textContent = (layer?.opacity ?? 100) + '%';
}

function setActiveLayerType(type) {
    const layer = getActiveLayer();
    if (!layer || layer.type === type) return;
    if (_layerAnimActive) _unmountLayerAnimEditor();
    _stopLayerAnim(layer);
    layer.type = type;
    if (type === 'static') {
        layer.colors = JSON.parse(JSON.stringify(getLayerSnapshot(layer)));
    } else {
        layer.frames = [{ duration: 100, colors: JSON.parse(JSON.stringify(layer.colors || {})) }];
        layer._frameIdx = 0;
        layer.loop = true;
        // Don't start ticker — only runs when streaming is active
        _mountLayerAnimEditor(layer);
    }
    _syncControlsToLayer();
    renderLayerStrip();
    toast(`Layer set to ${type}`);
}

function setActiveLayerOpacity(val) {
    const layer = getActiveLayer();
    if (!layer) return;
    layer.opacity = parseInt(val) || 100;
    document.getElementById('layerOpacityVal').textContent = layer.opacity + '%';
}

function toggleLayerEnabled(id) {
    const layer = layers.find(l => l.id === id);
    if (!layer) return;
    layer.enabled = !layer.enabled;
    if (layer.type === 'animation') {
        const shouldRun = layer.enabled && (applyLayersActive || (typeof isPlaying !== 'undefined' && isPlaying));
        shouldRun ? _startLayerAnim(layer) : _stopLayerAnim(layer);
    }
    renderLayerStrip();
}

function moveLayerUp(id) {
    const i = layers.findIndex(l => l.id === id);
    if (i <= 0) return;
    [layers[i-1], layers[i]] = [layers[i], layers[i-1]];
    renderLayerStrip();
}
function moveLayerDown(id) {
    const i = layers.findIndex(l => l.id === id);
    if (i < 0 || i >= layers.length - 1) return;
    [layers[i], layers[i+1]] = [layers[i+1], layers[i]];
    renderLayerStrip();
}

function clearAllLayers() {
    layers.forEach(l => _stopLayerAnim(l));
    layers = [];
    activeLayerId = null;
    renderLayerStrip();
    _refreshKeyboard();
    if (hasPyAPI()) window.pywebview.api.clear();
    toast('All layers cleared');
}

// ── Painting into the active layer ───────────────────────────────────────────
function layerPaintKey(idx) {
    if (eraserMode) { eraseLayerKey(idx); return; }
    const layer = getActiveLayer();
    if (!layer) { toast('No layer selected'); return; }
    const { r, g, b } = getCurrentRGB();
    if (layer.type === 'static') {
        layer.colors[idx] = { r, g, b };
    } else {
        // Use activeAnimFrame when editor is mounted, otherwise layer._frameIdx
        const fi = _layerAnimActive ? activeAnimFrame : (layer._frameIdx || 0);
        const frame = layer.frames?.[fi];
        if (frame) {
            if (!frame.colors) frame.colors = {};
            frame.colors[idx] = { r, g, b };
            if (_layerAnimActive && typeof updateFrameThumb === 'function') updateFrameThumb(fi);
        }
    }
    _refreshKeyboard();
}

function _refreshKeyboard() {
    if (!layersPanelOpen) return;
    if (layerViewMode === 'composite') _paintKeyboardFromMap(compositeLayers());
    else { const l = getActiveLayer(); _paintKeyboardFromMap(l ? getLayerSnapshot(l) : {}); }
    // Always send a static snapshot so hardware reflects what you see
    if (!applyLayersActive && !isPlaying) _sendStaticSnapshot();
}

// ── Mode entry ────────────────────────────────────────────────────────────────
modes.layers = {
    onKeyPaint(idx) { layerPaintKey(idx); },
    onClearAll() {
        const layer = getActiveLayer();
        if (!layer) { toast('No layer selected'); return; }
        if (layer.type === 'static') {
            layer.colors = {};
        } else {
            const fi = _layerAnimActive ? activeAnimFrame : (layer._frameIdx || 0);
            const f = layer.frames?.[fi];
            if (f) {
                f.colors = {};
                if (_layerAnimActive && typeof updateFrameThumb === 'function') updateFrameThumb(fi);
            }
        }
        _refreshKeyboard();
        toast('Layer cleared');
    },
    onApplySelected(idxs) {
        // Reuse layerPaintKey for each idx — it handles frame index, thumb update, and refresh
        const { r, g, b } = getCurrentRGB();
        const layer = getActiveLayer();
        if (!layer) { toast('No layer selected'); return; }
        idxs.forEach(idx => {
            if (layer.type === 'static') {
                layer.colors[idx] = { r, g, b };
            } else {
                const fi = _layerAnimActive ? activeAnimFrame : (layer._frameIdx || 0);
                const f = layer.frames?.[fi];
                if (f) { if (!f.colors) f.colors = {}; f.colors[idx] = { r, g, b }; }
            }
        });
        // Update thumb once after all keys applied
        if (layer.type === 'animation' && _layerAnimActive && typeof updateFrameThumb === 'function') {
            updateFrameThumb(activeAnimFrame);
        }
        _refreshKeyboard();
    },
    onPickSource(idx) {
        const l = getActiveLayer();
        return l ? (getLayerSnapshot(l)[idx] || null) : null;
    }
};

// ── Add layer helpers ─────────────────────────────────────────────────────────
function addStaticLayerFromCurrent() {
    if (!Object.keys(keyColors).length) { toast('No colors in current view'); return; }
    const name = prompt('Layer name:', 'Static Layer') || 'Static Layer';
    addLayer('static', name, { colors: keyColors });
}
function addAnimLayerFromCurrent() {
    if (!animFrames.length) { toast('No animation frames'); return; }
    const hasColors = animFrames.some(f => Object.keys(f.colors || {}).length > 0);
    if (!hasColors) { toast('No colors in current animation — paint some keys first'); return; }
    const name = prompt('Layer name:', document.getElementById('animNameInput')?.value || 'Anim Layer') || 'Anim Layer';
    addLayer('animation', name, {
        loop: document.getElementById('loopAnim')?.checked !== false,
        frames: animFrames.map(f => ({ duration: f.duration, colors: f.colors }))
    });
}
function addLayerFromSavedAnim() {
    const sel = document.getElementById('layerAnimSelect');
    if (!sel?.value) { toast('Select an animation'); return; }
    const data = savedAnimations[sel.value];
    if (!data) { toast('Not found'); return; }
    addLayer('animation', data.name || sel.value, data);
    sel.value = '';
}
function addLayerFromSavedStatic() {
    const sel = document.getElementById('layerStaticSelect');
    if (!sel?.value) { toast('Select a preset'); return; }
    const data = savedLightings[sel.value];
    if (!data) { toast('Not found'); return; }
    addLayer('static', data.name || sel.value, { colors: data.colors || {} });
    sel.value = '';
}
function addBlankLayer() {
    const name = prompt('Layer name:', 'New Layer') || 'New Layer';
    addLayer('static', name, { colors: {} });
}

// ── View mode ─────────────────────────────────────────────────────────────────
function setLayerViewMode(mode) {
    layerViewMode = mode;
    // strip header buttons
    document.getElementById('layerViewComposite')?.classList.toggle('active-mode', mode === 'composite');
    document.getElementById('layerViewSingle')?.classList.toggle('active-mode', mode === 'layer');
    // left panel buttons
    document.getElementById('leftViewComposite')?.classList.toggle('active-mode', mode === 'composite');
    document.getElementById('leftViewSingle')?.classList.toggle('active-mode', mode === 'layer');
    _syncLayerAnimControls();
    _refreshKeyboard();
}

// ── Render layer strip (replaces timeline) ───────────────────────────────────
let _dragSrcLayerIdx = null;

function renderLayerStrip() {
    const strip = document.getElementById('layerStrip');
    if (!strip) return;
    strip.innerHTML = '';

    // Update counter
    const countEl = document.getElementById('layerCountLabel');
    if (countEl) countEl.textContent = layers.length;

    if (!layers.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:0.62rem;color:var(--dim);padding:14px 16px;align-self:center';
        empty.textContent = 'No layers yet — add one using the panel on the right';
        strip.appendChild(empty);
        _syncControlsToLayer();
        return;
    }

    layers.forEach((layer, i) => {
        const isActive = layer.id === activeLayerId;
        const card = document.createElement('div');
        card.className = 'layer-card'
            + (isActive ? ' active-layer-card' : '')
            + (layer.enabled ? '' : ' layer-card-off');
        card.draggable = true;
        card.dataset.idx = i;

        const typeIcon = layer.type === 'animation' ? '🎬' : '✏️';
        const meta     = layer.type === 'animation' ? `${layer.frames?.length || 0}f` : 'static';

        card.innerHTML = `
            <div class="layer-card-top">
                <button class="lc-vis" onclick="event.stopPropagation();toggleLayerEnabled(${layer.id})"
                class="lc-vis${layer.enabled ? '' : ' lc-vis-off'}"
                >${'👁️'}</button>
                <span class="lc-icon">${typeIcon}</span>
                <span class="lc-name">${layer.name}</span>
                <span class="lc-meta">${meta}</span>
                <div class="lc-arrows">
                    <button onclick="event.stopPropagation();moveLayerUp(${layer.id})" ${i===0?'disabled':''}>▲</button>
                    <button onclick="event.stopPropagation();moveLayerDown(${layer.id})" ${i===layers.length-1?'disabled':''}>▼</button>
                </div>
                <button class="lc-del" onclick="event.stopPropagation();removeLayer(${layer.id})">✕</button>
            </div>
            <div class="layer-card-bar">
                <input type="range" min="0" max="100" value="${layer.opacity}"
                    oninput="event.stopPropagation();layers.find(l=>l.id===${layer.id}).opacity=parseInt(this.value);this.nextElementSibling.textContent=this.value+'%'"
                    onclick="event.stopPropagation()">
                <span>${layer.opacity}%</span>
            </div>`;

        // Prevent drag when using the opacity slider
        const slider = card.querySelector('input[type=range]');
        if (slider) {
            slider.addEventListener('mousedown', e => { e.stopPropagation(); card.draggable = false; });
            slider.addEventListener('mouseup',   () => { card.draggable = true; });
        }

        // Drag-drop handlers
        card.addEventListener('dragstart', e => {
            _dragSrcLayerIdx = i;
            card.classList.add('layer-dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('layer-dragging');
            strip.querySelectorAll('.layer-card').forEach(c => c.classList.remove('layer-drag-over'));
        });
        card.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            strip.querySelectorAll('.layer-card').forEach(c => c.classList.remove('layer-drag-over'));
            if (_dragSrcLayerIdx !== i) card.classList.add('layer-drag-over');
        });
        card.addEventListener('drop', e => {
            e.preventDefault();
            if (_dragSrcLayerIdx === null || _dragSrcLayerIdx === i) return;
            const moved = layers.splice(_dragSrcLayerIdx, 1)[0];
            layers.splice(i, 0, moved);
            _dragSrcLayerIdx = null;
            renderLayerStrip();
            _refreshKeyboard();
        });

        card.addEventListener('click', () => selectLayer(layer.id));
        strip.appendChild(card);
    });

    // + button
    const addBtn = document.createElement('button');
    addBtn.className = 'layer-strip-add';
    addBtn.textContent = '+';
    addBtn.title = 'Add blank layer';
    addBtn.onclick = addBlankLayer;
    strip.appendChild(addBtn);

    _syncControlsToLayer();
    if (typeof _syncLayerAnimControls === 'function') _syncLayerAnimControls();
}

// ── Refresh pickers (called after savedAnimations/savedLightings update) ──────
function refreshLayerPickers() {
    const animSel = document.getElementById('layerAnimSelect');
    if (animSel) {
        const cur = animSel.value;
        animSel.innerHTML = '<option value="">— saved animation —</option>';
        Object.entries(savedAnimations || {}).forEach(([fn, d]) => {
            const o = document.createElement('option');
            o.value = fn; o.textContent = d.name || fn;
            animSel.appendChild(o);
        });
        animSel.value = cur;
    }
    const staticSel = document.getElementById('layerStaticSelect');
    if (staticSel) {
        const cur = staticSel.value;
        staticSel.innerHTML = '<option value="">— saved preset —</option>';
        Object.entries(savedLightings || {}).forEach(([fn, d]) => {
            const o = document.createElement('option');
            o.value = fn; o.textContent = d.name || fn;
            staticSel.appendChild(o);
        });
        staticSel.value = cur;
    }
}

// ── Eraser mode ───────────────────────────────────────────────────────────────
let eraserMode = false;

function toggleEraser() {
    eraserMode = !eraserMode;
    const btn = document.getElementById('eraserBtn');
    if (btn) {
        btn.classList.toggle('eraser-active', eraserMode);
        btn.textContent = eraserMode ? '⬜ Eraser ON' : '⬜ Eraser';
    }
    if (eraserMode) {
        eyedropperMode = false;
        document.querySelectorAll('.eyedropper-btn').forEach(b => b.classList.remove('active-mode'));
    }
    if (typeof updateSelPanel === 'function') updateSelPanel();
}

function deactivateEraser() {
    eraserMode = false;
    const btn = document.getElementById('eraserBtn');
    if (btn) {
        btn.classList.remove('eraser-active');
        btn.textContent = '⬜ Eraser';
    }
}

function eraseLayerKey(idx) {
    const layer = getActiveLayer();
    if (!layer) return;
    if (layer.type === 'static') {
        delete layer.colors[idx];
    } else {
        const fi = _layerAnimActive ? activeAnimFrame : (layer._frameIdx || 0);
        const frame = layer.frames?.[fi];
        if (frame?.colors) {
            delete frame.colors[idx];
            if (_layerAnimActive && typeof updateFrameThumb === 'function') updateFrameThumb(fi);
        }
    }
    _refreshKeyboard();
}

// ── Layer animation editor ────────────────────────────────────────────────────
// When an anim layer is active we redirect the global animFrames array and
// activeAnimFrame index to point at the layer's own frames. All existing anim
// functions (addFrame, renderTimeline, selectAnimFrame, etc.) work unchanged.

let _layerAnimActive = false;  // true when an anim layer has hijacked the anim editor
let _savedAnimFrames = null;   // stash of the real anim editor frames while hijacked
let _savedActiveAnimFrame = -1;

function _mountLayerAnimEditor(layer) {
    if (_layerAnimActive) _unmountLayerAnimEditor();

    // Only stop this layer's ticker — editor controls it now.
    // All other layer tickers keep running if preview is active.
    _stopLayerAnim(layer);

    _layerAnimActive = true;
    _savedAnimFrames = animFrames;
    _savedActiveAnimFrame = activeAnimFrame;

    // Stop the background ticker — editor controls playback while mounted
    _stopLayerAnim(layer);

    // Redirect globals that all anim functions use
    animFrames = layer.frames;
    activeAnimFrame = Math.min(layer._frameIdx || 0, layer.frames.length - 1);
    if (activeAnimFrame < 0) activeAnimFrame = 0;

    // Show timeline + anim left tools; keep layersLeft visible too
    document.getElementById('timelineWrap').style.display = 'block';
    document.getElementById('animLeft').style.display = 'block';
    document.getElementById('layerHint').style.display = 'none';
    document.getElementById('animHint').style.display = 'block';
    document.getElementById('layerAnimControls').style.display = 'block';

    renderTimeline();
    updateAnimFrameCount();
    updateTotalDuration();
    if (animFrames.length > 0) selectAnimFrame(activeAnimFrame);
    else addFrame();

    // Sync both loop checkboxes from layer.loop
    const loopVal = layer.loop !== false;
    const layerLoop = document.getElementById('layerLoopAnim');
    const mainLoop  = document.getElementById('loopAnim');
    if (layerLoop) layerLoop.checked = loopVal;
    if (mainLoop)  mainLoop.checked  = loopVal;
}

function _unmountLayerAnimEditor(fullyStop = false) {
    if (!_layerAnimActive) return;

    if (fullyStop) {
        _stopAllPlayback();
    }

    // Save editor state back into the layer
    const layer = getActiveLayer();
    if (layer && layer.type === 'animation') {
        layer._frameIdx = activeAnimFrame;
        layer.frames = animFrames;
        const layerLoop = document.getElementById('layerLoopAnim');
        if (layerLoop) layer.loop = layerLoop.checked;
    }

    _layerAnimActive = false;
    animFrames = _savedAnimFrames;
    activeAnimFrame = _savedActiveAnimFrame;
    _savedAnimFrames = null;

    // Restart ALL layer tickers at their current positions if still playing
    if (applyLayersActive || (typeof isPlaying !== 'undefined' && isPlaying)) {
        _resumeAllLayerAnims();
    }

    document.getElementById('timelineWrap').style.display = 'none';
    document.getElementById('animLeft').style.display = 'none';
    document.getElementById('animHint').style.display = 'none';
    document.getElementById('layerHint').style.display = 'block';
    document.getElementById('layerAnimControls').style.display = 'none';
}

function _syncLayerLoop(checked) {
    const layer = getActiveLayer();
    if (layer) layer.loop = checked;
    const mainLoop = document.getElementById('loopAnim');
    if (mainLoop) mainLoop.checked = checked;
}

function _syncLayerAnimControls() {
    const hasAnimLayer = layers.some(l => l.type === 'animation' && l.enabled);
    const show = _layerAnimActive || (layerViewMode === 'composite' && hasAnimLayer);
    document.getElementById('layerAnimControls').style.display = show ? 'block' : 'none';
    if (!show) {
        // Ensure button is not stuck in playing state
        if (typeof _syncAllPlayBtns === 'function') _syncAllPlayBtns(false);
    }
}

// ── Open / close ──────────────────────────────────────────────────────────────
function openLayersPanel() {
    layersPanelOpen = true;
    activeMode = modes.layers;

    document.getElementById('staticLeft').style.display  = 'none';
    document.getElementById('animLeft').style.display    = 'none';
    document.getElementById('layersLeft').style.display  = 'block';
    document.getElementById('staticRight').style.display = 'none';
    document.getElementById('animRight').style.display   = 'none';
    document.getElementById('layersRight').style.display = 'flex';

    document.getElementById('timelineWrap').style.display   = 'none';
    document.getElementById('layerStripWrap').style.display = 'block';

    document.getElementById('staticHint').style.display = 'none';
    document.getElementById('animHint').style.display   = 'none';
    document.getElementById('layerHint').style.display  = 'block';

    document.getElementById('layersPanelBtn')?.classList.add('active-mode');

    // Sync view mode buttons (strip + left panel)
    document.getElementById('layerViewComposite')?.classList.toggle('active-mode', layerViewMode === 'composite');
    document.getElementById('layerViewSingle')?.classList.toggle('active-mode', layerViewMode === 'layer');
    document.getElementById('leftViewComposite')?.classList.toggle('active-mode', layerViewMode === 'composite');
    document.getElementById('leftViewSingle')?.classList.toggle('active-mode', layerViewMode === 'layer');

    renderLayerStrip();
    refreshLayerPickers();
    loadLayerPresets();
    applyLayersActive = false; // never auto-stream on open
    // Auto-create a blank layer on first open
    if (!layers.length) addLayer('static', 'Layer 1', { colors: {} });
    // Mount anim editor if active layer is an animation
    const _activeonOpen = getActiveLayer();
    if (_activeonOpen && _activeonOpen.type === 'animation') _mountLayerAnimEditor(_activeonOpen);
    _syncLayerAnimControls();
    if (typeof stopStaticStream === 'function') stopStaticStream();
    _refreshKeyboard();
    startCompositor();
}

function closeLayersPanel() {
    layersPanelOpen = false;
    activeMode = modes.static;

    if (_layerAnimActive) _unmountLayerAnimEditor(true);

    document.getElementById('staticLeft').style.display  = 'block';
    document.getElementById('animLeft').style.display    = 'none';
    document.getElementById('layersLeft').style.display  = 'none';
    document.getElementById('staticRight').style.display = 'block';
    document.getElementById('animRight').style.display   = 'none';
    document.getElementById('layersRight').style.display = 'none';

    document.getElementById('timelineWrap').style.display   = 'none';
    document.getElementById('layerStripWrap').style.display = 'none';

    document.getElementById('staticHint').style.display = 'block';
    document.getElementById('animHint').style.display   = 'none';
    document.getElementById('layerHint').style.display  = 'none';

    document.getElementById('layersPanelBtn')?.classList.remove('active-mode');

    deactivateEraser();
    restoreMainKeyboard();
    stopCompositor();
    _stopAllPlayback();
    if (typeof startStaticStream === 'function') startStaticStream();
}

function toggleLayersPanel() {
    layersPanelOpen ? closeLayersPanel() : openLayersPanel();
}

// ── Layer preset save / load ───────────────────────────────────────────────────
let savedLayerPresets = {}; // filename → preset data

function _serializeLayers() {
    // Strip runtime-only fields (_timer, _running, id) before saving
    return layers.map(l => {
        const out = {
            name: l.name, type: l.type,
            enabled: l.enabled, opacity: l.opacity,
        };
        if (l.type === 'static') {
            out.colors = l.colors || {};
        } else {
            out.loop = l.loop !== false;
            out.frames = (l.frames || []).map(f => ({ duration: f.duration, colors: f.colors || {} }));
        }
        return out;
    });
}

function _deserializeLayers(rawLayers) {
    layers.forEach(l => _stopLayerAnim(l));
    layers = [];
    activeLayerId = null;
    (rawLayers || []).forEach(raw => {
        const layer = _makeLayer(raw.type, raw.name, raw);
        layer.enabled = raw.enabled !== false;
        layer.opacity = raw.opacity ?? 100;
        layers.push(layer);
    });
    if (layers.length) activeLayerId = layers[0].id;
}

async function saveLayerPreset() {
    if (!hasPyAPI()) { toast('Not connected'); return; }
    const nameEl = document.getElementById('layerPresetNameInput');
    const name = nameEl?.value?.trim() || 'My Layers';
    const data = { layers: _serializeLayers() };
    const res = await window.pywebview.api.save_layer_preset(name, data);
    if (res.ok) { toast(`Saved "${name}"`); await loadLayerPresets(); }
    else toast('Save failed: ' + res.message);
}

async function loadLayerPresets() {
    if (!hasPyAPI()) return;
    const res = await window.pywebview.api.list_layer_presets();
    if (!res.ok) return;
    savedLayerPresets = {};
    res.presets.forEach(p => { savedLayerPresets[p.filename] = p; });
    renderLayerPresetList();
}

function renderLayerPresetList() {
    const el = document.getElementById('savedLayersList');
    if (!el) return;
    el.innerHTML = '';
    const entries = Object.entries(savedLayerPresets);
    if (!entries.length) {
        el.innerHTML = '<div style="font-size:0.6rem;color:var(--dim)">No saved presets</div>';
        return;
    }
    entries.forEach(([fname, preset]) => {
        const item = document.createElement('div');
        item.className = 'saved-anim-item';
        item.innerHTML = `
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${fname}">${preset.name}</span>
            <span style="font-size:0.58rem;color:var(--dim);flex-shrink:0">${preset.layer_count}L</span>
            <button class="load-btn">LOAD</button>
            <button class="del-btn">✕</button>`;
        item.querySelector('.load-btn').addEventListener('click', () => _loadLayerPreset(preset));
        item.querySelector('.del-btn').addEventListener('click', async () => {
            await window.pywebview.api.delete_layer_preset(fname);
            await loadLayerPresets();
        });
        el.appendChild(item);
    });
}

function _loadLayerPreset(preset) {
    _stopAllPlayback();
    if (_layerAnimActive) _unmountLayerAnimEditor(true);
    _deserializeLayers(preset.layers);
    renderLayerStrip();
    _refreshKeyboard();
    // Mount anim editor if active layer is animation
    const active = getActiveLayer();
    if (active && active.type === 'animation') _mountLayerAnimEditor(active);
    _syncLayerAnimControls();
    toast(`Loaded "${preset.name}"`);
}

// Button is now in HTML as part of the 3-way mode group — no injection needed.