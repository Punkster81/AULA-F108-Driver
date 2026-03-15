"""
driver.py — AULA F108 Pro background driver process.

Runs independently of the UI (pywebview/Chromium). Handles:
  - HID keyboard communication
  - Win32 keyboard hook for reactive effects
  - Reading compositor frames from shared memory
  - Writing key events to shared memory for UI to poll

Started by main.py, but keeps running even when game is fullscreen.
Can also be run standalone: python driver.py
"""

import sys
import os
import time
import threading
import struct
import ctypes
import ctypes.wintypes
import queue
import json

# ── Shared memory layout ──────────────────────────────────────────────────────
# Two named shared memory blocks:
#
# "AulaF108Frame" — UI writes compositor frames, driver reads and sends to HW
#   [0:4]   magic uint32 = 0xA10AF108 (valid flag)
#   [4:8]   seq  uint32  (increments each write, driver detects changes)
#   [8:520] frame data: up to 128 entries of [idx_hi, idx_lo, r, g, b] (5 bytes each)
#           terminated by 5 zero bytes
#
# "AulaF108Keys" — driver writes key events, UI reads for reactive display
#   [0:4]   write_pos uint32 (ring buffer write head, mod 64)
#   [4:4+64*8] ring buffer of 64 events: [led_hi, led_lo, kind, pad, ts_float32]
#              kind: 1=press, 2=release
#              ts: float32 unix timestamp

from multiprocessing import shared_memory as _shm_mod

FRAME_SHM   = "AulaF108Frame"
KEYS_SHM    = "AulaF108Keys"
FRAME_MAGIC = 0xA10AF108
FRAME_SIZE  = 8 + 128 * 5 + 5
KEYS_SIZE   = 4 + 64 * 8 + 4  # +4 for global sequence counter at end


class ShmFrame:
    def __init__(self, create=False):
        self._shm = _shm_mod.SharedMemory(name=FRAME_SHM, create=create, size=FRAME_SIZE)
        self._buf = self._shm.buf
        self._last_seq = -1

    def _read_u32(self, offset):
        b = self._buf[offset:offset+4]
        return b[0] | (b[1]<<8) | (b[2]<<16) | (b[3]<<24)

    def _write_u32(self, offset, val):
        self._buf[offset]   = val & 0xFF
        self._buf[offset+1] = (val>>8)  & 0xFF
        self._buf[offset+2] = (val>>16) & 0xFF
        self._buf[offset+3] = (val>>24) & 0xFF

    def write(self, colors: dict):
        seq = (self._read_u32(4) + 1) & 0xFFFFFFFF
        offset = 8
        for idx_str, rgb in colors.items():
            idx = int(idx_str, 16)
            self._buf[offset]   = (idx>>8) & 0xFF
            self._buf[offset+1] = idx & 0xFF
            self._buf[offset+2] = int(rgb[0]) & 0xFF
            self._buf[offset+3] = int(rgb[1]) & 0xFF
            self._buf[offset+4] = int(rgb[2]) & 0xFF
            offset += 5
            if offset + 10 > FRAME_SIZE:
                break
        self._buf[offset:offset+5] = bytes(5)  # terminator
        self._write_u32(4, seq)
        self._write_u32(0, FRAME_MAGIC)

    def read_if_new(self):
        if self._read_u32(0) != FRAME_MAGIC:
            return None
        seq = self._read_u32(4)
        if seq == self._last_seq:
            return None
        self._last_seq = seq
        colors = {}
        offset = 8
        while offset + 5 <= FRAME_SIZE:
            chunk = bytes(self._buf[offset:offset+5])
            if chunk == b'\x00\x00\x00\x00\x00':
                break
            idx = (chunk[0]<<8) | chunk[1]
            colors[f'{idx:02x}'] = [chunk[2], chunk[3], chunk[4]]
            offset += 5
        return colors

    def close(self):
        self._buf.release()
        self._shm.close()
        try: self._shm.unlink()
        except: pass


