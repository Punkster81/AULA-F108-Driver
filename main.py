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
import subprocess as _subprocess

# ── Launch driver subprocess BEFORE importing webview ─────────────────────────
# pywebview/CEF crashes if subprocesses are spawned after it initializes.
# Start driver here at the very top, before any webview import.
_driver_proc = None
_shm_frame   = None
_shm_keys    = None

def _launch_driver_early():
    global _driver_proc, _shm_frame, _shm_keys
    import ctypes
    driver_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'driver.py')

    # Always spawn driver directly — main.py self-elevates at startup if needed
    _driver_proc = _subprocess.Popen(
        [sys.executable, driver_script],
        stdin=_subprocess.DEVNULL,
        creationflags=getattr(_subprocess, 'CREATE_NEW_PROCESS_GROUP', 0),
    )

    import time as _t; _t.sleep(1.2)
    try:
        from driver import ShmFrame, ShmKeys
        _shm_frame = ShmFrame(create=False)
        _shm_keys  = ShmKeys(create=False)
        print('[ui] Attached to driver shared memory', flush=True)
    except Exception as e:
        print(f'[ui] shm attach failed: {e}', flush=True)

    import time as _t; _t.sleep(1.2)
    try:
        from driver import ShmFrame, ShmKeys
        _shm_frame = ShmFrame(create=False)
        _shm_keys  = ShmKeys(create=False)
        print('[ui] Attached to driver shared memory', flush=True)
    except Exception as e:
        print(f'[ui] shm attach failed: {e}', flush=True)

# ── Self-elevate if needed, then launch driver ────────────────────────────────
if __name__ == '__main__':
    try:
        import ctypes as _ctypes
        if not _ctypes.windll.shell32.IsUserAnAdmin():
            # Relaunch self as admin and exit this non-admin instance immediately
            # Don't launch the driver yet — the elevated instance will do it
            script = os.path.abspath(__file__)
            params = ' '.join(f'"{a}"' for a in sys.argv[1:])
            ret = _ctypes.windll.shell32.ShellExecuteW(
                None, 'runas', sys.executable, f'"{script}" {params}', None, 1
            )
            if ret > 32:
                sys.exit(0)  # elevated copy launched, we're done
    except Exception as _e:
        print(f'[ui] elevation check failed: {_e}', flush=True)

    # Only reach here if already admin (or elevation failed)
    try:
        _launch_driver_early()
    except Exception as _e:
        print(f'[ui] driver launch failed: {_e}', flush=True)
        import traceback; traceback.print_exc()

import webview
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

# ── Path helper (works both from source and PyInstaller bundle) ───────────────
def resource(rel):
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)

def _send_driver_cmd(cmd: str, payload=None):
    """Write a structured JSON command file for the driver to pick up."""
    try:
        base = os.path.dirname(os.path.abspath(__file__))
        tmp_file = os.path.join(base, 'driver_cmd.tmp')
        cmd_file = os.path.join(base, 'driver_cmd.json')
        data = {'cmd': cmd}
        if payload is not None:
            data['payload'] = payload
        with open(tmp_file, 'w') as f:
            json.dump(data, f)
        os.replace(tmp_file, cmd_file)  # atomic on Windows
        print(f'[ui] sent cmd={cmd_type}', flush=True)
    except Exception:
        pass

def _stop_driver():
    global _driver_proc
    _send_driver_cmd('STOP')
    if _driver_proc and hasattr(_driver_proc, 'terminate'):
        try: _driver_proc.terminate()
        except: pass
    _driver_proc = None

# ── Keyboard API (exposed to JS via window.pywebview.api) ─────────────────────
class KeyboardAPI:
    def __init__(self):
        pass  # HID now owned by driver process

    def connect(self):
        import time as _t
        # Wait up to 3s for driver to be alive
        for _ in range(15):
            if _driver_proc is not None and _driver_proc.poll() is None:
                return {'ok': True, 'message': 'Connected — VID:0C45 PID:800A', 'colors': {}}
            _t.sleep(0.2)
        return {'ok': False, 'message': 'Keyboard not found. Is AULA software closed?', 'colors': {}}

    def disconnect(self):
        return {'ok': True}

    def get_status(self):
        alive = _driver_proc is not None and _driver_proc.poll() is None
        return {'connected': alive}

    def apply_colors(self, colors):
        if _shm_frame:
            try:
                _shm_frame.write(colors)
                return {'ok': True}
            except Exception as e:
                return {'ok': False, 'message': str(e)}
        return {'ok': True}  # driver still starting, silently skip

    def apply_frame(self, colors):
        return self.apply_colors(colors)

    def clear(self):
        return self.apply_colors({})

    def save_to_flash(self, colors):
        """Send SAVE_FLASH command to driver process."""
        _send_driver_cmd('SAVE_FLASH', colors)
        return {'ok': True, 'message': 'Saved — colors will persist after power cycle'}


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

def reactive_dir():
    """Returns (and creates if needed) the 'reactive' folder next to main.py / the exe."""
    if getattr(sys, 'frozen', False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    d = os.path.join(base, 'reactive')
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
    def save_reactive_preset(self, name, data):
        try:
            safe = ''.join(c if c.isalnum() or c in '-_ ' else '_' for c in name).strip() or 'reactive'
            fname = safe.replace(' ', '_').lower() + '.json'
            data['name'] = name
            path = os.path.join(reactive_dir(), fname)
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            return {'ok': True, 'path': path, 'filename': fname}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def list_reactive_presets(self):
        try:
            results = []
            d = reactive_dir()
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
            return {'ok': True, 'presets': results}
        except Exception as e:
            return {'ok': False, 'presets': [], 'message': str(e)}

    def delete_reactive_preset(self, filename):
        try:
            path = os.path.join(reactive_dir(), os.path.basename(filename))
            if os.path.exists(path):
                os.remove(path)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

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

    def update_reactive_config(self, layers, enabled):
        """Send reactive config to driver via command file."""
        try:
            _send_driver_cmd('REACTIVE_CFG', {'layers': layers, 'enabled': enabled})
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def start_key_listener(self):
        return {'ok': True}

    def stop_key_listener(self):
        return {'ok': True}

    def poll_keys(self, since_ts):
        try:
            if not _shm_keys:
                return {'ok': True, 'ts': since_ts, 'held': [], 'events': []}
            events, held, now = _shm_keys.read_events(since_ts)
            return {'ok': True, 'ts': now, 'held': list(held), 'events': events}
        except Exception as e:
            return {'ok': False, 'message': str(e)}




# ── App entry point ───────────────────────────────────────────────────────────
def main():
    # Driver already launched and shm already attached at module level
    # (before webview import, to avoid CEF subprocess conflicts)

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

    import atexit
    atexit.register(_stop_driver)

    def on_close():
        # Don't block here — .NET FormClosed callback must return immediately
        # Driver cleanup happens via atexit when Python process exits
        threading.Thread(target=_stop_driver, daemon=True).start()
    window.events.closed += on_close

    webview.start(debug=False)


if __name__ == '__main__':
    import traceback
    try:
        main()
    except SystemExit:
        pass
    except Exception as e:
        traceback.print_exc()
        input('Press Enter to exit...')
    except BaseException as e:
        traceback.print_exc()
        input('Press Enter to exit...')