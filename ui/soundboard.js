// ── Soundboard ────────────────────────────────────────────────────────────────
// Manages soundboard cards, key combo recording, audio playback, and VC routing.

let _sbCards         = [];       // [{id, name, combo, comboLabel, soundPath, soundFilename, volume}]
let _sbRecording     = false;
let _sbRecordId      = null;
let _sbRecordHeld    = new Set();// VK codes held during recording
let _sbRecordCombo   = [];       // finalised combo from recording
let _sbPollTs        = 0;
let _sbPollTimer     = null;
let _sbAudioBuffers  = {};       // card_id -> AudioBuffer (cached)
let _sbVcDeviceId    = null;     // selected VC output device id
let _sbSpeakerDeviceId = null;   // default speakers (null = default)
let _sbVcEnabled     = true;
let _sbLoaded        = false;

// Key code → LED hex id using e.code strings (distinguishes numpad from main keys)
const SB_CODE_TO_LED = {
    // Function row
    'Escape':'01','F1':'02','F2':'03','F3':'04','F4':'05','F5':'06','F6':'07',
    'F7':'08','F8':'09','F9':'0a','F10':'0b','F11':'0c','F12':'0d',
    'PrintScreen':'70','ScrollLock':'71','Pause':'73',
    // Number row
    'Backquote':'13','Digit1':'14','Digit2':'15','Digit3':'16','Digit4':'17',
    'Digit5':'18','Digit6':'19','Digit7':'1a','Digit8':'1b','Digit9':'1c',
    'Digit0':'1d','Minus':'1e','Equal':'1f','Backspace':'67',
    // Nav cluster
    'Insert':'74','Home':'75','PageUp':'76','Delete':'77','End':'78','PageDown':'79',
    // Numpad
    'NumLock':'20','NumpadDivide':'21','NumpadMultiply':'22','NumpadSubtract':'7a',
    'Numpad7':'32','Numpad8':'33','Numpad9':'34','NumpadAdd':'7b',
    'Numpad4':'44','Numpad5':'45','Numpad6':'46',
    'Numpad1':'56','Numpad2':'57','Numpad3':'58','NumpadEnter':'6a',
    'Numpad0':'68','NumpadDecimal':'69',
    // QWERTY
    'Tab':'25','KeyQ':'26','KeyW':'27','KeyE':'28','KeyR':'29','KeyT':'2a',
    'KeyY':'2b','KeyU':'2c','KeyI':'2d','KeyO':'2e','KeyP':'2f',
    'BracketLeft':'30','BracketRight':'31','Backslash':'43',
    'CapsLock':'37','KeyA':'38','KeyS':'39','KeyD':'3a','KeyF':'3b',
    'KeyG':'3c','KeyH':'3d','KeyJ':'3e','KeyK':'3f','KeyL':'40',
    'Semicolon':'41','Quote':'42','Enter':'55',
    'ShiftLeft':'49','KeyZ':'4a','KeyX':'4b','KeyC':'4c','KeyV':'4d',
    'KeyB':'4e','KeyN':'4f','KeyM':'50','Comma':'51','Period':'52',
    'Slash':'53','ShiftRight':'54','ArrowUp':'65',
    // Bottom row
    'ControlLeft':'5b','MetaLeft':'5c','AltLeft':'5d','Space':'5e',
    'AltRight':'5f','Fn':'60','ContextMenu':'61','ControlRight':'62',
    'ArrowLeft':'63','ArrowDown':'64','ArrowRight':'66',
};

