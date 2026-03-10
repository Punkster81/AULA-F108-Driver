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
}
function syncFromPicker() {
    const hex = colorInput.value;
    setColorHex(hex);
}
function syncFromRGB() {
    const r = Math.min(255, Math.max(0, parseInt(rVal.value) || 0));
    const g = Math.min(255, Math.max(0, parseInt(gVal.value) || 0));
    const b = Math.min(255, Math.max(0, parseInt(bVal.value) || 0));
    const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    colorInput.value = hex;
    colorPreview.style.background = hex;
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

function onKeyDown(e, k) {
    e.preventDefault();
    painting = true;
    const idx = k.dataset.idx;
    if (!e.shiftKey) {
        // Single click - toggle select
        if (selected.has(idx)) { selected.delete(idx); k.classList.remove('selected'); }
        else { selected.add(idx); k.classList.add('selected'); }
    } else {
        selected.add(idx);
        k.classList.add('selected');
    }
    updateSelPanel();
}
function onKeyPaint(k) {
    const idx = k.dataset.idx;
    selected.add(idx);
    k.classList.add('selected');
    updateSelPanel();
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
    selected.forEach(idx => {
        keyColors[idx] = { r, g, b };
        paintKey(idx, r, g, b);
    });
    updateFooter();
    toast(`Applied to ${selected.size} key${selected.size !== 1 ? 's' : ''}`);
    clearSelection();
}

function paintKey(idx, r, g, b) {
    const k = keyEls[idx];
    if (!k) return;
    const brightness = Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b) / 255;
    if (r === 0 && g === 0 && b === 0) {
        k.style.setProperty('--key-color', 'transparent');
        k.classList.remove('lit');
    } else {
        k.style.setProperty('--key-color', `rgb(${r},${g},${b})`);
        k.classList.add('lit');
        k.style.color = brightness > 0.5 ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)';
    }
}

function clearAll() {
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
        await pushColors();
    } else {
        status.textContent = r.message;
        dot.style.background = '#ff4444';
        dot.style.boxShadow = '0 0 8px #ff4444';
        toast(r.message);
    }
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
    const r = await window.pywebview.api.save_to_flash(buildPayload());
    toast(r.ok ? '💾 ' + r.message : r.message);
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
window.addEventListener('pywebviewready', () => connectKeyboard());

// Init with rainbow on top row as preview
['01', '02', '03', '04', '05', '06', '07', '08', '09', '0a', '0b', '0c', '0d'].forEach((idx, i, arr) => {
    const rgb = hsvToRgb(i / arr.length, 1, 1);
    keyColors[idx] = rgb;
    paintKey(idx, rgb.r, rgb.g, rgb.b);
});
updateFooter();