class ShmKeys:
    RING_SIZE  = 64
    ENTRY_SIZE = 8

    def __init__(self, create=False):
        self._shm = _shm_mod.SharedMemory(name=KEYS_SHM, create=create, size=KEYS_SIZE)
        self._buf = self._shm.buf

    def _read_u32(self, offset):
        b = self._buf[offset:offset+4]
        return b[0] | (b[1]<<8) | (b[2]<<16) | (b[3]<<24)

    def _write_u32(self, offset, val):
        self._buf[offset]   = val & 0xFF
        self._buf[offset+1] = (val>>8)  & 0xFF
        self._buf[offset+2] = (val>>16) & 0xFF
        self._buf[offset+3] = (val>>24) & 0xFF

    def write_event(self, led: str, kind: str):
        import struct as _s
        wpos = self._read_u32(0) % self.RING_SIZE
        offset = 4 + wpos * self.ENTRY_SIZE
        idx = int(led, 16)
        # Global sequence counter stored at bytes 0-3, incremented each event
        seq = self._read_u32(516) + 1  # global seq counter at end of buffer
        self._buf[offset]   = (idx>>8) & 0xFF
        self._buf[offset+1] = idx & 0xFF
        self._buf[offset+2] = 1 if kind == 'press' else 2
        self._buf[offset+3] = 0
        # Store seq as uint32 in the 4-byte timestamp slot
        self._buf[offset+4:offset+8] = _s.pack('<I', seq)
        self._write_u32(0, (wpos + 1) % self.RING_SIZE)
        self._write_u32(516, seq)

    def read_events(self, since_ts: float):
        import struct as _s
        # since_ts is the last sequence number seen (JS passes back what we returned)
        since_seq = int(since_ts)
        all_events = []
        for i in range(self.RING_SIZE):
            offset = 4 + i * self.ENTRY_SIZE
            entry = bytes(self._buf[offset:offset+self.ENTRY_SIZE])
            kind_byte = entry[2]
            if kind_byte not in (1, 2):
                continue
            seq = _s.unpack_from('<I', entry, 4)[0]
            if seq == 0:
                continue
            led = f'{((entry[0]<<8)|entry[1]):02x}'
            all_events.append({'led': led, 'type': 'press' if kind_byte==1 else 'release', 'ts': float(seq)})
        # Return events with seq > since_seq
        events = [e for e in all_events if e['ts'] > since_seq]
        press_map = {e['led']: e['type'] for e in all_events}
        held = {l for l,t in press_map.items() if t == 'press'}
        # Return current max seq as the new "ts" for JS to use next call
        max_seq = max((e['ts'] for e in all_events), default=0.0)
        return events, held, max_seq

    def close(self):
        self._buf.release()
        self._shm.close()
        try: self._shm.unlink()
        except: pass





# ── LED coordinate map (x, y in key units) ────────────────────────────────────
LED_COORDS = {
    '01':(0.50,0),'02':(2.00,0),'03':(3.00,0),'04':(4.00,0),'05':(5.00,0),
    '06':(6.50,0),'07':(7.50,0),'08':(8.50,0),'09':(9.50,0),
    '0a':(11.00,0),'0b':(12.00,0),'0c':(13.00,0),'0d':(14.00,0),
    '13':(0.50,1),'14':(1.50,1),'15':(2.50,1),'16':(3.50,1),'17':(4.50,1),
    '18':(5.50,1),'19':(6.50,1),'1a':(7.50,1),'1b':(8.50,1),
    '1c':(9.50,1),'1d':(10.50,1),'1e':(11.50,1),'1f':(12.50,1),'67':(14.00,1),
    '25':(0.75,2),'26':(1.50,2),'27':(2.50,2),'28':(3.50,2),'29':(4.50,2),
    '2a':(5.50,2),'2b':(6.50,2),'2c':(7.50,2),'2d':(8.50,2),
    '2e':(9.50,2),'2f':(10.50,2),'30':(11.50,2),'31':(12.50,2),'43':(13.75,2),
    '37':(0.875,3),'38':(1.75,3),'39':(2.75,3),'3a':(3.75,3),'3b':(4.75,3),
    '3c':(5.75,3),'3d':(6.75,3),'3e':(7.75,3),'3f':(8.75,3),
    '40':(9.75,3),'41':(10.75,3),'42':(11.75,3),'55':(13.125,3),
    '49':(1.125,4),'4a':(2.25,4),'4b':(3.25,4),'4c':(4.25,4),'4d':(5.25,4),
    '4e':(6.25,4),'4f':(7.25,4),'50':(8.25,4),'51':(9.25,4),
    '52':(10.25,4),'53':(11.25,4),'54':(12.625,4),
    '5b':(0.75,5),'5c':(1.50,5),'5d':(2.25,5),'5e':(6.00,5),
    '5f':(9.75,5),'60':(10.75,5),'61':(11.75,5),'62':(12.75,5),
    # Nav cluster
    '70':(16.5,0),'71':(17.5,0),'73':(18.5,0),
    '74':(16.5,1),'75':(17.5,1),'76':(18.5,1),
    '77':(16.5,2),'78':(17.5,2),'79':(18.5,2),
    '65':(17.5,4),'63':(16.5,5),'64':(17.5,5),'66':(18.5,5),
    # Numpad
    '20':(20.0,1),'21':(21.0,1),'22':(22.0,1),'7a':(23.0,1),
    '32':(20.0,2),'33':(21.0,2),'34':(22.0,2),'7b':(23.0,2),
    '44':(20.0,3),'45':(21.0,3),'46':(22.0,3),
    '56':(20.0,4),'57':(21.0,4),'58':(22.0,4),'6a':(23.0,4),
    '68':(20.5,5),'69':(22.0,5),
}

