// ── main.js ───────────────────────────────────────────────────────────────────
// App entry point. Handles:
//   - PyWebView bridge (connect, restore lighting)
//   - Color picker state (shared across all modes)
//   - Keyboard DOM builder
//   - Key interaction (paint, select, eyedropper)
//   - Selection panel
//   - Swatches / recent colors
//   - Toast / footer / settings
//
// Mode-specific logic lives in:
//   flash.js   — flash-to-memory tab
//   layers.js  — layers, animation, reactive effects

'use strict';

// ── Color picker ──────────────────────────────────────────────────────────────
const colorInput   = document.getElementById('colorInput');
const colorPreview = document.getElementById('colorPreview');
const rVal = document.getElementById('rVal');
const gVal = document.getElementById('gVal');
const bVal = document.getElementById('bVal');

function getCurrentRGB() {
    return { r: parseInt(rVal.value)||0, g: parseInt(gVal.value)||0, b: parseInt(bVal.value)||0 };
}
function setColorHex(hex) {
    colorInput.value = hex;
    const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
    rVal.value=r; gVal.value=g; bVal.value=b;
    colorPreview.style.background=hex;
}
function syncFromPicker() { setColorHex(colorInput.value); }
function syncFromRGB() {
    const r=Math.min(255,Math.max(0,parseInt(rVal.value)||0));
    const g=Math.min(255,Math.max(0,parseInt(gVal.value)||0));
    const b=Math.min(255,Math.max(0,parseInt(bVal.value)||0));
    colorInput.value='#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join('');
    colorPreview.style.background=colorInput.value;
}
function commitRGB() {
    syncFromRGB();
    const hex=colorInput.value;
    rVal.value=parseInt(hex.slice(1,3),16);
    gVal.value=parseInt(hex.slice(3,5),16);
    bVal.value=parseInt(hex.slice(5,7),16);
}
colorInput.addEventListener('input', syncFromPicker);
[rVal,gVal,bVal].forEach(el => {
    if (!el) return;
    el.addEventListener('input', syncFromRGB);
    el.addEventListener('blur', commitRGB);
    el.addEventListener('keydown', e => { if(e.key==='Enter')commitRGB(); });
});

// ── Mode registry ─────────────────────────────────────────────────────────────
// keyColors is the shared flash/static color map. flash.js and layers.js both read it.
const keyColors = {};

const modes = {
    // Flash mode — paints directly into keyColors
    static: {
        onKeyPaint(idx) {
            const {r,g,b}=getCurrentRGB(); keyColors[idx]={r,g,b}; paintKey(idx,r,g,b); updateFooter();
        },
        onClearAll() {
            Object.keys(keyColors).forEach(idx=>{delete keyColors[idx];unpaintKey(idx);}); updateFooter(); toast('Cleared all keys');
        },
        onApplySelected(idxs) {
            const {r,g,b}=getCurrentRGB(); idxs.forEach(idx=>{keyColors[idx]={r,g,b};paintKey(idx,r,g,b);}); updateFooter();
        },
        onPickSource(idx) { return keyColors[idx]||null; },
    },
    // Layers mode entry — provided by layers.js after it loads
    // Assigned by openLayersPanel() in layers.js
    get layers() { return typeof _layersModeEntry!=='undefined' ? _layersModeEntry : this.static; },
};

let activeMode = modes.static;

// ── Swatches ──────────────────────────────────────────────────────────────────
const SWATCHES = [
    '#ff0000','#ff4400','#ff8800','#ffcc00','#ffff00','#aaff00',
    '#00ff00','#00ffaa','#00ffff','#0088ff','#0000ff','#8800ff',
    '#ff00ff','#ff0088','#ffffff','#aaaaaa','#555555','#000000',
];
const sg=document.getElementById('swatchGrid');
SWATCHES.forEach(c => { const s=document.createElement('div');s.className='swatch';s.style.background=c;s.onclick=()=>setColorHex(c);sg.appendChild(s); });

