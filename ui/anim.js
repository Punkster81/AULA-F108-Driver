// ── Animation state ───────────────────────────────────────────────────────────
let animFrames = [];       // [{duration:ms, colors:{idx:{r,g,b}}}]
let activeAnimFrame = -1;
let previewTimer = null;
let previewFrameIdx = 0;
let isPlaying = false;
let animPaintColor = { r: 255, g: 0, b: 0 };

// ── Anim painting — operates directly on the main keyboard ───────────────────

// Called by main.js onKeyDown/onKeyPaint when animModeActive is true.
function animPaintKey(idx) {
    if (activeAnimFrame < 0) { toast('Select a frame first'); return; }
    const { r, g, b } = animPaintColor;
    if (!animFrames[activeAnimFrame].colors) animFrames[activeAnimFrame].colors = {};
    animFrames[activeAnimFrame].colors[idx] = { r, g, b };
    paintKey(idx, r, g, b);
    updateFrameThumb(activeAnimFrame);
}

// Load a frame's colors onto the main keyboard.
function loadFrameIntoMain(frameIdx) {
    Object.keys(keyEls).forEach(idx => paintKey(idx, 0, 0, 0));
    if (frameIdx < 0 || !animFrames[frameIdx]) return;
    const colors = animFrames[frameIdx].colors || {};
    Object.entries(colors).forEach(([idx, { r, g, b }]) => paintKey(idx, r, g, b));
}

// Restore static keyColors to main keyboard when exiting anim mode.
function restoreMainKeyboard() {
    Object.keys(keyEls).forEach(idx => paintKey(idx, 0, 0, 0));
    Object.entries(keyColors).forEach(([idx, { r, g, b }]) => paintKey(idx, r, g, b));
}


// ── Frame management ──────────────────────────────────────────────────────────
function addFrame(colors = null, duration = 100) {
    animFrames.push({ duration, colors: colors ? Object.assign({}, colors) : {} });
    const newIdx = animFrames.length - 1;
    renderTimeline();
    selectAnimFrame(newIdx);
    updateAnimFrameCount();
}

function selectAnimFrame(idx) {
    activeAnimFrame = idx;
    document.getElementById('frameDuration').value = animFrames[idx]?.duration ?? 100;
    loadFrameIntoMain(idx);
    document.querySelectorAll('.frame-thumb').forEach((el, i) => {
        el.classList.toggle('active-frame', i === idx);
    });
}

function updateFrameDuration() {
    if (activeAnimFrame < 0) return;
    const v = parseInt(document.getElementById('frameDuration').value) || 100;
    animFrames[activeAnimFrame].duration = Math.max(50, v);
    const thumbs = document.querySelectorAll('.frame-thumb');
    if (thumbs[activeAnimFrame]) {
        thumbs[activeAnimFrame].querySelector('.frame-duration').textContent = animFrames[activeAnimFrame].duration + 'ms';
    }
    updateTotalDuration();
}

function duplicateFrame() {
    if (activeAnimFrame < 0 || !animFrames[activeAnimFrame]) { toast('No frame selected'); return; }
    const f = animFrames[activeAnimFrame];
    animFrames.splice(activeAnimFrame + 1, 0, { duration: f.duration, colors: JSON.parse(JSON.stringify(f.colors)) });
    renderTimeline();
    selectAnimFrame(activeAnimFrame + 1);
    updateAnimFrameCount();
}

function clearFrame() {
    if (activeAnimFrame < 0) { toast('No frame selected'); return; }
    animFrames[activeAnimFrame].colors = {};
    loadFrameIntoMain(activeAnimFrame);
    updateFrameThumb(activeAnimFrame);
    toast('Frame cleared');
}

function deleteFrame() {
    if (activeAnimFrame < 0 || animFrames.length === 0) { toast('No frame to delete'); return; }
    animFrames.splice(activeAnimFrame, 1);
    const newActive = Math.min(activeAnimFrame, animFrames.length - 1);
    activeAnimFrame = -1;
    renderTimeline();
    if (animFrames.length > 0) selectAnimFrame(newActive);
    updateAnimFrameCount();
}

function copyFromMain() {
    if (activeAnimFrame < 0) { toast('Select a frame first'); return; }
    animFrames[activeAnimFrame].colors = JSON.parse(JSON.stringify(keyColors));
    loadFrameIntoMain(activeAnimFrame);
    updateFrameThumb(activeAnimFrame);
    toast('Copied from main view');
}

