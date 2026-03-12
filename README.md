# AULA F108 Pro — RGB Driver

A fully custom RGB driver for the AULA F108 Pro keyboard. No AULA software required.
Built by reverse-engineering the USB HID protocol via Wireshark captures.

![Python](https://img.shields.io/badge/python-3.8+-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

- Full per-key RGB control
- Live streaming (~10fps) with no flicker
- Save colors to onboard flash (persists after power cycle)
- Custom animation editor with frame timeline
- Save/load animations as JSON
- Layer system — stack static and animated layers with per-layer opacity and transparency
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
git clone https://github.com/YOUR_USERNAME/aula-f108-driver
cd aula-f108-driver
pip install -r requirements.txt
python main.py
```

> **Note:** Close the official AULA software before running — it holds the HID interface exclusively.

## Pre-built executable

Download the latest `aula_driver.exe` from [Releases](../../releases) — no Python install needed.

---

## Project structure

```
aula-f108-driver/
├── main.py                   # PyWebView app entry point + keyboard API bridge
├── aula_f108_pro_final.py    # Low-level HID driver (Win32 DeviceIoControl)
├── requirements.txt
├── ui/
│   ├── index.html            # App UI
│   ├── main.css              # Main styles
│   ├── anim.css              # Animation editor styles
│   ├── layers.css            # Layer system styles
│   ├── layout.js             # Keyboard layout data (ROWS, NAV, NUMPAD)
│   ├── main.js               # Main UI logic
│   ├── anim.js               # Animation editor logic
│   └── layers.js             # Layer system logic
└── .github/
    └── workflows/
        └── build.yml         # Auto-builds exe on release tag
```

## Building the exe yourself

```bash
pip install pyinstaller
pyinstaller --onefile --windowed --add-data "ui;ui" --name aula_driver main.py
# Output: dist/aula_driver.exe
```

---

## Layer system

The layer system lets you stack multiple lighting layers on top of each other, composited in real time.

- **Static layers** — per-key colors painted directly onto the layer
- **Animation layers** — full frame-timeline animations running independently per layer
- **Opacity** — each layer has a 0–100% opacity slider for blending
- **Transparency** — keys with no color set on a layer are transparent; the layer below shows through. Black (`0,0,0`) counts as a real color — use the Eraser tool to make a key transparent
- **View modes** — toggle between editing a single layer in isolation or previewing the full composite
- **Three editing modes** in the toolbar: ✏️ Static, 🎬 Animations, ⚡ Layers

---

## Protocol notes

The keyboard uses a Sinowealth 8051 controller. All communication goes through USB HID
feature reports on interface 3 (`usage_page=0xff13`). Standard `hidapi` won't work on
Windows — you must use `DeviceIoControl` with `IOCTL_HID_SET_FEATURE` / `IOCTL_HID_GET_FEATURE`.

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

## Contributing

PRs welcome. Key areas that would benefit from contributions:

- Capture and reverse-engineer built-in effect commands (breathing, wave, ripple)
- macOS / Linux support investigation
- Keypress-reactive lighting effects

## License

MIT