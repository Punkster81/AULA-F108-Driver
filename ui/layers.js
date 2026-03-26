// ── layers.js ─────────────────────────────────────────────────────────────────
// Layer system — compositor, all layer types, all reactive effects.
// Animation tab merged in here. Flash (save-to-memory) lives in flash.js.
//
// Architecture:
//   Effects     — registry: one entry per reactive effect. Add new effects here only.
//   LayerTypes  — registry: one entry per layer type. Logic defined once, reused.
//   Compositor  — merges layers bottom→top, paints keyboard, streams to hardware.
//   Poller      — polls driver for key events, feeds reactive state.

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let layers          = [];
let layerIdCtr      = 0;
let activeLayerId   = null;
let layerViewMode   = 'layer';   // 'layer' | 'composite'
let layersPanelOpen = false;
let compositorTimer = null;
let applyLayersActive = false;

const COMPOSITOR_MS    = 35;
const REACTIVE_POLL_MS = 16;

// ── Helpers ───────────────────────────────────────────────────────────────────
function nextLayerId()      { return ++layerIdCtr; }
function getActiveLayer()   { return layers.find(l => l.id === activeLayerId) || null; }
function hasPyAPILayers()   { return window.pywebview && window.pywebview.api; }
function _rgbToHex(c)       { return '#' + [c.r,c.g,c.b].map(v => Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join(''); }
function _normalizeColor(c) { if (!c) return null; if (Array.isArray(c)) return {r:c[0]||0,g:c[1]||0,b:c[2]||0}; return {r:c.r||0,g:c.g||0,b:c.b||0}; }
function _normalizeColors(colors) {
    if (_isGroupedColors(colors)) colors = _groupedToFlat(colors);
    const out={};
    Object.entries(colors||{}).forEach(([idx,c])=>{const n=_normalizeColor(c);if(n)out[idx]=n;});
    return out;
}

// ── Color grouping: {idx:{r,g,b}} ↔ {rrggbb:[idx,...]} ───────────────────────
function _colorsToGrouped(colors) {
    const groups = {};
    Object.entries(colors || {}).forEach(([idx, c]) => {
        const r = c.r ?? c[0] ?? 0, g = c.g ?? c[1] ?? 0, b = c.b ?? c[2] ?? 0;
        const hex = ((r&0xff)<<16|(g&0xff)<<8|(b&0xff)).toString(16).padStart(6,'0');
        if (!groups[hex]) groups[hex] = [];
        groups[hex].push(idx);
    });
    return groups;
}
function _groupedToFlat(grouped) {
    const out = {};
    Object.entries(grouped || {}).forEach(([hex, idxs]) => {
        const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
        idxs.forEach(idx => { out[idx] = {r, g, b}; });
    });
    return out;
}
// Detect if a colors object is grouped format (values are arrays of strings) or flat
function _isGroupedColors(colors) {
    const first = Object.values(colors || {})[0];
    return Array.isArray(first) && typeof first[0] === 'string';
}

function _blendInto(out, idx, r, g, b, alpha) {
    const cur = out[idx] || {r:0,g:0,b:0};
    out[idx] = {
        r: Math.min(255, Math.round(r*alpha + cur.r*(1-alpha))),
        g: Math.min(255, Math.round(g*alpha + cur.g*(1-alpha))),
        b: Math.min(255, Math.round(b*alpha + cur.b*(1-alpha))),
    };
}

// Generic reactive param setter — used by effect settingsHTML oninput handlers
function _setReactiveParam(key, val, labelId, labelSuffix='') {
    const layer = getActiveLayer();
    if (!layer || layer.type !== 'reactive') return;
    layer[key] = val;
    if (key === 'holdMode') { layer._reactiveColors = {}; layer._heldKeys = new Set(); }
    const el = document.getElementById(labelId);
    if (el) el.textContent = val + labelSuffix;
    _reactiveSynced = false;
    _syncReactiveConfig();
    if (applyLayersActive) _syncLayerConfig(true);
}
function setReactiveParam(key, val) { _setReactiveParam(key, val); }

// ── LED coordinate map ────────────────────────────────────────────────────────
const LED_COORDS = {
    '01':[0.50,0],'02':[2.00,0],'03':[3.00,0],'04':[4.00,0],'05':[5.00,0],
    '06':[6.50,0],'07':[7.50,0],'08':[8.50,0],'09':[9.50,0],
    '0a':[11.00,0],'0b':[12.00,0],'0c':[13.00,0],'0d':[14.00,0],
    '13':[0.50,1],'14':[1.50,1],'15':[2.50,1],'16':[3.50,1],'17':[4.50,1],
    '18':[5.50,1],'19':[6.50,1],'1a':[7.50,1],'1b':[8.50,1],
    '1c':[9.50,1],'1d':[10.50,1],'1e':[11.50,1],'1f':[12.50,1],'67':[14.00,1],
    '25':[0.75,2],'26':[1.50,2],'27':[2.50,2],'28':[3.50,2],'29':[4.50,2],
    '2a':[5.50,2],'2b':[6.50,2],'2c':[7.50,2],'2d':[8.50,2],
    '2e':[9.50,2],'2f':[10.50,2],'30':[11.50,2],'31':[12.50,2],'43':[13.75,2],
    '37':[0.875,3],'38':[1.75,3],'39':[2.75,3],'3a':[3.75,3],'3b':[4.75,3],
    '3c':[5.75,3],'3d':[6.75,3],'3e':[7.75,3],'3f':[8.75,3],
    '40':[9.75,3],'41':[10.75,3],'42':[11.75,3],'55':[13.125,3],
    '49':[1.125,4],'4a':[2.25,4],'4b':[3.25,4],'4c':[4.25,4],'4d':[5.25,4],
    '4e':[6.25,4],'4f':[7.25,4],'50':[8.25,4],'51':[9.25,4],
    '52':[10.25,4],'53':[11.25,4],'54':[12.625,4],
    '5b':[0.75,5],'5c':[1.50,5],'5d':[2.25,5],'5e':[6.00,5],
    '5f':[9.75,5],'60':[10.75,5],'61':[11.75,5],'62':[12.75,5],
    '70':[16.5,0],'71':[17.5,0],'73':[18.5,0],
    '74':[16.5,1],'75':[17.5,1],'76':[18.5,1],
    '77':[16.5,2],'78':[17.5,2],'79':[18.5,2],
    '65':[17.5,4],'63':[16.5,5],'64':[17.5,5],'66':[18.5,5],
    '20':[20.0,1],'21':[21.0,1],'22':[22.0,1],'7a':[23.0,1],
    '32':[20.0,2],'33':[21.0,2],'34':[22.0,2],'7b':[23.0,2],
    '44':[20.0,3],'45':[21.0,3],'46':[22.0,3],
    '56':[20.0,4],'57':[21.0,4],'58':[22.0,4],'6a':[23.0,4],
    '68':[20.5,5],'69':[22.0,5],
};
function _ledDist(a, b) {
    const ca=LED_COORDS[a], cb=LED_COORDS[b];
    if (!ca||!cb) return 999;
    return Math.sqrt((ca[0]-cb[0])**2+(ca[1]-cb[1])**2);
}

// ── Meteor path tables ────────────────────────────────────────────────────────
const LED_METEOR_PATHS = {
    '01':[[0,'01']],'02':[[0,'02']],'03':[[0,'03']],'04':[[0,'04']],'05':[[0,'05']],
    '06':[[0,'06']],'07':[[0,'07']],'08':[[0,'08']],'09':[[0,'09']],
    '0a':[[0,'0a']],'0b':[[0,'0b']],'0c':[[0,'0c']],'0d':[[0,'0d']],
    '13':[[0,'01'],[1,'13']],'14':[[0,'02'],[1,'14']],'15':[[0,'02'],[1,'15']],
    '16':[[0,'03'],[1,'16']],'17':[[0,'04'],[1,'17']],'18':[[0,'05'],[1,'18']],
    '19':[[0,'06'],[1,'19']],'1a':[[0,'07'],[1,'1a']],'1b':[[0,'08'],[1,'1b']],
    '1c':[[0,'09'],[1,'1c']],'1d':[[0,'0a'],[1,'1d']],'1e':[[0,'0a'],[1,'1e']],
    '1f':[[0,'0b'],[1,'1f']],
    '25':[[0,'01'],[1,'13'],[2,'25']],'26':[[0,'02'],[1,'14'],[2,'26']],
    '27':[[0,'02'],[1,'15'],[2,'27']],'28':[[0,'03'],[1,'16'],[2,'28']],
    '29':[[0,'04'],[1,'17'],[2,'29']],'2a':[[0,'05'],[1,'18'],[2,'2a']],
    '2b':[[0,'06'],[1,'19'],[2,'2b']],'2c':[[0,'07'],[1,'1a'],[2,'2c']],
    '2d':[[0,'08'],[1,'1b'],[2,'2d']],'2e':[[0,'09'],[1,'1c'],[2,'2e']],
    '2f':[[0,'0a'],[1,'1d'],[2,'2f']],'30':[[0,'0a'],[1,'1e'],[2,'30']],
    '31':[[0,'0b'],[1,'1f'],[2,'31']],'43':[[0,'0d'],[1,'67'],[2,'43']],
    '37':[[0,'01'],[1,'13'],[2,'25'],[3,'37']],'38':[[0,'02'],[1,'14'],[2,'26'],[3,'38']],
    '39':[[0,'03'],[1,'15'],[2,'27'],[3,'39']],'3a':[[0,'04'],[1,'16'],[2,'28'],[3,'3a']],
    '3b':[[0,'05'],[1,'17'],[2,'29'],[3,'3b']],'3c':[[0,'05'],[1,'18'],[2,'2a'],[3,'3c']],
    '3d':[[0,'06'],[1,'19'],[2,'2b'],[3,'3d']],'3e':[[0,'07'],[1,'1a'],[2,'2c'],[3,'3e']],
    '3f':[[0,'08'],[1,'1b'],[2,'2d'],[3,'3f']],'40':[[0,'09'],[1,'1c'],[2,'2e'],[3,'40']],
    '41':[[0,'0a'],[1,'1d'],[2,'2f'],[3,'41']],'42':[[0,'0b'],[1,'1e'],[2,'30'],[3,'42']],
    '55':[[0,'0c'],[1,'1f'],[2,'31'],[3,'55']],
    '49':[[0,'01'],[1,'14'],[2,'25'],[3,'37'],[4,'49']],
    '4a':[[0,'02'],[1,'15'],[2,'27'],[3,'38'],[4,'4a']],
    '4b':[[0,'03'],[1,'16'],[2,'28'],[3,'39'],[4,'4b']],
    '4c':[[0,'04'],[1,'17'],[2,'29'],[3,'3a'],[4,'4c']],
    '4d':[[0,'05'],[1,'18'],[2,'2a'],[3,'3b'],[4,'4d']],
    '4e':[[0,'06'],[1,'19'],[2,'2b'],[3,'3c'],[4,'4e']],
    '4f':[[0,'07'],[1,'1a'],[2,'2c'],[3,'3d'],[4,'4f']],
    '50':[[0,'08'],[1,'1b'],[2,'2d'],[3,'3e'],[4,'50']],
    '51':[[0,'09'],[1,'1c'],[2,'2e'],[3,'3f'],[4,'51']],
    '52':[[0,'09'],[1,'1d'],[2,'2f'],[3,'40'],[4,'52']],
    '53':[[0,'0a'],[1,'1e'],[2,'30'],[3,'41'],[4,'53']],
    '54':[[0,'0c'],[1,'1f'],[2,'31'],[3,'55'],[4,'54']],
    '5b':[[0,'01'],[1,'13'],[2,'25'],[3,'37'],[4,'49'],[5,'5b']],
    '5c':[[0,'02'],[1,'14'],[2,'26'],[3,'38'],[4,'49'],[5,'5c']],
    '5d':[[0,'02'],[1,'15'],[2,'27'],[3,'38'],[4,'4a'],[5,'5d']],
    '5e':[[0,'06'],[1,'18'],[2,'2a'],[3,'3c'],[4,'4e'],[5,'5e']],
    '5f':[[0,'09'],[1,'1c'],[2,'2e'],[3,'40'],[4,'51'],[5,'5f']],
    '60':[[0,'0a'],[1,'1d'],[2,'2f'],[3,'41'],[4,'52'],[5,'60']],
    '61':[[0,'0b'],[1,'1e'],[2,'30'],[3,'42'],[4,'53'],[5,'61']],
    '62':[[0,'0c'],[1,'1f'],[2,'31'],[3,'55'],[4,'54'],[5,'62']],
    '63':[[0,'70'],[1,'74'],[2,'77'],[3,'55'],[4,'65'],[5,'63']],
    '64':[[0,'71'],[1,'75'],[2,'78'],[3,'44'],[4,'65'],[5,'64']],
    '65':[[0,'71'],[1,'75'],[2,'78'],[3,'44'],[4,'65']],
    '66':[[0,'73'],[1,'76'],[2,'79'],[3,'44'],[4,'65'],[5,'66']],
    '67':[[0,'0d'],[1,'67']],
    '68':[[0,'73'],[1,'20'],[2,'32'],[3,'44'],[4,'56'],[5,'68']],
    '69':[[0,'73'],[1,'22'],[2,'34'],[3,'46'],[4,'58'],[5,'69']],
    '6a':[[0,'73'],[1,'7a'],[2,'7b'],[3,'46'],[4,'6a']],
    '70':[[0,'70']],'71':[[0,'71']],'73':[[0,'73']],
    '74':[[0,'70'],[1,'74']],'75':[[0,'71'],[1,'75']],'76':[[0,'73'],[1,'76']],
    '77':[[0,'70'],[1,'74'],[2,'77']],'78':[[0,'71'],[1,'75'],[2,'78']],
    '79':[[0,'73'],[1,'76'],[2,'79']],
    '7a':[[0,'73'],[1,'7a']],'7b':[[0,'73'],[1,'7a'],[2,'7b']],
    '20':[[0,'73'],[1,'20']],'21':[[0,'73'],[1,'21']],'22':[[0,'73'],[1,'22']],
    '32':[[0,'73'],[1,'20'],[2,'32']],'33':[[0,'73'],[1,'21'],[2,'33']],
    '34':[[0,'73'],[1,'22'],[2,'34']],
    '44':[[0,'73'],[1,'20'],[2,'32'],[3,'44']],'45':[[0,'73'],[1,'21'],[2,'33'],[3,'45']],
    '46':[[0,'73'],[1,'22'],[2,'34'],[3,'46']],
    '56':[[0,'73'],[1,'20'],[2,'32'],[3,'44'],[4,'56']],
    '57':[[0,'73'],[1,'21'],[2,'33'],[3,'45'],[4,'57']],
    '58':[[0,'73'],[1,'22'],[2,'34'],[3,'46'],[4,'58']],
};

const _LED_ROW0 = ['01','02','03','04','05','06','07','08','09','0a','0b','0c','0d','70','71','73'];
const _LED_ROWS = {};
Object.entries(LED_COORDS).forEach(([idx,[x,y]]) => { if (!_LED_ROWS[y]) _LED_ROWS[y]=[]; _LED_ROWS[y].push([x,idx]); });
Object.values(_LED_ROWS).forEach(r => r.sort((a,b)=>a[0]-b[0]));

function _getDriftedMeteorPath(targetLed, drift) {
    const basePath = LED_METEOR_PATHS[targetLed];
    if (!basePath) return [];
    const baseStart = basePath[0][1];
    const i = _LED_ROW0.indexOf(baseStart);
    if (i === -1) return basePath;
    const startKey = _LED_ROW0[Math.max(0,Math.min(_LED_ROW0.length-1,i+drift))] || baseStart;
    const sc=LED_COORDS[startKey], tc=LED_COORDS[targetLed];
    if (!sc||!tc) return basePath;
    const sx=sc[0], [tx,ty]=tc;
    const path = [[0,startKey]];
    Object.keys(_LED_ROWS).map(Number).sort((a,b)=>a-b).forEach(ry => {
        if (ry===0||ry>ty) return;
        const lerpX = sx+(tx-sx)*(ry/ty);
        const closest = _LED_ROWS[ry].reduce((a,b)=>Math.abs(a[0]-lerpX)<Math.abs(b[0]-lerpX)?a:b);
        path.push([ry,closest[1]]);
    });
    return path;
}

// ── Shared settings UI helpers ────────────────────────────────────────────────
function _colorPickerHTML() { return ''; }

function _randomRainbowRGB() {
    const h = Math.random();
    const i = Math.floor(h*6), f = h*6-i, p=0, q=1-f, t=f;
    const cases=[[1,t,0],[q,1,0],[0,1,t],[0,q,1],[t,0,1],[1,0,q]];
    const [r,g,b]=cases[i%6];
    return {r:Math.round(r*255),g:Math.round(g*255),b:Math.round(b*255)};
}

function _rainbowCheckboxHTML(layer) {
    const checked = layer.rainbow ? 'checked' : '';
    return `<label style="display:flex;align-items:center;gap:5px;font-size:0.62rem;color:var(--dim);cursor:pointer;margin-left:4px">
        <input type="checkbox" ${checked} onchange="setReactiveParam('rainbow',this.checked)"> 🌈 Rainbow color
    </label>`;
}
function _holdModeHTML(layer, paramKey, options) {
    return `<div style="display:flex;gap:5px;align-items:center">
        <span class="rs-label">While held:</span>
        ${options.map(([val,label]) =>
            `<button class="layer-type-btn ${(layer[paramKey]||options[0][0])===val?'active-mode':''}"
                onclick="_setReactiveParam('${paramKey}','${val}');renderReactiveEffectList(getActiveLayer())">${label}</button>`
        ).join('')}
    </div>`;
}
function _sliderHTML(layer, key, label, min, max, step, defaultVal, labelId, suffix='ms') {
    const val = layer[key] ?? defaultVal;
    return `<div style="display:flex;gap:6px;align-items:center">
        <span class="rs-label">${label}:</span>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${val}"
            oninput="_setReactiveParam('${key}',${suffix===''||suffix===' u/s'?'parseFloat':'parseInt'}(this.value),'${labelId}','${suffix}')"
            style="width:${max>1000?'120':'90'}px">
        <span id="${labelId}" class="rs-val">${val}${suffix}</span>
    </div>`;
}

// ── Effects registry ──────────────────────────────────────────────────────────
// ADD A NEW EFFECT: add one entry here. Nothing else in the codebase needs changing.
//
// Each effect must implement:
//   label, icon, desc          — UI display
//   defaults                   — layer property defaults (merged on layer creation)
//   initRippleState()          — returns fresh [] or {} state container
//   onPress(state,idx,c,now,layer)
//   onRelease(state,idx,now)
//   snapshot(layer,now)        — returns {idx:{r,g,b}} color map
//   prune(layer,now)           — removes expired entries from state
//   settingsHTML(layer)        — returns HTML string for the settings strip
//   serializeExtra(layer)      — extra fields to include in save file

const Effects = {

    highlight: {
        label:'Key Highlight', icon:'💡', desc:'Pressed key lights up',
        defaults: { holdMode:'fade', fadeDuration:500 },
        initRippleState: () => ({}),
        onPress(state, idx, c, now, layer) {
            const hold = layer.holdMode || 'fade';
            if (hold === 'toggle-on') {
                // Off by default — press toggles on/off
                if (state[idx]?.on) delete state[idx];
                else state[idx] = { r:c.r, g:c.g, b:c.b, on:true, releaseTime:null, pressTime:now };
                return;
            }
            if (hold === 'toggle-off') {
                // On by default — press toggles off/on
                if (state[idx]?.on === false) delete state[idx];
                else state[idx] = { r:c.r, g:c.g, b:c.b, on:false, releaseTime:null, pressTime:now };
                return;
            }
            state[idx] = { r:c.r, g:c.g, b:c.b, releaseTime:null, pressTime:now };
        },
        onRelease(state, idx, now, layer) {
            const hold = layer.holdMode || 'fade';
            if (hold === 'toggle-on' || hold === 'toggle-off') return; // toggle state persists
            if (state[idx]) state[idx].releaseTime = now;
            else state[idx] = { r:0,g:0,b:0, releaseTime:now, pressTime:now };
        },
        snapshot(layer, now) {
            const out={}, fadeMs=layer.fadeDuration??500, hold=layer.holdMode||'fade';
            const opacity=(layer.opacity??100)/100, toDel=[];
            Object.entries(layer._reactiveColors||{}).forEach(([idx,key]) => {
                if (hold === 'toggle-on') {
                    if (key.on) _blendInto(out, idx, key.r, key.g, key.b, opacity);
                    return;
                }
                if (hold === 'toggle-off') {
                    // key.on===false means it's been turned off — show nothing
                    // absent from state means not yet pressed — show at full brightness
                    if (key.on !== false) _blendInto(out, idx, key.r, key.g, key.b, opacity);
                    return;
                }
                let alpha;
                if (key.releaseTime!==null) {
                    if (hold==='instant') { toDel.push(idx); return; }
                    alpha = Math.max(0, 1-(now-key.releaseTime)/Math.max(fadeMs,1));
                    if (alpha<=0) { toDel.push(idx); return; }
                } else { alpha=1; }
                _blendInto(out, idx, key.r, key.g, key.b, alpha*opacity);
            });
            // toggle-off: keys with a color painted but not in state are "on"
            if (hold === 'toggle-off') {
                Object.entries(layer.colors||{}).forEach(([idx, c]) => {
                    if (!layer._reactiveColors[idx]) {
                        _blendInto(out, idx, c.r, c.g, c.b, opacity);
                    }
                });
            }
            toDel.forEach(idx => delete layer._reactiveColors[idx]);
            return out;
        },
        prune(layer, now) {
            const hold = layer.holdMode || 'fade';
            if (hold === 'toggle-on' || hold === 'toggle-off') return; // toggles never expire
            const maxHold=(layer.fadeDuration||500)*3;
            Object.keys(layer._reactiveColors||{}).forEach(idx => {
                const key=layer._reactiveColors[idx];
                if (key.releaseTime===null&&(now-key.pressTime)>maxHold) key.releaseTime=now;
            });
        },
        settingsHTML(layer) {
            const hold = layer.holdMode || 'fade';
            const fade = hold === 'fade';
            return _holdModeHTML(layer,'holdMode',[['fade','FADE OUT'],['instant','INSTANT OFF'],['toggle-on','TOGGLE (off→on)'],['toggle-off','TOGGLE (on→off)']])
                + (fade ? _sliderHTML(layer,'fadeDuration','Fade',50,3000,50,500,'rsFadeVal') : '')
                + _colorPickerHTML(layer)
                + _rainbowCheckboxHTML(layer);

        },
        serializeExtra: ()=>({}),
    },

    ripple: {
        label:'Ripple', icon:'〰️', desc:'Ring expands from key',
        defaults: { rippleSpeed:8.0, rippleWidth:1.2, fadeDuration:1500, rippleHoldMode:'once' },
        initRippleState: ()=>([]),
        onPress(state, idx, c, now, layer) {
            const holdMode = layer.rippleHoldMode || 'once';
            if (holdMode !== 'continuous') {
                if (!layer._heldKeys) layer._heldKeys = new Set();
                if (layer._heldKeys.has(idx)) return;
                layer._heldKeys.add(idx);
            }
            state.push({ origin:idx, color:c, pressTime:now,
                releaseTime: holdMode === 'once' ? now : null });
        },
        onRelease(state, idx, now, layer) {
            layer._heldKeys?.delete(idx);
            if ((layer.rippleHoldMode||'once') === 'once') return;
            for (let i=state.length-1;i>=0;i--) { if(state[i].origin===idx&&state[i].releaseTime===null){state[i].releaseTime=now;break;} }
        },
        snapshot(layer, now) {
            const out={}, fadeMs=layer.fadeDuration??1500;
            const speed=(layer.rippleSpeed??8.0)/1000, width=layer.rippleWidth??1.2;
            const opacity=(layer.opacity??100)/100, toDel=[];
            (layer._ripples||[]).forEach((r,i) => {
                const ringR=(now-r.pressTime)*speed;
                let fade=1;
                if (r.releaseTime!==null) { fade=Math.max(0,1-(now-r.releaseTime)/Math.max(fadeMs,1)); if(fade<=0){toDel.push(i);return;} }
                Object.keys(LED_COORDS).forEach(idx => {
                    const diff=Math.abs(_ledDist(r.origin,idx)-ringR);
                    if (diff>width*2) return;
                    const a=Math.max(0,1-diff/width)*fade*opacity;
                    if (a>0) _blendInto(out, idx, r.color.r, r.color.g, r.color.b, a);
                });
            });
            for (let i=toDel.length-1;i>=0;i--) layer._ripples.splice(toDel[i],1);
            return out;
        },
        prune(layer, now) {
            const fadeMs=layer.fadeDuration??1500;
            layer._ripples=(layer._ripples||[]).filter(r=>r.releaseTime===null||(now-r.releaseTime)<fadeMs);
        },
        settingsHTML(layer) {
            return _holdModeHTML(layer,'rippleHoldMode',[['once','ONE PER PRESS'],['continuous','CONTINUOUS']])
                + _sliderHTML(layer,'rippleSpeed','Speed',2,20,0.5,8.0,'rsSpeedVal',' u/s')
                + _sliderHTML(layer,'rippleWidth','Width',0.3,4,0.1,1.2,'rsWidthVal','')
                + _sliderHTML(layer,'fadeDuration','Duration',100,3000,50,1500,'rsFadeVal')
                + _colorPickerHTML(layer)
                + _rainbowCheckboxHTML(layer);

        },
        serializeExtra: ()=>({}),
    },

    meteor: {
        label:'Meteor', icon:'☄️', desc:'Light falls to key from top',
        defaults: { fallDuration:600, trailLength:3.0, sitDuration:200, fadeDuration:400, rippleHoldMode:'once' },
        initRippleState: ()=>([]),
        onPress(state, idx, c, now, layer) {
            if (!layer._heldKeys) layer._heldKeys = new Set();
            if ((layer.rippleHoldMode||'once')!=='continuous') {
                if (layer._heldKeys.has(idx)) return;
            }
            layer._heldKeys.add(idx);
            const drift=Math.floor(Math.random()*3)-1;
            state.push({ origin:idx, color:c, pressTime:now, releaseTime:null, path:_getDriftedMeteorPath(idx,drift) });
        },
        onRelease(state, idx, now, layer) {
            layer._heldKeys?.delete(idx);
            for (let i=state.length-1;i>=0;i--) { if(state[i].origin===idx&&state[i].releaseTime===null){state[i].releaseTime=now;break;} }
        },
        snapshot(layer, now) {
            const out={}, fallMs=layer.fallDuration??600, trailN=layer.trailLength??3.0;
            const sitMs=layer.sitDuration??200, fadeMs=layer.fadeDuration??400;
            const opacity=(layer.opacity??100)/100, toDel=[];
            (layer._ripples||[]).forEach((m,i) => {
                const elapsed=now-m.pressTime;
                const path=(m.path&&m.path.length)?m.path:(LED_METEOR_PATHS[m.origin]||[]);
                if (!path.length) { toDel.push(i); return; }
                const {r,g,b}=m.color;
                if (elapsed>=fallMs) {
                    const post=elapsed-fallMs;
                    const a=post<sitMs?1.0:Math.max(0,1-(post-sitMs)/Math.max(fadeMs,1));
                    if (a<=0) { toDel.push(i); return; }
                    _blendInto(out, m.origin, r,g,b, a*opacity);
                } else {
                    const headStep=(path.length-1)*(elapsed/Math.max(fallMs,1));
                    path.forEach(([,keyIdx],stepI) => {
                        const dist=headStep-stepI;
                        if (dist<0||dist>trailN) return;
                        _blendInto(out, keyIdx, r,g,b, (1-dist/trailN)*opacity);
                    });
                }
            });
            for (let i=toDel.length-1;i>=0;i--) layer._ripples.splice(toDel[i],1);
            return out;
        },
        prune(layer, now) {
            const totalMs=(layer.fallDuration??600)+(layer.sitDuration??200)+(layer.fadeDuration??400);
            layer._ripples=(layer._ripples||[]).filter(r=>(now-r.pressTime)<totalMs);
        },
        settingsHTML(layer) {
            return _holdModeHTML(layer,'rippleHoldMode',[['once','ONE PER PRESS'],['continuous','CONTINUOUS']])
                + _sliderHTML(layer,'fallDuration','Fall time',50,3000,50,600,'mFallVal')
                + _sliderHTML(layer,'trailLength','Trail',0.3,5,0.1,3.0,'mTrailVal','')
                + _sliderHTML(layer,'sitDuration','Sit',0,1000,25,200,'mSitVal')
                + _sliderHTML(layer,'fadeDuration','Fade',50,2000,50,400,'rsFadeVal')
                + _colorPickerHTML(layer)
                + _rainbowCheckboxHTML(layer);

        },
        serializeExtra(layer) { return { fallDuration:layer.fallDuration??600, trailLength:layer.trailLength??3.0, sitDuration:layer.sitDuration??200 }; },
    },

    lightning: {
        label:'Lightning', icon:'⚡', desc:'Whole column flashes instantly',
        defaults: { fadeDuration:500, lightningHoldMode:'once' },
        initRippleState: ()=>([]),
        onPress(state, idx, c, now, layer) {
            if (!layer._heldKeys) layer._heldKeys = new Set();
            if ((layer.lightningHoldMode||'once')!=='continuous') {
                if (layer._heldKeys.has(idx)) return;
            }
            layer._heldKeys.add(idx);
            const drift=Math.floor(Math.random()*3)-1;
            state.push({ origin:idx, color:c, pressTime:now, released:false, path:_getDriftedMeteorPath(idx,drift) });
        },
        onRelease(state, idx, now, layer) {
            layer._heldKeys?.delete(idx);
            for (let i=state.length-1;i>=0;i--) { if(state[i].origin===idx&&!state[i].released){state[i].released=true;break;} }
        },
        snapshot(layer, now) {
            const out={}, fadeMs=layer.fadeDuration??500, opacity=(layer.opacity??100)/100, toDel=[];
            (layer._ripples||[]).forEach((bolt,i) => {
                const a=Math.max(0,1-(now-bolt.pressTime)/Math.max(fadeMs,1))*opacity;
                if (a<=0) { toDel.push(i); return; }
                const path=(bolt.path&&bolt.path.length)?bolt.path:(LED_METEOR_PATHS[bolt.origin]||[]);
                path.forEach(([,keyIdx]) => _blendInto(out, keyIdx, bolt.color.r, bolt.color.g, bolt.color.b, a));
            });
            for (let i=toDel.length-1;i>=0;i--) layer._ripples.splice(toDel[i],1);
            return out;
        },
        prune(layer, now) {
            const fadeMs=layer.fadeDuration??500;
            layer._ripples=(layer._ripples||[]).filter(r=>(now-r.pressTime)<fadeMs+100);
        },
        settingsHTML(layer) {
            return _holdModeHTML(layer,'lightningHoldMode',[['once','ONE PER PRESS'],['continuous','CONTINUOUS']])
                + _sliderHTML(layer,'fadeDuration','Fade',50,2000,50,500,'rsFadeVal')
                + _colorPickerHTML(layer)
                + _rainbowCheckboxHTML(layer);

        },
        serializeExtra: ()=>({}),
    },

};

// ── LayerTypes registry ───────────────────────────────────────────────────────
// Logic defined once here. flash.js reuses LayerTypes.static directly.

const LayerTypes = {

    static: {
        snapshot(layer)  { return layer.colors || {}; },
        makeDefaults()   { return { colors:{} }; },
        serialize(layer) { return { colors: _colorsToGrouped(layer.colors||{}) }; },
        deserialize(data){ return { colors: _normalizeColors(data.colors||{}) }; },
    },

    animation: {
        snapshot(layer) { return (layer.frames||[])[layer._frameIdx||0]?.colors || {}; },
        makeDefaults()  { return { frames:[], loop:true, _frameIdx:0, _timer:null, _running:false }; },
        serialize(layer){ return { loop:layer.loop!==false, frames:(layer.frames||[]).map(f=>({duration:f.duration,colors:_colorsToGrouped(f.colors||{})})) }; },
        deserialize(data){
            return {
                loop: true,
                frames: (data.frames||[]).map(f=>({duration:f.duration||100, colors:_normalizeColors(f.colors||{})})),
                _frameIdx:0, _timer:null, _running:false,
            };
        },
    },

    reactive: {
        snapshot(layer) {
            if (typeof layerViewMode !== 'undefined' && layerViewMode !== 'composite') {
                // Rainbow mode: return sentinel {rainbow:true} for each painted key
                if (layer.rainbow) {
                    const out = {};
                    Object.keys(layer.colors||{}).forEach(k => { out[k] = {rainbow:true}; });
                    return out;
                }
                return layer.colors || {};
            }
            const effect = Effects[layer.effect||'highlight'];
            if (!effect) return {};
            const now = performance.now();
            effect.prune(layer, now);
            return effect.snapshot(layer, now);
        },
        makeDefaults() { return { effect:'highlight', color:{r:255,g:255,b:255}, colors:{}, _ripples:[], _reactiveColors:{} }; },
        serialize(layer) {
            const effect = Effects[layer.effect||'highlight'];
            return {
                effect:            layer.effect||'highlight',
                color:             layer.color||{r:255,g:255,b:255},
                colors:            _colorsToGrouped(layer.colors||{}),
                rainbow:           !!layer.rainbow,
                holdMode:          layer.holdMode||'fade',
                fadeDuration:      layer.fadeDuration??500,
                rippleSpeed:       layer.rippleSpeed??8.0,
                rippleWidth:       layer.rippleWidth??1.2,
                rippleHoldMode:    layer.rippleHoldMode??'once',
                lightningHoldMode: layer.lightningHoldMode??'once',
                ...(effect?.serializeExtra(layer)||{}),
            };
        },
        deserialize(data) {
            const effectId  = data.effect||'highlight';
            const effectDef = Effects[effectId];
            const defs      = effectDef?.defaults || {};
            return {
                effect:            effectId,
                color:             data.color||{r:255,g:255,b:255},
                colors:            _normalizeColors(data.colors||{}),
                rainbow:           !!data.rainbow,
                holdMode:          data.holdMode||'fade',
                fadeDuration:      data.fadeDuration ?? defs.fadeDuration ?? 500,
                rippleSpeed:       data.rippleSpeed  ?? defs.rippleSpeed  ?? 8.0,
                rippleWidth:       data.rippleWidth  ?? defs.rippleWidth  ?? 1.2,
                rippleHoldMode:    data.rippleHoldMode    ?? defs.rippleHoldMode    ?? 'once',
                lightningHoldMode: data.lightningHoldMode ?? defs.lightningHoldMode ?? 'once',
                fallDuration:      data.fallDuration ?? defs.fallDuration ?? 600,
                trailLength:       data.trailLength  ?? defs.trailLength  ?? 3.0,
                sitDuration:       data.sitDuration  ?? defs.sitDuration  ?? 200,
                _ripples:          [],
                _reactiveColors:   {},
            };
        },
    },

};

// ── Layer snapshot ────────────────────────────────────────────────────────────
function getLayerSnapshot(layer) {
    if (!layer) return {};
    return LayerTypes[layer.type]?.snapshot(layer) ?? {};
}

// ── Layer CRUD ────────────────────────────────────────────────────────────────
function _makeLayer(type, name, data) {
    const typeDef = LayerTypes[type];
    if (!typeDef) { console.warn('Unknown layer type:', type); return null; }
    return { id:nextLayerId(), name:name||'Layer', type, enabled:data.enabled!==false, opacity:data.opacity??100, ...typeDef.deserialize(data) };
}
function addLayer(type, name, data={}) {
    const layer = _makeLayer(type, name, data);
    if (!layer) return;
    layers.push(layer);
    if (type==='animation'&&applyLayersActive) _startLayerAnim(layer);
    selectLayer(layer.id);
    renderLayerStrip();
    if (typeof toast==='function') toast(`Layer "${layer.name}" added`);
}
function removeLayer(id) {
    const idx = layers.findIndex(l=>l.id===id);
    if (idx<0) return;
    if (_layerAnimActive&&activeLayerId===id) _unmountLayerAnimEditor(true);
    _stopLayerAnim(layers[idx]);
    layers.splice(idx,1);
    if (activeLayerId===id) activeLayerId = layers[0]?.id||null;
    renderLayerStrip(); _refreshKeyboard();
    const nowActive = getActiveLayer();
    if (nowActive?.type==='animation'&&!_layerAnimActive) _mountLayerAnimEditor(nowActive);
    else if ((!nowActive||nowActive.type!=='animation')&&_layerAnimActive) _unmountLayerAnimEditor();
    _syncLayerAnimControls();
    _syncControlsToLayer();
}
function selectLayer(id) {
    if (applyLayersActive||isPlaying) _stopAllPlayback();
    if (_layerAnimActive) _unmountLayerAnimEditor();
    activeLayerId = id;
    if (typeof deactivateEraser==='function') deactivateEraser();
    _syncControlsToLayer(); renderLayerStrip(); _refreshKeyboard();
    const layer = getActiveLayer();
    if (layer?.type==='animation') _mountLayerAnimEditor(layer);
    else if (applyLayersActive&&layerViewMode!=='composite') _stopAllPlayback();
}
function moveLayerUp(id)   { const i=layers.findIndex(l=>l.id===id); if(i<=0)return; [layers[i-1],layers[i]]=[layers[i],layers[i-1]]; renderLayerStrip(); }
function moveLayerDown(id) { const i=layers.findIndex(l=>l.id===id); if(i<0||i>=layers.length-1)return; [layers[i],layers[i+1]]=[layers[i+1],layers[i]]; renderLayerStrip(); }
function clearAllLayers() {
    if (_layerAnimActive) _unmountLayerAnimEditor(true);
    layers.forEach(l=>_stopLayerAnim(l));
    layers=[]; activeLayerId=null;
    addLayer('static','Layer 1',{colors:{}});
    _refreshKeyboard();
    if(hasPyAPILayers())window.pywebview.api.clear();
    if(typeof toast==='function')toast('All layers cleared');
}
function toggleLayerEnabled(id) {
    const layer=layers.find(l=>l.id===id); if(!layer)return;
    layer.enabled=!layer.enabled;
    if (layer.type==='animation') { const run=layer.enabled&&(applyLayersActive||isPlaying); run?_startLayerAnim(layer):_stopLayerAnim(layer); }
    renderLayerStrip(); _syncLayerAnimControls();
}
function setActiveLayerType(type) {
    const layer=getActiveLayer(); if(!layer||layer.type===type)return;
    if (_layerAnimActive) _unmountLayerAnimEditor();
    _stopLayerAnim(layer);
    const snap = getLayerSnapshot(layer);
    layer.type = type;
    Object.assign(layer, LayerTypes[type].deserialize({ colors:snap }));
    if (type==='animation'&&!layer.frames.length) layer.frames=[{duration:100,colors:JSON.parse(JSON.stringify(snap))}];
    if (type==='animation') _mountLayerAnimEditor(layer);
    _syncControlsToLayer(); renderLayerStrip();
    if (typeof toast==='function') toast(`Layer set to ${type}`);
}
function setActiveLayerOpacity(val) {
    const layer=getActiveLayer(); if(!layer)return;
    layer.opacity=parseInt(val)||100;
    document.getElementById('layerOpacityVal').textContent=layer.opacity+'%';
    _refreshKeyboard();
}

// ── Painting ──────────────────────────────────────────────────────────────────
function layerPaintKey(idx) {
    if (typeof eraserMode!=='undefined'&&eraserMode) { eraseLayerKey(idx); return; }
    const layer=getActiveLayer(); if(!layer){if(typeof toast==='function')toast('No layer selected');return;}
    const {r,g,b}=getCurrentRGB();
    if (layer.type==='static'||layer.type==='reactive') { if(!layer.colors)layer.colors={}; layer.colors[idx]={r,g,b}; }
    else {
        const fi=_layerAnimActive?activeAnimFrame:(layer._frameIdx||0);
        const frame=layer.frames?.[fi];
        if (frame) { if(!frame.colors)frame.colors={}; frame.colors[idx]={r,g,b}; if(_layerAnimActive&&typeof updateFrameThumb==='function')updateFrameThumb(fi); }
    }
    _refreshKeyboard();
}
function eraseLayerKey(idx) {
    const layer=getActiveLayer(); if(!layer)return;
    if (layer.type==='static'||layer.type==='reactive') { delete layer.colors[idx]; }
    else {
        const fi=_layerAnimActive?activeAnimFrame:(layer._frameIdx||0);
        const frame=layer.frames?.[fi];
        if (frame?.colors) { delete frame.colors[idx]; if(_layerAnimActive&&typeof updateFrameThumb==='function')updateFrameThumb(fi); }
    }
    _refreshKeyboard();
}

// Exposed to main.js modes registry
const _layersModeEntry = {
    onKeyPaint(idx) { layerPaintKey(idx); },
    onClearAll() {
        const layer=getActiveLayer(); if(!layer){if(typeof toast==='function')toast('No layer selected');return;}
        if (layer.type==='static'||layer.type==='reactive') { layer.colors={}; }
        else { const fi=_layerAnimActive?activeAnimFrame:(layer._frameIdx||0);const f=layer.frames?.[fi];if(f){f.colors={};if(_layerAnimActive&&typeof updateFrameThumb==='function')updateFrameThumb(fi);} }
        _refreshKeyboard(); if(typeof toast==='function')toast('Layer cleared');
    },
    onApplySelected(idxs) {
        const {r,g,b}=getCurrentRGB(); const layer=getActiveLayer(); if(!layer)return;
        idxs.forEach(idx => {
            if (layer.type==='static'||layer.type==='reactive') { if(!layer.colors)layer.colors={}; layer.colors[idx]={r,g,b}; }
            else { const fi=_layerAnimActive?activeAnimFrame:(layer._frameIdx||0);const f=layer.frames?.[fi];if(f){if(!f.colors)f.colors={};f.colors[idx]={r,g,b};} }
        });
        if (layer.type==='animation'&&_layerAnimActive&&typeof updateFrameThumb==='function') updateFrameThumb(activeAnimFrame);
        _refreshKeyboard();
    },
    onPickSource(idx) { const l=getActiveLayer(); return l?(getLayerSnapshot(l)[idx]||null):null; },
};

// ── Compositor ────────────────────────────────────────────────────────────────
function compositeLayers() {
    const result={};
    for (const layer of layers) {
        if (!layer.enabled) continue;
        const snap=getLayerSnapshot(layer), la=layer.opacity/100;
        Object.entries(snap).forEach(([idx,{r,g,b}]) => {
            const acc=result[idx];
            if (!acc) { result[idx]={r:r*la,g:g*la,b:b*la,a:la}; }
            else { const rem=(1-acc.a)*la; result[idx]={r:acc.r+r*rem,g:acc.g+g*rem,b:acc.b+b*rem,a:Math.min(1,acc.a+rem)}; }
        });
    }
    const out={};
    Object.entries(result).forEach(([idx,{r,g,b}])=>{out[idx]={r:Math.round(r),g:Math.round(g),b:Math.round(b)};});
    return out;
}
function _paintKeyboardFromMap(colorMap) {
    Object.keys(keyEls).forEach(idx => {
        const c=colorMap[idx];
        if (!c) { unpaintKey(idx); return; }
        if (c.rainbow) { if(typeof paintKeyRainbow==='function') paintKeyRainbow(idx); return; }
        paintKey(idx,c.r,c.g,c.b);
    });
}
function _refreshKeyboard() {
    if (!layersPanelOpen) return;
    const map=(layerViewMode==='composite')?compositeLayers():(()=>{const l=getActiveLayer();return l?getLayerSnapshot(l):{};})();
    _paintKeyboardFromMap(map);
    if (!applyLayersActive&&!isPlaying) _sendLayersSnapshot();
}
function _sendLayersSnapshot() {
    if (!hasPyAPILayers()) return;
    const map=(layerViewMode==='composite')?compositeLayers():(()=>{const l=getActiveLayer();return l?getLayerSnapshot(l):{};})();
    const payload={};
    Object.entries(map).forEach(([idx,c])=>{if(c&&!c.rainbow&&(c.r||c.g||c.b))payload[idx]=[c.r,c.g,c.b];});
    window.pywebview.api.apply_frame(payload);
}
let _compositorRunning = false;
function startCompositor() {
    if (_compositorRunning) return;
    _compositorRunning = true;
    _compositorTick();
    startReactivePoller();
}
function stopCompositor() {
    _compositorRunning = false;
    clearTimeout(compositorTimer); compositorTimer = null;
    _tickCallback = null;
    stopReactivePoller();
}
// ── Unthrottled tick helper ───────────────────────────────────────────────────
// setTimeout is throttled to ~1s when window is minimized (Chromium behaviour).
// MessageChannel postMessage is NOT throttled — use it to keep animations smooth.
const _tickChannel = new MessageChannel();
let _tickCallback  = null;
_tickChannel.port2.onmessage = () => { if (_tickCallback) { const cb = _tickCallback; _tickCallback = null; cb(); } };
function _scheduleCompositorTick(ms, cb) {
    if (document.hidden && ms < 100) {
        // Window minimized — use unthrottled MessageChannel
        _tickCallback = cb;
        _tickChannel.port1.postMessage(null);
    } else {
        setTimeout(cb, ms);
    }
}

function _compositorTick() {
    if (layersPanelOpen) {
        const map = layerViewMode==='composite'
            ? compositeLayers()
            : (()=>{ const l=getActiveLayer(); return l?getLayerSnapshot(l):{}; })();
        _paintKeyboardFromMap(map);
        // Only send apply_frame if driver is NOT handling the layer stack
        // (driver handles it when layer stack has animation or reactive layers)
        const driverHandles = applyLayersActive && layers.some(l => l.enabled && (l.type==='animation' || l.type==='reactive'));
        if (hasPyAPILayers() && applyLayersActive && !driverHandles) {
            const payload={};
            Object.entries(map).forEach(([idx,c])=>{if(c&&!c.rainbow&&(c.r||c.g||c.b))payload[idx]=[c.r,c.g,c.b];});
            window.pywebview.api.apply_frame(payload);
        }
    }
    compositorTimer = _compositorRunning
        ? _scheduleCompositorTick(layersPanelOpen ? 16 : COMPOSITOR_MS, _compositorTick)
        : null;
}

// ── Animation ticking ─────────────────────────────────────────────────────────
function _startAllLayerAnims()  { layers.forEach(l=>{if(l.type==='animation'&&l.enabled){l._frameIdx=0;_startLayerAnim(l);}}); }
function _stopAllLayerAnims()   { layers.forEach(l=>_stopLayerAnim(l)); }
function _startLayerAnim(layer) { if(layer.type!=='animation')return; _stopLayerAnim(layer); if(layer._frameIdx===undefined)layer._frameIdx=0; layer._running=true; _scheduleNextTick(layer); }
function _stopLayerAnim(layer)  { clearTimeout(layer._timer); layer._timer=null; layer._running=false; }
function _scheduleNextTick(layer) {
    if (!layer._running) return;
    const frames=layer.frames||[]; if(!frames.length)return;
    const dur=frames[layer._frameIdx]?.duration||100;
    const fire = () => {
        if(!layer._running)return;
        const next=(layer._frameIdx+1)%frames.length;
        if(next===0&&!layer.loop){layer._running=false;return;}
        layer._frameIdx=next; _scheduleNextTick(layer);
    };
    if (document.hidden) {
        // When hidden, use MessageChannel but track real time to respect duration
        const start = performance.now();
        const poll = () => {
            if (!layer._running) return;
            if (performance.now() - start >= dur) { fire(); return; }
            const ch = new MessageChannel();
            ch.port2.onmessage = poll;
            ch.port1.postMessage(null);
        };
        const ch = new MessageChannel();
        ch.port2.onmessage = poll;
        ch.port1.postMessage(null);
    } else {
        layer._timer = setTimeout(fire, dur);
    }
}
function _stopAllPlayback() {
    applyLayersActive=false; isPlaying=false;
    clearTimeout(previewTimer);
    _stopAllLayerAnims();
    layers.forEach(l => {
        if (l.type==='animation') l._frameIdx=0;
        if (l.type==='reactive') { l._reactiveColors={}; l._ripples=[]; l._heldKeys=new Set(); }
    });
    if (_layerAnimActive && animFrames?.length) selectAnimFrame(0);
    _syncReactiveConfig();
    _syncLayerConfig(false);
    _syncAllPlayBtns(false);
}

// ── Reactive poller ───────────────────────────────────────────────────────────
let _reactiveLastTs   = 0;
let _reactivePollTimer = null;
let _reactiveSynced   = false;

function startReactivePoller()  { if(_reactivePollTimer)return; _reactiveSynced=false; _reactivePollLoop(); }
function stopReactivePoller()   { clearTimeout(_reactivePollTimer); _reactivePollTimer=null; _reactiveSynced=false; }
async function _reactivePollLoop() {
    if (!_reactiveSynced&&layers.some(l=>l.type==='reactive'&&l.enabled)) { await _syncReactiveConfig(); _reactiveSynced=true; }
    await _pollReactiveLayers();
    _reactivePollTimer=setTimeout(_reactivePollLoop, REACTIVE_POLL_MS);
}
async function _pollReactiveLayers() {
    if (!hasPyAPILayers()) return;
    if (!layers.some(l=>l.type==='reactive'&&l.enabled)) return;
    try {
        const res=await window.pywebview.api.poll_keys(_reactiveLastTs);
        if (!res?.ok) return;
        _reactiveLastTs=res.ts;
        if (!res.events.length) return;
        const now=performance.now();
        layers.forEach(layer => {
            if (layer.type!=='reactive'||!layer.enabled) return;
            const effectDef=Effects[layer.effect||'highlight']; if(!effectDef)return;
            if (!layer._ripples)        layer._ripples=[];
            if (!layer._reactiveColors) layer._reactiveColors={};
            const state=(layer.effect==='highlight')?layer._reactiveColors:layer._ripples;
            res.events.forEach(ev => {
                const idx=ev.led;
                let perKey=layer.colors?.[idx];
                if (!perKey) { if(ev.type==='release')effectDef.onRelease(state,idx,now,layer); return; }
                // Rainbow: pick a random vivid color on press (once-per-press guarded by _heldKeys in onPress)
                if (ev.type==='press' && layer.rainbow && !layer._heldKeys?.has(idx)) perKey = _randomRainbowRGB();
                if (ev.type==='press')   effectDef.onPress(state,idx,perKey,now,layer);
                if (ev.type==='release') effectDef.onRelease(state,idx,now,layer);
            });
        });
    } catch(e) {}
}
async function _syncReactiveConfig() {
    if (!hasPyAPILayers()) return;
    const reactiveLayers=layers.filter(l=>l.type==='reactive'&&l.enabled).map(l=>({
        effect:l.effect||'highlight', color:l.color||{r:255,g:255,b:255}, colors:l.colors||{},
        rainbow:!!l.rainbow,

        holdMode:l.holdMode||'fade',
        fadeDuration: (l.holdMode==='toggle-on'||l.holdMode==='toggle-off') ? 0 : (l.fadeDuration??500), opacity:(l.opacity??100)/100,
        rippleSpeed:l.rippleSpeed??8.0, rippleWidth:l.rippleWidth??1.2,
        rippleHoldMode:l.rippleHoldMode??'once', lightningHoldMode:l.lightningHoldMode??'once',
        fallDuration:l.fallDuration??600, trailLength:l.trailLength??3.0, sitDuration:l.sitDuration??200,
    }));
    const hasReactive=reactiveLayers.length>0&&layersPanelOpen;
    try { await window.pywebview.api.update_reactive_config(reactiveLayers,hasReactive); } catch(e) {}
}

// ── Reactive settings UI ──────────────────────────────────────────────────────
function setReactiveColor(hex) {
    const layer=getActiveLayer(); if(!layer||layer.type!=='reactive')return;
    layer.color={r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)};
    _reactiveSynced=false; _syncReactiveConfig();
    if (applyLayersActive) _syncLayerConfig(true);
}
function renderReactiveEffectList(layer) {
    const el=document.getElementById('reactiveEffectList');
    const settingsEl=document.getElementById('reactiveEffectSettings');
    if (!el) return;
    el.innerHTML='';
    Object.entries(Effects).forEach(([id,def]) => {
        const isActive=(layer.effect||'highlight')===id;
        const card=document.createElement('div');
        card.className='frame-thumb'+(isActive?' active-frame':'');
        card.style.cssText='min-width:90px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:6px 10px;cursor:pointer;text-align:center';
        card.innerHTML=`<div style="font-size:1.2rem">${def.icon}</div>
            <div style="font-size:0.6rem;font-weight:600;color:var(--text)">${def.label}</div>
            <div style="font-size:0.55rem;color:var(--dim)">${def.desc}</div>`;
        card.addEventListener('click', ()=>{
            layer.effect=id; layer._ripples=[]; layer._reactiveColors={};
            Object.assign(layer, LayerTypes.reactive.deserialize({...LayerTypes.reactive.serialize(layer),effect:id}));
            renderReactiveEffectList(layer); _reactiveSynced=false; _syncReactiveConfig();
            if (applyLayersActive) _syncLayerConfig(true);
        });
        el.appendChild(card);
    });
    if (settingsEl) settingsEl.innerHTML=Effects[layer.effect||'highlight']?.settingsHTML(layer)||'';
}