// ── Build keyboard ────────────────────────────────────────────────────────────
const keyboard = document.getElementById('keyboard');
const keyEls   = {};
let painting   = false;

function makeKeyEl(label, idx, cls, ri) {
    const k=document.createElement('div');
    k.className='key '+(cls||''); k.dataset.idx=idx;
    if(ri!==undefined)k.dataset.row=ri;
    k.innerHTML=`<span>${label}</span>`;
    k.addEventListener('mousedown', e=>onKeyDown(e,k));
    k.addEventListener('mouseenter', ()=>{if(painting)onKeyPaint(k);});
    keyEls[idx]=k; return k;
}

const kbWrap=document.createElement('div');
kbWrap.style.cssText='display:flex;gap:8px;align-items:flex-start';

const mainBlock=document.createElement('div');
mainBlock.style.cssText='display:flex;flex-direction:column;gap:5px';
ROWS.forEach((row,ri)=>{
    const rowEl=document.createElement('div'); rowEl.className='kb-row';
    row.forEach(([label,idx,cls])=>{
        if(!idx){const sp=document.createElement('div');sp.className='key key-spacer '+(cls||'');rowEl.appendChild(sp);return;}
        rowEl.appendChild(makeKeyEl(label,idx,cls,ri));
    });
    mainBlock.appendChild(rowEl);
});
kbWrap.appendChild(mainBlock);

// Nav and numpad start at row 1 of the main block (F-key row).
// Each key row = 38px + 5px gap = 43px. Row 1 (F-keys) aligns with nav row 1.
const navBlock=document.createElement('div');
navBlock.style.cssText='display:grid;grid-template-columns:repeat(3,38px);grid-template-rows:repeat(6,38px);gap:4px;';
NAV.forEach(([label,idx,col,row])=>{
    const k=makeKeyEl(label,idx,'',undefined); k.style.gridColumn=col; k.style.gridRow=row; navBlock.appendChild(k);
});
kbWrap.appendChild(navBlock);

// Numpad: 5 rows of keys + row 1 blank (NumLock row aligns with number row).
// Offset by 1 main row (43px) so NumLock aligns with the number row.
const numBlock=document.createElement('div');
numBlock.style.cssText='display:grid;grid-template-columns:repeat(4,38px);grid-template-rows:repeat(5,38px);gap:4px;margin-top:42px;';
let npCol=1,npRow=1;
NUMPAD.forEach(([label,idx,colSpan,rowSpan])=>{
    if(!idx){npCol+=colSpan;if(npCol>4){npCol=1;npRow++;}return;}
    const k=makeKeyEl(label,idx,'',undefined);
    k.style.gridColumn=`${npCol}/span ${colSpan}`; k.style.gridRow=`${npRow}/span ${rowSpan}`;
    if(rowSpan>1)k.style.height=`${rowSpan*38+(rowSpan-1)*4}px`;
    if(colSpan>1)k.style.minWidth=`${colSpan*38+(colSpan-1)*4}px`;
    numBlock.appendChild(k);
    npCol+=colSpan;if(npCol>4){npCol=1;npRow++;}
});
kbWrap.appendChild(numBlock);
keyboard.appendChild(kbWrap);
document.addEventListener('mouseup', ()=>{painting=false;});

// ── Input modes ───────────────────────────────────────────────────────────────
let paintMode      = false;
let eyedropperMode = false;
let _paintModeBeforeEyedrop = false;

