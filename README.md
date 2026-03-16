# AULA F108 Pro — RGB Driver

A fully custom RGB driver for the AULA F108 Pro keyboard. No AULA software required.
Built by reverse-engineering the USB HID protocol via Wireshark captures.

![Python](https://img.shields.io/badge/python-3.8+-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

- Full per-key RGB control
- **Flash mode** — burn static colors to onboard memory, persists after power cycle (no software needed)
- **Layer system** — stack unlimited layers with per-layer opacity and blending
  - Static layers — per-key color maps
  - Animation layers — frame timeline with per-frame colors and durations
  - Reactive layers — keypress-driven effects (see below)
- **Reactive effects** — per-key colors triggered by keypresses, easily extensible
  - Key Highlight — pressed key lights up and fades on release
  - Ripple — expanding ring from keypress
  - Meteor — light falls from top row down to the pressed key with trail
  - Lightning — entire column flashes instantly on press
- Save/load layer presets, animations, and flash presets as JSON files
- Native desktop app (PyWebView — no browser needed)

## Hardware

| Field | Value |
|-------|-------|
| Vendor ID | `0x0C45` |
| Product ID | `0x800A` |
| RGB Interface | 3 (`usage_page=0xff13`) |
| Protocol | Sinowealth 8051 HID feature reports via Win32 `DeviceIoControl` |

---

## Running from source

**Requirements:** Python 3.8+, Windows

```bash
git clone https://github.com/Punkster81/AULA-F108-Driver
cd AULA-F108-Driver
pip install -r requirements.txt
python main.py
```

> **Note:** Close the official AULA software before running — it holds the HID interface exclusively.

## Pre-built executable

Download the latest `aula_driver.exe` from [Releases](../../releases) — no Python install needed.

---

## Project structure

```
AULA-F108-Driver/
├── main.py                    # PyWebView app entry point + Python API bridge
├── driver.py                  # Background HID + keyboard hook process
├── aula_f108_pro_final.py     # Low-level HID protocol (Win32 DeviceIoControl)
├── requirements.txt
└── ui/
    ├── index.html             # App shell
    ├── main.css               # Core styles
    ├── anim.css               # Timeline / frame editor styles
    ├── layers.css             # Layer strip and card styles
    ├── layout.js              # Keyboard layout data (ROWS, NAV, NUMPAD)
    ├── main.js                # Color picker, keyboard builder, selection, PyWebView bridge
    ├── flash.js               # Flash-to-memory tab (save colors to onboard storage)
    └── layers.js              # Layer system, compositor, animation editor, reactive effects
```

### Why two JS files instead of three?

The old `anim.js` standalone animation tab has been merged into `layers.js`. Animations are now just a layer type — you add an animation layer inside the Layers panel and edit its frames there. This eliminates duplicated compositor logic and makes animations compositable with other layers.

`flash.js` stays separate because it is the only mode that writes to keyboard onboard memory. It is intentionally distinct from the live-streaming layer system.

---

## Two-mode design

### 💾 Flash
Writes colors directly to the keyboard's onboard flash memory. Colors survive power cycles — the keyboard shows them even with no software running. Use this for your "default" keyboard appearance.

### ⚡ Layers
Streams a live composite frame to the keyboard at ~30fps. Layers are stacked bottom-to-top. Any combination of static, animation, and reactive layers can be mixed. The full composite is sent to hardware via shared memory — the driver just writes it, no separate reactive engine running on the driver side.

---

## Architecture

```
main.py (UI process)
  └─ spawns driver.py (background process)

Shared memory:
  AulaF108Frame  — UI writes compositor frames → driver reads and sends to HW
  AulaF108Keys   — driver writes key events → UI reads for reactive display

UI JS stack (load order):
  layout.js   → key geometry constants
  main.js     → color state, keyboard DOM, mode registry
  flash.js    → flash-to-memory tab logic
  layers.js   → layer system, compositor, all effects
```

### Adding a new reactive effect

Open `layers.js` and add one entry to the `Effects` object:

```js
const Effects = {
    // ... existing effects ...

    myEffect: {
        label: 'My Effect',
        icon:  '✨',
        desc:  'Does something cool',
        defaults: { fadeDuration: 600, myParam: 1.0 },
        initRippleState: () => ([]),
        onPress(state, idx, color, now, layer)  { /* push to state */ },
        onRelease(state, idx, now)              { /* mark release */ },
        snapshot(layer, now)                   { /* return {idx:{r,g,b}} */ },
        prune(layer, now)                      { /* remove expired entries */ },
        settingsHTML(layer)                    { /* return HTML string */ },
        serializeExtra(layer)                  { return { myParam: layer.myParam ?? 1.0 }; },
    },
};
```

That's it. The effect card appears in the UI automatically, the poller routes keypresses to it automatically, and it serializes/deserializes automatically. Nothing else needs changing.

You also need to add the same effect logic to `driver.py` so the hardware matches the display — add a `_apply_myEffect` method and wire it into `_build_reactive_frame` and `_on_key_event`.

---

## Protocol notes

The keyboard uses a Sinowealth 8051 controller. All communication goes through USB HID feature reports on interface 3 (`usage_page=0xff13`). Standard `hidapi` won't work on Windows — you must use `DeviceIoControl` with `IOCTL_HID_SET_FEATURE` / `IOCTL_HID_GET_FEATURE`.

Key protocol details are documented in `aula_f108_pro_final.py`.

---

## Building the exe

```bash
pip install pyinstaller
pyinstaller --onefile --windowed --add-data "ui;ui" --name aula_driver main.py
# Output: dist/aula_driver.exe
```

---

## Protocol notes

The keyboard uses a Sinowealth 8051 controller. All communication goes through USB HID feature reports on interface 3 (`usage_page=0xff13`). Standard `hidapi` won't work on Windows — you must use `DeviceIoControl` with `IOCTL_HID_SET_FEATURE` / `IOCTL_HID_GET_FEATURE`.

Key protocol details are documented in `aula_f108_pro_final.py`.

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

PRs welcome. Key areas that would benefit from contributions:

- New reactive effects (see "Adding a new reactive effect" above)
- Capture and reverse-engineer built-in effect commands (breathing, wave, ripple) from official software
- macOS / Linux support investigation

## License

MIT