// ── Layer controls ────────────────────────────────────────────────────────────
function _syncControlsToLayer() {
    const layer=getActiveLayer();
    document.getElementById('layerTypeBtns')?.querySelectorAll('.layer-type-btn').forEach(btn=>{
        btn.classList.toggle('active-mode',!!layer&&btn.dataset.type===layer.type); btn.disabled=!layer;
    });
    const isReactive=layer?.type==='reactive';
    const reactiveStrip=document.getElementById('reactiveStripWrap');
    if(reactiveStrip) reactiveStrip.style.display=(isReactive&&layersPanelOpen)?'block':'none';
    // Always re-render reactive list — clear first to force update even if previously reactive
    if(isReactive&&layersPanelOpen) {
        const el=document.getElementById('reactiveEffectList');
        const settingsEl=document.getElementById('reactiveEffectSettings');
        if(el) el.innerHTML='';
        if(settingsEl) settingsEl.innerHTML='';
        renderReactiveEffectList(layer);
    }
}

// ── Layer strip rendering ─────────────────────────────────────────────────────
let _dragSrcLayerIdx=null;
function renderLayerStrip() {
    const strip=document.getElementById('layerStrip'); if(!strip)return;
    strip.innerHTML='';
    const countEl=document.getElementById('layerCountLabel'); if(countEl)countEl.textContent=layers.length;
    if (!layers.length) {
        const empty=document.createElement('div');
        empty.style.cssText='font-size:0.62rem;color:var(--dim);padding:14px 16px;align-self:center';
        empty.textContent='No layers yet — add one using the panel on the right';
        strip.appendChild(empty); _syncControlsToLayer(); return;
    }
    layers.forEach((layer,i) => {
        const isActive=layer.id===activeLayerId;
        const card=document.createElement('div');
        card.className='layer-card'+(isActive?' active-layer-card':'')+(layer.enabled?'':' layer-card-off');
        card.dataset.idx=i;
        const typeIcon=layer.type==='animation'?'🎬':layer.type==='reactive'?'⚡':'✏️';
        const effectTag=layer.type==='reactive'?(layer.effect||'highlight'):layer.type==='animation'?`${layer.frames?.length||0}f`:'';
        card.innerHTML=`<div class="layer-card-top" draggable="true">
                <span class="lc-num">${i+1}</span><span class="lc-icon">${typeIcon}</span>
                <span class="lc-name" title="Double-click to rename">${layer.name}</span>
                ${effectTag?`<span class="lc-meta">${effectTag}</span>`:''}
                <button class="lc-vis${layer.enabled?'':' lc-vis-off'}" onclick="event.stopPropagation();toggleLayerEnabled(${layer.id})" title="Toggle">👁️</button>
                <button class="lc-del" onclick="event.stopPropagation();removeLayer(${layer.id})" title="Delete">✕</button>
            </div>
            <div class="layer-card-bar">
                <span style="font-size:0.55rem;color:var(--dim);flex-shrink:0">opacity</span>
                <input type="range" min="0" max="100" value="${layer.opacity}"
                    oninput="layers.find(l=>l.id===${layer.id}).opacity=parseInt(this.value);this.nextElementSibling.textContent=this.value+'%';_refreshKeyboard()">
                <span>${layer.opacity}%</span>
            </div>`;
        const cardTop = card.querySelector('.layer-card-top');
        const nameEl=cardTop.querySelector('.lc-name');
        let _rt=null;
        nameEl.addEventListener('click',e=>{e.stopPropagation();clearTimeout(_rt);_rt=setTimeout(()=>selectLayer(layer.id),200);});
        nameEl.addEventListener('dblclick',e=>{
            e.stopPropagation();clearTimeout(_rt);
            const input=document.createElement('input');
            input.type='text';input.value=layer.name;
            input.style.cssText='flex:1;font-size:0.7rem;font-weight:500;background:var(--key-off);border:1px solid var(--accent);border-radius:3px;color:var(--text);padding:0 4px;min-width:0;outline:none;width:0';
            nameEl.replaceWith(input);input.focus();input.select();
            const commit=()=>{layer.name=input.value.trim()||layer.name;renderLayerStrip();};
            input.addEventListener('blur',commit);
            input.addEventListener('keydown',e=>{if(e.key==='Enter')commit();if(e.key==='Escape')renderLayerStrip();});
        });
        card.addEventListener('click',e=>{if(!e.target.closest('.lc-name,.lc-vis,.lc-del,input'))selectLayer(layer.id);});
        cardTop.addEventListener('dragstart',e=>{_dragSrcLayerIdx=i;card.classList.add('layer-dragging');e.dataTransfer.effectAllowed='move';});
        cardTop.addEventListener('dragend',()=>{card.classList.remove('layer-dragging');strip.querySelectorAll('.layer-card').forEach(c=>c.classList.remove('layer-drag-over'));});
        card.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';strip.querySelectorAll('.layer-card').forEach(c=>c.classList.remove('layer-drag-over'));if(_dragSrcLayerIdx!==i)card.classList.add('layer-drag-over');});
        card.addEventListener('drop',e=>{e.preventDefault();if(_dragSrcLayerIdx===null||_dragSrcLayerIdx===i)return;const moved=layers.splice(_dragSrcLayerIdx,1)[0];layers.splice(i,0,moved);_dragSrcLayerIdx=null;renderLayerStrip();});
        strip.appendChild(card);
    });
    // + add button at end of strip
    const addBtn=document.createElement('button');
    addBtn.className='layer-strip-add'; addBtn.textContent='+'; addBtn.title='Add blank layer';
    addBtn.onclick=()=>addBlankLayer();
    strip.appendChild(addBtn);
}