function setPaintMode(on) {
    paintMode=on; eyedropperMode=false;
    document.getElementById('selectModeBtn').classList.toggle('active-mode',!on);
    document.getElementById('paintModeBtn').classList.toggle('active-mode',on);
    document.querySelectorAll('.eyedropper-btn').forEach(b=>b.classList.remove('active-mode'));
    document.getElementById('keyboard').style.cursor='';
    const selectAll=document.getElementById('selectAllBtn'), deselect=document.getElementById('deselectBtn');
    if(on){clearSelection();selectAll.disabled=true;deselect.disabled=true;selectAll.style.opacity='0.35';deselect.style.opacity='0.35';}
    else{selectAll.disabled=false;deselect.disabled=false;selectAll.style.opacity='';deselect.style.opacity='';}
}
function toggleEyedropper() {
    eyedropperMode=!eyedropperMode;
    if(eyedropperMode){
        _paintModeBeforeEyedrop=paintMode; paintMode=false;
        document.getElementById('selectModeBtn').classList.remove('active-mode');
        document.getElementById('paintModeBtn').classList.remove('active-mode');
        document.querySelectorAll('.eyedropper-btn').forEach(b=>b.classList.add('active-mode'));
        document.getElementById('keyboard').style.cursor='crosshair';
    } else {
        document.querySelectorAll('.eyedropper-btn').forEach(b=>b.classList.remove('active-mode'));
        document.getElementById('keyboard').style.cursor='';
        setPaintMode(_paintModeBeforeEyedrop);
    }
}

// ── Key interaction ───────────────────────────────────────────────────────────
function onKeyDown(e, k) {
    e.preventDefault(); painting=true;
    const idx=k.dataset.idx;
    if(eyedropperMode){
        const src=activeMode.onPickSource(idx);
        if(src){setColorHex('#'+[src.r,src.g,src.b].map(x=>x.toString(16).padStart(2,'0')).join(''));toast('Color picked');}
        else toast('Key has no color');
        toggleEyedropper(); painting=false; return;
    }
    if(paintMode){
        activeMode.onKeyPaint(idx);
        addRecentColor(colorInput.value);
    } else {
        if(!e.shiftKey){if(selected.has(idx)){selected.delete(idx);k.classList.remove('selected');}else{selected.add(idx);k.classList.add('selected');}}
        else{selected.add(idx);k.classList.add('selected');}
        updateSelPanel();
    }
}
function onKeyPaint(k) {
    const idx=k.dataset.idx;
    if(paintMode){activeMode.onKeyPaint(idx);}
    else{selected.add(idx);k.classList.add('selected');updateSelPanel();}
}

// ── paintKey / unpaintKey ─────────────────────────────────────────────────────
function paintKey(idx, r, g, b) {
    const k=keyEls[idx]; if(!k)return;
    const brightness=Math.sqrt(0.299*r*r+0.587*g*g+0.114*b*b)/255;
    k.style.setProperty('--key-color',`rgb(${r},${g},${b})`);
    k.classList.add('lit'); k.classList.remove('key-empty'); k.classList.remove('key-rainbow');
    k.style.color=brightness>0.4?'rgba(0,0,0,0.8)':'rgba(255,255,255,0.9)';
}
function paintKeyRainbow(idx) {
    const k=keyEls[idx]; if(!k)return;
    k.classList.add('lit','key-rainbow'); k.classList.remove('key-empty');
    k.style.removeProperty('--key-color');
    k.style.color='';
}
function unpaintKey(idx) {
    const k=keyEls[idx]; if(!k)return;
    k.style.setProperty('--key-color','transparent');
    k.classList.remove('lit','key-rainbow'); k.classList.add('key-empty');
    k.style.color='';
}