def _led_dist(a, b):
    """Euclidean distance between two LED indices."""
    if a not in LED_COORDS or b not in LED_COORDS:
        return 999.0
    ax, ay = LED_COORDS[a]
    bx, by = LED_COORDS[b]
    return ((ax-bx)**2 + (ay-by)**2) ** 0.5

# ── VK → LED map ──────────────────────────────────────────────────────────────
VK_TO_LED = {
    27:  '01',  112: '02',  113: '03',  114: '04',  115: '05',
    116: '06',  117: '07',  118: '08',  119: '09',  120: '0a',
    121: '0b',  122: '0c',  123: '0d',   44: '70',  145: '71',
     19: '73',  192: '13',   49: '14',   50: '15',   51: '16',
     52: '17',   53: '18',   54: '19',   55: '1a',   56: '1b',
     57: '1c',   48: '1d',  189: '1e',  187: '1f',    8: '67',
     45: '74',   36: '75',   33: '76',   46: '77',   35: '78',
     34: '79',    9: '25',   81: '26',   87: '27',   69: '28',
     82: '29',   84: '2a',   89: '2b',   85: '2c',   73: '2d',
     79: '2e',   80: '2f',  219: '30',  221: '31',  220: '43',
     20: '37',   65: '38',   83: '39',   68: '3a',   70: '3b',
     71: '3c',   72: '3d',   74: '3e',   75: '3f',   76: '40',
    186: '41',  222: '42',   13: '55',  160: '49',   90: '4a',
     88: '4b',   67: '4c',   86: '4d',   66: '4e',   78: '4f',
     77: '50',  188: '51',  190: '52',  191: '53',  161: '54',
    162: '5b',   91: '5c',  164: '5d',   32: '5e',  165: '5f',
     93: '61',  163: '62',   37: '63',   40: '64',   38: '65',
     39: '66',  144: '20',  111: '21',  106: '22',  109: '7a',
    107: '7b',  103: '32',  104: '33',  105: '34',  100: '44',
    101: '45',  102: '46',   97: '56',   98: '57',   99: '58',
     96: '68',  110: '69',
}

NUMPAD_NUMLOCK_OFF = {
    35: '56',  40: '57',  34: '58',
    37: '44',  12: '45',  39: '46',
    36: '32',  38: '33',  33: '34',
    45: '68',  46: '69',
}


# ── Driver ─────────────────────────────────────────────────────────────────────