function setLayerViewMode(mode) {
    layerViewMode=mode;
    document.getElementById('layerViewComposite')?.classList.toggle('active-mode',mode==='composite');
    document.getElementById('layerViewSingle')?.classList.toggle('active-mode',mode==='layer');
    document.getElementById('leftViewComposite')?.classList.toggle('active-mode',mode==='composite');
    document.getElementById('leftViewSingle')?.classList.toggle('active-mode',mode==='layer');
    _syncLayerAnimControls(); _refreshKeyboard();
}

// ── Eraser ────────────────────────────────────────────────────────────────────
let eraserMode=false;
function toggleEraser() {
    eraserMode=!eraserMode;
    const btn=document.getElementById('eraserBtn');
    if(btn){btn.classList.toggle('eraser-active',eraserMode);btn.textContent=eraserMode?'⬜ Eraser ON':'⬜ Eraser';}
    if(eraserMode){eyedropperMode=false;document.querySelectorAll('.eyedropper-btn').forEach(b=>b.classList.remove('active-mode'));}
    if(typeof updateSelPanel==='function')updateSelPanel();
}
function deactivateEraser() {
    eraserMode=false;
    const btn=document.getElementById('eraserBtn');
    if(btn){btn.classList.remove('eraser-active');btn.textContent='⬜ Eraser';}
}