// ── Selection ─────────────────────────────────────────────────────────────────
const selected=new Set();
function clearSelection() { selected.forEach(idx=>keyEls[idx]&&keyEls[idx].classList.remove('selected'));selected.clear();updateSelPanel(); }
function selectAll() { Object.keys(keyEls).forEach(idx=>{selected.add(idx);keyEls[idx].classList.add('selected');});updateSelPanel(); }
function selectRow(ri) { ROWS[ri].forEach(([,idx])=>{if(idx&&keyEls[idx]){selected.add(idx);keyEls[idx].classList.add('selected');}});updateSelPanel(); }
function updateSelPanel() {
    const panel=document.getElementById('selPanel'), info=document.getElementById('selInfo');
    info.textContent=`${selected.size} key${selected.size!==1?'s':''} selected`;
    if(!selected.size){panel.innerHTML='<div class="sel-empty">Click keys on the<br>keyboard to select</div>';return;}
    const names=[...selected].map(idx=>{const el=keyEls[idx];return el?el.querySelector('span').textContent:`0x${idx}`;}).slice(0,8).join(', ')+(selected.size>8?'...':'');
    const inEraser=typeof eraserMode!=='undefined'&&eraserMode;
    panel.innerHTML=`<div class="sel-count">${selected.size}</div>
        <div class="sel-label">KEYS SELECTED</div>
        <div style="font-size:0.62rem;color:var(--dim);margin:10px 0 14px;line-height:1.7">${names}</div>
        ${inEraser
            ?`<button class="apply-btn" style="background:#2a1a1a;border-color:#e74c3c;color:#e74c3c" onclick="eraseSelected()">⬜ ERASE SELECTED</button>`
            :`<button class="apply-btn" onclick="applyColorToSelected()">APPLY COLOR</button>`}
        <div style="height:1px;background:var(--border);margin-top:10px;margin-bottom:6px"></div>
        <div class="panel-title" style="margin:0 0 6px">Gradient</div>
        <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center">
            <span style="font-size:0.6rem;color:var(--dim);flex-shrink:0">From</span>
            <div style="position:relative;width:32px;height:24px;border-radius:4px;overflow:hidden;border:1px solid var(--border);cursor:pointer" onclick="document.getElementById('gradFrom').click()">
                <div id="gradFromBox" style="width:100%;height:100%;background:${_gradFrom}"></div>
                <input type="color" id="gradFrom" value="${_gradFrom}" style="position:absolute;opacity:0;width:0;height:0" oninput="_gradFrom=this.value;document.getElementById('gradFromBox').style.background=this.value">
            </div>
            <span style="font-size:0.6rem;color:var(--dim);flex-shrink:0">To</span>
            <div style="position:relative;width:32px;height:24px;border-radius:4px;overflow:hidden;border:1px solid var(--border);cursor:pointer" onclick="document.getElementById('gradTo').click()">
                <div id="gradToBox" style="width:100%;height:100%;background:${_gradTo};opacity:${_gradRainbow?'0.35':'1'}"></div>
                <input type="color" id="gradTo" value="${_gradTo}" style="position:absolute;opacity:0;width:0;height:0" oninput="_gradTo=this.value;document.getElementById('gradToBox').style.background=this.value">
            </div>
            <div style="width:1px;height:20px;background:var(--border);margin:0 4px;flex-shrink:0"></div>
            <label style="display:flex;align-items:center;gap:4px;font-size:0.6rem;color:var(--dim);cursor:pointer">
                <input type="checkbox" id="gradRainbow" ${_gradRainbow?'checked':''}> Rainbow
            </label>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
            <span style="font-size:0.6rem;color:var(--dim);width:34px;flex-shrink:0">Skew</span>
            <input type="range" id="gradSkew" min="-1" max="1" step="0.05" value="${_gradSkew}"
                oninput="_gradSkew=parseFloat(this.value);document.getElementById('gradSkewVal').textContent=Math.round(this.value*100)+'%'"
                style="flex:1;height:4px">
            <span id="gradSkewVal" style="font-size:0.6rem;color:var(--text);min-width:32px;text-align:right">${Math.round(_gradSkew*100)}%</span>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center">
            <span style="font-size:0.6rem;color:var(--dim);width:34px;flex-shrink:0">Origin</span>
            <input type="range" id="gradPos" min="0" max="1" step="0.05" value="${_gradPos}"
                oninput="_gradPos=parseFloat(this.value);document.getElementById('gradPosVal').textContent=Math.round(this.value*100)+'%'"
                style="flex:1;height:4px">
            <span id="gradPosVal" style="font-size:0.6rem;color:var(--text);min-width:32px;text-align:right">${Math.round(_gradPos*100)}%</span>
        </div>
        <div style="display:flex;gap:5px;margin-bottom:8px">
            <button class="layer-type-btn ${_gradDir==='lr'?'active-mode':''}" id="gdir-lr"  onclick="setGradDir('lr')"  title="Left→Right">→</button>
            <button class="layer-type-btn ${_gradDir==='rl'?'active-mode':''}" id="gdir-rl"  onclick="setGradDir('rl')"  title="Right→Left">←</button>
            <button class="layer-type-btn ${_gradDir==='tb'?'active-mode':''}" id="gdir-tb"  onclick="setGradDir('tb')"  title="Top→Bottom">↓</button>
            <button class="layer-type-btn ${_gradDir==='bt'?'active-mode':''}" id="gdir-bt"  onclick="setGradDir('bt')"  title="Bottom→Top">↑</button>
        </div>
        <button class="apply-btn" onclick="applyGradient()" style="font-size:0.68rem">🎨 APPLY GRADIENT</button>`;

    // Sync rainbow checkbox — toggle color pickers
    document.getElementById('gradRainbow').addEventListener('change', function() {
        _gradRainbow = this.checked;
        _syncGradRainbow(_gradRainbow);
    });
    // Apply initial state if rainbow was already on
    if (_gradRainbow) _syncGradRainbow(true);
}
function eraseSelected() {
    if(!selected.size){toast('No keys selected');return;}
    [...selected].forEach(idx=>activeMode.onKeyPaint(idx));
    toast(`Erased ${selected.size} key${selected.size!==1?'s':''}`); clearSelection();
}
function applyColorToSelected() {
    if(!selected.size){toast('No keys selected');return;}
    activeMode.onApplySelected([...selected]);
    const {r,g,b}=getCurrentRGB(); addRecentColor('#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join(''));
    toast(`Applied to ${selected.size} key${selected.size!==1?'s':''}`); clearSelection();
}
function clearAll() { activeMode.onClearAll(); }

// ── Gradient tool ─────────────────────────────────────────────────────────────
let _gradDir     = 'lr';
let _gradFrom    = '#ff0000';
let _gradTo      = '#0000ff';
let _gradRainbow = false;
let _gradSkew    = 0;
let _gradPos     = 0;

function _syncGradRainbow(on) {
    const opacity = on ? '0.35' : '1';
    const fromEl = document.getElementById('gradFrom');
    const toEl   = document.getElementById('gradTo');
    const fromBox = document.getElementById('gradFromBox');
    const toBox   = document.getElementById('gradToBox');
    if (fromEl)  fromEl.disabled  = on;
    if (toEl)    toEl.disabled    = on;
    if (fromBox) fromBox.style.opacity = opacity;
    if (toBox)   toBox.style.opacity   = opacity;
}

function setGradDir(dir) {
    _gradDir = dir;
    ['lr','rl','tb','bt'].forEach(d => {
        const btn = document.getElementById(`gdir-${d}`);
        if (btn) btn.classList.toggle('active-mode', d === dir);
    });
}

function applyGradient() {
    if (!selected.size) { toast('No keys selected'); return; }

    const rainbow  = document.getElementById('gradRainbow')?.checked ?? _gradRainbow;
    const fromHex  = document.getElementById('gradFrom')?.value || _gradFrom;
    const toHex    = document.getElementById('gradTo')?.value   || _gradTo;
    const fromRGB  = _hexToRgb(fromHex);
    const toRGB    = _hexToRgb(toHex);

    // Get LED coords for selected keys — fall back to [0,0] if not in map
    const coords = typeof LED_COORDS !== 'undefined' ? LED_COORDS : {};
    const keys   = [...selected];

    // Find min/max along the chosen axis
    const axis = (_gradDir === 'lr' || _gradDir === 'rl') ? 0 : 1;
    let min = Infinity, max = -Infinity;
    keys.forEach(idx => {
        const c = coords[idx];
        const v = c ? c[axis] : 0;
        if (v < min) min = v;
        if (v > max) max = v;
    });

    const range = max - min || 1;
    const colors = {};

    keys.forEach(idx => {
        const c = coords[idx];
        const v = c ? c[axis] : min;
        let t = (v - min) / range;
        if (_gradDir === 'rl' || _gradDir === 'bt') t = 1 - t;
        // Origin: radiates from _gradPos outward in both directions
        if (_gradPos > 0) {
            const dist = Math.abs(t - _gradPos);
            const maxDist = Math.max(_gradPos, 1 - _gradPos);
            t = Math.min(1, dist / maxDist);
        }
        // Skew: positive = bias toward end color, negative = bias toward start color
        if (_gradSkew !== 0) {
            const exp = _gradSkew > 0 ? 1 + _gradSkew * 3 : 1 / (1 + Math.abs(_gradSkew) * 3);
            t = Math.pow(t, exp);
        }

        let r, g, b;
        if (rainbow) {
            const h = t * 0.83; // red → violet, no loop back to red
            ({r, g, b} = _hsvToRgb(h, 1, 1));
        } else {
            r = Math.round(fromRGB.r + (toRGB.r - fromRGB.r) * t);
            g = Math.round(fromRGB.g + (toRGB.g - fromRGB.g) * t);
            b = Math.round(fromRGB.b + (toRGB.b - fromRGB.b) * t);
        }
        colors[idx] = {r, g, b};
    });

    // Apply via active mode
    keys.forEach(idx => {
        rVal.value = colors[idx].r;
        gVal.value = colors[idx].g;
        bVal.value = colors[idx].b;
        activeMode.onKeyPaint(idx);
    });

    // Restore color picker to gradient-from color
    setColorHex(fromHex);
    toast(`Gradient applied to ${keys.length} keys`);
    clearSelection();
}

function _hexToRgb(hex) {
    const n = parseInt(hex.replace('#',''), 16);
    return { r: (n>>16)&255, g: (n>>8)&255, b: n&255 };
}
function _hsvToRgb(h, s, v) {
    const i=Math.floor(h*6), f=h*6-i, p=v*(1-s), q=v*(1-f*s), t=v*(1-(1-f)*s);
    const cases=[[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]];
    const [r,g,b]=cases[i%6];
    return {r:Math.round(r*255),g:Math.round(g*255),b:Math.round(b*255)};
}

// ── Swatches tabs ─────────────────────────────────────────────────────────────
function switchSwatchTab(tab) {
    const isSw=tab==='swatches';
    document.getElementById('swatchesPane').style.display=isSw?'':'none';
    document.getElementById('recentPane').style.display=isSw?'none':'';
    document.getElementById('swatchTabBtn').classList.toggle('active-tab',isSw);
    document.getElementById('recentTabBtn').classList.toggle('active-tab',!isSw);
}

// ── Recent colors ─────────────────────────────────────────────────────────────
let recentColors=[];
const MAX_RECENT=18;
function addRecentColor(hex) {
    hex=hex.toLowerCase(); recentColors=recentColors.filter(c=>c!==hex); recentColors.unshift(hex);
    if(recentColors.length>MAX_RECENT)recentColors.length=MAX_RECENT;
    renderRecentColors(); if(hasPyAPI())window.pywebview.api.save_recent_colors(recentColors);
}
function renderRecentColors() {
    const grid=document.getElementById('recentGrid'), empty=document.getElementById('recentEmpty');
    if(!grid)return; grid.innerHTML='';
    if(!recentColors.length){if(empty)empty.style.display='';return;}
    if(empty)empty.style.display='none';
    recentColors.forEach(hex=>{const s=document.createElement('div');s.className='swatch';s.style.background=hex;s.onclick=()=>setColorHex(hex);grid.appendChild(s);});
}
async function loadRecentColors() {
    if(!hasPyAPI())return;
    const r=await window.pywebview.api.load_recent_colors();
    if(r.ok&&r.colors.length){recentColors=r.colors;renderRecentColors();}
}

// ── Footer / toast ────────────────────────────────────────────────────────────
function updateFooter() {
    const n=Object.values(keyColors).filter(c=>c.r||c.g||c.b).length;
    document.getElementById('colorCount').textContent=`${n} key${n!==1?'s':''} lit`;
}
let toastTimer;
function toast(msg) {
    const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2500);
}

