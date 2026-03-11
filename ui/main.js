// ── State ────────────────────────────────────────────────────────────────────
const keyColors = {};   // idx -> {r,g,b}
const selected = new Set();
let painting = false;
let paintColor = null;
let activeEffect = 'static';


// ── Swatches ─────────────────────────────────────────────────────────────────
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

// ── Color sync ───────────────────────────────────────────────────────────────
const colorInput = document.getElementById('colorInput');
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
    // Always keep anim picker + anim RGB inputs in sync
    if (typeof animPaintColor !== 'undefined') {
        animPaintColor = { r, g, b };
        const ap = document.getElementById('animColorPicker');
        const apb = document.getElementById('animColorPreviewBlock');
        const ra = document.getElementById('rValAnim');
        const ga = document.getElementById('gValAnim');
        const ba = document.getElementById('bValAnim');
        if (ap) ap.value = hex;
        if (apb) apb.style.background = hex;
        if (ra) ra.value = r;
        if (ga) ga.value = g;
        if (ba) ba.value = b;
    }
}
function syncFromPicker() {
    setColorHex(colorInput.value);
}
function syncFromRGB() {
    const r = Math.min(255, Math.max(0, parseInt(rVal.value) || 0));
    const g = Math.min(255, Math.max(0, parseInt(gVal.value) || 0));
    const b = Math.min(255, Math.max(0, parseInt(bVal.value) || 0));
    const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    setColorHex(hex);
}
function syncAnimFromRGB() {
    const r = Math.min(255, Math.max(0, parseInt(document.getElementById('rValAnim').value) || 0));
    const g = Math.min(255, Math.max(0, parseInt(document.getElementById('gValAnim').value) || 0));
    const b = Math.min(255, Math.max(0, parseInt(document.getElementById('bValAnim').value) || 0));
    const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    setColorHex(hex);
}
colorInput.addEventListener('input', syncFromPicker);
rVal.addEventListener('input', syncFromRGB);
gVal.addEventListener('input', syncFromRGB);
bVal.addEventListener('input', syncFromRGB);

// ── Build keyboard ────────────────────────────────────────────────────────────
const keyboard = document.getElementById('keyboard');
const keyEls = {};  // idx -> element

function makeKeyEl(label, idx, cls, ri) {
    const k = document.createElement('div');
    k.className = 'key ' + (cls || '');
    k.dataset.idx = idx;
    if (ri !== undefined) k.dataset.row = ri;
    k.innerHTML = `<span>${label}</span>`;
    k.addEventListener('mousedown', e => { onKeyDown(e, k); });
    k.addEventListener('mouseenter', () => { if (painting) onKeyPaint(k); });
    keyEls[idx] = k;
    return k;
}

// Wrapper: main keys + nav cluster + numpad
const kbWrap = document.createElement('div');
kbWrap.style.cssText = 'display:flex;gap:8px;align-items:flex-start';

// Main key block
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

// Nav cluster — 3 cols × 6 rows CSS grid
const navBlock = document.createElement('div');
navBlock.style.cssText = `
  display:grid;
  grid-template-columns:repeat(3,38px);
  grid-template-rows:repeat(6,38px);
  gap:4px;
`;
NAV.forEach(([label, idx, col, row]) => {
    const k = makeKeyEl(label, idx, '', undefined);
    k.style.gridColumn = col;
    k.style.gridRow = row;
    navBlock.appendChild(k);
});
kbWrap.appendChild(navBlock);