// ── Layer pickers ─────────────────────────────────────────────────────────────
function refreshLayerPickers() { refreshLoadLayerList(); }
function addLayerFromSavedAnim()   {} // superseded by refreshLoadLayerList
function addLayerFromSavedStatic() {} // superseded by refreshLoadLayerList
function addBlankLayer()    { addLayer('static',   prompt('Layer name:','New Layer')   ||'New Layer',   {}); }
function addReactiveLayer() { addLayer('reactive', prompt('Layer name:','Reactive')    ||'Reactive',    {}); _syncReactiveConfig(); }
function addStaticLayerFromCurrent()  { if(typeof keyColors==='undefined'||!Object.keys(keyColors).length){if(typeof toast==='function')toast('No colors in current view');return;} addLayer('static',prompt('Layer name:','Static Layer')||'Static Layer',{colors:keyColors}); }
function addAnimLayerFromCurrent()    { if(typeof animFrames==='undefined'||!animFrames.length){if(typeof toast==='function')toast('No animation frames');return;} addLayer('animation',prompt('Layer name:','Anim Layer')||'Anim Layer',{loop:true,frames:animFrames.map(f=>({duration:f.duration,colors:f.colors}))}); }

// ── Save / Load layer presets ─────────────────────────────────────────────────
let savedLayerPresets={};
function _serializeLayers() {
    return layers.map(l=>{const t=LayerTypes[l.type];return{name:l.name,type:l.type,enabled:l.enabled,opacity:l.opacity,...t.serialize(l)};});
}
function _deserializeLayers(rawLayers) {
    layers.forEach(l=>_stopLayerAnim(l)); layers=[];activeLayerId=null;
    (rawLayers||[]).forEach(raw=>{const layer=_makeLayer(raw.type,raw.name,raw);if(layer)layers.push(layer);});
    if(layers.length)activeLayerId=layers[0].id;
}
async function saveLayerPreset() {
    if(!hasPyAPILayers()){if(typeof toast==='function')toast('Not connected');return;}
    const name=document.getElementById('layerPresetNameInput')?.value?.trim()||'My Layers';
    const res=await window.pywebview.api.save_layer_preset(name,{layers:_serializeLayers()});
    if(res.ok){if(typeof toast==='function')toast(`Saved "${name}"`);await loadLayerPresets();}
    else if(typeof toast==='function')toast('Save failed: '+res.message);
}
async function loadLayerPresets() {
    if(!hasPyAPILayers())return;
    const res=await window.pywebview.api.list_layer_presets(); if(!res.ok)return;
    savedLayerPresets={}; res.presets.forEach(p=>{savedLayerPresets[p.filename]=p;}); renderLayerPresetList();
}
function renderLayerPresetList() {
    const el=document.getElementById('savedLayersList'); if(!el)return; el.innerHTML='';
    const entries=Object.entries(savedLayerPresets);
    if(!entries.length){el.innerHTML='<div style="font-size:0.6rem;color:var(--dim)">No saved presets</div>';return;}
    entries.forEach(([fname,preset])=>{
        const item=document.createElement('div'); item.className='saved-anim-item';
        item.innerHTML=`<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${fname}">${preset.name}</span>
            <span style="font-size:0.58rem;color:var(--dim);flex-shrink:0">${preset.layer_count}L</span>
            <button class="load-btn">LOAD</button><button class="del-btn">✕</button>`;
        item.querySelector('.load-btn').addEventListener('click',()=>{
            _stopAllPlayback(); if(_layerAnimActive)_unmountLayerAnimEditor(true);
            _deserializeLayers(preset.layers); renderLayerStrip(); _refreshKeyboard();
            const active=getActiveLayer(); if(active?.type==='animation')_mountLayerAnimEditor(active);
            _syncLayerAnimControls(); _syncControlsToLayer();
            const nameInput = document.getElementById('layerPresetNameInput');
            if (nameInput && preset.name) nameInput.value = preset.name;
            if(typeof toast==='function')toast(`Loaded "${preset.name}"`);
        });
        item.querySelector('.del-btn').addEventListener('click',async()=>{await window.pywebview.api.delete_layer_preset(fname);await loadLayerPresets();});
        el.appendChild(item);
    });
}

