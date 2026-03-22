# AULA F108 Pro — RGB Driver

A fully custom RGB driver for the AULA F108 Pro keyboard. No AULA software required.
Built by reverse-engineering the USB HID protocol via Wireshark captures.

![Python](https://img.shields.io/badge/python-3.8+-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

- Full per-key RGB control
- **Flash mode** — burn static colors to onboard memory, persists after power cycle with no software needed
- **Layer system** — stack unlimited layers with per-layer opacity and blending
  - Static layers — per-key color maps
  - Animation layers — frame timeline with per-frame colors and durations
  - Reactive layers — keypress-driven effects
- **Reactive effects** — per-key colors triggered by keypresses, easily extensible
  - Key Highlight — pressed key lights up, with fade, instant off, or toggle modes
  - Ripple — expanding ring from keypress
  - Meteor — light falls from top row down to the pressed key with trail
  - Lightning — entire column flashes instantly on press
- **Soundboard** — bind global key combos to sound files, plays through speakers and/or a virtual audio cable for VC routing
  - VB-Audio Virtual Cable integration — route sounds into Discord/game voice chat
  - Per-card volume, renaming, keyboard visualisation of assigned keys
- Save/load layer presets, animations, flash presets, and reactive presets as JSON
- Auto-updater — notified of new releases on startup, one-click update and restart
- Launch on Windows startup (optional)
- Native desktop app via PyWebView 4+ — no browser needed, persistent settings storage

## Hardware

| Field | Value |
|-------|-------|
| Vendor ID | `0x0C45` |
| Product ID | `0x800A` |
| RGB Interface | 3 (`usage_page=0xff13`) |
| Protocol | Sinowealth 8051 HID feature reports via Win32 `DeviceIoControl` |

---

## Running from source

**Requirements:** Python 3.8+, Windows, PyWebView 4+

```bash
git clone https://github.com/Punkster81/AULA-F108-Driver
cd AULA-F108-Driver
pip install -r requirements.txt
python main.py
```

> **Note:** The app requests administrator privileges on launch — this is required for HID device access. Close the official AULA software first, as it holds the HID interface exclusively.

## Pre-built executable

Download the latest `aula_driver.exe` from [Releases](../../releases). No Python install needed. The app will notify you automatically when a newer version is available and can update itself with one click.

---

## Project structure

```
AULA-F108-Driver/
├── .github/
│   └── workflows/
│       └── build.yml              # Auto-builds exe and publishes to Releases on version tag
├── main.py                        # PyWebView app entry point, Python API bridge, auto-updater
├── driver.py                      # Background HID + keyboard hook process
├── aula_f108_pro_final.py         # Low-level HID protocol (Win32 DeviceIoControl)
├── requirements.txt
└── ui/
    ├── index.html                 # App shell
    ├── main.css                   # Core styles
    ├── anim.css                   # Timeline / frame editor styles
    ├── layers.css                 # Layer strip and card styles
    ├── layout.js                  # Keyboard layout data (ROWS, NAV, NUMPAD)
    ├── main.js                    # Color picker, keyboard DOM, selection, PyWebView bridge
    ├── flash.js                   # Flash-to-memory tab
    ├── layers.js                  # Layer system, compositor, animation editor, reactive effects
    └── soundboard.js              # Soundboard tab — key combos, audio playback, VB-Audio
```

User data is stored in `%LOCALAPPDATA%\AulaF108Driver\` and is never committed to the repo:

```
%LOCALAPPDATA%\AulaF108Driver\
├── aula_driver.exe       — the installed exe (moved here on first run)
├── webview_storage/      — PyWebView persistent storage (mic permissions, etc.)
├── animations/           — saved animation files
├── lighting/             — saved flash presets
├── layers/               — saved layer stack presets
├── reactive/             — saved reactive layer presets
├── colors/               — recent color history
└── soundboard/
    ├── cards.json        — soundboard card definitions
    └── sounds/           — copied sound files
```

When running from source, data folders are created in the project root instead.

---

## Two-mode design

### 💾 Flash
Writes colors directly to keyboard onboard memory. Survives power cycles — the keyboard shows them with no software running. Use this for a default appearance.

### ⚡ Layers
Streams a live composite frame to the keyboard at ~30fps. Layers are stacked bottom-to-top with per-layer opacity. Any combination of static, animation, and reactive layers can be mixed. The compositor runs in JS and pushes frames via shared memory to the driver process, which writes them to hardware.

---

## Architecture

```
main.py  (UI process — PyWebView 4+)
  └─ spawns driver.py  (background process — HID + Win32 keyboard hook)

Shared memory:
  AulaF108Frame  — UI writes compositor frames → driver sends to hardware
  AulaF108Keys   — driver writes key events   → UI reads for reactive effects

driver_cmd.json  — UI writes commands → driver reads (SOUNDBOARD_CFG, SOUNDBOARD_RECORDING, etc.)
soundboard_trigger.json — driver writes trigger → UI polls at 50ms

JS load order:
  layout.js      → keyboard geometry constants
  main.js        → color picker, keyboard DOM, selection, bridge, updater UI
  flash.js       → flash-to-memory tab
  layers.js      → layers, compositor, animation editor, all reactive effects
  soundboard.js  → soundboard cards, key recording, audio playback, VB-Audio
```

---

## Releasing a new version

1. Bump `VERSION` in `main.py` (e.g. `VERSION = 'v1.1.0'`)
2. Commit and push
3. Tag the release:

```bash
git tag v1.1.0
git push --tags
```

GitHub Actions builds the exe on Windows and attaches it to the release automatically. Users running the app will see an update prompt on next launch.

## Building the exe manually

```bash
pip install pyinstaller
pyinstaller --onefile --windowed \
  --add-data "ui;ui" \
  --icon "icon.ico" \
  --name aula_driver \
  main.py
# Output: dist/aula_driver.exe
```

The driver runs as a `multiprocessing.Process` inside the same exe — no second exe needed. `freeze_support()` in `main.py` handles the frozen child process routing automatically.

---

## Adding a new reactive effect

Add one entry to the `Effects` object in `layers.js`. Nothing else needs changing in the UI:

```js
myEffect: {
    label: 'My Effect',
    icon:  '✨',
    desc:  'Does something cool',
    defaults: { fadeDuration: 600, myParam: 1.0 },
    initRippleState: () => ([]),
    onPress(state, idx, color, now, layer)  { /* push entry to state */ },
    onRelease(state, idx, now, layer)       { /* mark release */ },
    snapshot(layer, now)                   { /* return {idx:{r,g,b}} map */ },
    prune(layer, now)                      { /* remove expired state entries */ },
    settingsHTML(layer)                    { /* return HTML string for settings strip */ },
    serializeExtra(layer)                  { return { myParam: layer.myParam ?? 1.0 }; },
},
```

Then add matching logic to `driver.py` — a `_apply_myEffect` method wired into `_build_reactive_frame` and `_on_key_event` — so the hardware matches the display.

---

## Protocol notes

The keyboard uses a Sinowealth 8051 controller. All communication goes through USB HID feature reports on interface 3 (`usage_page=0xff13`). Standard `hidapi` won't work on Windows — you must use `DeviceIoControl` with `IOCTL_HID_SET_FEATURE` / `IOCTL_HID_GET_FEATURE`.

Full protocol details are documented in `aula_f108_pro_final.py`.

### LED index map (confirmed)

| Key | Index | Key | Index | Key | Index |
|-----|-------|-----|-------|-----|-------|
| ESC | `0x01` | F1 | `0x02` | F2 | `0x03` |
| F3 | `0x04` | F4 | `0x05` | F5 | `0x06` |
| F6 | `0x07` | F7 | `0x08` | F8 | `0x09` |
| F9 | `0x0a` | F10 | `0x0b` | F11 | `0x0c` |
| F12 | `0x0d` | PRT SCR | `0x70` | SCROLL LK | `0x71` |
| PAUSE | `0x73` | \` ~ | `0x13` | 1 | `0x14` |
| 2 | `0x15` | 3 | `0x16` | 4 | `0x17` |
| 5 | `0x18` | 6 | `0x19` | 7 | `0x1a` |
| 8 | `0x1b` | 9 | `0x1c` | 0 | `0x1d` |
| - | `0x1e` | = | `0x1f` | BACKSPACE | `0x67` |
| INS | `0x74` | HOME | `0x75` | PG UP | `0x76` |
| DEL | `0x77` | END | `0x78` | PG DN | `0x79` |
| NUM LK | `0x20` | NUM / | `0x21` | NUM * | `0x22` |
| NUM - | `0x7a` | TAB | `0x25` | Q | `0x26` |
| W | `0x27` | E | `0x28` | R | `0x29` |
| T | `0x2a` | Y | `0x2b` | U | `0x2c` |
| I | `0x2d` | O | `0x2e` | P | `0x2f` |
| [ | `0x30` | ] | `0x31` | \\ | `0x43` |
| NUM 7 | `0x32` | NUM 8 | `0x33` | NUM 9 | `0x34` |
| NUM + | `0x7b` | CAPS | `0x37` | A | `0x38` |
| S | `0x39` | D | `0x3a` | F | `0x3b` |
| G | `0x3c` | H | `0x3d` | J | `0x3e` |
| K | `0x3f` | L | `0x40` | ; | `0x41` |
| ' | `0x42` | ENTER | `0x55` | NUM 4 | `0x44` |
| NUM 5 | `0x45` | NUM 6 | `0x46` | L-SHIFT | `0x49` |
| Z | `0x4a` | X | `0x4b` | C | `0x4c` |
| V | `0x4d` | B | `0x4e` | N | `0x4f` |
| M | `0x50` | , | `0x51` | . | `0x52` |
| / | `0x53` | R-SHIFT | `0x54` | UP | `0x65` |
| NUM 1 | `0x56` | NUM 2 | `0x57` | NUM 3 | `0x58` |
| NUM ENTER | `0x6a` | L-CTRL | `0x5b` | WIN | `0x5c` |
| L-ALT | `0x5d` | SPACE | `0x5e` | R-ALT | `0x5f` |
| FN | `0x60` | MENU | `0x61` | R-CTRL | `0x62` |
| LEFT | `0x63` | DOWN | `0x64` | RIGHT | `0x66` |
| NUM 0 | `0x68` | NUM . | `0x69` | | |

---

## Contributing

PRs welcome. Key areas that would benefit from contributions:

- New reactive effects (see adding a new reactive effect above)
- Confirm bluetooth or wifi support
- macOS / Linux HID support investigation

## License

MIT