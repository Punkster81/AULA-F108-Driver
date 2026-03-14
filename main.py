"""
AULA F108 Pro — RGB Driver App
Run with: python main.py
Build exe: pyinstaller aula_driver.spec
"""

import sys
import os
import json
import threading
import winreg

# ── Startup registry helpers ──────────────────────────────────────────────────
_STARTUP_KEY  = r"Software\Microsoft\Windows\CurrentVersion\Run"
_STARTUP_NAME = "AulaF108RGBDriver"

def _get_exe_path():
    if getattr(sys, 'frozen', False):
        return f'"{sys.executable}"'
    return f'"{sys.executable}" "{os.path.abspath(__file__)}"'

def set_startup(enable: bool) -> bool:
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, _STARTUP_KEY, 0, winreg.KEY_SET_VALUE)
        if enable:
            winreg.SetValueEx(key, _STARTUP_NAME, 0, winreg.REG_SZ, _get_exe_path())
        else:
            try:
                winreg.DeleteValue(key, _STARTUP_NAME)
            except FileNotFoundError:
                pass
        winreg.CloseKey(key)
        return True
    except Exception as e:
        print(f"Startup registration failed: {e}")
        return False

def is_startup_enabled() -> bool:
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, _STARTUP_KEY, 0, winreg.KEY_READ)
        winreg.QueryValueEx(key, _STARTUP_NAME)
        winreg.CloseKey(key)
        return True
    except FileNotFoundError:
        return False
    except Exception:
        return False
import webview

# ── Path helper (works both from source and PyInstaller bundle) ───────────────
def resource(rel):
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)

# ── Keyboard API (exposed to JS via window.pywebview.api) ─────────────────────
class KeyboardAPI:
    def __init__(self):
        self._kb = None
        self._lock = threading.Lock()

    # ── Connection ─────────────────────────────────────────────────────────────
    def connect(self):
        """
        Try to connect to the keyboard.
        Returns {ok, message, colors} where colors is {hex_idx: [r,g,b]} of
        the keyboard's current LED state (populated on success).
        """
        try:
            from aula_f108_pro_final import AulaF108Pro
            with self._lock:
                if self._kb:
                    self._kb.disconnect()
                self._kb = AulaF108Pro()
                colors = self._kb.connect()
                _reactive_state.start()
                if colors is not None:
                    self._kb.start()
                    return {'ok': True, 'message': 'Connected — VID:0C45 PID:800A', 'colors': colors}
                else:
                    self._kb = None
                    return {'ok': False, 'message': 'Keyboard not found. Is AULA software closed?', 'colors': {}}
        except Exception as e:
            return {'ok': False, 'message': str(e), 'colors': {}}

    def disconnect(self):
        with self._lock:
            if self._kb:
                self._kb.disconnect()
                self._kb = None
        return {'ok': True}

    def get_status(self):
        with self._lock:
            connected = self._kb is not None
        return {'connected': connected}

    # ── Color control ──────────────────────────────────────────────────────────
    def apply_colors(self, colors):
        """
        Apply a full color map to the keyboard immediately.
        colors: dict of {"hex_idx": [r, g, b], ...}  e.g. {"01": [255, 0, 0]}
        """
        with self._lock:
            if not self._kb:
                return {'ok': False, 'message': 'Not connected'}
            try:
                # Clear first, then apply only lit keys
                self._kb.clear()
                for idx_str, rgb in colors.items():
                    self._kb.set_index(int(idx_str, 16), rgb[0], rgb[1], rgb[2])
                return {'ok': True}
            except Exception as e:
                return {'ok': False, 'message': str(e)}

    def apply_frame(self, colors):
        """Same as apply_colors — used by animation playback."""
        return self.apply_colors(colors)

    def clear(self):
        with self._lock:
            if not self._kb:
                return {'ok': False, 'message': 'Not connected'}
            try:
                self._kb.clear()
                return {'ok': True}
            except Exception as e:
                return {'ok': False, 'message': str(e)}

    # ── Flash save ─────────────────────────────────────────────────────────────
    def save_to_flash(self, colors):
        """
        Burn colors to onboard flash.
        Returns {ok, message}.
        """
        with self._lock:
            if not self._kb:
                return {'ok': False, 'message': 'Not connected'}
            try:
                # Apply colors first so save picks them up
                self._kb.clear()
                for idx_str, rgb in colors.items():
                    self._kb.set_index(int(idx_str, 16), rgb[0], rgb[1], rgb[2])
                self._kb.save()
                return {'ok': True, 'message': 'Saved — colors will persist after power cycle'}
            except Exception as e:
                return {'ok': False, 'message': str(e)}