// ── Animation frame editor ────────────────────────────────────────────────────
// Operates on the active animation layer's frames array.
// Previously lived in anim.js as a standalone mode.

let _layerAnimActive = false;
let activeAnimFrame  = -1;
let previewTimer     = null;
let isPlaying        = false;
let animFrames       = []; // reference to active layer's frames when mounted, [] otherwise

const PREVIEW_KEYS = (() => {
    const keys=[];
    const k=(idx,x,y,w=1,h=1)=>keys.push({idx,x,y,w,h});
    k('01',0,0);k('02',1.25,0);k('03',2.25,0);k('04',3.25,0);k('05',4.25,0);
    k('06',5.5,0);k('07',6.5,0);k('08',7.5,0);k('09',8.5,0);
    k('0a',9.75,0);k('0b',10.75,0);k('0c',11.75,0);k('0d',12.75,0);
    k('13',0,1);k('14',1,1);k('15',2,1);k('16',3,1);k('17',4,1);
    k('18',5,1);k('19',6,1);k('1a',7,1);k('1b',8,1);k('1c',9,1);
    k('1d',10,1);k('1e',11,1);k('1f',12,1);k('67',13,1,2);
    k('25',0,2,1.5);k('26',1.5,2);k('27',2.5,2);k('28',3.5,2);k('29',4.5,2);
    k('2a',5.5,2);k('2b',6.5,2);k('2c',7.5,2);k('2d',8.5,2);
    k('2e',9.5,2);k('2f',10.5,2);k('30',11.5,2);k('31',12.5,2);k('43',13.5,2,1.5);
    k('37',0,3,1.75);k('38',1.75,3);k('39',2.75,3);k('3a',3.75,3);k('3b',4.75,3);
    k('3c',5.75,3);k('3d',6.75,3);k('3e',7.75,3);k('3f',8.75,3);
    k('40',9.75,3);k('41',10.75,3);k('42',11.75,3);k('55',12.75,3,2.25);
    k('49',0,4,2.25);k('4a',2.25,4);k('4b',3.25,4);k('4c',4.25,4);k('4d',5.25,4);
    k('4e',6.25,4);k('4f',7.25,4);k('50',8.25,4);k('51',9.25,4);
    k('52',10.25,4);k('53',11.25,4);k('54',12.25,4,2.75);
    k('5b',0,5,1.5);k('5c',1.5,5);k('5d',2.5,5,1.5);k('5e',4,5,6.5);
    k('5f',10.5,5);k('60',11.5,5);k('61',12.5,5);k('62',13.5,5,1.5);
    const NX=15.5;
    k('70',NX,0);k('71',NX+1,0);k('73',NX+2,0);k('74',NX,1);k('75',NX+1,1);k('76',NX+2,1);
    k('77',NX,2);k('78',NX+1,2);k('79',NX+2,2);k('65',NX+1,4);k('63',NX,5);k('64',NX+1,5);k('66',NX+2,5);
    const NPX=19;
    k('20',NPX,1);k('21',NPX+1,1);k('22',NPX+2,1);k('7a',NPX+3,1);
    k('32',NPX,2);k('33',NPX+1,2);k('34',NPX+2,2);k('7b',NPX+3,2,1,2);
    k('44',NPX,3);k('45',NPX+1,3);k('46',NPX+2,3);
    k('56',NPX,4);k('57',NPX+1,4);k('58',NPX+2,4);k('6a',NPX+3,4,1,2);
    k('68',NPX,5,2);k('69',NPX+2,5);
    return keys;
})();
const PREVIEW_W=23, PREVIEW_H=7, U=10, KG=1.2, KR=1;