// Numpad — CSS grid so + and Enter can span rows
const numBlock = document.createElement('div');
numBlock.style.cssText = `
  display:grid;
  grid-template-columns:repeat(4,38px);
  grid-template-rows:repeat(6,38px);
  gap:4px;
  align-self:flex-end;
`;
let npCol = 1, npRow = 1;
NUMPAD.forEach(([label, idx, colSpan, rowSpan]) => {
    if (!idx) { npCol += colSpan; if (npCol > 4) { npCol = 1; npRow++; } return; }
    const k = makeKeyEl(label, idx, '', undefined);
    k.style.gridColumn = `${npCol}/span ${colSpan}`;
    k.style.gridRow = `${npRow}/span ${rowSpan}`;
    if (rowSpan > 1) k.style.height = `${rowSpan * 38 + (rowSpan - 1) * 4}px`;
    if (colSpan > 1) k.style.minWidth = `${colSpan * 38 + (colSpan - 1) * 4}px`;
    numBlock.appendChild(k);
    npCol += colSpan; if (npCol > 4) { npCol = 1; npRow++; }
});
kbWrap.appendChild(numBlock);
keyboard.appendChild(kbWrap);

document.addEventListener('mouseup', () => { painting = false; paintColor = null; });

// ── Paint / Select mode toggle ────────────────────────────────────────────────
let paintMode = false;
let eyedropperMode = false;

function setPaintMode(on) {
    paintMode = on;
    eyedropperMode = false;
    document.getElementById('selectModeBtn').classList.toggle('active-mode', !on);
    document.getElementById('paintModeBtn').classList.toggle('active-mode', on);
    [document.getElementById('eyedropperBtn'), document.getElementById('eyedropperBtnAnim')]
        .forEach(b => b && b.classList.remove('active-mode'));
    document.getElementById('keyboard').style.cursor = '';
    const selectAll = document.getElementById('selectAllBtn');
    const deselect = document.getElementById('deselectBtn');
    if (on) {
        clearSelection();
        selectAll.disabled = true;
        deselect.disabled = true;
        selectAll.style.opacity = '0.35';
        deselect.style.opacity = '0.35';
    } else {
        selectAll.disabled = false;
        deselect.disabled = false;
        selectAll.style.opacity = '';
        deselect.style.opacity = '';
    }
}

function toggleEyedropper() {
    eyedropperMode = !eyedropperMode;
    const btns = [document.getElementById('eyedropperBtn'), document.getElementById('eyedropperBtnAnim')];
    if (eyedropperMode) {
        paintMode = false;
        document.getElementById('selectModeBtn').classList.remove('active-mode');
        document.getElementById('paintModeBtn').classList.remove('active-mode');
        btns.forEach(b => b && b.classList.add('active-mode'));
        document.getElementById('keyboard').style.cursor = 'crosshair';
    } else {
        btns.forEach(b => b && b.classList.remove('active-mode'));
        document.getElementById('keyboard').style.cursor = '';
        document.getElementById('selectModeBtn').classList.add('active-mode');
    }
}

function onKeyDown(e, k) {
    e.preventDefault();
    painting = true;
    const idx = k.dataset.idx;

    if (eyedropperMode) {
        // Pick color from this key
        const source = (typeof animModeActive !== 'undefined' && animModeActive && activeAnimFrame >= 0)
            ? (animFrames[activeAnimFrame].colors[idx] || null)
            : (keyColors[idx] || null);
        if (source) {
            const hex = '#' + [source.r, source.g, source.b].map(x => x.toString(16).padStart(2, '0')).join('');
            setColorHex(hex);
            toast('Color picked');
        } else {
            toast('Key has no color');
        }
        toggleEyedropper();  // auto-exit eyedropper after one pick
        painting = false;
        return;
    }

    if (paintMode) {
        if (typeof animModeActive !== 'undefined' && animModeActive) {
            animPaintKey(idx);
        } else {
            const { r, g, b } = getCurrentRGB();
            keyColors[idx] = { r, g, b };
            paintKey(idx, r, g, b);
            updateFooter();
        }
        // Track color on initial click (not every drag pixel)
        const hex = colorInput.value;
        addRecentColor(hex);
    } else {
        if (!e.shiftKey) {
            if (selected.has(idx)) { selected.delete(idx); k.classList.remove('selected'); }
            else { selected.add(idx); k.classList.add('selected'); }
        } else {
            selected.add(idx);
            k.classList.add('selected');
        }
        updateSelPanel();
    }
}

