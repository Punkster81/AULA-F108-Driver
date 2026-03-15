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
    if (layer.type === 'reactive') {
        if (layerViewMode === 'composite') return _getReactiveSnapshot(layer);
        return layer.colors || {};
    }
    const frames = layer.frames || [];
    if (!frames.length) return {};
    return frames[layer._frameIdx || 0]?.colors || {};
}

// ── Reactive layer engine ─────────────────────────────────────────────────────

function _getReactiveSnapshot(layer) {
    const out = {};
    const now = performance.now();
    Object.entries(layer._reactiveColors || {}).forEach(([idx, key]) => {
        let alpha = key.alpha;
        if (key.releaseTime !== null) {
            if (layer.holdMode === 'instant') {
                alpha = 0;
            } else {
                const elapsed = now - key.releaseTime;
                alpha = Math.max(0, 1 - elapsed / (layer.fadeDuration || 500));
            }
        }
        if (alpha > 0) {
            out[idx] = {
                r: Math.round(key.r * alpha),
                g: Math.round(key.g * alpha),
                b: Math.round(key.b * alpha),
            };
        }
    });
    return out;
}

function _tickReactiveLayers() {
    const now = performance.now();
    layers.forEach(layer => {
        if (layer.type !== 'reactive' || !layer.enabled) return;
        const maxHold = (layer.fadeDuration || 500) * 3; // force fade after 3x duration if no release
        Object.keys(layer._reactiveColors).forEach(idx => {
            const key = layer._reactiveColors[idx];
            // Force release if held too long (missed release event)
            if (key.releaseTime === null && (now - key.pressTime) > maxHold) {
                key.releaseTime = now;
            }
            if (key.releaseTime === null) return;
            let alpha;
            if (layer.holdMode === 'instant') {
                alpha = 0;
            } else {
                const elapsed = now - key.releaseTime;
                alpha = Math.max(0, 1 - elapsed / (layer.fadeDuration || 500));
            }
            if (alpha <= 0) delete layer._reactiveColors[idx];
        });
    });
}

let _reactiveLastTs = 0;
let _reactivePollTimer = null;
const REACTIVE_POLL_MS = 16; // ~60fps, independent of compositor

let _reactiveSynced = false;

function startReactivePoller() {
    if (_reactivePollTimer) return;
    _reactiveSynced = false;
    _reactivePollLoop();
}
function stopReactivePoller() {
    clearTimeout(_reactivePollTimer);
    _reactivePollTimer = null;
    _reactiveSynced = false;
}
async function _reactivePollLoop() {
    // Sync config to Python on first run and whenever reactive layers exist
    if (!_reactiveSynced) {
        const hasReactive = layers.some(l => l.type === 'reactive' && l.enabled);
        if (hasReactive) {
            await _syncReactiveConfig();
            _reactiveSynced = true;
        }
    }
    await _pollReactiveLayers();
    _reactivePollTimer = setTimeout(_reactivePollLoop, REACTIVE_POLL_MS);
}

async function _pollReactiveLayers() {
    if (!hasPyAPI()) return;
    const hasReactive = layers.some(l => l.type === 'reactive' && l.enabled);
    if (!hasReactive) return;

    try {
        const res = await window.pywebview.api.poll_keys(_reactiveLastTs);
        if (!res?.ok) return;
        _reactiveLastTs = res.ts;

        const now = performance.now();
        layers.forEach(layer => {
            if (layer.type !== 'reactive' || !layer.enabled) return;
            const defaultColor = layer.color;

            res.events.forEach(ev => {
                const idx = ev.led;
                if (ev.type === 'press') {
                    const { r, g, b } = layer.colors?.[idx] || defaultColor;
                    layer._reactiveColors[idx] = { r, g, b, alpha: 1, releaseTime: null, pressTime: now };
                } else if (ev.type === 'release') {
                    if (layer._reactiveColors[idx]) {
                        layer._reactiveColors[idx].releaseTime = now;
                    } else {
                        // Key released without a press in our window — start fade immediately
                        const { r, g, b } = layer.colors?.[idx] || defaultColor;
                        layer._reactiveColors[idx] = { r, g, b, alpha: 1, releaseTime: now, pressTime: now };
                    }
                }
            });
        });
    } catch (e) { /* silently ignore poll errors */ }
}

