"""
AULA F108 Pro - Standalone RGB Driver
No AULA software required. Windows only (uses Win32 HID via ctypes).

Protocol notes:
  - VID: 0x0C45  PID: 0x800A
  - RGB interface: 3  (usage_page=0xff13, usage=0x0001)
  - All comms via DeviceIoControl IOCTL_HID_SET/GET_FEATURE on EP0
  - hidapi.write() routes to wrong interface — must use Win32 directly
  - 'aa 55' footer = Sinowealth 8051 controller signature
  - Arg byte always sits at packet index 8
  - error 121 (ERROR_SEM_TIMEOUT) after 04 f0 is normal — keyboard busy writing flash
"""

import colorsys
import ctypes
import ctypes.wintypes as wt
import threading
import time
import hid as hidapi

# ── Win32 HID ─────────────────────────────────────────────────────────────────
GENERIC_READ          = 0x80000000
GENERIC_WRITE         = 0x40000000
FILE_SHARE_READ       = 0x00000001
FILE_SHARE_WRITE      = 0x00000002
OPEN_EXISTING         = 3
INVALID_HANDLE_VALUE  = ctypes.c_void_p(-1).value
IOCTL_HID_GET_FEATURE = 0x000B0192
IOCTL_HID_SET_FEATURE = 0x000B0191
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

def _open(path):
    h = kernel32.CreateFileW(path, GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, 0, None)
    if h == INVALID_HANDLE_VALUE:
        raise OSError(f"CreateFile failed: {ctypes.get_last_error()}")
    return h

def _close(h):
    kernel32.CloseHandle(h)

def _set(h, data, retries=3):
    buf = (ctypes.c_byte * 65)(*([0x00] + list(data) + [0] * (64 - len(data))))
    bret = wt.DWORD(0)
    for attempt in range(retries):
        if kernel32.DeviceIoControl(h, IOCTL_HID_SET_FEATURE,
                buf, 65, None, 0, ctypes.byref(bret), None):
            return
        err = ctypes.get_last_error()
        if err == 121 and attempt < retries - 1:
            time.sleep(0.05 * (attempt + 1))
            continue
        raise OSError(f"SET failed: {err}")

def _get(h):
    buf = (ctypes.c_byte * 65)(*([0x00] * 65))
    bret = wt.DWORD(0)
    if not kernel32.DeviceIoControl(h, IOCTL_HID_GET_FEATURE,
            buf, 65, buf, 65, ctypes.byref(bret), None):
        raise OSError(f"GET failed: {ctypes.get_last_error()}")
    return bytes(buf)[1:]

def _sr(h, data):
    buf = list(data) + [0] * (64 - len(data))
    _set(h, bytes(buf[:64]))

def _gr(h):
    try:
        return _get(h)
    except OSError:
        return None

def _pkt(c0, c1, arg=0x00):
    """Build a 9-byte command prefix. Arg always sits at byte index 8."""
    return [c0, c1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, arg]

# ── Protocol constants ─────────────────────────────────────────────────────────
_UNLOCK_REALTIME = (
    [0x00, 0x01, 0x5a, 0x1a, 0x03, 0x09, 0x00, 0x01, 0x02, 0x00, 0x01]
    + [0x00] * 51 + [0xaa, 0x55]
)
_UNLOCK_PROFILE = (
    [0x00, 0x01, 0x5a, 0x1a, 0x03, 0x09, 0x11, 0x31, 0x0a, 0x00, 0x01]
    + [0x00] * 51 + [0xaa, 0x55]
)
_HEADER_80 = (
    [0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x05, 0x00, 0x00, 0x00, 0x00, 0xaa, 0x55]
    + [0x00] * 48
)

# ── Realtime handshake ─────────────────────────────────────────────────────────
def _handshake(h):
    """Enter realtime/host-control mode. Required before streaming or saving."""
    _sr(h, _pkt(0x04, 0x18));          _gr(h)
    _sr(h, _pkt(0x04, 0x28, 0x01));    _gr(h)
    _sr(h, _UNLOCK_REALTIME);          _gr(h)
    _sr(h, _pkt(0x04, 0x02));          _gr(h)
    time.sleep(0.2)

# ── Realtime frame ─────────────────────────────────────────────────────────────
def _send_frame(h, colors):
    """Send one full frame. colors: dict of {int_idx: (r, g, b)}"""
    _sr(h, _pkt(0x04, 0x20, 0x08));    _gr(h)
    entries = [[idx, *colors.get(idx, (0, 0, 0))] for idx in LED_ORDER]
    for i in range(0, len(entries), 16):
        chunk = entries[i:i + 16]
        pkt = [b for e in chunk for b in e] + [0] * (64 - len(chunk) * 4)
        _sr(h, pkt[:64])
    _sr(h, [0x00] * 64)
    _sr(h, _pkt(0x04, 0x02));          _gr(h)