// ── PyWebView bridge ──────────────────────────────────────────────────────────
function hasPyAPI() { return window.pywebview && window.pywebview.api; }

async function connectKeyboard() {
    if(!hasPyAPI()){toast('Run via python main.py to connect');return;}
    toast('Connecting...');
    const r=await window.pywebview.api.connect();
    const dot=document.querySelector('.status-dot'), status=document.getElementById('conn-status');
    if(r.ok){
        status.textContent=r.message; dot.style.background='#2ecc71'; dot.style.boxShadow='0 0 8px #2ecc71';
        toast('Connected!'); startStaticStream(); await restoreLastLighting();
        _checkForUpdate();
        window.pywebview.api.get_version().then(r=>{ if(r.ok){const el=document.getElementById('appVersion');if(el)el.textContent=r.version;} });
        // Start soundboard — loads cards, starts poller, syncs to driver
        if (typeof initSoundboard==='function') await initSoundboard();
    } else {
        status.textContent=r.message; dot.style.background='#ff4444'; dot.style.boxShadow='0 0 8px #ff4444';
        toast(r.message);
    }
}

async function _checkForUpdate() {
    try {
        const r = await window.pywebview.api.check_for_update();
        if (!r.ok || !r.available) return;
        _showUpdateBanner(r.version, r.url);
    } catch(e) {}
}