function _mountLayerAnimEditor(layer) {
    _layerAnimActive=true; animFrames=layer.frames;
    activeAnimFrame=layer._frameIdx||0;
    document.getElementById('timelineWrap').style.display='block';
    document.getElementById('animSettingsWrap').style.display='block';
    renderTimeline(); _updateAnimFrameCount();
    selectAnimFrame(activeAnimFrame); // updates duration input + highlights active frame
    _syncLayerAnimControls();
}
function _unmountLayerAnimEditor(fullyStop=false) {
    if(fullyStop){stopPreview();_stopAllLayerAnims();}
    _layerAnimActive=false; animFrames=[]; activeAnimFrame=-1;
    const el=document.getElementById('layerAnimControls'); if(el)el.style.display='none';
    document.getElementById('layerPlayControls').style.display='none';
    document.getElementById('animSettingsWrap').style.display='none';
    document.getElementById('timelineWrap').style.display='none';
}
function _syncLayerAnimControls() {
    const layer = getActiveLayer();
    const isAnimLayer = layer?.type === 'animation';
    const hasAnyAnim  = layers.some(l => l.type === 'animation' && l.enabled);

    // Play controls: show when active layer is animation OR composite view has any anim
    const showPlay = isAnimLayer || (layerViewMode === 'composite' && hasAnyAnim);
    const playEl = document.getElementById('layerPlayControls');
    if (playEl) playEl.style.display = showPlay ? 'block' : 'none';

    // animSettingsWrap is shown/hidden by _mountLayerAnimEditor directly

    // Update save name input
    const nameEl = document.getElementById('animNameInput');
    if (nameEl && layer) {
        nameEl.placeholder = layer.type === 'animation' ? 'Animation name...'
            : layer.type === 'reactive' ? 'Reactive preset name...' : 'Static preset name...';
        if (!nameEl.value || nameEl.value === nameEl._lastAuto) {
            nameEl.value = layer.name || '';
            nameEl._lastAuto = nameEl.value;
        }
    }

    // Sync loop checkbox removed — loop is always true
}