// Also keep VK→LED for the driver combo matching (uses keyCode)
const SB_VK_TO_LED = {
    27:'01',112:'02',113:'03',114:'04',115:'05',116:'06',117:'07',118:'08',
    119:'09',120:'0a',121:'0b',122:'0c',123:'0d',44:'70',145:'71',19:'73',
    192:'13',49:'14',50:'15',51:'16',52:'17',53:'18',54:'19',55:'1a',56:'1b',
    57:'1c',48:'1d',189:'1e',187:'1f',8:'67',45:'74',36:'75',33:'76',46:'77',
    35:'78',34:'79',9:'25',81:'26',87:'27',69:'28',82:'29',84:'2a',89:'2b',
    85:'2c',73:'2d',79:'2e',80:'2f',219:'30',221:'31',220:'43',20:'37',65:'38',
    83:'39',68:'3a',70:'3b',71:'3c',72:'3d',74:'3e',75:'3f',76:'40',186:'41',
    222:'42',13:'55',160:'49',90:'4a',88:'4b',67:'4c',86:'4d',66:'4e',78:'4f',
    77:'50',188:'51',190:'52',191:'53',161:'54',162:'5b',91:'5c',164:'5d',
    32:'5e',165:'5f',93:'61',163:'62',37:'63',40:'64',38:'65',39:'66',
    144:'20',111:'21',106:'22',109:'7a',107:'7b',103:'32',104:'33',105:'34',
    100:'44',101:'45',102:'46',97:'56',98:'57',99:'58',96:'68',110:'69',
};

function _sbComboToLeds(combo) {
    // combo entries are now {code, vk} objects or legacy plain vk numbers
    return (combo || []).map(entry => {
        if (typeof entry === 'object' && entry.code) return SB_CODE_TO_LED[entry.code];
        return SB_VK_TO_LED[entry];
    }).filter(Boolean);
}

function _sbHighlightKeys(leds, color='#ffffff') {
    leds.forEach(led => {
        const k = typeof keyEls !== 'undefined' && keyEls[led];
        if (!k) return;
        k.style.setProperty('--key-color', color);
        k.classList.add('lit');
        k.classList.remove('key-empty');
        k.style.color = 'rgba(0,0,0,0.8)';
        k.dataset.sbHighlight = '1';
    });
}

function _sbClearHighlights() {
    if (typeof keyEls === 'undefined') return;
    Object.entries(keyEls).forEach(([idx, k]) => {
        if (k.dataset.sbHighlight) {
            delete k.dataset.sbHighlight;
            if (typeof unpaintKey === 'function') unpaintKey(idx);
        }
    });
}

function _sbShowAllComboDim() {
    // Show all keys that have any combo assigned, dimly
    const allLeds = new Set();
    _sbCards.forEach(card => {
        if (card.combo?.length) _sbComboToLeds(card.combo).forEach(l => allLeds.add(l));
    });
    _sbHighlightKeys([...allLeds], 'rgba(255,255,255,0.18)');
}

function sbCardHover(id) {
    _sbClearHighlights();
    const card = _sbCards.find(c => c.id === id);
    if (!card?.combo?.length) return;
    _sbHighlightKeys(_sbComboToLeds(card.combo), '#ffffff');
}

function sbCardLeave() {
    _sbClearHighlights();
    _sbShowAllComboDim();
}