# ── Animation file helpers ────────────────────────────────────────────────────
def animations_dir():
    """Returns (and creates if needed) the 'animations' folder next to main.py / the exe."""
    if getattr(sys, 'frozen', False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    d = os.path.join(base, 'animations')
    os.makedirs(d, exist_ok=True)
    return d

def lighting_dir():
    """Returns (and creates if needed) the 'lighting' folder next to main.py / the exe."""
    if getattr(sys, 'frozen', False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    d = os.path.join(base, 'lighting')
    os.makedirs(d, exist_ok=True)
    return d

def colors_dir():
    """Returns (and creates if needed) the 'colors' folder next to main.py / the exe."""
    if getattr(sys, 'frozen', False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    d = os.path.join(base, 'colors')
    os.makedirs(d, exist_ok=True)
    return d

def layers_dir():
    """Returns (and creates if needed) the 'layers' folder next to main.py / the exe."""
    if getattr(sys, 'frozen', False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    d = os.path.join(base, 'layers')
    os.makedirs(d, exist_ok=True)
    return d

class AnimationAPI:
    def save_current_animation(self, data):
        """Save animation as current_animation.json and also write current.json pointer."""
        try:
            anim_path = os.path.join(animations_dir(), 'current_animation.json')
            with open(anim_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            current = {'type': 'animation', 'file': anim_path}
            with open(os.path.join(lighting_dir(), 'current.json'), 'w', encoding='utf-8') as f:
                json.dump(current, f, indent=2)
            return {'ok': True, 'path': anim_path}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    # ── Static lighting persistence ────────────────────────────────────────────
    def save_static_lighting(self, name, colors):
        """Save a static color map to lighting/<name>.json. Also updates current.json."""
        try:
            safe = ''.join(c if c.isalnum() or c in '-_ ' else '_' for c in name).strip() or 'lighting'
            fname = safe.replace(' ', '_').lower() + '.json'
            data = {'name': name, 'type': 'static', 'colors': colors}
            path = os.path.join(lighting_dir(), fname)
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            return {'ok': True, 'path': path, 'filename': fname}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def save_current_lighting(self, colors):
        """Overwrite lighting/current.json with the latest static color state."""
        try:
            data = {'type': 'static', 'colors': colors}
            with open(os.path.join(lighting_dir(), 'current.json'), 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def save_current_layers(self, layers_data):
        """Overwrite lighting/current.json with the latest layer stack state."""
        try:
            data = {'type': 'layers', 'layers': layers_data}
            with open(os.path.join(lighting_dir(), 'current.json'), 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def load_current_lighting(self):
        """
        Read lighting/current.json and return the last-used state.
        Returns {ok, type, colors} for static, {ok, type, animation} for animation,
        or {ok, type, layers} for a layer stack.
        """
        try:
            path = os.path.join(lighting_dir(), 'current.json')
            if not os.path.exists(path):
                return {'ok': False, 'reason': 'no_current'}
            with open(path, 'r', encoding='utf-8') as f:
                current = json.load(f)
            if current.get('type') == 'layers':
                return {'ok': True, 'type': 'layers', 'layers': current.get('layers', [])}
            if current.get('type') == 'animation':
                anim_path = current.get('file', '')
                if not os.path.exists(anim_path):
                    return {'ok': False, 'reason': 'missing_file'}
                with open(anim_path, 'r', encoding='utf-8') as f:
                    anim = json.load(f)
                return {'ok': True, 'type': 'animation', 'animation': anim}
            else:
                return {'ok': True, 'type': 'static', 'colors': current.get('colors', {})}
        except Exception as e:
            return {'ok': False, 'reason': str(e)}

    def list_static_lightings(self):
        """List all saved static lighting presets."""
        try:
            results = []
            d = lighting_dir()
            for fname in sorted(os.listdir(d)):
                if fname == 'current.json' or not fname.lower().endswith('.json'):
                    continue
                try:
                    with open(os.path.join(d, fname), 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    if data.get('type') == 'static':
                        data['_filename'] = fname
                        results.append(data)
                except Exception:
                    pass
            return {'ok': True, 'lightings': results}
        except Exception as e:
            return {'ok': False, 'lightings': [], 'message': str(e)}

    def delete_static_lighting(self, filename):
        """Delete a static lighting preset file."""
        try:
            path = os.path.join(lighting_dir(), os.path.basename(filename))
            if os.path.exists(path):
                os.remove(path)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def save_recent_colors(self, colors):
        """Save up to 18 recent colors to colors/recent.json."""
        try:
            path = os.path.join(colors_dir(), 'recent.json')
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(colors[:18], f)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def load_recent_colors(self):
        """Load recent colors from colors/recent.json."""
        try:
            path = os.path.join(colors_dir(), 'recent.json')
            if not os.path.exists(path):
                return {'ok': False, 'colors': []}
            with open(path, 'r', encoding='utf-8') as f:
                return {'ok': True, 'colors': json.load(f)}
        except Exception as e:
            return {'ok': False, 'colors': [], 'message': str(e)}

    def get_startup_enabled(self):
        """Return whether the app is registered to launch on Windows startup."""
        return {'ok': True, 'enabled': is_startup_enabled()}

    def set_startup_enabled(self, enable):
        """Register or deregister the app from Windows startup."""
        ok = set_startup(bool(enable))
        return {'ok': ok}

    def save_animation(self, name, data):
        """
        Save animation JSON to <app_dir>/animations/<name>.json
        data: the full animation object (dict)
        Returns {ok, path}
        """
        try:
            safe = ''.join(c if c.isalnum() or c in '-_ ' else '_' for c in name).strip() or 'animation'
            fname = safe.replace(' ', '_').lower() + '.json'
            path = os.path.join(animations_dir(), fname)
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            return {'ok': True, 'path': path, 'filename': fname}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def list_animations(self):
        """
        Scan <app_dir>/animations/ and return list of animation objects.
        Returns {ok, animations: [{name, filename, frames, loop, ...}]}
        """
        try:
            results = []
            d = animations_dir()
            for fname in sorted(os.listdir(d)):
                if not fname.lower().endswith('.json'):
                    continue
                try:
                    with open(os.path.join(d, fname), 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    data['_filename'] = fname
                    results.append(data)
                except Exception:
                    pass
            return {'ok': True, 'animations': results}
        except Exception as e:
            return {'ok': False, 'animations': [], 'message': str(e)}

    def delete_animation(self, filename):
        """Delete <app_dir>/animations/<filename>. Returns {ok}."""
        try:
            path = os.path.join(animations_dir(), os.path.basename(filename))
            if os.path.exists(path):
                os.remove(path)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    # ── Layer presets ──────────────────────────────────────────────────────────
    def save_layer_preset(self, name, data):
        """
        Save a layer stack to layers/<name>.json.
        data: { name, version, layers: [ {name, type, opacity, enabled, colors?, frames?, loop?} ] }
        Each layer is self-contained — static layers embed colors, anim layers embed frames.
        """
        try:
            safe = ''.join(c if c.isalnum() or c in '-_ ' else '_' for c in name).strip() or 'layers'
            fname = safe.replace(' ', '_').lower() + '.json'
            data['name'] = name
            data['version'] = 1
            path = os.path.join(layers_dir(), fname)
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            return {'ok': True, 'path': path, 'filename': fname}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def list_layer_presets(self):
        """List all saved layer preset files."""
        try:
            results = []
            d = layers_dir()
            for fname in sorted(os.listdir(d)):
                if not fname.lower().endswith('.json'):
                    continue
                try:
                    with open(os.path.join(d, fname), 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    results.append({
                        'filename': fname,
                        'name': data.get('name', fname),
                        'layer_count': len(data.get('layers', [])),
                        'layers': data.get('layers', []),
                    })
                except Exception:
                    pass
            return {'ok': True, 'presets': results}
        except Exception as e:
            return {'ok': False, 'presets': [], 'message': str(e)}

    def delete_layer_preset(self, filename):
        """Delete a layer preset file."""
        try:
            path = os.path.join(layers_dir(), os.path.basename(filename))
            if os.path.exists(path):
                os.remove(path)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    # ── Reactive key state ─────────────────────────────────────────────────────
    def start_key_listener(self):
        """Start the global key listener. Safe to call multiple times."""
        try:
            _reactive_state.start()
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def stop_key_listener(self):
        """Stop the global key listener."""
        try:
            _reactive_state.stop()
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def poll_keys(self, since_ts):
        """
        Poll key state since the given timestamp.
        Returns {ok, ts, held: [led_idx, ...], events: [{led, type, ts}]}
        """
        try:
            return _reactive_state.poll(since_ts)
        except Exception as e:
            return {'ok': False, 'message': str(e)}



# Tracks currently pressed LED indices and recent press events for the JS
# reactive layer system. Runs pynput in a daemon thread.

import time as _time

class ReactiveKeyState:
    def __init__(self):
        self._lock    = threading.Lock()
        self._held    = set()
        self._events  = []
        self._running = False

    def start(self):
        if self._running:
            return
        self._running = True
        t = threading.Thread(target=self._run, daemon=True)
        t.start()

    def stop(self):
        self._running = False
        # Post WM_QUIT to unblock the GetMessageW pump
        try:
            import ctypes
            ctypes.WinDLL('user32').PostQuitMessage(0)
        except Exception:
            pass

    def _run(self):
        import ctypes
        import ctypes.wintypes

        LLKHF_EXTENDED = 0x0001
        WH_KEYBOARD_LL = 13
        WM_KEYDOWN     = 0x0100
        WM_SYSKEYDOWN  = 0x0104
        WM_KEYUP       = 0x0101
        WM_SYSKEYUP    = 0x0105

        class KBDLLHOOKSTRUCT(ctypes.Structure):
            _fields_ = [
                ('vkCode',      ctypes.wintypes.DWORD),
                ('scanCode',    ctypes.wintypes.DWORD),
                ('flags',       ctypes.wintypes.DWORD),
                ('time',        ctypes.wintypes.DWORD),
                ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong)),
            ]

        user32 = ctypes.WinDLL('user32', use_last_error=True)

        NUMPAD_NUMLOCK_OFF = {
            35: '56',  # End   → Num1
            40: '57',  # Down  → Num2
            34: '58',  # PgDn  → Num3
            37: '44',  # Left  → Num4
            12: '45',  # Clear → Num5
            39: '46',  # Right → Num6
            36: '32',  # Home  → Num7
            38: '33',  # Up    → Num8
            33: '34',  # PgUp  → Num9
            45: '68',  # Ins   → Num0
            46: '69',  # Del   → Num.
        }

        def _is_numlock_on():
            return bool(user32.GetKeyState(144) & 1)

        def _resolve_led(vk, extended):
            # Numpad Enter: extended=True, main Enter: extended=False
            if vk == 13:
                return '6a' if extended else '55'
            # NumLock off: numpad keys report as nav-cluster VKs
            if not _is_numlock_on() and vk in NUMPAD_NUMLOCK_OFF:
                return NUMPAD_NUMLOCK_OFF[vk]
            return VK_TO_LED.get(vk)

        HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_int,
                                       ctypes.wintypes.WPARAM,
                                       ctypes.wintypes.LPARAM)

        user32.CallNextHookEx.restype  = ctypes.c_long
        user32.CallNextHookEx.argtypes = [
            ctypes.c_void_p, ctypes.c_int,
            ctypes.wintypes.WPARAM, ctypes.wintypes.LPARAM
        ]
        user32.SetWindowsHookExW.restype  = ctypes.c_void_p
        user32.SetWindowsHookExW.argtypes = [
            ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.wintypes.DWORD
        ]
        user32.UnhookWindowsHookEx.argtypes = [ctypes.c_void_p]

        def _hook_proc(nCode, wParam, lParam):
            if nCode >= 0:
                kb = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
                vk       = kb.vkCode
                extended = bool(kb.flags & LLKHF_EXTENDED)
                led      = _resolve_led(vk, extended)
                if led:
                    is_down = wParam in (WM_KEYDOWN, WM_SYSKEYDOWN)
                    is_up   = wParam in (WM_KEYUP,   WM_SYSKEYUP)
                    if is_down or is_up:
                        with self._lock:
                            if is_down:
                                print(f'[reactive] press led=0x{led}', flush=True)
                                self._held.add(led)
                                self._events.append((led, 'press', _time.time()))
                            else:
                                self._held.discard(led)
                                self._events.append((led, 'release', _time.time()))
                            if len(self._events) > 256:
                                self._events = self._events[-256:]
            return user32.CallNextHookEx(None, nCode, wParam, lParam)

        _proc = HOOKPROC(_hook_proc)

        # Hook must be installed AND pumped on the same thread.
        # Use a blocking GetMessageW pump — never sleeps, always ready.
        import queue as _queue
        _ready = threading.Event()

        def _pump_thread():
            nonlocal _proc
            h = user32.SetWindowsHookExW(WH_KEYBOARD_LL, _proc, None, 0)
            if not h:
                print(f'[reactive] SetWindowsHookExW failed: {ctypes.get_last_error()}', flush=True)
                _ready.set()
                return
            _ready.set()
            # Blocking message pump — GetMessageW blocks until a message arrives
            msg = ctypes.wintypes.MSG()
            while self._running:
                ret = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if ret == 0 or ret == -1:
                    break
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
            user32.UnhookWindowsHookEx(h)

        t = threading.Thread(target=_pump_thread, daemon=True)
        t.start()
        _ready.wait(timeout=2.0)  # wait for hook to be installed before returning


    def poll(self, since_ts: float):
        """Return held keys + events since since_ts. Called by JS every frame."""
        with self._lock:
            now = _time.time()
            events = [
                {'led': e[0], 'type': e[1], 'ts': e[2]}
                for e in self._events if e[2] >= since_ts
            ]
            held = list(self._held)
        return {'ok': True, 'ts': now, 'held': held, 'events': events}


# VK → LED index map (Windows Virtual Key codes → AULA F108 LED indices)
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

_reactive_state = ReactiveKeyState()


# ── App entry point ───────────────────────────────────────────────────────────
def main():
    kb_api = KeyboardAPI()
    anim_api = AnimationAPI()

    # Merge both APIs into a single object for pywebview
    class CombinedAPI(KeyboardAPI, AnimationAPI):
        pass
    api = CombinedAPI()

    window = webview.create_window(
        title     = 'AULA F108 Pro — RGB Driver',
        url       = resource('ui/index.html'),
        js_api    = api,
        width     = 1400,
        height    = 780,
        min_size  = (900, 600),
        resizable = True,
    )

    # Clean up keyboard on window close
    def on_close():
        api.disconnect()

    window.events.closed += on_close

    webview.start(debug=False)


if __name__ == '__main__':
    main()