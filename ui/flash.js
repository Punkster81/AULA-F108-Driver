// ── flash.js ──────────────────────────────────────────────────────────────────
// Flash tab — the only mode that writes colors to keyboard onboard memory.
// Survives power cycle. Distinct from layers (which streams live frames).
//
// Reuses LayerTypes.static from layers.js for color map logic — no duplication.
// The "flash layer" is just a static color map plus a save-to-hardware step.

'use strict';

// ── Flash state ───────────────────────────────────────────────────────────────
// keyColors is owned by main.js. Flash reads it directly via LayerTypes.static.
// savedLightings is the disk-backed preset store (also read by layers.js pickers).
let savedLightings = {};

// Builds a {idx: [r,g,b]} payload from keyColors for hardware sends (apply_frame)
function _buildFlashPayload() {
    const payload = {};
    Object.entries(keyColors).forEach(([idx, {r,g,b}]) => { if (r||g||b) payload[idx] = [r,g,b]; });
    return payload;
}
// Builds a grouped {rrggbb:[idx,...]} payload for disk saves
function _buildGroupedPayload() {
    return typeof _colorsToGrouped === 'function' ? _colorsToGrouped(keyColors) : _buildFlashPayload();
}

// ── Continuous stream ─────────────────────────────────────────────────────────
// Streams the current keyColors to hardware while in flash mode so the
// keyboard reflects edits live without needing to explicitly apply.
let _staticStreamTimer = null;
const STATIC_STREAM_MS = 80;

function startStaticStream() {
    if (_staticStreamTimer) return;
    _staticStreamTick();
}
function stopStaticStream() {
    clearTimeout(_staticStreamTimer);
    _staticStreamTimer = null;
}
function _staticStreamTick() {
    if (typeof layersPanelOpen === 'undefined' || !layersPanelOpen) {
        if (window.pywebview?.api) window.pywebview.api.apply_frame(_buildFlashPayload());
    }
    _staticStreamTimer = setTimeout(_staticStreamTick, STATIC_STREAM_MS);
}

// ── Apply / Save ──────────────────────────────────────────────────────────────
async function applyToKeyboard() {
    if (!window.pywebview?.api) { if (typeof toast === 'function') toast('Run via python main.py to connect'); return; }
    const r = await window.pywebview.api.apply_colors(_buildFlashPayload());
    if (r?.ok) { if (typeof toast === 'function') toast('Applied to keyboard'); }
    else if (r) { if (typeof toast === 'function') toast(r.message); }
}

async function saveToFlash() {
    if (!window.pywebview?.api) { if (typeof toast === 'function') toast('Run via python main.py to connect'); return; }
    if (typeof toast === 'function') toast('Saving to flash...');
    const flatPayload = _buildFlashPayload();
    const r = await window.pywebview.api.save_to_flash(flatPayload);
    if (r.ok) {
        window.pywebview.api.save_current_lighting(_buildGroupedPayload(), document.getElementById('lightingNameInput')?.value?.trim() || null);
        if (typeof toast === 'function') toast('💾 ' + r.message);
    } else {
        if (typeof toast === 'function') toast(r.message);
    }
}

// ── Presets ───────────────────────────────────────────────────────────────────
async function saveStaticLighting() {
    if (!window.pywebview?.api) { if (typeof toast === 'function') toast('Run via python main.py'); return; }
    const name = document.getElementById('lightingNameInput')?.value?.trim() || 'lighting';
    if (!Object.keys(keyColors).length) { if (typeof toast === 'function') toast('No colors to save'); return; }
    const r = await window.pywebview.api.save_static_lighting(name, _buildGroupedPayload());
    if (r.ok) { if (typeof toast === 'function') toast(`Saved "${name}"`); await loadStaticLightingsFromDisk(); }
    else if (typeof toast === 'function') toast('Save failed: ' + (r.message || ''));
}

async function loadStaticLightingsFromDisk() {
    if (!window.pywebview?.api) return;
    const r = await window.pywebview.api.list_static_lightings();
    if (!r.ok) return;
    savedLightings = {};
    r.lightings.forEach(d => { savedLightings[d._filename] = d; });
    renderSavedLightingList();
    if (typeof refreshLayerPickers === 'function') refreshLayerPickers();
}

function applyStaticLightingData(data) {
    applyStaticColorMap(data.colors || {});
    const nameInput = document.getElementById('lightingNameInput');
    if (nameInput && data.name) nameInput.value = data.name;
    if (typeof toast === 'function') toast(`Loaded "${data.name}"`);
}

async function deleteStaticLighting(filename) {
    if (!window.pywebview?.api) return;
    await window.pywebview.api.delete_static_lighting(filename);
    await loadStaticLightingsFromDisk();
}

function renderSavedLightingList() {
    const el = document.getElementById('savedLightingList');
    if (!el) return;
    el.innerHTML = '';
    const entries = Object.entries(savedLightings);
    if (!entries.length) { el.innerHTML = '<div style="font-size:0.6rem;color:var(--dim)">No saved presets</div>'; return; }
    entries.forEach(([filename, data]) => {
        const item = document.createElement('div');
        item.className = 'saved-anim-item';
        item.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${data.name||filename}</span>
            <button class="load-btn">LOAD</button><button class="del-btn">✕</button>`;
        item.querySelector('.load-btn').addEventListener('click', () => applyStaticLightingData(data));
        item.querySelector('.del-btn').addEventListener('click', () => deleteStaticLighting(filename));
        el.appendChild(item);
    });
}

// ── Color map helpers (shared with layers.js via keyColors) ───────────────────
function applyStaticColorMap(colors) {
    // Handle grouped format {rrggbb:[idx,...]} or flat {idx:[r,g,b]} or {idx:{r,g,b}}
    if (typeof _isGroupedColors === 'function' && _isGroupedColors(colors)) colors = _groupedToFlat(colors);
    Object.keys(keyColors).forEach(idx => { delete keyColors[idx]; unpaintKey(idx); });
    Object.entries(colors).forEach(([idx, rgb]) => {
        const [rv,gv,bv] = Array.isArray(rgb) ? rgb : [rgb.r, rgb.g, rgb.b];
        keyColors[idx] = { r:rv, g:gv, b:bv };
        paintKey(idx, rv, gv, bv);
    });
    if (typeof updateFooter === 'function') updateFooter();
}

function applyRainbow() {
    function hsvToRgb(h,s,v) {
        const i=Math.floor(h*6),f=h*6-i,p=v*(1-s),q=v*(1-f*s),t=v*(1-(1-f)*s);
        const cases=[[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]];
        const [r,g,b]=cases[i%6]; return {r:Math.round(r*255),g:Math.round(g*255),b:Math.round(b*255)};
    }
    const targets = typeof selected !== 'undefined' && selected.size > 0 ? [...selected] : Object.keys(keyEls);
    targets.forEach((idx,i) => {
        const rgb = hsvToRgb(i/targets.length,1,1);
        keyColors[idx]=rgb; paintKey(idx,rgb.r,rgb.g,rgb.b);
    });
    if (typeof updateFooter === 'function') updateFooter();
    if (typeof toast === 'function') toast('Rainbow applied!');
}