// ── Timeline rendering ────────────────────────────────────────────────────────
function renderTimeline() {
    const tl = document.getElementById('animTimeline');
    // Keep the add button, rebuild frame thumbs
    tl.innerHTML = '';
    animFrames.forEach((frame, i) => {
        const thumb = document.createElement('div');
        thumb.className = 'frame-thumb' + (i === activeAnimFrame ? ' active-frame' : '');
        thumb.dataset.frameIdx = i;
        thumb.innerHTML = `
  <div class="frame-preview" id="fp-${i}"></div>
  <div class="frame-duration">${frame.duration}ms</div>
`;
        thumb.onclick = () => selectAnimFrame(i);
        tl.appendChild(thumb);
        renderFramePreview(i);
    });
    const addBtn = document.createElement('button');
    addBtn.className = 'add-frame-btn';
    addBtn.textContent = '+';
    addBtn.onclick = () => addFrame();
    tl.appendChild(addBtn);
    updateTotalDuration();
}

// Key layout for frame preview SVG — full F108 Pro layout in unit coordinates
const U = 10;   // pixels per unit
const KG = 1.2; // gap between keys
const KR = 1;   // corner radius

const PREVIEW_KEYS = (() => {
    const keys = [];
    const k = (idx, x, y, w=1, h=1) => keys.push({idx, x, y, w, h});

    // Row 0 — Fn row: ESC | F1-F4 | F5-F8 | F9-F12
    k('01', 0,    0);
    k('02', 1.25, 0); k('03', 2.25, 0); k('04', 3.25, 0); k('05', 4.25, 0);
    k('06', 5.5,  0); k('07', 6.5,  0); k('08', 7.5,  0); k('09', 8.5,  0);
    k('0a', 9.75, 0); k('0b',10.75, 0); k('0c',11.75, 0); k('0d',12.75, 0);

    // Row 1 — number row
    k('13', 0,1); k('14',1,1); k('15',2,1); k('16',3,1); k('17',4,1);
    k('18', 5,1); k('19',6,1); k('1a',7,1); k('1b',8,1); k('1c',9,1);
    k('1d',10,1); k('1e',11,1); k('1f',12,1); k('67',13,1,2);

    // Row 2 — QWERTY
    k('25', 0,   2, 1.5);
    k('26', 1.5, 2); k('27', 2.5, 2); k('28', 3.5, 2); k('29', 4.5, 2);
    k('2a', 5.5, 2); k('2b', 6.5, 2); k('2c', 7.5, 2); k('2d', 8.5, 2);
    k('2e', 9.5, 2); k('2f',10.5, 2); k('30',11.5, 2); k('31',12.5, 2);
    k('43',13.5, 2, 1.5);

    // Row 3 — ASDF
    k('37', 0,   3, 1.75);
    k('38', 1.75,3); k('39', 2.75,3); k('3a', 3.75,3); k('3b', 4.75,3);
    k('3c', 5.75,3); k('3d', 6.75,3); k('3e', 7.75,3); k('3f', 8.75,3);
    k('40', 9.75,3); k('41',10.75,3); k('42',11.75,3);
    k('55',12.75, 3, 2.25);

    // Row 4 — ZXCV
    k('49', 0,    4, 2.25);
    k('4a', 2.25, 4); k('4b', 3.25, 4); k('4c', 4.25, 4); k('4d', 5.25, 4);
    k('4e', 6.25, 4); k('4f', 7.25, 4); k('50', 8.25, 4); k('51', 9.25, 4);
    k('52',10.25, 4); k('53',11.25, 4);
    k('54',12.25, 4, 2.75);

    // Row 5 — bottom row
    k('5b', 0,    5, 1.5);
    k('5c', 1.5,  5);
    k('5d', 2.5,  5, 1.5);
    k('5e', 4,    5, 6.5);
    k('5f',10.5,  5);
    k('60',11.5,  5);
    k('61',12.5,  5);
    k('62',13.5,  5, 1.5);

    // Nav cluster — gap at X=15.5
    const NX = 15.5;
    k('70',NX+0,0); k('71',NX+1,0); k('73',NX+2,0); // PRT SCR PAUSE
    k('74',NX+0,1); k('75',NX+1,1); k('76',NX+2,1); // INS HOM PGU
    k('77',NX+0,2); k('78',NX+1,2); k('79',NX+2,2); // DEL END PGD
    // row 3 blank
    k('65',NX+1,4);                                   // UP (row 4, was 3 — but SVG rows are 0-based so shift +1 vs NAV grid)
    k('63',NX+0,5); k('64',NX+1,5); k('66',NX+2,5); // L DN R

    // Numpad — gap at X=19
    const NPX = 19;
    k('20',NPX+0,1); k('21',NPX+1,1); k('22',NPX+2,1); k('7a',NPX+3,1);       // NUM / * -
    k('32',NPX+0,2); k('33',NPX+1,2); k('34',NPX+2,2); k('7b',NPX+3,2,1,2);  // 7 8 9 +
    k('44',NPX+0,3); k('45',NPX+1,3); k('46',NPX+2,3);                         // 4 5 6
    k('56',NPX+0,4); k('57',NPX+1,4); k('58',NPX+2,4); k('6a',NPX+3,4,1,2);  // 1 2 3 ENTER
    k('68',NPX+0,5,2);                k('69',NPX+2,5);                          // 0 .

    return keys;
})();

