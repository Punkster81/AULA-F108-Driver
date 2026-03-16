// ── Shared color state (single source of truth) ───────────────────────────────
const colorInput   = document.getElementById('colorInput');
const colorPreview = document.getElementById('colorPreview');
const rVal = document.getElementById('rVal');
const gVal = document.getElementById('gVal');
const bVal = document.getElementById('bVal');

function getCurrentRGB() {
    return { r: parseInt(rVal.value) || 0, g: parseInt(gVal.value) || 0, b: parseInt(bVal.value) || 0 };
}
function setColorHex(hex) {
    colorInput.value = hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    rVal.value = r; gVal.value = g; bVal.value = b;
    colorPreview.style.background = hex;
}
function syncFromPicker() { setColorHex(colorInput.value); }
function syncFromRGB() {
    const r = Math.min(255, Math.max(0, parseInt(rVal.value) || 0));
    const g = Math.min(255, Math.max(0, parseInt(gVal.value) || 0));
    const b = Math.min(255, Math.max(0, parseInt(bVal.value) || 0));
    const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    // Update preview and picker without overwriting the number inputs mid-type
    colorInput.value = hex;
    colorPreview.style.background = hex;
}
function commitRGB() {
    // On blur/enter: clamp values and fully sync
    syncFromRGB();
    const hex = colorInput.value;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    rVal.value = r; gVal.value = g; bVal.value = b;
}
colorInput.addEventListener('input', syncFromPicker);
[rVal, gVal, bVal].forEach(el => {
    el.addEventListener('input', syncFromRGB);
    el.addEventListener('blur', commitRGB);
    el.addEventListener('keydown', e => { if (e.key === 'Enter') commitRGB(); });
});

// ── Mode registry ─────────────────────────────────────────────────────────────
const keyColors = {};
let activeEffect = 'static';

const modes = {
    static: {
        onKeyPaint(idx) {
            const { r, g, b } = getCurrentRGB();
            keyColors[idx] = { r, g, b };
            paintKey(idx, r, g, b);
            updateFooter();
        },
        onClearAll() {
            Object.keys(keyColors).forEach(idx => { delete keyColors[idx]; unpaintKey(idx); });
            updateFooter();
            toast('Cleared all keys');
        },
        onApplySelected(idxs) {
            const { r, g, b } = getCurrentRGB();
            idxs.forEach(idx => { keyColors[idx] = { r, g, b }; paintKey(idx, r, g, b); });
            updateFooter();
        },
        onPickSource(idx) { return keyColors[idx] || null; }
    },
    animation: {
        onKeyPaint(idx) {
            if (activeAnimFrame < 0) { toast('Select a frame first'); return; }
            const { r, g, b } = getCurrentRGB();
            if (!animFrames[activeAnimFrame].colors) animFrames[activeAnimFrame].colors = {};
            animFrames[activeAnimFrame].colors[idx] = { r, g, b };
            paintKey(idx, r, g, b);
            updateFrameThumb(activeAnimFrame);
        },
        onClearAll() { clearFrame(); },
        onApplySelected(idxs) {
            if (activeAnimFrame < 0) { toast('Select a frame first'); return; }
            const { r, g, b } = getCurrentRGB();
            idxs.forEach(idx => {
                animFrames[activeAnimFrame].colors[idx] = { r, g, b };
                paintKey(idx, r, g, b);
            });
            updateFrameThumb(activeAnimFrame);
        },
        onPickSource(idx) {
            return (activeAnimFrame >= 0 && animFrames[activeAnimFrame]?.colors[idx]) || null;
        }
    }
};

let activeMode = modes.static;

// ── Swatches ──────────────────────────────────────────────────────────────────
const SWATCHES = [
    '#ff0000', '#ff4400', '#ff8800', '#ffcc00', '#ffff00', '#aaff00',
    '#00ff00', '#00ffaa', '#00ffff', '#0088ff', '#0000ff', '#8800ff',
    '#ff00ff', '#ff0088', '#ffffff', '#aaaaaa', '#555555', '#000000',
];
const sg = document.getElementById('swatchGrid');
SWATCHES.forEach(c => {
    const s = document.createElement('div');
    s.className = 'swatch';
    s.style.background = c;
    s.onclick = () => setColorHex(c);
    sg.appendChild(s);
});