function renderTimeline() {
    const tl=document.getElementById('animTimeline'); if(!tl)return; tl.innerHTML='';
    (animFrames||[]).forEach((frame,i)=>{
        const thumb=document.createElement('div');
        thumb.className='frame-thumb'+(i===activeAnimFrame?' active-frame':'');
        thumb.dataset.frameIdx=i; thumb.draggable=true;
        thumb.innerHTML=`<div class="frame-preview" id="fp-${i}"></div><div class="frame-duration">${frame.duration}ms</div>`;
        thumb.onclick=()=>selectAnimFrame(i);
        let _dfSrc=null;
        thumb.addEventListener('dragstart',e=>{_dfSrc=i;thumb.classList.add('frame-dragging');e.dataTransfer.effectAllowed='move';});
        thumb.addEventListener('dragend',()=>{thumb.classList.remove('frame-dragging');tl.querySelectorAll('.frame-thumb').forEach(t=>t.classList.remove('frame-drag-over'));});
        thumb.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';tl.querySelectorAll('.frame-thumb').forEach(t=>t.classList.remove('frame-drag-over'));if(_dfSrc!==i)thumb.classList.add('frame-drag-over');});
        thumb.addEventListener('drop',e=>{e.preventDefault();if(_dfSrc===null||_dfSrc===i)return;const moved=animFrames.splice(_dfSrc,1)[0];animFrames.splice(i,0,moved);activeAnimFrame=i;_dfSrc=null;renderTimeline();});
        tl.appendChild(thumb); renderFramePreview(i);
    });
    const addBtn=document.createElement('button');
    addBtn.className='add-frame-btn';addBtn.textContent='+';addBtn.onclick=()=>addFrame();
    tl.appendChild(addBtn); _updateTotalDuration();
}
function renderFramePreview(frameIdx) {
    const fp=document.getElementById(`fp-${frameIdx}`); if(!fp)return; fp.innerHTML='';
    const colors=(animFrames[frameIdx]||{}).colors||{};
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox',`0 0 ${PREVIEW_W*U} ${PREVIEW_H*U}`);
    svg.setAttribute('width','100%');svg.setAttribute('height','100%');
    svg.setAttribute('preserveAspectRatio','xMidYMid meet');svg.style.display='block';
    PREVIEW_KEYS.forEach(({idx,x,y,w,h})=>{
        const c=colors[idx];
        const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');
        rect.setAttribute('x',x*U+KG/2);rect.setAttribute('y',y*U+KG/2);
        rect.setAttribute('width',w*U-KG);rect.setAttribute('height',h*U-KG);
        rect.setAttribute('rx',KR);rect.setAttribute('fill',c?`rgb(${c.r},${c.g},${c.b})`:'#1a1a22');
        svg.appendChild(rect);
    });
    fp.appendChild(svg);
}
function updateFrameThumb(frameIdx) { renderFramePreview(frameIdx); }
function _updateTotalDuration() { const el=document.getElementById('totalDurationLabel');if(el)el.textContent=(animFrames||[]).reduce((s,f)=>s+f.duration,0)+'ms total'; }
function _updateAnimFrameCount() { const el=document.getElementById('animFrameCount');if(el)el.textContent=`${(animFrames||[]).length} frame${(animFrames||[]).length!==1?'s':''}`; }

function addFrame(colors=null,duration=100) { if(!animFrames)return; animFrames.push({duration,colors:colors?Object.assign({},colors):{}}); renderTimeline();selectAnimFrame(animFrames.length-1);_updateAnimFrameCount(); }
function selectAnimFrame(idx) {
    activeAnimFrame=idx;
    const frame = animFrames[idx];
    const durEl=document.getElementById('frameDuration');
    if(durEl) durEl.value = frame?.duration ?? 100;
    document.querySelectorAll('.frame-thumb').forEach((el,i)=>el.classList.toggle('active-frame',i===idx));
    if(_layerAnimActive){const l=getActiveLayer();if(l)l._frameIdx=idx;}
    _refreshKeyboard();
}
function updateFrameDuration() {
    if(activeAnimFrame<0)return;
    const v=parseInt(document.getElementById('frameDuration')?.value)||100;
    animFrames[activeAnimFrame].duration=Math.max(50,v);
    const thumb=document.querySelectorAll('.frame-thumb')[activeAnimFrame];
    if(thumb)thumb.querySelector('.frame-duration').textContent=animFrames[activeAnimFrame].duration+'ms';
    _updateTotalDuration();
}
function duplicateFrame() { if(activeAnimFrame<0||!animFrames[activeAnimFrame]){if(typeof toast==='function')toast('No frame selected');return;} const f=animFrames[activeAnimFrame];animFrames.splice(activeAnimFrame+1,0,{duration:f.duration,colors:JSON.parse(JSON.stringify(f.colors))});renderTimeline();selectAnimFrame(activeAnimFrame+1);_updateAnimFrameCount(); }
function clearFrame()     { if(activeAnimFrame<0){if(typeof toast==='function')toast('No frame selected');return;} animFrames[activeAnimFrame].colors={};updateFrameThumb(activeAnimFrame);_refreshKeyboard();if(typeof toast==='function')toast('Frame cleared'); }
function deleteFrame()    { if(activeAnimFrame<0||!animFrames.length){if(typeof toast==='function')toast('No frame to delete');return;} animFrames.splice(activeAnimFrame,1);const na=Math.min(activeAnimFrame,animFrames.length-1);activeAnimFrame=-1;renderTimeline();if(animFrames.length>0)selectAnimFrame(na);_updateAnimFrameCount(); }
function copyFromMain()   { if(activeAnimFrame<0){if(typeof toast==='function')toast('Select a frame first');return;} if(typeof keyColors==='undefined')return; animFrames[activeAnimFrame].colors=JSON.parse(JSON.stringify(keyColors));updateFrameThumb(activeAnimFrame);_refreshKeyboard();if(typeof toast==='function')toast('Copied from main view'); }

// ── Playback ──────────────────────────────────────────────────────────────────
function _syncAllPlayBtns(playing) {
    ['playBtn','layerPlayBtn'].forEach(id=>{const btn=document.getElementById(id);if(!btn)return;btn.textContent=playing?'■ STOP':'▶ PLAY ANIMATION';btn.classList.toggle('playing',playing);});
}
// loop is always true on all animation layers
function togglePreview() {
    if(applyLayersActive||isPlaying){_stopAllPlayback();return;}
    // In composite view: preview all animation layers in the stack
    // In active layer view: preview the active animation layer
    const hasAnimLayers = layers.some(l=>l.type==='animation'&&l.enabled);
    if (!hasAnimLayers && (!animFrames||!animFrames.length)) {
        if(typeof toast==='function')toast('No animation layers to preview'); return;
    }
    isPlaying=true; _syncAllPlayBtns(true); _startAllLayerAnims(); _previewLoop();
}
function stopPreview() {
    _stopAllPlayback();
    _sendLayersSnapshot();
}
function _previewLoop() {
    if(!isPlaying)return;
    if(hasPyAPILayers()&&applyLayersActive){const merged=compositeLayers();const payload={};Object.entries(merged).forEach(([idx,{r,g,b}])=>{if(r||g||b)payload[idx]=[r,g,b];});window.pywebview.api.apply_frame(payload);}
    previewTimer=setTimeout(_previewLoop,35);
}