// VK code → display name map for showing combos
const VK_NAMES = {
    8:'Backspace',9:'Tab',13:'Enter',16:'Shift',17:'Ctrl',18:'Alt',19:'Pause',
    20:'CapsLock',27:'Esc',32:'Space',33:'PgUp',34:'PgDn',35:'End',36:'Home',
    37:'←',38:'↑',39:'→',40:'↓',44:'PrtSc',45:'Ins',46:'Del',
    91:'Win',93:'Menu',144:'NumLk',145:'ScrlLk',
    112:'F1',113:'F2',114:'F3',115:'F4',116:'F5',117:'F6',
    118:'F7',119:'F8',120:'F9',121:'F10',122:'F11',123:'F12',
    186:';',187:'=',188:',',189:'-',190:'.',191:'/',192:'`',
    219:'[',220:'\\',221:']',222:"'",
    160:'LShift',161:'RShift',162:'LCtrl',163:'RCtrl',164:'LAlt',165:'RAlt',
};
function _vkName(entry) {
    // Handle both legacy plain vk numbers and new {code, vk} objects
    if (typeof entry === 'object' && entry.code) {
        // Pretty name from code string
        const c = entry.code;
        if (c.startsWith('Key')) return c.slice(3);
        if (c.startsWith('Digit')) return c.slice(5);
        if (c.startsWith('Numpad')) return 'Num' + c.slice(6);
        if (c === 'ShiftLeft') return 'LShift';
        if (c === 'ShiftRight') return 'RShift';
        if (c === 'ControlLeft') return 'LCtrl';
        if (c === 'ControlRight') return 'RCtrl';
        if (c === 'AltLeft') return 'LAlt';
        if (c === 'AltRight') return 'RAlt';
        if (c === 'MetaLeft' || c === 'MetaRight') return 'Win';
        if (c === 'ArrowUp') return '↑';
        if (c === 'ArrowDown') return '↓';
        if (c === 'ArrowLeft') return '←';
        if (c === 'ArrowRight') return '→';
        // Fall through to readable version of code
        return c.replace(/([A-Z])/g, ' $1').trim();
    }
    const vk = typeof entry === 'object' ? entry.vk : entry;
    if (VK_NAMES[vk]) return VK_NAMES[vk];
    if (vk >= 48 && vk <= 57) return String.fromCharCode(vk);
    if (vk >= 65 && vk <= 90) return String.fromCharCode(vk);
    if (vk >= 96 && vk <= 105) return `Num${vk-96}`;
    return `VK${vk}`;
}
function _comboLabel(combo) {
    return combo.map(_vkName).join(' + ') || '—';
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function initSoundboard() {
    if (_sbLoaded) return;
    _sbLoaded = true;
    await loadSoundboardCards();
    _startSbPoller();
    await _checkVbAudio();
    await _populateAudioDevices();
    if (hasPyAPI()) {
        try { await window.pywebview.api.sync_soundboard_to_driver(); } catch(e) {}
    }
    // Show dim highlights for all assigned keys
    setTimeout(_sbShowAllComboDim, 100);
}

async function _checkVbAudio() {
    const statusEl = document.getElementById('sbVbStatus');
    const guideEl  = document.getElementById('sbSetupGuide');
    if (!statusEl || !hasPyAPI()) return;

    try {
        const r = await window.pywebview.api.check_vb_audio();
        if (r.installed) {
            statusEl.innerHTML = `<div style="display:flex;align-items:center;gap:6px;font-size:0.6rem;color:#2ecc71">
                ✓ VB-Audio Virtual Cable installed
            </div>`;
            if (guideEl) guideEl.style.display = 'block';
            // Auto-select CABLE Input if not already set
            if (!_sbVcDeviceId) {
                setTimeout(async () => {
                    await _populateAudioDevices();
                    _autoSelectCable();
                }, 500);
            }
        } else {
            statusEl.innerHTML = `
                <div style="font-size:0.6rem;color:var(--dim);margin-bottom:6px;line-height:1.6">
                    ✗ VB-Audio Virtual Cable not found.<br>Required for VC output.
                </div>
                <button class="sb-btn" id="sbInstallBtn" onclick="_installVbAudio()" style="width:100%;text-align:center;border-color:#f39c12;color:#f39c12">
                    ⬇ Install VB-Audio (free)
                </button>
                <button class="sb-btn" onclick="window.pywebview.api.open_vb_audio_page()" style="width:100%;text-align:center;margin-top:4px;font-size:0.58rem">
                    Open download page manually
                </button>`;
        }
    } catch(e) {
        statusEl.innerHTML = '<div style="font-size:0.6rem;color:var(--dim)">Could not check VB-Audio status</div>';
    }
}

async function _installVbAudio() {
    const statusEl = document.getElementById('sbVbStatus');
    if (statusEl) {
        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;font-size:0.6rem;color:var(--dim)">
                <div class="sb-spinner"></div>
                <span id="sbInstallStatus">Downloading VB-Audio (~10MB)...</span>
            </div>
            <div style="font-size:0.58rem;color:var(--dim);margin-top:6px;line-height:1.6">
                An installer window will open — click <b style="color:var(--text)">Install</b> to proceed.
            </div>`;
    }

    // Update status text during install
    const stages = [
        [3000,  'Extracting installer...'],
        [6000,  'Installing driver (may take a moment)...'],
        [15000, 'Registering audio device...'],
    ];
    stages.forEach(([delay, msg]) => {
        setTimeout(() => {
            const el = document.getElementById('sbInstallStatus');
            if (el) el.textContent = msg;
        }, delay);
    });

    try {
        const r = await window.pywebview.api.install_vb_audio();
        if (r.ok) {
            if (r.installed) {
                toast('VB-Audio installed successfully!');
                await _checkVbAudio();
                await _populateAudioDevices();
                _autoSelectCable();
            } else if (r.needs_restart) {
                const statusEl = document.getElementById('sbVbStatus');
                if (statusEl) statusEl.innerHTML = `
                    <div style="font-size:0.6rem;color:#f39c12;line-height:1.6">
                        ⚠ Driver installed — please <b>restart Windows</b> for the audio device to appear.
                    </div>`;
                toast('Restart Windows to complete install');
            } else {
                toast('Install ran but device not detected — try restarting Windows');
                await _checkVbAudio();
            }
        } else {
            const msg = r.message || 'Unknown error';
            const statusEl = document.getElementById('sbVbStatus');
            if (statusEl) {
                statusEl.innerHTML = `
                    <div style="font-size:0.6rem;color:#e74c3c;margin-bottom:6px;line-height:1.6">
                        ✗ Install failed:<br><span style="font-family:monospace;font-size:0.56rem">${msg}</span>
                    </div>
                    <button class="sb-btn" onclick="_installVbAudio()" style="width:100%;text-align:center;border-color:#f39c12;color:#f39c12;margin-bottom:4px">
                        ⬇ Try again
                    </button>
                    <button class="sb-btn" onclick="window.pywebview.api.open_vb_audio_page()" style="width:100%;text-align:center;font-size:0.58rem">
                        Open download page manually
                    </button>`;
            }
        }
    } catch(e) {
        toast('Install error — try the manual download');
        await _checkVbAudio();
    }
}

function _autoSelectCable() {
    const sel = document.getElementById('sbVcDeviceSelect');
    if (!sel) return;
    // Find CABLE Input option and select it
    for (const opt of sel.options) {
        if (opt.textContent.toLowerCase().includes('cable input') ||
            opt.textContent.toLowerCase().includes('vb-audio')) {
            sel.value = opt.value;
            setSbVcDevice(opt.value);
            break;
        }
    }
}

async function loadSoundboardCards() {
    if (!hasPyAPI()) { renderSoundboardCards(); return; }
    try {
        const r = await window.pywebview.api.list_soundboard_cards();
        _sbCards = r.ok ? (r.cards || []) : [];
    } catch(e) { _sbCards = []; }
    renderSoundboardCards();
}

// ── Card rendering ────────────────────────────────────────────────────────────
function renderSoundboardCards() {
    const grid = document.getElementById('sbCardGrid');
    if (!grid) return;
    grid.innerHTML = '';

    _sbCards.forEach(card => {
        const el = document.createElement('div');
        el.className = 'sb-card';
        el.dataset.id = card.id;
        el.addEventListener('mouseenter', () => sbCardHover(card.id));
        el.addEventListener('mouseleave', () => sbCardLeave());
        const hasSound = !!card.soundPath;
        const vol = card.volume ?? 100;
        el.innerHTML = `
            <div class="sb-card-header">
                <span class="sb-card-name" title="Double-click to rename" ondblclick="renameSbCard('${card.id}', this)">${card.name}</span>
                <button class="sb-del-btn" onclick="deleteSbCard('${card.id}')" title="Delete">✕</button>
            </div>
            <div class="sb-card-combo" id="sbCombo_${card.id}">${_comboLabel(card.combo||[])}</div>
            <div class="sb-card-actions">
                <button class="sb-btn sb-record-btn" id="sbRec_${card.id}" onclick="startRecording('${card.id}')">⏺ Record Key</button>
                <button class="sb-btn sb-sound-btn ${hasSound?'has-sound':''}" onclick="pickSound('${card.id}')">${hasSound?'🔊 '+card.soundFilename:'📁 Add Sound'}</button>
            </div>
            <div class="sb-vol-row">
                <span class="sb-vol-label">Vol</span>
                <input type="range" min="0" max="100" value="${vol}" class="sb-vol-slider"
                    oninput="setSbVolume('${card.id}',parseInt(this.value))">
                <span class="sb-vol-val" id="sbVol_${card.id}">${vol}%</span>
            </div>
            <button class="sb-btn sb-play-btn" onclick="playSbCard('${card.id}')" ${hasSound?'':'disabled'}>▶ Test</button>`;
        grid.appendChild(el);
    });

    // Add new card button
    const addEl = document.createElement('div');
    addEl.className = 'sb-card sb-add-card';
    addEl.innerHTML = `<button class="sb-add-btn" onclick="addSbCard()">＋ New Sound</button>`;
    grid.appendChild(addEl);
    // Clear stale highlights then show all assigned keys dimly
    _sbClearHighlights();
    setTimeout(_sbShowAllComboDim, 50);
}

// ── Card CRUD ─────────────────────────────────────────────────────────────────
function _sbId() { return 'sb_' + Date.now() + '_' + Math.random().toString(36).slice(2,7); }

async function addSbCard() {
    const name = prompt('Sound name:', 'Sound ' + (_sbCards.length + 1));
    if (!name) return;
    const card = { id: _sbId(), name, combo: [], comboLabel: '—', soundPath: null, soundFilename: null, volume: 100 };
    _sbCards.push(card);
    await _saveSbCard(card);
    renderSoundboardCards();
}

function renameSbCard(id, el) {
    const card = _sbCards.find(c => c.id === id);
    if (!card) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = card.name;
    input.className = 'sb-card-name sb-rename-input';
    input.style.cssText = 'background:var(--surface);border:1px solid var(--accent);border-radius:3px;color:var(--text);font-family:inherit;font-size:inherit;font-weight:inherit;width:100%;padding:0 2px;outline:none;';
    el.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
        const name = input.value.trim() || card.name;
        card.name = name;
        // Replace input back with span
        const span = document.createElement('span');
        span.className = 'sb-card-name';
        span.title = 'Double-click to rename';
        span.textContent = name;
        span.ondblclick = () => renameSbCard(id, span);
        input.replaceWith(span);
        await _saveSbCard(card);
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = card.name; input.blur(); }
    });
}

async function deleteSbCard(id) {
    if (!confirm('Delete this sound card?')) return;
    _sbCards = _sbCards.filter(c => c.id !== id);
    delete _sbAudioBuffers[id];
    if (hasPyAPI()) {
        try { await window.pywebview.api.delete_soundboard_card(id); } catch(e) {}
    }
    renderSoundboardCards();
}

async function _saveSbCard(card) {
    if (!hasPyAPI()) return;
    try { await window.pywebview.api.save_soundboard_card(card); } catch(e) {}
}

async function setSbVolume(id, vol) {
    const card = _sbCards.find(c => c.id === id);
    if (!card) return;
    card.volume = vol;
    const el = document.getElementById(`sbVol_${id}`);
    if (el) el.textContent = vol + '%';
    await _saveSbCard(card);
}

// ── Key recording ─────────────────────────────────────────────────────────────
function startRecording(id) {
    if (_sbRecording) stopRecording();
    _sbRecording = true;
    _sbRecordId  = id;
    _sbRecordHeld = new Set();
    _sbRecordCombo = [];

    const btn = document.getElementById(`sbRec_${id}`);
    if (btn) { btn.textContent = '⏹ Stop (release all)'; btn.classList.add('recording'); }

    const comboEl = document.getElementById(`sbCombo_${id}`);
    if (comboEl) comboEl.textContent = 'Press keys...';

    document.addEventListener('keydown', _sbKeyDown);
    document.addEventListener('keyup',   _sbKeyUp);
}

function _sbKeyDown(e) {
    e.preventDefault();
    if (!_sbRecording) return;
    const entry = { code: e.code, vk: e.keyCode };
    // Dedupe by code
    if (![..._sbRecordHeld].some(k => k.code === e.code)) {
        _sbRecordHeld.add(entry);
    }
    const comboEl = document.getElementById(`sbCombo_${_sbRecordId}`);
    if (comboEl) comboEl.textContent = _comboLabel([..._sbRecordHeld]);
}

function _sbKeyUp(e) {
    if (!_sbRecording) return;
    if (_sbRecordCombo.length === 0 && _sbRecordHeld.size > 0) {
        _sbRecordCombo = [..._sbRecordHeld];
    }
    _sbRecordHeld = new Set([..._sbRecordHeld].filter(k => k.code !== e.code));
    if (_sbRecordHeld.size === 0) {
        stopRecording();
    }
}

async function stopRecording() {
    if (!_sbRecording) return;
    document.removeEventListener('keydown', _sbKeyDown);
    document.removeEventListener('keyup',   _sbKeyUp);
    _sbRecording = false;

    const id   = _sbRecordId;
    const combo = _sbRecordCombo.length ? _sbRecordCombo : [..._sbRecordHeld];
    _sbRecordId = null;
    _sbRecordHeld.clear();

    const btn = document.getElementById(`sbRec_${id}`);
    if (btn) { btn.textContent = '⏺ Record Key'; btn.classList.remove('recording'); }

    if (!combo.length) return;

    const card = _sbCards.find(c => c.id === id);
    if (!card) return;
    card.combo = combo;
    card.comboLabel = _comboLabel(combo);

    const comboEl = document.getElementById(`sbCombo_${id}`);
    if (comboEl) comboEl.textContent = card.comboLabel;

    await _saveSbCard(card);
    // Re-sync to driver with new combo
    if (hasPyAPI()) {
        try { await window.pywebview.api.sync_soundboard_to_driver(); } catch(e) {}
    }
    // Refresh keyboard highlight
    _sbClearHighlights();
    _sbShowAllComboDim();
}

// ── Sound file picking ────────────────────────────────────────────────────────
async function pickSound(id) {
    if (!hasPyAPI()) { toast('Not connected'); return; }
    const card = _sbCards.find(c => c.id === id);
    if (!card) return;
    try {
        const r = await window.pywebview.api.pick_and_copy_sound(id);
        if (r.cancelled) return;
        if (!r.ok) { toast('Failed: ' + r.message); return; }
        card.soundPath     = r.path;
        card.soundFilename = r.filename;
        delete _sbAudioBuffers[id]; // clear cached buffer
        await _saveSbCard(card);
        renderSoundboardCards();
        toast('Sound added!');
    } catch(e) { toast('Error picking sound'); }
}

// ── Audio playback ────────────────────────────────────────────────────────────
async function _loadAudioBuffer(card) {
    if (_sbAudioBuffers[card.id]) return _sbAudioBuffers[card.id];
    if (!hasPyAPI() || !card.soundPath) return null;
    try {
        const r = await window.pywebview.api.read_sound_file(card.soundPath);
        if (!r.ok) return null;
        const binary = atob(r.data);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const ctx    = new AudioContext();
        const buffer = await ctx.decodeAudioData(bytes.buffer);
        await ctx.close();
        _sbAudioBuffers[card.id] = { buffer, mime: r.mime };
        return _sbAudioBuffers[card.id];
    } catch(e) {
        console.error('[soundboard] load failed:', e);
        return null;
    }
}

async function _playOnDevice(buffer, volume, sinkId) {
    try {
        const ctx = new AudioContext();
        if (sinkId) {
            try { await ctx.setSinkId(sinkId); } catch(e) {}
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = volume / 100;
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(0);
        source.onended = () => ctx.close();
    } catch(e) {
        console.error('[soundboard] playback failed:', e);
    }
}

async function playSbCard(id) {
    const card = _sbCards.find(c => c.id === id);
    if (!card || !card.soundPath) return;
    const cached = await _loadAudioBuffer(card);
    if (!cached) { toast('Sound not loaded'); return; }
    const vol = card.volume ?? 100;
    // Always play on speakers
    await _playOnDevice(cached.buffer, vol, _sbSpeakerDeviceId);
    // Also play on VC device if enabled and different
    if (_sbVcEnabled && _sbVcDeviceId && _sbVcDeviceId !== _sbSpeakerDeviceId) {
        await _playOnDevice(cached.buffer, vol, _sbVcDeviceId);
    }
}

// ── Trigger polling ───────────────────────────────────────────────────────────
function _startSbPoller() {
    if (_sbPollTimer) return;
    _sbPollTs = Date.now() / 1000;
    _sbPollTick();
}
function _stopSbPoller() {
    clearTimeout(_sbPollTimer); _sbPollTimer = null;
}
async function _sbPollTick() {
    if (!hasPyAPI()) {
        _sbPollTimer = setTimeout(_sbPollTick, 200); return;
    }
    try {
        const r = await window.pywebview.api.poll_soundboard_trigger(_sbPollTs);
        if (r?.triggered) {
            _sbPollTs = r.ts;
            playSbCard(r.id);
            _flashSbCard(r.id);
        }
    } catch(e) {}
    _sbPollTimer = setTimeout(_sbPollTick, 50);
}

function _flashSbCard(id) {
    const card = document.querySelector(`.sb-card[data-id="${id}"]`);
    if (!card) return;
    card.classList.add('sb-triggered');
    setTimeout(() => card.classList.remove('sb-triggered'), 300);
}

// ── Audio device picker ───────────────────────────────────────────────────────
async function _populateAudioDevices() {
    const sel = document.getElementById('sbVcDeviceSelect');
    if (!sel) return;
    try {
        // Try enumerating without requesting permission first
        let devices = await navigator.mediaDevices.enumerateDevices();
        let outputs = devices.filter(d => d.kind === 'audiooutput');

        // If labels are empty (no permission yet), request once silently
        if (outputs.length && !outputs[0].label) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(t => t.stop());
                devices = await navigator.mediaDevices.enumerateDevices();
                outputs = devices.filter(d => d.kind === 'audiooutput');
            } catch(e) {
                // Permission denied — show devices without labels
            }
        }

        sel.innerHTML = '<option value="">— None (speakers only) —</option>';
        outputs.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Audio Output ${d.deviceId.slice(0,6)}`;
            if (d.deviceId === _sbVcDeviceId) opt.selected = true;
            sel.appendChild(opt);
        });
    } catch(e) {
        sel.innerHTML = '<option value="">Could not enumerate devices</option>';
    }
}

function setSbVcDevice(deviceId) {
    _sbVcDeviceId = deviceId || null;
    localStorage && localStorage.setItem('sbVcDevice', _sbVcDeviceId || '');
}

function setSbVcEnabled(on) {
    _sbVcEnabled = on;
}

// Restore saved VC device
try { _sbVcDeviceId = localStorage.getItem('sbVcDevice') || null; } catch(e) {}