// ── Build keyboard ────────────────────────────────────────────────────────────
const keyboard = document.getElementById('keyboard');
const keyEls = {};
let painting = false;

function makeKeyEl(label, idx, cls, ri) {
    const k = document.createElement('div');
    k.className = 'key ' + (cls || '');
    k.dataset.idx = idx;
    if (ri !== undefined) k.dataset.row = ri;
    k.innerHTML = `<span>${label}</span>`;
    k.addEventListener('mousedown', e => onKeyDown(e, k));
    k.addEventListener('mouseenter', () => { if (painting) onKeyPaint(k); });
    keyEls[idx] = k;
    return k;
}

const kbWrap = document.createElement('div');
kbWrap.style.cssText = 'display:flex;gap:8px;align-items:flex-start';

const mainBlock = document.createElement('div');
mainBlock.style.cssText = 'display:flex;flex-direction:column;gap:5px';
ROWS.forEach((row, ri) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'kb-row';
    row.forEach(([label, idx, cls]) => {
        if (!idx) {
            const sp = document.createElement('div');
            sp.className = 'key key-spacer ' + (cls || '');
            rowEl.appendChild(sp); return;
        }
        rowEl.appendChild(makeKeyEl(label, idx, cls, ri));
    });
    mainBlock.appendChild(rowEl);
});
kbWrap.appendChild(mainBlock);

const navBlock = document.createElement('div');
navBlock.style.cssText = 'display:grid;grid-template-columns:repeat(3,38px);grid-template-rows:repeat(6,38px);gap:4px;';
NAV.forEach(([label, idx, col, row]) => {
    const k = makeKeyEl(label, idx, '', undefined);
    k.style.gridColumn = col; k.style.gridRow = row;
    navBlock.appendChild(k);
});
kbWrap.appendChild(navBlock);

const numBlock = document.createElement('div');
numBlock.style.cssText = 'display:grid;grid-template-columns:repeat(4,38px);grid-template-rows:repeat(6,38px);gap:4px;align-self:flex-end;';
let npCol = 1, npRow = 1;
NUMPAD.forEach(([label, idx, colSpan, rowSpan]) => {
    if (!idx) { npCol += colSpan; if (npCol > 4) { npCol = 1; npRow++; } return; }
    const k = makeKeyEl(label, idx, '', undefined);
    k.style.gridColumn = `${npCol}/span ${colSpan}`;
    k.style.gridRow    = `${npRow}/span ${rowSpan}`;
    if (rowSpan > 1) k.style.height    = `${rowSpan * 38 + (rowSpan - 1) * 4}px`;
    if (colSpan > 1) k.style.minWidth  = `${colSpan * 38 + (colSpan - 1) * 4}px`;
    numBlock.appendChild(k);
    npCol += colSpan; if (npCol > 4) { npCol = 1; npRow++; }
});
kbWrap.appendChild(numBlock);
keyboard.appendChild(kbWrap);

document.addEventListener('mouseup', () => { painting = false; });

// ── Input modes ───────────────────────────────────────────────────────────────
let paintMode      = false;
let eyedropperMode = false;
let _paintModeBeforeEyedrop = false;

// ── Continuous stream for static & anim modes ─────────────────────────────────
let _staticStreamTimer = null;
const STATIC_STREAM_MS = 80; // ~12fps, light enough not to hammer the HID

function startStaticStream() {
    if (_staticStreamTimer) return;
    _staticStreamTick();
}
function stopStaticStream() {
    clearTimeout(_staticStreamTimer);
    _staticStreamTimer = null;
}
function _staticStreamTick() {
    // Only run when NOT in layers mode (compositor handles that)
    if (typeof layersPanelOpen === 'undefined' || !layersPanelOpen) {
        if (hasPyAPI()) {
            window.pywebview.api.apply_frame(buildPayload());
        }
    }
    _staticStreamTimer = setTimeout(_staticStreamTick, STATIC_STREAM_MS);
}