function onKeyPaint(k) {
    const idx = k.dataset.idx;
    if (paintMode) {
        if (typeof animModeActive !== 'undefined' && animModeActive) {
            animPaintKey(idx);
        } else {
            const { r, g, b } = getCurrentRGB();
            keyColors[idx] = { r, g, b };
            paintKey(idx, r, g, b);
            updateFooter();
        }
    } else {
        selected.add(idx);
        k.classList.add('selected');
        updateSelPanel();
    }
}

// ── Selection ────────────────────────────────────────────────────────────────
function clearSelection() {
    selected.forEach(idx => keyEls[idx] && keyEls[idx].classList.remove('selected'));
    selected.clear();
    updateSelPanel();
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
    const info = document.getElementById('selInfo');
    info.textContent = `${selected.size} key${selected.size !== 1 ? 's' : ''} selected`;
    if (selected.size === 0) {
        panel.innerHTML = '<div class="sel-empty">Click keys on the<br>keyboard to select</div>';
        return;
    }
    const names = [...selected].map(idx => {
        const el = keyEls[idx];
        return el ? el.querySelector('span').textContent : `0x${idx}`;
    }).slice(0, 8).join(', ') + (selected.size > 8 ? '...' : '');
    panel.innerHTML = `
    <div class="sel-count">${selected.size}</div>
    <div class="sel-label">KEYS SELECTED</div>
    <div style="font-size:0.62rem;color:var(--dim);margin:10px 0 14px;line-height:1.7">${names}</div>
    <button class="apply-btn" onclick="applyColorToSelected()">APPLY COLOR</button>
  `;
}

// ── Apply color ───────────────────────────────────────────────────────────────
function applyColorToSelected() {
    if (selected.size === 0) { toast('No keys selected'); return; }
    const { r, g, b } = getCurrentRGB();
    if (typeof animModeActive !== 'undefined' && animModeActive) {
        if (typeof activeAnimFrame === 'undefined' || activeAnimFrame < 0) { toast('Select a frame first'); return; }
        selected.forEach(idx => {
            animFrames[activeAnimFrame].colors[idx] = { r, g, b };
            paintKey(idx, r, g, b);
        });
        updateFrameThumb(activeAnimFrame);
    } else {
        selected.forEach(idx => {
            keyColors[idx] = { r, g, b };
            paintKey(idx, r, g, b);
        });
        updateFooter();
    }
    toast(`Applied to ${selected.size} key${selected.size !== 1 ? 's' : ''}`);
    const { r: cr, g: cg, b: cb } = getCurrentRGB();
    addRecentColor('#' + [cr, cg, cb].map(x => x.toString(16).padStart(2, '0')).join(''));
    clearSelection();
}

function paintKey(idx, r, g, b) {
    const k = keyEls[idx];
    if (!k) return;
    if (r === 0 && g === 0 && b === 0) {
        k.style.setProperty('--key-color', 'transparent');
        k.classList.remove('lit');
        k.style.color = '';
    } else {
        const brightness = Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b) / 255;
        k.style.setProperty('--key-color', `rgb(${r},${g},${b})`);
        k.classList.add('lit');
        k.style.color = brightness > 0.5 ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)';
    }
}

function clearAll() {
    if (typeof animModeActive !== 'undefined' && animModeActive) {
        clearFrame();
        return;
    }
    Object.keys(keyColors).forEach(idx => { delete keyColors[idx]; paintKey(idx, 0, 0, 0); });
    updateFooter();
    toast('Cleared all keys');
}