# ── Flash save ─────────────────────────────────────────────────────────────────
def _save_to_flash(h, colors):
    """
    Burn colors to onboard flash. Confirmed working protocol:
      - Stream 30 frames first so keyboard is in active realtime state
      - Transition to profile mode via _UNLOCK_PROFILE
      - 04 13 = enter static mode (ACK = all-zeros on success)
      - 04 23 = start LED data (sequential indices 0x00-0x7b)
      - 04 f0 = flash write trigger (~800ms, no ACK — error 121 is normal)
    """
    # Phase 1: prime with active streaming
    for _ in range(30):
        _send_frame(h, colors)
        time.sleep(0.035)

    # Phase 2: transition to profile mode
    _sr(h, _pkt(0x04, 0x18));          _gr(h)
    _sr(h, _pkt(0x04, 0x28, 0x01));    _gr(h)
    _sr(h, _UNLOCK_PROFILE);           _gr(h)
    _sr(h, _pkt(0x04, 0x02));          _gr(h)

    # Phase 3: enter static lighting mode
    _sr(h, _pkt(0x04, 0x18));          _gr(h)
    _sr(h, _pkt(0x04, 0x13, 0x01));    _gr(h)
    _sr(h, _HEADER_80);                _gr(h)
    _sr(h, _pkt(0x04, 0x02));          _gr(h)
    _sr(h, _pkt(0x04, 0xf0))
    time.sleep(0.3)

    # Phase 4: send LED data (sequential indices 0x00-0x7b)
    _sr(h, _pkt(0x04, 0x18));          _gr(h)
    _sr(h, _pkt(0x04, 0x23, 0x09));    _gr(h)
    entries = [[idx, *colors.get(idx, (0, 0, 0))] for idx in range(0x7c)]
    for i in range(0, len(entries), 16):
        chunk = entries[i:i + 16]
        pkt = [b for e in chunk for b in e] + [0] * (64 - len(chunk) * 4)
        _sr(h, pkt[:64])
        time.sleep(0.5)
    _sr(h, [0x00] * 62 + [0xaa, 0x55])

    # Phase 5: commit + flash write
    _sr(h, _pkt(0x04, 0x02));          _gr(h)
    _sr(h, _pkt(0x04, 0xf0))
    time.sleep(0.8)

# ── Key / LED maps ─────────────────────────────────────────────────────────────
KEY_MAP = {
    'ESC':  0x01,
    'F1':   0x02, 'F2':  0x03, 'F3':  0x04, 'F4':  0x05,
    'F5':   0x06, 'F6':  0x07, 'F7':  0x08, 'F8':  0x09,
    'F9':   0x0a, 'F10': 0x0b, 'F11': 0x0c, 'F12': 0x0d,
    'PRTSC': 0x70, 'SCRLK': 0x71, 'PAUSE': 0x73,
    'TILDE': 0x13,
    '1': 0x14, '2': 0x15, '3': 0x16, '4': 0x17, '5': 0x18,
    '6': 0x19, '7': 0x1a, '8': 0x1b, '9': 0x1c, '0': 0x1d,
    'MINUS': 0x1e, 'EQUALS': 0x1f, 'BACKSPACE': 0x67,
    'INS':  0x74, 'HOME': 0x75, 'PGUP': 0x76,
    'DEL':  0x77, 'END':  0x78, 'PGDN': 0x79,
    'UP':   0x65, 'LEFT': 0x63, 'DOWN': 0x64, 'RIGHT': 0x66,
    'NUMLK': 0x20, 'NUMDIV': 0x21, 'NUMMUL': 0x22, 'NUMSUB': 0x7a,
    'NUM7': 0x32, 'NUM8': 0x33, 'NUM9': 0x34, 'NUMADD': 0x7b,
    'NUM4': 0x44, 'NUM5': 0x45, 'NUM6': 0x46,
    'NUM1': 0x56, 'NUM2': 0x57, 'NUM3': 0x58, 'NUMENTER': 0x6a,
    'NUM0': 0x68, 'NUMDOT': 0x69,
    'TAB':   0x25,
    'CAPS':  0x37, 'ENTER': 0x55,
    'LSHIFT': 0x49, 'RSHIFT': 0x54,
    'LCTRL': 0x5b, 'WIN': 0x5c, 'LALT': 0x5d,
    'SPACE': 0x5e,
    'RALT': 0x5f, 'FN': 0x60, 'MENU': 0x61, 'RCTRL': 0x62,
    'Q': 0x26, 'W': 0x27, 'E': 0x28, 'R': 0x29, 'T': 0x2a,
    'Y': 0x2b, 'U': 0x2c, 'I': 0x2d, 'O': 0x2e, 'P': 0x2f,
    'LBRACKET': 0x30, 'RBRACKET': 0x31, 'BACKSLASH': 0x43,
    'A': 0x38, 'S': 0x39, 'D': 0x3a, 'F': 0x3b, 'G': 0x3c,
    'H': 0x3d, 'J': 0x3e, 'K': 0x3f, 'L': 0x40,
    'SEMICOLON': 0x41, 'QUOTE': 0x42,
    'Z': 0x4a, 'X': 0x4b, 'C': 0x4c, 'V': 0x4d, 'B': 0x4e,
    'N': 0x4f, 'M': 0x50, 'COMMA': 0x51, 'PERIOD': 0x52, 'SLASH': 0x53,
}