function setPaintMode(on) {
    paintMode = on; eyedropperMode = false;
    document.getElementById('selectModeBtn').classList.toggle('active-mode', !on);
    document.getElementById('paintModeBtn').classList.toggle('active-mode', on);
    document.querySelectorAll('.eyedropper-btn').forEach(b => b.classList.remove('active-mode'));
    document.getElementById('keyboard').style.cursor = '';
    const selectAll = document.getElementById('selectAllBtn');
    const deselect  = document.getElementById('deselectBtn');
    if (on) {
        clearSelection();
        selectAll.disabled = true; deselect.disabled = true;
        selectAll.style.opacity = '0.35'; deselect.style.opacity = '0.35';
    } else {
        selectAll.disabled = false; deselect.disabled = false;
        selectAll.style.opacity = ''; deselect.style.opacity = '';
    }
}

function toggleEyedropper() {
    eyedropperMode = !eyedropperMode;
    if (eyedropperMode) {
        _paintModeBeforeEyedrop = paintMode;
        paintMode = false;
        document.getElementById('selectModeBtn').classList.remove('active-mode');
        document.getElementById('paintModeBtn').classList.remove('active-mode');
        document.querySelectorAll('.eyedropper-btn').forEach(b => b.classList.add('active-mode'));
        document.getElementById('keyboard').style.cursor = 'crosshair';
    } else {
        document.querySelectorAll('.eyedropper-btn').forEach(b => b.classList.remove('active-mode'));
        document.getElementById('keyboard').style.cursor = '';
        // Restore whichever mode was active before eyedropper
        setPaintMode(_paintModeBeforeEyedrop);
    }
}

// ── Key interaction ───────────────────────────────────────────────────────────
function onKeyDown(e, k) {
    e.preventDefault();
    painting = true;
    const idx = k.dataset.idx;

    if (eyedropperMode) {
        const src = activeMode.onPickSource(idx);
        if (src) {
            setColorHex('#' + [src.r, src.g, src.b].map(x => x.toString(16).padStart(2, '0')).join(''));
            toast('Color picked');
        } else { toast('Key has no color'); }
        toggleEyedropper();
        painting = false;
        return;
    }

    if (paintMode) {
        activeMode.onKeyPaint(idx);
        addRecentColor(colorInput.value);
    } else {
        if (!e.shiftKey) {
            if (selected.has(idx)) { selected.delete(idx); k.classList.remove('selected'); }
            else { selected.add(idx); k.classList.add('selected'); }
        } else { selected.add(idx); k.classList.add('selected'); }
        updateSelPanel();
    }
}

function onKeyPaint(k) {
    const idx = k.dataset.idx;
    if (paintMode) {
        activeMode.onKeyPaint(idx);
    } else {
        selected.add(idx); k.classList.add('selected'); updateSelPanel();
    }
}

// ── Selection ─────────────────────────────────────────────────────────────────
const selected = new Set();

function clearSelection() {
    selected.forEach(idx => keyEls[idx] && keyEls[idx].classList.remove('selected'));
    selected.clear(); updateSelPanel();
}
function selectAll() {
    Object.keys(keyEls).forEach(idx => { selected.add(idx); keyEls[idx].classList.add('selected'); });
    updateSelPanel();
}
function selectRow(ri) {
    ROWS[ri].forEach(([, idx]) => {
        if (idx && keyEls[idx]) { selected.add(idx); keyEls[idx].classList.add('selected'); }
    });
    updateSelPanel();
}
function updateSelPanel() {
    const panel = document.getElementById('selPanel');
    const info  = document.getElementById('selInfo');
    info.textContent = `${selected.size} key${selected.size !== 1 ? 's' : ''} selected`;
    if (selected.size === 0) {
        panel.innerHTML = '<div class="sel-empty">Click keys on the<br>keyboard to select</div>';
        return;
    }
    const names = [...selected].map(idx => {
        const el = keyEls[idx];
        return el ? el.querySelector('span').textContent : `0x${idx}`;
    }).slice(0, 8).join(', ') + (selected.size > 8 ? '...' : '');
    const inEraser = typeof eraserMode !== 'undefined' && eraserMode;
    panel.innerHTML = `
    <div class="sel-count">${selected.size}</div>
    <div class="sel-label">KEYS SELECTED</div>
    <div style="font-size:0.62rem;color:var(--dim);margin:10px 0 14px;line-height:1.7">${names}</div>
    ${inEraser
        ? `<button class="apply-btn" style="background:#2a1a1a;border-color:#e74c3c;color:#e74c3c" onclick="eraseSelected()">⬜ ERASE SELECTED</button>`
        : `<button class="apply-btn" onclick="applyColorToSelected()">APPLY COLOR</button>`
    }`;
}

