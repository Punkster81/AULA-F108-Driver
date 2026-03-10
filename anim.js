// ── Animation state ───────────────────────────────────────────────────────────
let animFrames = [];       // [{duration:ms, colors:{idx:{r,g,b}}}]
let activeAnimFrame = -1;
let previewTimer = null;
let previewFrameIdx = 0;
let isPlaying = false;
let animPaintColor = { r: 255, g: 0, b: 0 };

// ── Mini keyboard ─────────────────────────────────────────────────────────────
const miniKeyEls = {};
const MK_SIZES = { 'key-15': 'mk-15', 'key-175': 'mk-175', 'key-2': 'mk-2', 'key-225': 'mk-225', 'key-275': 'mk-275' };
(function buildMiniKb() {
    const mk = document.getElementById('miniKeyboard');

    function makeMiniKey(label, idx, cls) {
        const sz = MK_SIZES[cls] || '';
        const k = document.createElement('div');
        k.className = 'mini-key ' + sz;
        k.dataset.idx = idx;
        k.innerHTML = `<span>${label}</span>`;
        k.addEventListener('mousedown', e => { e.preventDefault(); miniPaintKey(idx); miniPainting = true; });
        k.addEventListener('mouseenter', () => { if (miniPainting) miniPaintKey(idx); });
        miniKeyEls[idx] = k;
        return k;
    }

    // Wrapper: main + nav + numpad
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:5px;align-items:flex-start';

    const mainB = document.createElement('div');
    mainB.style.cssText = 'display:flex;flex-direction:column;gap:3px';
    ROWS.forEach(row => {
        const rowEl = document.createElement('div');
        rowEl.className = 'kb-row';
        row.forEach(([label, idx, cls]) => {
            if (!idx) {
                const sp = document.createElement('div');
                sp.className = 'mini-key mk-spacer ' + (MK_SIZES[cls] || 'mk-spacer');
                rowEl.appendChild(sp); return;
            }
            rowEl.appendChild(makeMiniKey(label, idx, cls));
        });
        mainB.appendChild(rowEl);
    });
    wrap.appendChild(mainB);

    // Mini nav cluster
    const navB = document.createElement('div');
    navB.style.cssText = 'display:grid;grid-template-columns:repeat(3,22px);grid-template-rows:repeat(5,22px);gap:3px';
    NAV.forEach(([label, idx, col, row]) => {
        const k = makeMiniKey(label, idx, '');
        k.style.gridColumn = col;
        k.style.gridRow = row;
        navB.appendChild(k);
    });
    wrap.appendChild(navB);

    // Mini numpad grid
    const numB = document.createElement('div');
    numB.style.cssText = 'display:grid;grid-template-columns:repeat(4,22px);grid-template-rows:repeat(5,22px);gap:3px;align-self:flex-end';
    let nc = 1, nr = 1;
    NUMPAD.forEach(([label, idx, cs, rs]) => {
        if (!idx) { nc += cs; if (nc > 4) { nc = 1; nr++; } return; }
        const k = makeMiniKey(label, idx, '');
        k.style.gridColumn = `${nc}/span ${cs}`;
        k.style.gridRow = `${nr}/span ${rs}`;
        if (rs > 1) k.style.height = `${rs * 22 + (rs - 1) * 3}px`;
        if (cs > 1) k.style.minWidth = `${cs * 22 + (cs - 1) * 3}px`;
        numB.appendChild(k);
        nc += cs; if (nc > 4) { nc = 1; nr++; }
    });
    wrap.appendChild(numB);
    mk.appendChild(wrap);

    document.addEventListener('mouseup', () => { miniPainting = false; });
})();
let miniPainting = false;

function miniPaintKey(idx) {
    if (activeAnimFrame < 0) { toast('Select a frame first'); return; }

    const { r, g, b } = animPaintColor;

    if (!animFrames[activeAnimFrame].colors)
        animFrames[activeAnimFrame].colors = {};

    animFrames[activeAnimFrame].colors[idx] = { r, g, b };

    renderMiniKey(idx, r, g, b);
    updateFrameThumb(activeAnimFrame);
    updateAnimPyOutput();
    updateTotalDuration();
}

function renderMiniKey(idx, r, g, b) {
    const k = miniKeyEls[idx];
    if (!k) return;
    if (r === 0 && g === 0 && b === 0) {
        k.style.setProperty('--key-color', 'transparent');
        k.classList.remove('lit');
    } else {
        k.style.setProperty('--key-color', `rgb(${r},${g},${b})`);
        k.classList.add('lit');
    }
}

function loadFrameIntoMini(frameIdx) {
    // Clear all mini keys
    Object.keys(miniKeyEls).forEach(idx => renderMiniKey(idx, 0, 0, 0));
    if (frameIdx < 0 || !animFrames[frameIdx]) return;
    const colors = animFrames[frameIdx].colors || {};
    Object.entries(colors).forEach(([idx, { r, g, b }]) => renderMiniKey(idx, r, g, b));
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
    loadFrameIntoMini(idx);
    document.querySelectorAll('.frame-thumb').forEach((el, i) => {
        el.classList.toggle('active-frame', i === idx);
    });
}

function updateFrameDuration() {
    if (activeAnimFrame < 0) return;
    const v = parseInt(document.getElementById('frameDuration').value) || 100;
    animFrames[activeAnimFrame].duration = Math.max(16, v);
    const thumbs = document.querySelectorAll('.frame-thumb');
    if (thumbs[activeAnimFrame]) {
        thumbs[activeAnimFrame].querySelector('.frame-duration').textContent = animFrames[activeAnimFrame].duration + 'ms';
    }
    updateTotalDuration();
    updateAnimPyOutput();
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
    loadFrameIntoMini(activeAnimFrame);
    updateFrameThumb(activeAnimFrame);
    updateAnimPyOutput();
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
    updateAnimPyOutput();
}