async function _syncReactiveConfig() {
    if (!hasPyAPI()) return;
    const reactiveLayers = layers
        .filter(l => l.type === 'reactive' && l.enabled)
        .map(l => ({
            color:        l.color        || {r:255,g:255,b:255},
            colors:       l.colors       || {},
            holdMode:     l.holdMode     || 'fade',
            fadeDuration: l.fadeDuration ?? 500,
            opacity:      (l.opacity     ?? 100) / 100,
        }));
    const hasReactive = reactiveLayers.length > 0;
    try {
        await window.pywebview.api.update_reactive_config(reactiveLayers, hasReactive);
    } catch(e) {}
}


function startCompositor() {
    if (compositorTimer) return;
    _compositorTick();
    startReactivePoller();
}
function stopCompositor() {
    clearTimeout(compositorTimer);
    compositorTimer = null;
    stopReactivePoller();
}
function _compositorTick() {
    _tickReactiveLayers();
    if (layersPanelOpen) {
        if (layerViewMode === 'composite') {
            const merged = compositeLayers();
            _paintKeyboardFromMap(merged);
            if (hasPyAPI()) {
                const hasReactive = layers.some(l => l.type === 'reactive' && l.enabled);
                if (hasReactive) {
                    // Always send base frame to driver so it can overlay reactive on top
                    const base = compositeLayersExcluding('reactive');
                    const payload = {};
                    Object.entries(base).forEach(([idx, {r, g, b}]) => { if (r||g||b) payload[idx]=[r,g,b]; });
                    window.pywebview.api.apply_frame(payload);
                } else if (applyLayersActive) {
                    const payload = {};
                    Object.entries(merged).forEach(([idx, {r, g, b}]) => { if (r||g||b) payload[idx]=[r,g,b]; });
                    window.pywebview.api.apply_frame(payload);
                }
            }
        } else {
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
    const hasReactive = layers.some(l => l.type === 'reactive' && l.enabled);
    const map = layerViewMode === 'composite'
        ? compositeLayersExcluding(hasReactive ? 'reactive' : null)
        : (() => { const l = getActiveLayer(); return l ? getLayerSnapshot(l) : {}; })();
    const payload = {};
    Object.entries(map).forEach(([idx, {r, g, b}]) => { if (r||g||b) payload[idx]=[r,g,b]; });
    window.pywebview.api.apply_frame(payload);
}

function compositeLayers() {
    return compositeLayersExcluding(null);
}

function compositeLayersExcluding(excludeType) {
    // Iterate top (index 0) → bottom (index length-1)
    // result tracks {r,g,b,a} where a is the accumulated coverage (0..1)
    // Standard alpha-over compositing: top layers occlude lower ones
    const result = {}; // idx → {r,g,b,a}  (a = accumulated alpha)
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        if (!layer.enabled) continue;
        if (excludeType && layer.type === excludeType) continue;
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
    layers.forEach(l => { if (l.type === 'reactive') l._reactiveColors = {}; });
    if (typeof _syncReactiveConfig === 'function') _syncReactiveConfig(); // disables Python engine
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
    if (type === 'reactive') {
        return {
            ...base,
            effect:       data.effect       || 'highlight',
            color:        data.color        || { r: 255, g: 255, b: 255 },
            colors:       _normalizeColors(data.colors || {}), // per-key color overrides
            holdMode:     data.holdMode     || 'fade',
            fadeDuration: data.fadeDuration ?? 500,
            _reactiveColors: {},
            _pollTs: 0,
        };
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

    const isReactive = layer?.type === 'reactive';
    const reactiveStrip = document.getElementById('reactiveStripWrap');
    if (reactiveStrip) reactiveStrip.style.display = isReactive ? 'block' : 'none';
    if (isReactive) renderReactiveEffectList(layer);
}

function setReactiveColor(hex) {
    const layer = getActiveLayer();
    if (!layer || layer.type !== 'reactive') return;
    layer.color = { r: parseInt(hex.slice(1,3),16), g: parseInt(hex.slice(3,5),16), b: parseInt(hex.slice(5,7),16) };
    _reactiveSynced = false;
    _syncReactiveConfig();
}

function setReactiveHoldMode(mode) {
    const layer = getActiveLayer();
    if (!layer || layer.type !== 'reactive') return;
    layer.holdMode = mode;
    layer._reactiveColors = {};
    renderReactiveEffectList(layer);
    _reactiveSynced = false;
    _syncReactiveConfig();
}

function setReactiveFadeDuration(ms) {
    const layer = getActiveLayer();
    if (!layer || layer.type !== 'reactive') return;
    layer.fadeDuration = ms;
    ['reactiveFadeDurationVal','rsFadeDurVal'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = ms + 'ms';
    });
    _reactiveSynced = false;
    _syncReactiveConfig();
}

function setActiveLayerType(type) {
    const layer = getActiveLayer();
    if (!layer || layer.type === type) return;
    if (_layerAnimActive) _unmountLayerAnimEditor();
    _stopLayerAnim(layer);
    layer._reactiveColors = {};
    layer.type = type;
    if (type === 'static') {
        layer.colors = JSON.parse(JSON.stringify(getLayerSnapshot(layer)));
    } else if (type === 'animation') {
        layer.frames = [{ duration: 100, colors: JSON.parse(JSON.stringify(layer.colors || {})) }];
        layer._frameIdx = 0;
        layer.loop = true;
        _mountLayerAnimEditor(layer);
    } else if (type === 'reactive') {
        layer.color        = layer.color        || { r: 255, g: 255, b: 255 };
        layer.holdMode     = layer.holdMode     || 'fade';
        layer.fadeDuration = layer.fadeDuration ?? 500;
        layer._reactiveColors = {};
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
    } else if (layer.type === 'reactive') {
        if (!layer.colors) layer.colors = {};
        layer.colors[idx] = { r, g, b };
    } else {
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
        if (layer.type === 'static' || layer.type === 'reactive') {
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
        const { r, g, b } = getCurrentRGB();
        const layer = getActiveLayer();
        if (!layer) { toast('No layer selected'); return; }
        idxs.forEach(idx => {
            if (layer.type === 'static' || layer.type === 'reactive') {
                if (!layer.colors) layer.colors = {};
                layer.colors[idx] = { r, g, b };
            } else {
                const fi = _layerAnimActive ? activeAnimFrame : (layer._frameIdx || 0);
                const f = layer.frames?.[fi];
                if (f) { if (!f.colors) f.colors = {}; f.colors[idx] = { r, g, b }; }
            }
        });
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

function addReactiveLayer() {
    const name = prompt('Layer name:', 'Reactive') || 'Reactive';
    addLayer('reactive', name, {});
    const newLayer = layers[layers.length - 1];
    if (newLayer) selectLayer(newLayer.id);
    _syncReactiveConfig();
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

        const typeIcon = layer.type === 'animation' ? '🎬' : layer.type === 'reactive' ? '⚡' : '✏️';
        const meta     = layer.type === 'animation' ? `${layer.frames?.length || 0}f` : layer.type === 'reactive' ? 'reactive' : 'static';

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
    if (layer.type === 'static' || layer.type === 'reactive') {
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

// ── Reactive effect list ──────────────────────────────────────────────────────
const REACTIVE_EFFECTS = [
    { id: 'highlight', label: 'Key Highlight', icon: '💡', desc: 'Pressed key lights up' },
    // More effects will be added here (ripple, wave, etc.)
];

function renderReactiveEffectList(layer) {
    const el = document.getElementById('reactiveEffectList');
    const settingsEl = document.getElementById('reactiveEffectSettings');
    if (!el) return;
    el.innerHTML = '';

    // Effect cards
    REACTIVE_EFFECTS.forEach(effect => {
        const card = document.createElement('div');
        const isActive = (layer.effect || 'highlight') === effect.id;
        card.className = 'frame-thumb' + (isActive ? ' active-frame' : '');
        card.style.cssText = 'min-width:90px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:6px 10px;cursor:pointer;text-align:center';
        card.innerHTML = `
            <div style="font-size:1.2rem">${effect.icon}</div>
            <div style="font-size:0.6rem;font-weight:600;color:var(--text)">${effect.label}</div>
            <div style="font-size:0.55rem;color:var(--dim)">${effect.desc}</div>`;
        card.addEventListener('click', () => {
            layer.effect = effect.id;
            renderReactiveEffectList(layer);
        });
        el.appendChild(card);
    });

    // Settings below the effect cards
    if (!settingsEl) return;
    settingsEl.innerHTML = '';
    const activeEffect = layer.effect || 'highlight';

    if (activeEffect === 'highlight') {
        const fadeActive   = (layer.holdMode || 'fade') === 'fade';
        const instantActive = (layer.holdMode || 'fade') === 'instant';
        settingsEl.innerHTML = `
            <div style="display:flex;gap:5px;align-items:center">
                <span style="font-size:0.6rem;color:var(--dim);white-space:nowrap">After release:</span>
                <button class="layer-type-btn ${fadeActive?'active-mode':''}" onclick="setReactiveHoldMode('fade')" style="font-size:0.58rem;padding:3px 8px">FADE OUT</button>
                <button class="layer-type-btn ${instantActive?'active-mode':''}" onclick="setReactiveHoldMode('instant')" style="font-size:0.58rem;padding:3px 8px">INSTANT OFF</button>
            </div>
            ${fadeActive ? `
            <div style="display:flex;gap:6px;align-items:center">
                <span style="font-size:0.6rem;color:var(--dim);white-space:nowrap">Fade:</span>
                <input type="range" min="50" max="3000" step="50" value="${layer.fadeDuration??500}"
                    oninput="setReactiveFadeDuration(parseInt(this.value))"
                    style="width:120px">
                <span id="rsFadeDurVal" style="font-size:0.6rem;color:var(--text);min-width:38px">${layer.fadeDuration??500}ms</span>
            </div>` : ''}
            <div style="display:flex;gap:6px;align-items:center">
                <span style="font-size:0.6rem;color:var(--dim);white-space:nowrap">Default color:</span>
                <input type="color" value="${_rgbToHex(layer.color||{r:255,g:255,b:255})}"
                    oninput="setReactiveColor(this.value)"
                    style="width:36px;height:24px;border:1px solid var(--border);border-radius:4px;background:none;cursor:pointer">
                <span style="font-size:0.55rem;color:var(--dim)">Paint keys for per-key colors</span>
            </div>`;
    }
}

function _rgbToHex(c) {
    return '#' + [c.r||0, c.g||0, c.b||0].map(x => x.toString(16).padStart(2,'0')).join('');
}


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
    _syncReactiveConfig(); // ensure Python engine knows about reactive layers
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
    return layers.map(l => {
        const out = {
            name: l.name, type: l.type,
            enabled: l.enabled, opacity: l.opacity,
        };
        if (l.type === 'static') {
            out.colors = l.colors || {};
        } else if (l.type === 'reactive') {
            out.effect       = l.effect       || 'highlight';
            out.color        = l.color        || { r: 255, g: 255, b: 255 };
            out.colors       = l.colors       || {};
            out.holdMode     = l.holdMode     || 'fade';
            out.fadeDuration = l.fadeDuration ?? 500;
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