function eraseSelected() {
    if (selected.size === 0) { toast('No keys selected'); return; }
    [...selected].forEach(idx => activeMode.onKeyPaint(idx)); // eraserMode intercepts via layerPaintKey
    toast(`Erased ${selected.size} key${selected.size !== 1 ? 's' : ''}`);
    clearSelection();
}

function applyColorToSelected() {
    if (selected.size === 0) { toast('No keys selected'); return; }
    activeMode.onApplySelected([...selected]);
    const { r, g, b } = getCurrentRGB();
    addRecentColor('#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join(''));
    toast(`Applied to ${selected.size} key${selected.size !== 1 ? 's' : ''}`);
    clearSelection();
}

// ── paintKey (pure DOM, mode-agnostic) ────────────────────────────────────────
function paintKey(idx, r, g, b) {
    const k = keyEls[idx];
    if (!k) return;
    const brightness = Math.sqrt(0.299*r*r + 0.587*g*g + 0.114*b*b) / 255;
    k.style.setProperty('--key-color', `rgb(${r},${g},${b})`);
    k.classList.add('lit');
    k.classList.remove('key-empty');
    k.style.color = brightness > 0.4 ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)';
}

function unpaintKey(idx) {
    const k = keyEls[idx];
    if (!k) return;
    k.style.setProperty('--key-color', 'transparent');
    k.classList.remove('lit');
    k.classList.add('key-empty');
    k.style.color = '';
}

function clearAll() { activeMode.onClearAll(); }

// ── Effects ───────────────────────────────────────────────────────────────────
function setEffect(btn) {
    document.querySelectorAll('.effect-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeEffect = btn.dataset.effect;
}

// ── Rainbow ───────────────────────────────────────────────────────────────────
function hsvToRgb(h, s, v) {
    const i = Math.floor(h * 6), f = h*6-i, p = v*(1-s), q = v*(1-f*s), t = v*(1-(1-f)*s);
    let r, g, b;
    switch (i % 6) {
        case 0: r=v;g=t;b=p; break; case 1: r=q;g=v;b=p; break;
        case 2: r=p;g=v;b=t; break; case 3: r=p;g=q;b=v; break;
        case 4: r=t;g=p;b=v; break; case 5: r=v;g=p;b=q; break;
    }
    return { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255) };
}
function applyRainbow() {
    const targets = selected.size > 0 ? [...selected] : Object.keys(keyEls);
    targets.forEach((idx, i) => {
        const rgb = hsvToRgb(i / targets.length, 1, 1);
        keyColors[idx] = rgb; paintKey(idx, rgb.r, rgb.g, rgb.b);
    });
    updateFooter(); toast('Rainbow applied!');
}

// ── PyWebView bridge ──────────────────────────────────────────────────────────
function hasPyAPI() { return window.pywebview && window.pywebview.api; }

async function connectKeyboard() {
    if (!hasPyAPI()) { toast('Run via python main.py to connect'); return; }
    toast('Connecting...');
    const r = await window.pywebview.api.connect();
    const dot = document.querySelector('.status-dot');
    const status = document.getElementById('conn-status');
    if (r.ok) {
        status.textContent = r.message;
        dot.style.background = '#2ecc71'; dot.style.boxShadow = '0 0 8px #2ecc71';
        toast('Connected!');
        startStaticStream();
        await restoreLastLighting();
    } else {
        status.textContent = r.message;
        dot.style.background = '#ff4444'; dot.style.boxShadow = '0 0 8px #ff4444';
        toast(r.message);
    }
}