LED_ORDER = [
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x70, 0x71, 0x73,
    0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a,
    0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x67, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x20, 0x21, 0x22, 0x7a,
    0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c,
    0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x43, 0x32, 0x33,
    0x34, 0x7b, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c,
    0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x55, 0x44,
    0x45, 0x46, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e,
    0x4f, 0x50, 0x51, 0x52, 0x53, 0x54, 0x65, 0x56,
    0x57, 0x58, 0x6a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
    0x60, 0x61, 0x62, 0x63, 0x64, 0x66, 0x68, 0x69,
]

# ── Main class ─────────────────────────────────────────────────────────────────
class AulaF108Pro:
    FRAME_INTERVAL = 0.035  # ~30fps

    def __init__(self):
        self._h       = None
        self._colors  = {idx: (0, 0, 0) for idx in LED_ORDER}
        self._lock    = threading.Lock()
        self._running = False
        self._thread  = None

    def connect(self):
        """Open device and perform realtime handshake.
        Returns empty dict {} on success (colors unknown until user applies them),
        or None on failure.
        """
        for d in hidapi.enumerate(0x0C45, 0x800A):
            if d['usage_page'] == 0xff13:
                path = d['path']
                path = path.decode() if isinstance(path, bytes) else path
                self._h = _open(path)
                print(f"Connected: {path}")
                _handshake(self._h)
                print("Ready.")
                return {}
        print("Device not found. Is AULA software closed?")
        return None

    def disconnect(self):
        self.stop()
        if self._h:
            _close(self._h)
            self._h = None

    def set_key(self, key, r, g, b):
        """Set a key by name. e.g. set_key('ESC', 255, 0, 0)"""
        idx = KEY_MAP.get(key.upper())
        if idx is None:
            print(f"Unknown key: {key}"); return
        with self._lock:
            self._colors[idx] = (r, g, b)

    def set_index(self, idx, r, g, b):
        """
        Set a key by LED index. Accepts int or hex string.
        e.g. set_index(0x01, 255, 0, 0)
             set_index('01', 255, 0, 0)   <- from JS UI
        """
        if isinstance(idx, str):
            idx = int(idx, 16)
        with self._lock:
            self._colors[idx] = (r, g, b)

    def set_all(self, r, g, b):
        """Set all keys to one color."""
        with self._lock:
            self._colors = {idx: (r, g, b) for idx in LED_ORDER}

    def set_rainbow(self, keys=None):
        """Spread a rainbow across given key names, or all keys if None."""
        if keys is None:
            indices = LED_ORDER
        else:
            indices = [KEY_MAP[k.upper()] for k in keys if k.upper() in KEY_MAP]
        with self._lock:
            for i, idx in enumerate(indices):
                hue = i / len(indices)
                r, g, b = [int(x * 255) for x in colorsys.hsv_to_rgb(hue, 1.0, 1.0)]
                self._colors[idx] = (r, g, b)

    def clear(self):
        """Turn off all keys."""
        self.set_all(0, 0, 0)

    def _loop(self):
        while self._running:
            try:
                with self._lock:
                    colors = dict(self._colors)
                _send_frame(self._h, colors)
            except Exception as e:
                print(f"Frame error: {e}")
                break
            time.sleep(self.FRAME_INTERVAL)

    def start(self):
        """Start streaming frames in a background thread (~30fps)."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        """Stop the streaming thread."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None

    def save(self):
        """
        Burn current colors to onboard flash (survives power cycle).
        Takes a couple seconds. Streaming resumes automatically after.
        """
        was_running = self._running
        self.stop()
        with self._lock:
            colors = dict(self._colors)
        print("Saving to flash...")
        _save_to_flash(self._h, colors)
        _handshake(self._h)
        print("Saved. Colors will persist after power cycle.")
        if was_running:
            self.start()


# ── Standalone demo ────────────────────────────────────────────────────────────
if __name__ == '__main__':
    kb = AulaF108Pro()
    if not kb.connect():
        exit(1)

    kb.set_rainbow()
    kb.start()
    print("Streaming. Press Enter to save to flash, Ctrl+C to quit.")
    try:
        while True:
            input()
            kb.save()
    except KeyboardInterrupt:
        pass

    kb.disconnect()
    print("Done.")