# AULA F108 Pro — RGB Driver

A fully custom RGB driver for the AULA F108 Pro keyboard. No AULA software required.
Built by reverse-engineering the USB HID protocol via Wireshark captures.

![Python](https://img.shields.io/badge/python-3.8+-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

- Full per-key RGB control
- Live streaming (~30fps) with no flicker
- Save colors to onboard flash (persists after power cycle)
- Custom animation editor with frame timeline
- Save/load animations as JSON
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
│   ├── layout.js             # Keyboard layout data (ROWS, NAV, NUMPAD)
│   ├── main.js               # Main UI logic
│   └── anim.js               # Animation editor logic
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

## Protocol notes

The keyboard uses a Sinowealth 8051 controller. All communication goes through USB HID
feature reports on interface 3 (`usage_page=0xff13`). Standard `hidapi` won't work on
Windows — you must use `DeviceIoControl` with `IOCTL_HID_SET_FEATURE` / `IOCTL_HID_GET_FEATURE`.

Key protocol details are documented in `aula_f108_pro_final.py`.

### LED index map (confirmed)

| Key | Index | Key | Index |
|-----|-------|-----|-------|
| ESC | `0x01` | F1–F12 | `0x02–0x0d` |
| PRT SCR | `0x70` | SCROLL LK | `0x71` |
| PAUSE | `0x73` | \` ~ | `0x13` |
| 1–0 | `0x14–0x1d` | - = | `0x1e 0x1f` |
| BACKSPACE | `0x67` | TAB | `0x25` |
| CAPS | `0x37` | ENTER | `0x55` |
| L-SHIFT | `0x49` | R-SHIFT | `0x54` |
| SPACE | `0x5e` | NUM LK | `0x20` |

> Remaining keys (alpha row, modifiers) are mapped but indices for some bottom-row
> keys are approximate pending further Wireshark captures.

---

## Contributing

PRs welcome. Key areas that would benefit from contributions:

- Complete LED index verification for all keys
- Capture and reverse-engineer built-in effect commands (breathing, wave, ripple)
- macOS / Linux support investigation
- Startup with Windows / autorun option

## License

MIT