async function restoreLastLighting() {
    if (!hasPyAPI()) return;
    const r = await window.pywebview.api.load_current_lighting();
    if (r.ok && r.type === 'static') { applyStaticColorMap(r.colors); await pushColors(); return; }
    if (r.ok && r.type === 'animation') { loadAnimationData(r.animation); openAnimPanel(); setAsActiveAnimation(); return; }
    if (r.ok && r.type === 'layers') {
        // Restore layer stack: open layers panel, deserialize, start streaming
        openLayersPanel();
        _deserializeLayers(r.layers);
        renderLayerStrip();
        // Auto-apply: start streaming if any animation layers, else static snapshot
        const hasAnim = layers.some(l => l.type === 'animation' && l.enabled);
        setLayerViewMode('composite');
        if (hasAnim) {
            applyLayersActive = true;
            _startAllLayerAnims();
            startCompositor();
            if (typeof _syncAllPlayBtns === 'function') _syncAllPlayBtns(true);
        } else {
            applyLayersActive = false;
            _sendStaticSnapshot();
        }
        return;
    }

    const ls = await window.pywebview.api.list_static_lightings();
    if (ls.ok && ls.lightings.length > 0) { applyStaticColorMap(ls.lightings[0].colors); await pushColors(); return; }

    const la = await window.pywebview.api.list_animations();
    if (la.ok && la.animations.length > 0) { loadAnimationData(la.animations[0]); openAnimPanel(); setAsActiveAnimation(); return; }

    Object.keys(keyColors).forEach(idx => { delete keyColors[idx]; unpaintKey(idx); });
    updateFooter();
}

function applyStaticColorMap(colors) {
    Object.keys(keyColors).forEach(idx => { delete keyColors[idx]; unpaintKey(idx); });
    Object.entries(colors).forEach(([idx, rgb]) => {
        const [rv, gv, bv] = Array.isArray(rgb) ? rgb : [rgb.r, rgb.g, rgb.b];
        keyColors[idx] = { r: rv, g: gv, b: bv }; paintKey(idx, rv, gv, bv);
    });
    updateFooter();
}

function buildPayload() {
    const payload = {};
    Object.entries(keyColors).forEach(([idx, {r, g, b}]) => { if (r||g||b) payload[idx] = [r,g,b]; });
    return payload;
}
async function pushColors() {
    if (!hasPyAPI()) return;
    return window.pywebview.api.apply_colors(buildPayload());
}
async function applyToKeyboard() {
    if (!hasPyAPI()) { toast('Not running in app — use python main.py'); return; }
    const r = await pushColors();
    if (r && r.ok) toast('Applied to keyboard'); else if (r) toast(r.message);
}
async function saveToFlash() {
    if (!hasPyAPI()) { toast('Not running in app — use python main.py'); return; }
    toast('Saving to flash...');
    const payload = buildPayload();
    const r = await window.pywebview.api.save_to_flash(payload);
    if (r.ok) { window.pywebview.api.save_current_lighting(payload); toast('💾 ' + r.message); }
    else toast(r.message);
}

// ── Swatch tabs ───────────────────────────────────────────────────────────────
function switchSwatchTab(tab) {
    const isSwatches = tab === 'swatches';
    document.getElementById('swatchesPane').style.display = isSwatches ? '' : 'none';
    document.getElementById('recentPane').style.display   = isSwatches ? 'none' : '';
    document.getElementById('swatchTabBtn').classList.toggle('active-tab', isSwatches);
    document.getElementById('recentTabBtn').classList.toggle('active-tab', !isSwatches);
}

// ── Recent colors ─────────────────────────────────────────────────────────────
let recentColors = [];
const MAX_RECENT = 18;