// ── Rainbow ───────────────────────────────────────────────────────────────────
function applyRainbow() {
    const targets = selected.size > 0 ? [...selected] : Object.keys(keyEls);
    targets.forEach((idx, i) => {
        const hue = i / targets.length;
        const r = Math.round((0.5 - Math.abs(((hue * 6) % 2) - 1)) * 510);
        const rgb = hsvToRgb(hue, 1, 1);
        keyColors[idx] = rgb;
        paintKey(idx, rgb.r, rgb.g, rgb.b);
    });
    updateFooter();
    toast('Rainbow applied!');
}
function hsvToRgb(h, s, v) {
    let r, g, b;
    const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break; case 1: r = q; g = v; b = p; break; case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break; case 4: r = t; g = p; b = v; break; case 5: r = v; g = p; b = q;
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

// ── Effects ───────────────────────────────────────────────────────────────────
function setEffect(btn) {
    document.querySelectorAll('.effect-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeEffect = btn.dataset.effect;
}

// ── PyWebView API bridge ───────────────────────────────────────────────────────
function hasPyAPI() {
    return window.pywebview && window.pywebview.api;
}

// ── Connection ────────────────────────────────────────────────────────────────
async function connectKeyboard() {
    if (!hasPyAPI()) { toast('Run via python main.py to connect'); return; }
    toast('Connecting...');
    const r = await window.pywebview.api.connect();
    const dot = document.querySelector('.status-dot');
    const status = document.getElementById('conn-status');
    if (r.ok) {
        status.textContent = r.message;
        dot.style.background = '#2ecc71';
        dot.style.boxShadow = '0 0 8px #2ecc71';
        toast('Connected!');
        await restoreLastLighting();
    } else {
        status.textContent = r.message;
        dot.style.background = '#ff4444';
        dot.style.boxShadow = '0 0 8px #ff4444';
        toast(r.message);
    }
}

async function restoreLastLighting() {
    if (!hasPyAPI()) return;
    const r = await window.pywebview.api.load_current_lighting();

    if (r.ok && r.type === 'static') {
        applyStaticColorMap(r.colors);
        await pushColors();
        return;
    }

    if (r.ok && r.type === 'animation') {
        loadAnimationData(r.animation);
        openAnimPanel();
        setAsActiveAnimation();
        return;
    }

    // No current.json — try first saved static preset
    const ls = await window.pywebview.api.list_static_lightings();
    if (ls.ok && ls.lightings.length > 0) {
        applyStaticColorMap(ls.lightings[0].colors);
        await pushColors();
        return;
    }

    // No animation either — try first saved animation
    const la = await window.pywebview.api.list_animations();
    if (la.ok && la.animations.length > 0) {
        loadAnimationData(la.animations[0]);
        openAnimPanel();
        setAsActiveAnimation();
        return;
    }

    // Truly nothing saved — start blank
    Object.keys(keyColors).forEach(idx => { delete keyColors[idx]; paintKey(idx, 0, 0, 0); });
    updateFooter();
}

function applyStaticColorMap(colors) {
    Object.keys(keyColors).forEach(idx => { delete keyColors[idx]; paintKey(idx, 0, 0, 0); });
    Object.entries(colors).forEach(([idx, rgb]) => {
        const [rv, gv, bv] = Array.isArray(rgb) ? rgb : [rgb.r, rgb.g, rgb.b];
        keyColors[idx] = { r: rv, g: gv, b: bv };
        paintKey(idx, rv, gv, bv);
    });
    updateFooter();
}

// ── Build color payload from current state ────────────────────────────────────
function buildPayload() {
    const payload = {};
    Object.entries(keyColors).forEach(([idx, {r, g, b}]) => {
        if (r || g || b) payload[idx] = [r, g, b];
    });
    return payload;
}

// ── Push current colors to keyboard ──────────────────────────────────────────
async function pushColors() {
    if (!hasPyAPI()) return;
    return window.pywebview.api.apply_colors(buildPayload());
}

// ── Apply button ──────────────────────────────────────────────────────────────
async function applyToKeyboard() {
    if (!hasPyAPI()) { toast('Not running in app — use python main.py'); return; }
    const r = await pushColors();
    if (r && r.ok) toast('Applied to keyboard');
    else if (r) toast(r.message);
}

// ── Save to flash ─────────────────────────────────────────────────────────────
async function saveToFlash() {
    if (!hasPyAPI()) { toast('Not running in app — use python main.py'); return; }
    toast('Saving to flash (~2s)...');
    const payload = buildPayload();
    const r = await window.pywebview.api.save_to_flash(payload);
    if (r.ok) {
        window.pywebview.api.save_current_lighting(payload);
        toast('💾 ' + r.message);
    } else toast(r.message);
}

// ── Swatch tabs ───────────────────────────────────────────────────────────────
function switchSwatchTab(tab) {
    const isSwatches = tab === 'swatches';
    document.getElementById('swatchesPane').style.display = isSwatches ? '' : 'none';
    document.getElementById('recentPane').style.display = isSwatches ? 'none' : '';
    document.getElementById('swatchTabBtn').classList.toggle('active-tab', isSwatches);
    document.getElementById('recentTabBtn').classList.toggle('active-tab', !isSwatches);
}

// ── Recent colors ─────────────────────────────────────────────────────────────
let recentColors = [];  // array of hex strings, most recent first
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
    if (recentColors.length === 0) {
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';
    recentColors.forEach(hex => {
        const s = document.createElement('div');
        s.className = 'swatch';
        s.style.background = hex;
        s.onclick = () => setColorHex(hex);
        grid.appendChild(s);
    });
}

async function loadRecentColors() {
    if (!hasPyAPI()) return;
    const r = await window.pywebview.api.load_recent_colors();
    if (r.ok && r.colors.length > 0) {
        recentColors = r.colors;
        renderRecentColors();
    }
}


let savedLightings = {};

async function saveStaticLighting() {
    if (!hasPyAPI()) { toast('Run via python main.py'); return; }
    const name = document.getElementById('lightingNameInput').value.trim() || 'lighting';
    if (Object.keys(keyColors).length === 0) { toast('No colors to save'); return; }
    const payload = buildPayload();
    const r = await window.pywebview.api.save_static_lighting(name, payload);
    if (r.ok) {
        toast(`Saved "${name}"`);
        await loadStaticLightingsFromDisk();
    } else toast('Save failed: ' + (r.message || ''));
}

async function loadStaticLightingsFromDisk() {
    if (!hasPyAPI()) return;
    const r = await window.pywebview.api.list_static_lightings();
    if (!r.ok) return;
    savedLightings = {};
    r.lightings.forEach(d => { savedLightings[d._filename] = d; });
    renderSavedLightingList();
}

function applyStaticLightingData(data) {
    applyStaticColorMap(data.colors || {});
    toast(`Loaded "${data.name}"`);
}

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
    if (entries.length === 0) {
        el.innerHTML = '<div style="font-size:0.6rem;color:var(--dim)">No saved presets</div>';
        return;
    }
    entries.forEach(([filename, data]) => {
        const item = document.createElement('div');
        item.className = 'saved-anim-item';
        item.innerHTML = `
  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${data.name || filename}</span>
  <button class="load-btn">LOAD</button>
  <button class="del-btn">✕</button>`;
        item.querySelector('.load-btn').addEventListener('click', () => applyStaticLightingData(data));
        item.querySelector('.del-btn').addEventListener('click', () => deleteStaticLighting(filename));
        el.appendChild(item);
    });
}


function updateFooter() {
    const n = Object.values(keyColors).filter(c => c.r || c.g || c.b).length;
    document.getElementById('colorCount').textContent = `${n} key${n !== 1 ? 's' : ''} lit`;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Auto-connect when PyWebView is ready ─────────────────────────────────────
window.addEventListener('pywebviewready', () => {
    connectKeyboard();
    loadStaticLightingsFromDisk();
    loadRecentColors();
});

// Init — start blank, then try to preload saved lighting for visual display
(async function initDisplay() {
    if (!hasPyAPI()) return;  // will be handled on pywebviewready
    // Try to show something before connect happens — handled in restoreLastLighting after connect
})();
updateFooter();