const PREVIEW_TOTAL_W = 23; // total units wide
const PREVIEW_TOTAL_H = 7;  // total units tall (6 rows + extra gap in nav cluster)

function renderFramePreview(frameIdx) {
    const fp = document.getElementById(`fp-${frameIdx}`);
    if (!fp) return;
    fp.innerHTML = '';
    const colors = animFrames[frameIdx].colors || {};

    const svgW = PREVIEW_TOTAL_W * U;
    const svgH = PREVIEW_TOTAL_H * U;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.display = 'block';

    PREVIEW_KEYS.forEach(({idx, x, y, w, h}) => {
        const c = colors[idx];
        const fill = c ? `rgb(${c.r},${c.g},${c.b})` : '#1a1a22';
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x',      x * U + KG / 2);
        rect.setAttribute('y',      y * U + KG / 2);
        rect.setAttribute('width',  w * U - KG);
        rect.setAttribute('height', h * U - KG);
        rect.setAttribute('rx', KR);
        rect.setAttribute('fill', fill);
        svg.appendChild(rect);
    });

    fp.appendChild(svg);
}

function updateFrameThumb(frameIdx) {
    renderFramePreview(frameIdx);
}

function updateAnimFrameCount() {
    document.getElementById('animFrameCount').textContent = `${animFrames.length} frame${animFrames.length !== 1 ? 's' : ''}`;
}

function updateTotalDuration() {
    const total = animFrames.reduce((s, f) => s + f.duration, 0);
    document.getElementById('totalDurationLabel').textContent = total + 'ms total';
}

// ── Playback (preview in mini keyboard) ──────────────────────────────────────
function togglePreview() {
    if (isPlaying) stopPreview();
    else startPreview();
}

function startPreview() {
    if (animFrames.length === 0) { toast('No frames to preview'); return; }
    isPlaying = true;
    previewFrameIdx = 0;
    document.getElementById('playBtn').textContent = '■ STOP';
    document.getElementById('playBtn').classList.add('playing');
    playNextFrame();
}

function stopPreview() {
    isPlaying = false;
    clearTimeout(previewTimer);
    document.getElementById('playBtn').textContent = '▶ PREVIEW';
    document.getElementById('playBtn').classList.remove('playing');
    document.getElementById('playStatus').textContent = 'Stopped';
    if (activeAnimFrame >= 0) loadFrameIntoMain(activeAnimFrame);
}

function playNextFrame() {
    if (!isPlaying) return;
    if (previewFrameIdx >= animFrames.length) {
        if (document.getElementById('loopAnim').checked) previewFrameIdx = 0;
        else { stopPreview(); return; }
    }
    const frame = animFrames[previewFrameIdx];
    document.getElementById('playStatus').textContent = `Frame ${previewFrameIdx + 1}/${animFrames.length}`;
    loadFrameIntoMain(previewFrameIdx);
    if (window.pywebview && window.pywebview.api) {
        const payload = {};
        Object.entries(frame.colors || {}).forEach(([idx, { r, g, b }]) => {
            if (r || g || b) payload[idx] = [r, g, b];
        });
        window.pywebview.api.apply_frame(payload);
    }
    previewFrameIdx++;
    previewTimer = setTimeout(playNextFrame, frame.duration);
}