function _showUpdateBanner(version, url) {
    let banner = document.getElementById('updateBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'updateBanner';
        banner.style.cssText = `
            position:fixed;bottom:40px;right:16px;z-index:10000;
            background:#1a1a2e;border:1px solid var(--accent);border-radius:8px;
            padding:12px 16px;display:flex;flex-direction:column;gap:8px;
            box-shadow:0 4px 24px rgba(0,0,0,0.8);max-width:280px;
            backdrop-filter:none;`;
        document.body.appendChild(banner);
    }
    banner.innerHTML = `
        <div style="font-size:0.72rem;font-weight:700;color:var(--accent)">⬆ Update available</div>
        <div style="font-size:0.62rem;color:var(--dim)">${version} is ready to install.</div>
        <div style="display:flex;gap:8px">
            <button onclick="_applyUpdate('${url}')" style="flex:1;background:var(--accent);border:none;border-radius:5px;color:#fff;font-family:inherit;font-size:0.65rem;font-weight:700;padding:7px;cursor:pointer">UPDATE & RESTART</button>
            <button onclick="this.closest('#updateBanner').remove()" style="background:none;border:1px solid var(--border);border-radius:5px;color:var(--dim);font-family:inherit;font-size:0.65rem;padding:7px 10px;cursor:pointer">Later</button>
        </div>`;
}