class Driver:
    def __init__(self):
        self._kb          = None
        self._kb_lock     = threading.Lock()
        self._shm_frame   = None
        self._shm_keys    = None
        self._running     = False
        self._reactive_layers  = []     # list of {cfg, active} per layer
        self._reactive_enabled = False
        self._reactive_lock = threading.Lock()
        self._base_frame  = {}       # last frame from shm (non-reactive)
        self._send_queue  = queue.Queue(maxsize=8)
    # ── Keyboard connection ───────────────────────────────────────────────────
    def connect(self):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from aula_f108_pro_final import AulaF108Pro
        with self._kb_lock:
            if self._kb:
                try: self._kb.disconnect()
                except: pass
            self._kb = AulaF108Pro()
            colors = self._kb.connect()
            if colors is None:
                self._kb = None
                return False
            self._kb.start()
            print('[driver] Keyboard connected', flush=True)
            return True

    def _send_frame(self, colors):
        with self._kb_lock:
            if not self._kb: return
            try:
                self._kb.clear()
                for idx_str, rgb in colors.items():
                    self._kb.set_index(int(idx_str, 16), rgb[0], rgb[1], rgb[2])
            except Exception as e:
                print(f'[driver] send error: {e}', flush=True)

    # ── Frame sender thread ───────────────────────────────────────────────────
    def _sender_thread(self):
        while self._running:
            try:
                frame = self._send_queue.get(timeout=0.5)
                if frame:
                    self._send_frame(frame)
            except queue.Empty:
                pass

    def _queue_frame(self, frame):
        try:
            self._send_queue.put_nowait(frame)
        except queue.Full:
            try: self._send_queue.get_nowait()
            except: pass
            try: self._send_queue.put_nowait(frame)
            except: pass

    # ── Shared memory frame reader ────────────────────────────────────────────
    def _frame_reader_thread(self):
        """Reads compositor frames from shm. When reactive is active, just updates
        base_frame — the reactive engine sends its own composite frames on keypresses
        and via the fade ticker. When reactive is inactive, sends frames normally."""
        while self._running:
            try:
                colors = self._shm_frame.read_if_new()
                if colors is not None:
                    self._base_frame = colors
                    if not self._reactive_enabled:
                        self._queue_frame(colors)
            except Exception as e:
                print(f'[driver] frame_reader: {e}', flush=True)
            time.sleep(0.005)

    # ── Reactive engine ───────────────────────────────────────────────────────
    def set_reactive_config(self, layers, enabled):
        with self._reactive_lock:
            self._reactive_enabled = bool(enabled)
            if not enabled:
                self._reactive_layers = []
                return
            # Build per-layer state, preserving existing active keys where layer matches
            new_layers = []
            for i, cfg in enumerate(layers or []):
                if not isinstance(cfg, dict): continue
                effect = cfg.get('effect', 'highlight')
                if i < len(self._reactive_layers) and self._reactive_layers[i]['cfg'].get('effect') == effect:
                    existing = self._reactive_layers[i]['active']
                else:
                    existing = [] if effect == 'ripple' else {}
                new_layers.append({'cfg': cfg, 'active': existing})
            self._reactive_layers = new_layers

    def _build_reactive_frame(self):
        with self._reactive_lock:
            now   = time.monotonic()
            frame = dict(self._base_frame)

            for layer_state in reversed(self._reactive_layers):  # bottom first, top (index 0) last = wins
                cfg     = layer_state['cfg']
                active  = layer_state['active']
                effect  = cfg.get('effect', 'highlight')
                opacity = cfg.get('opacity', 1.0)

                if effect == 'ripple':
                    self._apply_ripple(frame, active, cfg, now, opacity)
                else:
                    self._apply_highlight(frame, active, cfg, now, opacity)

            return frame

    def _apply_highlight(self, frame, active, cfg, now, opacity):
        fade_s = cfg.get('fadeDuration', 500) / 1000.0
        hold   = cfg.get('holdMode', 'fade')
        to_del = []
        for idx, key in active.items():
            rt = key['release_ts']
            if rt is not None:
                if hold == 'instant':
                    to_del.append(idx); continue
                alpha = max(0.0, 1.0 - (now - rt) / max(fade_s, 0.001))
                if alpha <= 0:
                    to_del.append(idx); continue
            else:
                alpha = 1.0
            alpha *= opacity
            cur = frame.get(idx, [0,0,0])
            cr,cg,cb = cur if isinstance(cur,(list,tuple)) else [cur.get('r',0),cur.get('g',0),cur.get('b',0)]
            frame[idx] = [int(key['r']*alpha+cr*(1-alpha)), int(key['g']*alpha+cg*(1-alpha)), int(key['b']*alpha+cb*(1-alpha))]
        for idx in to_del:
            del active[idx]

    def _apply_ripple(self, frame, active, cfg, now, opacity):
        """Expanding ring ripple — active is a list of ripple objects."""
        fade_s = cfg.get('fadeDuration', 1500) / 1000.0
        speed  = cfg.get('rippleSpeed', 8.0)
        width  = cfg.get('rippleWidth', 1.2)

        to_del = []
        for i, ripple in enumerate(active):
            elapsed = now - ripple['press_ts']
            ring_r  = elapsed * speed

            rt = ripple['release_ts']
            if rt is not None:
                fade_alpha = max(0.0, 1.0 - (now - rt) / max(fade_s, 0.001))
                if fade_alpha <= 0:
                    to_del.append(i); continue
            else:
                fade_alpha = 1.0

            for idx in LED_COORDS:
                dist = _led_dist(ripple['origin'], idx)
                diff = abs(dist - ring_r)
                if diff > width * 2:
                    continue
                ring_alpha = max(0.0, 1.0 - diff / width) * fade_alpha * opacity
                if ring_alpha <= 0:
                    continue
                cur = frame.get(idx, [0,0,0])
                cr,cg,cb = cur if isinstance(cur,(list,tuple)) else [cur.get('r',0),cur.get('g',0),cur.get('b',0)]
                frame[idx] = [
                    min(255, int(ripple['r']*ring_alpha + cr*(1-ring_alpha))),
                    min(255, int(ripple['g']*ring_alpha + cg*(1-ring_alpha))),
                    min(255, int(ripple['b']*ring_alpha + cb*(1-ring_alpha))),
                ]

        # Remove expired ripples (reverse order to preserve indices)
        for i in reversed(to_del):
            active.pop(i)

    def _on_key_event(self, led, kind):
        """Called from hook thread."""
        # Write to shm keys ring for UI display
        if self._shm_keys:
            try: self._shm_keys.write_event(led, kind)
            except: pass

        # Update reactive state and queue a frame
        with self._reactive_lock:
            if not self._reactive_enabled or not self._reactive_layers:
                return
            now = time.monotonic()
            for layer_state in self._reactive_layers:
                cfg    = layer_state['cfg']
                active = layer_state['active']
                effect = cfg.get('effect', 'highlight')
                c = cfg.get('colors', {}).get(led) or cfg.get('color', {'r':255,'g':255,'b':255})
                if isinstance(c, (list, tuple)):
                    r, g, b = int(c[0]), int(c[1]), int(c[2])
                else:
                    r, g, b = int(c.get('r',255)), int(c.get('g',255)), int(c.get('b',255))

                if effect == 'ripple':
                    if kind == 'press':
                        hold_mode = cfg.get('rippleHoldMode', 'once')
                        if hold_mode == 'once':
                            already_held = any(
                                rip['origin'] == led and rip['release_ts'] is None
                                for rip in active
                            )
                            if already_held:
                                continue
                        active.append({'origin': led, 'r':r,'g':g,'b':b,
                                       'press_ts': now, 'release_ts': None})
                    elif kind == 'release':
                        # Mark the most recent unfinished ripple from this key
                        for ripple in reversed(active):
                            if ripple['origin'] == led and ripple['release_ts'] is None:
                                ripple['release_ts'] = now
                                break
                else:
                    # active is a dict — one entry per key
                    if kind == 'press':
                        if led in active and active[led]['release_ts'] is None:
                            continue  # ignore key repeat
                        active[led] = {'r':r,'g':g,'b':b,'release_ts':None,'press_ts':now}
                    elif kind == 'release' and led in active:
                        active[led]['release_ts'] = now

        frame = self._build_reactive_frame()
        self._queue_frame(frame)

    # ── Fade ticker ───────────────────────────────────────────────────────────
    def _fade_ticker_thread(self):
        tick = 0
        while self._running:
            time.sleep(0.030)
            tick += 1
            if tick % 100 == 0:
                print(f'[driver] alive enabled={self._reactive_enabled} layers={len(self._reactive_layers)}', flush=True)
            if not self._reactive_enabled:
                continue
            frame = self._build_reactive_frame()
            self._queue_frame(frame)

    # ── Win32 keyboard hook ───────────────────────────────────────────────────
    def _hook_thread(self):
        import ctypes.wintypes as wt

        LLKHF_EXTENDED = 0x0001
        WH_KEYBOARD_LL = 13
        WM_KEYDOWN, WM_SYSKEYDOWN = 0x0100, 0x0104
        WM_KEYUP,   WM_SYSKEYUP   = 0x0101, 0x0105

        class KBDLLHOOKSTRUCT(ctypes.Structure):
            _fields_ = [('vkCode', wt.DWORD), ('scanCode', wt.DWORD),
                        ('flags', wt.DWORD), ('time', wt.DWORD),
                        ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong))]

        user32 = ctypes.WinDLL('user32', use_last_error=True)
        user32.CallNextHookEx.restype  = ctypes.c_long
        user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wt.WPARAM, wt.LPARAM]
        user32.SetWindowsHookExW.restype  = ctypes.c_void_p
        user32.SetWindowsHookExW.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, wt.DWORD]
        user32.UnhookWindowsHookEx.argtypes = [ctypes.c_void_p]

        def _resolve_led(vk, extended):
            if vk == 13: return '6a' if extended else '55'
            if not (user32.GetKeyState(144) & 1) and vk in NUMPAD_NUMLOCK_OFF:
                return NUMPAD_NUMLOCK_OFF[vk]
            return VK_TO_LED.get(vk)

        HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_int, wt.WPARAM, wt.LPARAM)

        def _hook_proc(nCode, wParam, lParam):
            if nCode >= 0:
                kb  = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
                led = _resolve_led(kb.vkCode, bool(kb.flags & LLKHF_EXTENDED))
                if led:
                    if wParam in (WM_KEYDOWN, WM_SYSKEYDOWN):
                        self._on_key_event(led, 'press')
                    elif wParam in (WM_KEYUP, WM_SYSKEYUP):
                        self._on_key_event(led, 'release')
            return user32.CallNextHookEx(None, nCode, wParam, lParam)

        _proc = HOOKPROC(_hook_proc)
        _ready = threading.Event()

        def _pump():
            h = user32.SetWindowsHookExW(WH_KEYBOARD_LL, _proc, None, 0)
            if not h:
                print(f'[driver] hook failed: {ctypes.get_last_error()}', flush=True)
                _ready.set(); return
            _ready.set()
            msg = wt.MSG()
            while self._running:
                ret = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if ret == 0 or ret == -1: break
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
            user32.UnhookWindowsHookEx(h)

        t = threading.Thread(target=_pump, daemon=True)
        t.start()
        _ready.wait(timeout=2.0)
        print('[driver] Hook installed', flush=True)

    # ── Main run loop ─────────────────────────────────────────────────────────
    def run(self):
        self._running = True

        # Create shared memory blocks
        self._shm_frame = ShmFrame(create=True)
        self._shm_keys  = ShmKeys(create=True)
        print('[driver] Shared memory created', flush=True)

        # Connect to keyboard
        if not self.connect():
            print('[driver] Keyboard not found — waiting for connection', flush=True)

        # Start threads
        threading.Thread(target=self._sender_thread,     daemon=True).start()
        threading.Thread(target=self._frame_reader_thread, daemon=True).start()
        threading.Thread(target=self._fade_ticker_thread, daemon=True).start()
        self._hook_thread()  # installs hook (returns after hook is ready)

        print('[driver] Running.', flush=True)

        # Poll for commands via file
        cmd_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'driver_cmd.json')
        try: os.remove(cmd_file)
        except: pass

        try:
            while self._running:
                time.sleep(0.1)
                if not os.path.exists(cmd_file):
                    continue
                try:
                    with open(cmd_file, 'r') as f:
                        content = f.read().strip()
                    if not content:
                        continue
                    try: os.remove(cmd_file)
                    except: pass
                    data = json.loads(content)
                    cmd = data.get('cmd', '')
                    payload = data.get('payload', {})
                    if cmd == 'STOP':
                        break
                    elif cmd == 'REACTIVE_CFG':
                        print(f'[driver] got REACTIVE_CFG payload={payload}', flush=True)
                        self.set_reactive_config(payload.get('layers'), payload.get('enabled', False))
                    elif cmd == 'SAVE_FLASH':
                        self._send_frame(payload)
                        with self._kb_lock:
                            if self._kb: self._kb.save()
                        print('[driver] Flash saved', flush=True)
                except (json.JSONDecodeError, OSError):
                    pass  # file mid-write, retry next tick
                except Exception as e:
                    print(f'[driver] cmd error: {e}', flush=True)
        except KeyboardInterrupt:
            pass

        self._running = False
        if self._shm_frame: self._shm_frame.close()
        if self._shm_keys:  self._shm_keys.close()
        print('[driver] Stopped.', flush=True)


if __name__ == '__main__':
    Driver().run()