function copyFromMain() {
    if (activeAnimFrame < 0) { toast('Select a frame first'); return; }
    animFrames[activeAnimFrame].colors = JSON.parse(JSON.stringify(keyColors));
    loadFrameIntoMini(activeAnimFrame);
    updateFrameThumb(activeAnimFrame);
    updateAnimPyOutput();
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

function renderFramePreview(frameIdx) {
    const fp = document.getElementById(`fp-${frameIdx}`);
    if (!fp) return;
    fp.innerHTML = '';
    // Show a representative sample of keys as tiny pixels
    const sampleIdxs = LED_ORDER.slice(0, 32);
    const colors = animFrames[frameIdx].colors || {};
    sampleIdxs.forEach(idx => {
        const c = colors[idx];
        const px = document.createElement('div');
        px.className = 'frame-pixel';
        px.style.background = c ? `rgb(${c.r},${c.g},${c.b})` : 'var(--key-off)';
        fp.appendChild(px);
    });
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
    // Restore active frame
    if (activeAnimFrame >= 0) loadFrameIntoMini(activeAnimFrame);
}

function playNextFrame() {
    if (!isPlaying) return;
    if (previewFrameIdx >= animFrames.length) {
        if (document.getElementById('loopAnim').checked) previewFrameIdx = 0;
        else { stopPreview(); return; }
    }
    const frame = animFrames[previewFrameIdx];
    document.getElementById('playStatus').textContent = `Frame ${previewFrameIdx + 1}/${animFrames.length}`;
    loadFrameIntoMini(previewFrameIdx);
    previewFrameIdx++;
    previewTimer = setTimeout(playNextFrame, frame.duration);
}

// ── Save / Load JSON ──────────────────────────────────────────────────────────
function saveAnimation() {
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
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase() + '.json';
    a.click();
    toast(`Saved "${name}"`);
    // Also store in memory for quick reload
    savedAnimations[name] = data;
    renderSavedList();
}

let savedAnimations = {};

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
    updateAnimPyOutput();
    savedAnimations[data.name] = data;
    renderSavedList();
}

function renderSavedList() {
    const el = document.getElementById('savedAnimList');
    el.innerHTML = '';
    Object.entries(savedAnimations).forEach(([name, data]) => {
        const item = document.createElement('div');
        item.className = 'saved-anim-item';
        item.innerHTML = `
  <span style="flex:1">${name}</span>
  <span style="font-size:0.58rem;color:var(--dim)">${data.frames?.length || 0}f</span>
  <button class="load-btn" onclick="loadAnimationData(savedAnimations['${name}'])">LOAD</button>
  <button class="del-btn" onclick="delete savedAnimations['${name}'];renderSavedList()">✕</button>
`;
        el.appendChild(item);
    });
}

// ── Python export for animation ───────────────────────────────────────────────
function updateAnimPyOutput() {
    if (animFrames.length === 0) {
        document.getElementById('animPyOutput').value = '# No frames yet';
        return;
    }
    const lines = [
        'import json, time',
        'from aula_f108_pro_final import AulaF108Pro',
        '',
        '# Load animation from JSON file',
        "with open('my_animation.json') as f:",
        '    anim = json.load(f)',
        '',
        'kb = AulaF108Pro()',
        'kb.connect()',
        'kb.start()',
        '',
        'try:',
        '    while True:  # loop',
        '        for frame in anim["frames"]:',
        '            kb.clear()',
        '            for idx_str, c in frame["colors"].items():',
        '                kb.set_index(int(idx_str, 16), c["r"], c["g"], c["b"])',
        '            time.sleep(frame["duration"] / 1000)',
        'except KeyboardInterrupt:',
        '    pass',
        '',
        'kb.disconnect()',
    ];
    document.getElementById('animPyOutput').value = lines.join('\n');
}

function copyAnimPython() {
    navigator.clipboard.writeText(document.getElementById('animPyOutput').value)
        .then(() => toast('Copied!'));
}

// ── Panel open/close ──────────────────────────────────────────────────────────
function openAnimPanel() {
    document.getElementById('animPanel').classList.add('open');
    updateAnimPyOutput();
}
function closeAnimPanel() {
    stopPreview();
    document.getElementById('animPanel').classList.remove('open');
}

// Add animation button to toolbar after DOM ready
document.addEventListener('DOMContentLoaded', () => { }, false);
(function injectAnimBtn() {
    const toolbar = document.querySelector('.kb-toolbar');
    if (!toolbar) { setTimeout(injectAnimBtn, 50); return; }
    const btn = document.createElement('button');
    btn.className = 'tb-btn';
    btn.style.cssText = 'border-color:var(--accent2);color:var(--accent2)';
    btn.textContent = '🎬 ANIMATIONS';
    btn.onclick = openAnimPanel;
    toolbar.insertBefore(btn, toolbar.querySelector('.selection-info'));
})();

document.addEventListener('DOMContentLoaded', () => {

    const animPicker = document.getElementById('animColorPicker');
    const animPreview = document.getElementById('animColorPreview');

    if (!animPicker) return;

    animPicker.addEventListener('input', () => {
        const hex = animPicker.value;

        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);

        animPaintColor = { r, g, b };

        if (animPreview)
            animPreview.style.background = hex;
    });

});

// Start with one empty frame
addFrame();