async function _applyUpdate(url) {
    const banner = document.getElementById('updateBanner');
    if (banner) banner.innerHTML = '<div style="font-size:0.65rem;color:var(--dim);padding:4px 0">Downloading update... app will restart.</div>';
    await window.pywebview.api.apply_update(url);
}

async function restoreLastLighting() {
    if(!hasPyAPI())return;
    const r=await window.pywebview.api.load_current_lighting();
    if(r.ok&&r.type==='static'){applyStaticColorMap(r.colors);await window.pywebview.api.apply_frame(_buildFlashPayload());return;}
    if(r.ok&&r.type==='layers'){
        openLayersPanel(); _syncTopModeBtns('layers'); _deserializeLayers(r.layers); renderLayerStrip();
        _syncControlsToLayer(); _refreshKeyboard();
        const hasAnim=layers.some(l=>l.type==='animation'&&l.enabled);
        setLayerViewMode('composite');
        if(hasAnim){applyLayersActive=true;_startAllLayerAnims();startCompositor();_syncAllPlayBtns(true);}
        else{applyLayersActive=false;_sendLayersSnapshot();}
        return;
    }
    const ls=await window.pywebview.api.list_static_lightings();
    if(ls.ok&&ls.lightings.length>0){applyStaticColorMap(ls.lightings[0].colors);await window.pywebview.api.apply_frame(_buildFlashPayload());return;}
    Object.keys(keyColors).forEach(idx=>{delete keyColors[idx];unpaintKey(idx);}); updateFooter();
}