// ── Save / Load animations ────────────────────────────────────────────────────
let savedAnimations={};
let savedReactivePresets={};
async function saveCurrentLayer() {
    const layer = getActiveLayer();
    if (!layer) { if(typeof toast==='function') toast('No layer selected'); return; }
    const nameEl = document.getElementById('animNameInput');
    const name = nameEl?.value?.trim() || layer.name || 'layer';
    if (layer.type === 'animation') {
        const data = { name, version:1, loop:layer.loop!==false, frames:layer.frames.map(f=>({duration:f.duration,colors:f.colors||{}})) };
        if (hasPyAPILayers()) { const r=await window.pywebview.api.save_animation(name,data); if(r.ok){if(typeof toast==='function')toast(`Saved animation "${name}"`);await loadAnimationsFromDisk();}else if(typeof toast==='function')toast('Save failed: '+(r.message||'')); }
    } else if (layer.type === 'reactive') {
        const data = { name, version:1, ...LayerTypes.reactive.serialize(layer) };
        if (hasPyAPILayers()) { const r=await window.pywebview.api.save_reactive_preset(name,data); if(r.ok){if(typeof toast==='function')toast(`Saved reactive layer "${name}"`);await loadReactivePresetsFromDisk();}else if(typeof toast==='function')toast('Save failed: '+(r.message||'')); }
    } else if (layer.type === 'static') {
        const payload = {}; Object.entries(layer.colors||{}).forEach(([idx,{r,g,b}])=>{if(r||g||b)payload[idx]=[r,g,b];});
        if (hasPyAPILayers()) { const r=await window.pywebview.api.save_static_lighting(name,payload); if(r.ok){if(typeof toast==='function')toast(`Saved static layer "${name}"`);await loadStaticLightingsFromDisk();}else if(typeof toast==='function')toast('Save failed: '+(r.message||'')); }
    }
}
async function loadAnimationsFromDisk() {
    if(!hasPyAPILayers())return;
    const r=await window.pywebview.api.list_animations();if(!r.ok)return;
    savedAnimations={};r.animations.forEach(d=>{savedAnimations[d._filename]=d;});
    refreshLoadLayerList();
}
async function loadReactivePresetsFromDisk() {
    if(!hasPyAPILayers())return;
    const r=await window.pywebview.api.list_reactive_presets();if(!r.ok)return;
    savedReactivePresets={};r.presets.forEach(d=>{savedReactivePresets[d._filename]=d;});
    refreshLoadLayerList();
}

function refreshLoadLayerList() {
    const el = document.getElementById('loadLayerList');
    if (!el) return;
    const typeEl = document.getElementById('loadLayerTypeSelect');
    const type = typeEl?.value || 'static';

    let entries = [];
    if (type === 'static') {
        entries = Object.entries(typeof savedLightings!=='undefined' ? savedLightings : {})
            .map(([fname, data]) => ({ fname, name: data.name||fname, data, layerType: 'static' }));
    } else if (type === 'animation') {
        entries = Object.entries(savedAnimations)
            .map(([fname, data]) => ({ fname, name: data.name||fname, data, layerType: 'animation' }));
    } else if (type === 'reactive') {
        entries = Object.entries(savedReactivePresets)
            .map(([fname, data]) => ({ fname, name: data.name||fname, data, layerType: 'reactive' }));
    }

    el.innerHTML = '';
    if (!entries.length) {
        el.innerHTML = `<div style="font-size:0.6rem;color:var(--dim)">No saved ${type} layers</div>`;
        return;
    }
    entries.forEach(({ fname, name, data, layerType }) => {
        const item = document.createElement('div');
        item.className = 'saved-anim-item';
        const meta = layerType === 'animation' ? `${data.frames?.length||0}f`
                   : layerType === 'reactive'  ? (data.effect||'highlight')
                   : '';
        item.innerHTML = `
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${fname}">${name}</span>
            ${meta ? `<span style="font-size:0.58rem;color:var(--dim);flex-shrink:0">${meta}</span>` : ''}
            <button class="load-btn">ADD</button>
            <button class="del-btn">✕</button>`;
        item.querySelector('.load-btn').addEventListener('click', () => {
            addLayer(layerType, name, data);
        });
        item.querySelector('.del-btn').addEventListener('click', async () => {
            if (layerType === 'animation') {
                await window.pywebview.api.delete_animation(fname); await loadAnimationsFromDisk();
            } else if (layerType === 'reactive') {
                await window.pywebview.api.delete_reactive_preset(fname); await loadReactivePresetsFromDisk();
            } else {
                await window.pywebview.api.delete_static_lighting(fname);
                if (typeof loadStaticLightingsFromDisk === 'function') await loadStaticLightingsFromDisk();
            }
        });
        el.appendChild(item);
    });
}

// ── Open / close layers panel ─────────────────────────────────────────────────
function restoreMainKeyboard() {
    if(typeof keyColors!=='undefined'){Object.keys(keyEls).forEach(idx=>paintKey(idx,0,0,0));Object.entries(keyColors).forEach(([idx,{r,g,b}])=>paintKey(idx,r,g,b));}
}
function openLayersPanel() {
    layersPanelOpen=true;
    if(typeof activeMode!=='undefined')activeMode=_layersModeEntry;
    document.getElementById('staticLeft').style.display='none';
    document.getElementById('layersLeft').style.display='block';
    document.getElementById('staticRight').style.display='none';
    document.getElementById('layersRight').style.display='flex';
    document.getElementById('timelineWrap').style.display='none';
    document.getElementById('layerStripWrap').style.display='block';
    document.getElementById('staticHint').style.display='none';
    document.getElementById('layerHint').style.display='block';
    document.getElementById('layersPanelBtn')?.classList.add('active-mode');
    document.getElementById('layerViewComposite')?.classList.toggle('active-mode',layerViewMode==='composite');
    document.getElementById('layerViewSingle')?.classList.toggle('active-mode',layerViewMode==='layer');
    document.getElementById('leftViewComposite')?.classList.toggle('active-mode',layerViewMode==='composite');
    document.getElementById('leftViewSingle')?.classList.toggle('active-mode',layerViewMode==='layer');
    renderLayerStrip(); refreshLayerPickers(); loadLayerPresets(); loadAnimationsFromDisk(); loadReactivePresetsFromDisk();
    applyLayersActive=false;
    if(!layers.length)addLayer('static','Layer 1',{colors:{}});
    const active=getActiveLayer();
    if(active?.type==='animation')_mountLayerAnimEditor(active);
    _syncLayerAnimControls();
    _syncControlsToLayer(); // render settings for the already-selected layer
    if(typeof stopStaticStream==='function')stopStaticStream();
    _refreshKeyboard(); startCompositor(); _syncReactiveConfig();
}
function closeLayersPanel() {
    layersPanelOpen=false;
    if(typeof activeMode!=='undefined'&&typeof modes!=='undefined')activeMode=modes.static;
    if(_layerAnimActive)_unmountLayerAnimEditor(true);
    document.getElementById('staticLeft').style.display='block';
    document.getElementById('layersLeft').style.display='none';
    document.getElementById('staticRight').style.display='block';
    document.getElementById('layersRight').style.display='none';
    document.getElementById('timelineWrap').style.display='none';
    document.getElementById('layerStripWrap').style.display='none';
    document.getElementById('staticHint').style.display='block';
    document.getElementById('layerHint').style.display='none';
    document.getElementById('layersPanelBtn')?.classList.remove('active-mode');
    const rs=document.getElementById('reactiveStripWrap');if(rs)rs.style.display='none';
    deactivateEraser(); restoreMainKeyboard();
    _reactiveSynced=false; stopCompositor(); _stopAllPlayback();
    if(typeof startStaticStream==='function')startStaticStream();
}
function toggleLayersPanel() { layersPanelOpen?closeLayersPanel():openLayersPanel(); }

// ── Push to keyboard ──────────────────────────────────────────────────────────
function _buildDriverLayers() {
    return layers.filter(l => l.enabled).map(l => {
        const base = { type: l.type, opacity: (l.opacity ?? 100) / 100 };
        if (l.type === 'static') {
            const colors = {};
            Object.entries(l.colors || {}).forEach(([idx, c]) => { colors[idx] = [c.r, c.g, c.b]; });
            base.colors = colors;
        } else if (l.type === 'animation') {
            base.loop   = l.loop !== false;
            base.frames = (l.frames || []).map(f => {
                const colors = {};
                Object.entries(f.colors || {}).forEach(([idx, c]) => {
                    colors[idx] = Array.isArray(c) ? c : [c.r, c.g, c.b];
                });
                return { duration: f.duration || 100, colors };
            });
        } else if (l.type === 'reactive') {
            base.effect            = l.effect || 'highlight';
            base.colors            = {};
            Object.entries(l.colors || {}).forEach(([idx, c]) => { base.colors[idx] = [c.r, c.g, c.b]; });
            base.rainbow           = !!l.rainbow;
            base.holdMode          = l.holdMode || 'fade';
            base.fadeDuration      = l.fadeDuration ?? 500;
            base.rippleHoldMode    = l.rippleHoldMode ?? 'once';
            base.rippleSpeed       = l.rippleSpeed ?? 8.0;
            base.rippleWidth       = l.rippleWidth ?? 1.2;
            base.fallDuration      = l.fallDuration ?? 600;
            base.trailLength       = l.trailLength ?? 3.0;
            base.sitDuration       = l.sitDuration ?? 200;
            base.lightningHoldMode = l.lightningHoldMode ?? 'once';
        }
        return base;
    });
}

async function _syncLayerConfig(enabled) {
    if (!hasPyAPILayers()) return;
    if (!enabled) {
        try { await window.pywebview.api.update_layer_config([], false); } catch(e) {}
        return;
    }
    try { await window.pywebview.api.update_layer_config(_buildDriverLayers(), true); } catch(e) {}
}

function pushLayersToKeyboard() {
    setLayerViewMode('composite');
    const needsStream = layers.some(l => l.enabled && (l.type==='animation' || l.type==='reactive'));
    if (needsStream) {
        applyLayersActive = true;
        _startAllLayerAnims();
        stopCompositor(); startCompositor();
        _syncAllPlayBtns(true);
        _syncReactiveConfig(); // keep reactive poller working for UI preview
        _syncLayerConfig(true); // driver handles hardware output
        if (typeof toast === 'function') toast('⚡ Layers streaming to keyboard');
    } else {
        applyLayersActive = false;
        _syncLayerConfig(false);
        _sendLayersSnapshot();
        if (typeof toast === 'function') toast('⚡ Layers applied (static)');
    }
    if (hasPyAPILayers()) window.pywebview.api.save_current_layers(_serializeLayers(), document.getElementById('layerPresetNameInput')?.value?.trim() || null);
}