function addRecentColor(hex) {
    hex = hex.toLowerCase();
    recentColors = recentColors.filter(c => c !== hex);
    recentColors.unshift(hex);
    if (recentColors.length > MAX_RECENT) recentColors.length = MAX_RECENT;
    renderRecentColors();
    if (hasPyAPI()) window.pywebview.api.save_recent_colors(recentColors);
}
function renderRecentColors() {
    const grid = document.getElementById('recentGrid');
    const empty = document.getElementById('recentEmpty');
    if (!grid) return;
    grid.innerHTML = '';
    if (recentColors.length === 0) { if (empty) empty.style.display = ''; return; }
    if (empty) empty.style.display = 'none';
    recentColors.forEach(hex => {
        const s = document.createElement('div');
        s.className = 'swatch'; s.style.background = hex;
        s.onclick = () => setColorHex(hex);
        grid.appendChild(s);
    });
}
async function loadRecentColors() {
    if (!hasPyAPI()) return;
    const r = await window.pywebview.api.load_recent_colors();
    if (r.ok && r.colors.length > 0) { recentColors = r.colors; renderRecentColors(); }
}

// ── Static lighting presets ───────────────────────────────────────────────────
let savedLightings = {};

async function saveStaticLighting() {
    if (!hasPyAPI()) { toast('Run via python main.py'); return; }
    const name = document.getElementById('lightingNameInput').value.trim() || 'lighting';
    if (Object.keys(keyColors).length === 0) { toast('No colors to save'); return; }
    const r = await window.pywebview.api.save_static_lighting(name, buildPayload());
    if (r.ok) { toast(`Saved "${name}"`); await loadStaticLightingsFromDisk(); }
    else toast('Save failed: ' + (r.message || ''));
}
async function loadStaticLightingsFromDisk() {
    if (!hasPyAPI()) return;
    const r = await window.pywebview.api.list_static_lightings();
    if (!r.ok) return;
    savedLightings = {};
    r.lightings.forEach(d => { savedLightings[d._filename] = d; });
    renderSavedLightingList();
}
function applyStaticLightingData(data) { applyStaticColorMap(data.colors || {}); toast(`Loaded "${data.name}"`); }
async function deleteStaticLighting(filename) {
    if (!hasPyAPI()) return;
    await window.pywebview.api.delete_static_lighting(filename);
    await loadStaticLightingsFromDisk();
}
function renderSavedLightingList() {
    const el = document.getElementById('savedLightingList');
    if (!el) return;
    el.innerHTML = '';
    const entries = Object.entries(savedLightings);
    if (entries.length === 0) { el.innerHTML = '<div style="font-size:0.6rem;color:var(--dim)">No saved presets</div>'; return; }
    entries.forEach(([filename, data]) => {
        const item = document.createElement('div');
        item.className = 'saved-anim-item';
        item.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${data.name || filename}</span>
  <button class="load-btn">LOAD</button><button class="del-btn">✕</button>`;
        item.querySelector('.load-btn').addEventListener('click', () => applyStaticLightingData(data));
        item.querySelector('.del-btn').addEventListener('click', () => deleteStaticLighting(filename));
        el.appendChild(item);
    });
}

// ── Footer & toast ────────────────────────────────────────────────────────────
function updateFooter() {
    const n = Object.values(keyColors).filter(c => c.r || c.g || c.b).length;
    document.getElementById('colorCount').textContent = `${n} key${n !== 1 ? 's' : ''} lit`;
}

let toastTimer;
function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Settings modal ────────────────────────────────────────────────────────────
function openSettings() {
    document.getElementById('settingsOverlay').classList.add('open');
    loadStartupState();
}
function closeSettings(e) {
    if (e && e.target !== document.getElementById('settingsOverlay')) return;
    document.getElementById('settingsOverlay').classList.remove('open');
}
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.getElementById('settingsOverlay').classList.remove('open');
});

async function loadStartupState() {
    if (!hasPyAPI()) return;
    const r = await window.pywebview.api.get_startup_enabled();
    if (r.ok) document.getElementById('startupToggle').checked = r.enabled;
}

async function setStartup(enable) {
    if (!hasPyAPI()) { toast('Run via python main.py'); return; }
    const r = await window.pywebview.api.set_startup_enabled(enable);
    if (r.ok) toast(enable ? '✓ Will launch on startup' : 'Startup disabled');
    else { toast('Failed to update startup setting'); document.getElementById('startupToggle').checked = !enable; }
}


window.addEventListener('pywebviewready', () => {
    connectKeyboard();
    loadStaticLightingsFromDisk();
    loadRecentColors();
});
updateFooter();