// ── Settings modal ────────────────────────────────────────────────────────────
function openSettings() { document.getElementById('settingsOverlay').classList.add('open'); loadStartupState(); }
function closeSettings(e) { if(e&&e.target!==document.getElementById('settingsOverlay'))return; document.getElementById('settingsOverlay').classList.remove('open'); }
function openDataFolder() { if(hasPyAPI()) window.pywebview.api.open_data_folder(); }
document.addEventListener('keydown', e=>{if(e.key==='Escape')document.getElementById('settingsOverlay').classList.remove('open');});
async function loadStartupState() { if(!hasPyAPI())return; const r=await window.pywebview.api.get_startup_enabled(); if(r.ok)document.getElementById('startupToggle').checked=r.enabled; }
async function setStartup(enable) {
    if(!hasPyAPI()){toast('Run via python main.py');return;}
    const r=await window.pywebview.api.set_startup_enabled(enable);
    if(r.ok)toast(enable?'✓ Will launch on startup':'Startup disabled');
    else{toast('Failed to update startup setting');document.getElementById('startupToggle').checked=!enable;}
}

// ── Mode switcher ─────────────────────────────────────────────────────────────
function switchTopMode(mode) {
    if(typeof deactivateEraser==='function')deactivateEraser();
    if(typeof layersPanelOpen!=='undefined'&&layersPanelOpen) closeLayersPanel();
    if(mode==='layers') openLayersPanel();

    const isSb = mode==='soundboard';

    // Left panel sections
    document.getElementById('colorSection').style.display  = isSb ? 'none' : '';
    document.getElementById('staticLeft').style.display    = isSb ? 'none' : '';
    document.getElementById('soundboardLeft').style.display = isSb ? '' : 'none';
    // swatches/selection hidden in soundboard
    document.querySelectorAll('#leftPanel > div:not(#colorSection):not(#staticLeft):not(#layersLeft):not(#soundboardLeft)').forEach(el => {
        el.style.display = isSb ? 'none' : '';
    });

    // Right panel sections
    document.getElementById('staticRight').style.display    = mode==='static'     ? '' : 'none';
    document.getElementById('layersRight').style.display    = mode==='layers'     ? '' : 'none';
    document.getElementById('soundboardRight').style.display = isSb              ? '' : 'none';

    // Center: card grid below keyboard
    document.getElementById('sbPanel').style.display = isSb ? 'block' : 'none';
    // Disable key interaction in soundboard mode
    const kb = document.getElementById('keyboard');
    if (kb) kb.style.pointerEvents = isSb ? 'none' : '';
    // Hide paint/select toolbar buttons in soundboard mode
    ['selectModeBtn','paintModeBtn','selectAllBtn','deselectBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isSb ? 'none' : '';
    });
    const danger = document.querySelector('#kbToolbar .danger');
    if (danger) danger.style.display = isSb ? 'none' : '';

    if (isSb && typeof clearSelection==='function') clearSelection();
    if (isSb) {
        // Wipe painted colors so only soundboard highlights show
        if (typeof keyColors !== 'undefined') {
            Object.keys(keyColors).forEach(idx => { delete keyColors[idx]; if (typeof unpaintKey==='function') unpaintKey(idx); });
        }
        if (typeof updateFooter==='function') updateFooter();
    }
    if (isSb && typeof initSoundboardUI==='function') initSoundboardUI();
    if (isSb && typeof _sbShowAllComboDim==='function') setTimeout(_sbShowAllComboDim, 80);
    _syncTopModeBtns(mode);
}
function _syncTopModeBtns(mode) {
    document.getElementById('staticModeBtn')?.classList.toggle('active-mode',mode==='static');
    document.getElementById('layersPanelBtn')?.classList.toggle('active-mode',mode==='layers');
    document.getElementById('soundboardBtn')?.classList.toggle('active-mode',mode==='soundboard');
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('pywebviewready', () => {
    connectKeyboard();
    loadStaticLightingsFromDisk();
    loadRecentColors();
});
updateFooter();