// ── Active animation (runs on keyboard, independent of screen preview) ────────
let activeAnimTimer = null;
let activeAnimFrameIdx = 0;
let isActiveAnim = false;

async function setAsActiveAnimation() {
    if (animFrames.length === 0) { toast('No frames to activate'); return; }

    // Save as current_animation.json
    const name = document.getElementById('animNameInput').value.trim() || 'animation';
    const data = {
        name,
        version: 1,
        created: new Date().toISOString(),
        loop: true,
        frames: animFrames.map(f => ({
            duration: f.duration,
            colors: Object.fromEntries(
                Object.entries(f.colors).map(([idx, { r, g, b }]) => [idx, { r, g, b }])
            )
        }))
    };

    if (window.pywebview && window.pywebview.api) {
        await window.pywebview.api.save_current_animation(data);
    }

    startActiveAnim();
}

function startActiveAnim() {
    stopActiveAnim();
    isActiveAnim = true;
    activeAnimFrameIdx = 0;
    document.getElementById('activeAnimBtn').textContent = '■ STOP ACTIVE';
    document.getElementById('activeAnimBtn').classList.add('playing');
    document.getElementById('activeAnimStatus').textContent = 'Running on keyboard';
    runActiveAnimFrame();
}

function stopActiveAnim() {
    isActiveAnim = false;
    clearTimeout(activeAnimTimer);
    const btn = document.getElementById('activeAnimBtn');
    if (btn) { btn.textContent = '▶ SET AS ACTIVE'; btn.classList.remove('playing'); }
    const status = document.getElementById('activeAnimStatus');
    if (status) status.textContent = '';
}

function runActiveAnimFrame() {
    if (!isActiveAnim || animFrames.length === 0) return;
    if (activeAnimFrameIdx >= animFrames.length) activeAnimFrameIdx = 0;
    const frame = animFrames[activeAnimFrameIdx];
    if (window.pywebview && window.pywebview.api) {
        const payload = {};
        Object.entries(frame.colors || {}).forEach(([idx, { r, g, b }]) => {
            if (r || g || b) payload[idx] = [r, g, b];
        });
        window.pywebview.api.apply_frame(payload);
    }
    activeAnimFrameIdx++;
    activeAnimTimer = setTimeout(runActiveAnimFrame, frame.duration);
}


async function saveAnimation() {
    const name = document.getElementById('animNameInput').value.trim() || 'animation';
    if (animFrames.length === 0) { toast('No frames to save'); return; }
    const data = {
        name,
        version: 1,
        created: new Date().toISOString(),
        loop: document.getElementById('loopAnim').checked,
        frames: animFrames.map(f => ({
            duration: f.duration,
            colors: Object.fromEntries(
                Object.entries(f.colors).map(([idx, { r, g, b }]) => [idx, { r, g, b }])
            )
        }))
    };

    if (window.pywebview && window.pywebview.api) {
        const r = await window.pywebview.api.save_animation(name, data);
        if (r.ok) {
            toast(`Saved "${name}" to animations/`);
            await loadAnimationsFromDisk();
        } else {
            toast('Save failed: ' + (r.message || 'unknown error'));
        }
    } else {
        // Fallback: browser download in demo mode
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase() + '.json';
        a.click();
        toast(`Saved "${name}"`);
    }
}

let savedAnimations = {};

async function loadAnimationsFromDisk() {
    if (!window.pywebview || !window.pywebview.api) return;
    const r = await window.pywebview.api.list_animations();
    if (!r.ok) return;
    savedAnimations = {};
    r.animations.forEach(data => {
        savedAnimations[data._filename] = data;
    });
    renderSavedList();
}

function loadAnimationFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const data = JSON.parse(e.target.result);
            loadAnimationData(data);
            toast(`Loaded "${data.name || file.name}"`);
        } catch (err) {
            toast('Error reading file: ' + err.message);
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

function loadAnimationData(data) {
    animFrames = (data.frames || []).map(f => ({
        duration: f.duration || 100,
        colors: f.colors || {}
    }));
    document.getElementById('animNameInput').value = data.name || '';
    document.getElementById('loopAnim').checked = data.loop !== false;
    activeAnimFrame = -1;
    renderTimeline();
    if (animFrames.length > 0) selectAnimFrame(0);
    updateAnimFrameCount();
}

async function deleteAnimation(filename) {
    if (!window.pywebview || !window.pywebview.api) return;
    await window.pywebview.api.delete_animation(filename);
    await loadAnimationsFromDisk();
}

function renderSavedList() {
    const el = document.getElementById('savedAnimList');
    el.innerHTML = '';
    const entries = Object.entries(savedAnimations);
    if (entries.length === 0) {
        el.innerHTML = '<div style="font-size:0.6rem;color:var(--dim)">No saved animations</div>';
        return;
    }
    entries.forEach(([filename, data]) => {
        const name = data.name || filename;
        const item = document.createElement('div');
        item.className = 'saved-anim-item';
        item.innerHTML = `
  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${filename}">${name}</span>
  <span style="font-size:0.58rem;color:var(--dim);flex-shrink:0">${data.frames?.length || 0}f</span>
  <button class="load-btn">LOAD</button>
  <button class="del-btn">✕</button>
`;
        item.querySelector('.load-btn').addEventListener('click', () => loadAnimationData(data));
        item.querySelector('.del-btn').addEventListener('click', () => deleteAnimation(filename));
        el.appendChild(item);
    });
}

// ── Python export for animation ───────────────────────────────────────────────

// ── Anim mode toggle (inline, no overlay) ────────────────────────────────────
let animModeActive = false;

function openAnimPanel() {
    animModeActive = true;
    setPaintMode(true);
    document.getElementById('staticLeft').style.display = 'none';
    document.getElementById('animLeft').style.display = 'block';
    document.getElementById('timelineWrap').style.display = 'block';
    document.getElementById('staticHint').style.display = 'none';
    document.getElementById('animHint').style.display = 'block';
    document.getElementById('staticRight').style.display = 'none';
    document.getElementById('animRight').style.display = 'flex';
    const btn = document.getElementById('animToggleBtn');
    if (btn) { btn.textContent = '✕ EXIT ANIMATIONS'; btn.style.cssText = 'border-color:#ff4444;color:#ff4444'; }
    // Show active frame on keyboard, or clear it
    if (activeAnimFrame >= 0) loadFrameIntoMain(activeAnimFrame);
    else Object.keys(keyEls).forEach(idx => paintKey(idx, 0, 0, 0));
    loadAnimationsFromDisk();
}

function closeAnimPanel() {
    animModeActive = false;
    setPaintMode(false);
    stopPreview();
    stopActiveAnim();
    document.getElementById('staticLeft').style.display = 'block';
    document.getElementById('animLeft').style.display = 'none';
    document.getElementById('timelineWrap').style.display = 'none';
    document.getElementById('staticHint').style.display = 'block';
    document.getElementById('animHint').style.display = 'none';
    document.getElementById('staticRight').style.display = 'block';
    document.getElementById('animRight').style.display = 'none';
    const btn = document.getElementById('animToggleBtn');
    if (btn) { btn.textContent = '🎬 ANIMATIONS'; btn.style.cssText = 'border-color:var(--accent2);color:var(--accent2)'; }
    restoreMainKeyboard();
}

function toggleAnimPanel() {
    animModeActive ? closeAnimPanel() : openAnimPanel();
}

// Inject the toggle button into the toolbar once DOM is ready
(function injectAnimBtn() {
    const toolbar = document.querySelector('.kb-toolbar');
    if (!toolbar) { setTimeout(injectAnimBtn, 50); return; }
    const btn = document.createElement('button');
    btn.id = 'animToggleBtn';
    btn.className = 'tb-btn';
    btn.style.cssText = 'border-color:var(--accent2);color:var(--accent2)';
    btn.textContent = '🎬 ANIMATIONS';
    btn.onclick = toggleAnimPanel;
    toolbar.insertBefore(btn, toolbar.querySelector('.selection-info'));
})();

document.addEventListener('DOMContentLoaded', () => {
    const animPicker = document.getElementById('animColorPicker');
    const previewBlock = document.getElementById('animColorPreviewBlock');
    if (!animPicker) return;
    animPicker.addEventListener('input', () => {
        const hex = animPicker.value;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        animPaintColor = { r, g, b };
        if (previewBlock) previewBlock.style.background = hex;
        // Keep main color picker + anim RGB inputs in sync
        if (typeof setColorHex === 'function') setColorHex(hex);
    });
});

// Start with one empty frame
addFrame();