"""
AULA F108 Pro — RGB Driver App
Run with: python main.py
Build exe: pyinstaller --onefile --windowed --add-data "ui;ui" --icon icon.ico --name aula_driver main.py
"""

import sys
import os
import json
import threading
import winreg
import subprocess as _subprocess
import multiprocessing

VERSION = 'v1.0.15'
GITHUB_REPO = 'Punkster81/AULA-F108-Driver'

# ── Update system ─────────────────────────────────────────────────────────────
def _get_current_exe():
    if getattr(sys, 'frozen', False):
        return sys.executable
    return None

def _check_for_update():
    try:
        import urllib.request
        url = f'https://api.github.com/repos/{GITHUB_REPO}/releases/latest'
        req = urllib.request.Request(url, headers={'User-Agent': 'aula-f108-driver'})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read())
        latest = data.get('tag_name', '')
        if latest and latest != VERSION:
            asset_url = None
            for asset in data.get('assets', []):
                if asset['name'] == 'aula_driver.exe':
                    asset_url = asset['browser_download_url']
                    break
            return {'version': latest, 'url': asset_url, 'notes': data.get('body', '')}
        return None
    except Exception as e:
        print(f'[updater] update check failed: {e}', flush=True)
        return None

def _download_and_apply_update(asset_url):
    try:
        import urllib.request
        exe_path = _installed_exe() if _is_frozen() else None
        if not exe_path:
            return {'ok': False, 'message': 'Not running as exe — update manually'}

        exe_dir  = os.path.dirname(exe_path)
        new_exe  = os.path.join(exe_dir, '_update_new.exe')
        bat_path = os.path.join(exe_dir, '_updater.bat')

        print(f'[updater] downloading {asset_url}', flush=True)
        urllib.request.urlretrieve(asset_url, new_exe)
        print(f'[updater] download complete, size={os.path.getsize(new_exe)}', flush=True)

        bat = f'''@echo off
:: Wait for the old process to fully exit
timeout /t 2 /nobreak >nul

:: Retry move up to 10 times (1s each)
set /a tries=0
:retry
move /y "{new_exe}" "{exe_path}"
if errorlevel 1 (
    set /a tries+=1
    if %tries% lss 10 (
        timeout /t 1 /nobreak >nul
        goto retry
    )
    echo Failed to replace exe after 10 attempts
    exit /b 1
)

:: Relaunch via PowerShell with elevation
powershell -NonInteractive -WindowStyle Hidden -Command "Start-Process '{exe_path}' -Verb RunAs"

:: Self-delete
(goto) 2>nul & del "%~f0"
'''
        with open(bat_path, 'w') as f:
            f.write(bat)

        print(f'[updater] launching updater bat: {bat_path}', flush=True)
        _subprocess.Popen(
            ['cmd', '/c', bat_path],
            creationflags=_subprocess.CREATE_NEW_PROCESS_GROUP,
            close_fds=True,
        )
        _send_driver_cmd('STOP')
        if _driver_proc is not None:
            try: _driver_proc.terminate()
            except: pass
        import time; time.sleep(1.5)
        os._exit(0)
    except Exception as e:
        print(f'[updater] update failed: {e}', flush=True)
        return {'ok': False, 'message': str(e)}

# ── App data directory + install helpers ─────────────────────────────────────
# These must be defined BEFORE the __main__ block since first-run install
# runs there before webview is imported.

APP_FOLDER    = 'AulaF108Driver'
_STARTUP_KEY  = r"Software\Microsoft\Windows\CurrentVersion\Run"
_STARTUP_NAME = "AulaF108RGBDriver"

def _is_frozen():
    return getattr(sys, 'frozen', False)

def _appdata_dir():
    base = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
    d = os.path.join(base, APP_FOLDER)
    os.makedirs(d, exist_ok=True)
    return d

def _installed_exe():
    return os.path.join(_appdata_dir(), 'aula_driver.exe')

def _is_running_from_install():
    if not _is_frozen():
        return True  # source mode — skip install
    return os.path.normcase(sys.executable) == os.path.normcase(_installed_exe())

def _userdata_base():
    return _appdata_dir() if _is_frozen() else os.path.dirname(os.path.abspath(__file__))

def _grouped_to_flat(colors):
    """Convert grouped {rrggbb:[idx,...]} or flat {idx:[r,g,b]} to flat {idx:[r,g,b]}."""
    if not colors:
        return {}
    first_val = next(iter(colors.values()), None)
    if isinstance(first_val, list) and first_val and isinstance(first_val[0], str):
        # Grouped format: {rrggbb: [idx, ...]}
        out = {}
        for hex_color, idxs in colors.items():
            r = int(hex_color[0:2], 16)
            g = int(hex_color[2:4], 16)
            b = int(hex_color[4:6], 16)
            for idx in idxs:
                out[idx] = [r, g, b]
        return out
    return colors  # already flat

def _make_dir(name):
    d = os.path.join(_userdata_base(), name)
    os.makedirs(d, exist_ok=True)
    return d

def _send_driver_cmd(cmd: str, payload=None):
    try:
        base = _appdata_dir() if _is_frozen() else os.path.dirname(os.path.abspath(__file__))
        tmp_file = os.path.join(base, 'driver_cmd.tmp')
        cmd_file = os.path.join(base, 'driver_cmd.json')
        data = {'cmd': cmd}
        if payload is not None:
            data['payload'] = payload
        with open(tmp_file, 'w') as f:
            json.dump(data, f)
        os.replace(tmp_file, cmd_file)
    except Exception:
        pass

def _first_run_install():
    import shutil, time

    install_path = _installed_exe()
    install_dir  = _appdata_dir()
    src          = sys.executable
    bat_path     = os.path.join(install_dir, '_installer.bat')

    print(f'[install] Installing to {install_path}', flush=True)

    # Desktop shortcut path
    desktop  = os.path.join(os.path.expanduser('~'), 'Desktop')
    shortcut = os.path.join(desktop, 'AULA F108 Driver.lnk')

    # PowerShell command to create shortcut (runs after copy in bat)
    ps_cmd = (
        f'$ws = New-Object -ComObject WScript.Shell; '
        f'$s = $ws.CreateShortcut(\\"{shortcut}\\"); '
        f'$s.TargetPath = \\"{install_path}\\"; '
        f'$s.IconLocation = \\"{install_path}\\"; '
        f'$s.Description = \\"AULA F108 Pro RGB Driver\\"; '
        f'$s.Save()'
    )

    # Bat: wait for us to exit, copy exe, create shortcut, relaunch
    bat = f'''@echo off
timeout /t 3 /nobreak >nul
copy /y "{src}" "{install_path}"
powershell -NonInteractive -Command "{ps_cmd}"
start "" "{install_path}"
timeout /t 2 /nobreak >nul
del /f /q "{src}"
del "%~f0"
'''
    os.makedirs(install_dir, exist_ok=True)
    with open(bat_path, 'w') as f:
        f.write(bat)

    # Register startup pointing to install location
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, _STARTUP_KEY, 0, winreg.KEY_SET_VALUE)
        winreg.SetValueEx(key, _STARTUP_NAME, 0, winreg.REG_SZ, f'"{install_path}"')
        winreg.CloseKey(key)
    except Exception as e:
        print(f'[install] Startup registration failed: {e}', flush=True)

    # Launch bat detached, then exit so the exe is no longer locked
    _subprocess.Popen(
        ['cmd', '/c', bat_path],
        creationflags=_subprocess.CREATE_NEW_PROCESS_GROUP | _subprocess.DETACHED_PROCESS,
    )
    return True

# ── Driver process ────────────────────────────────────────────────────────────
_driver_proc = None
_shm_frame   = None
_shm_keys    = None

def _launch_driver_early():
    global _driver_proc, _shm_frame, _shm_keys
    import time as _t
    import driver as _driver_mod

    _driver_proc = multiprocessing.Process(
        target=_driver_mod.main,
        daemon=True,
        name='AulaF108Driver',
    )
    _driver_proc.start()
    print(f'[ui] Driver process started (pid {_driver_proc.pid})', flush=True)

    for attempt in range(10):
        _t.sleep(0.8)
        try:
            from driver import ShmFrame, ShmKeys
            _shm_frame = ShmFrame(create=False)
            _shm_keys  = ShmKeys(create=False)
            print(f'[ui] Attached to driver shared memory (attempt {attempt+1})', flush=True)
            return
        except Exception as e:
            print(f'[ui] shm attach attempt {attempt+1} failed: {e}', flush=True)

    print('[ui] Could not attach to driver shared memory after 10 attempts', flush=True)

# ── Self-elevate if needed, then launch driver ────────────────────────────────
if __name__ == '__main__':
    # freeze_support must be called before anything else in the frozen main process
    multiprocessing.freeze_support()

    try:
        import ctypes as _ctypes
        if not _ctypes.windll.shell32.IsUserAnAdmin():
            script = os.path.abspath(__file__)
            params = ' '.join(f'"{a}"' for a in sys.argv[1:])
            ret = _ctypes.windll.shell32.ShellExecuteW(
                None, 'runas', sys.executable, f'"{script}" {params}', None, 1
            )
            if ret > 32:
                sys.exit(0)
    except Exception as _e:
        print(f'[ui] elevation check failed: {_e}', flush=True)

    # First run: install to appdata, create shortcut, relaunch
    if _is_frozen() and not _is_running_from_install():
        if _first_run_install():
            os._exit(0)  # exit immediately so exe lock is released for the bat to copy it

    try:
        _launch_driver_early()
    except Exception as _e:
        print(f'[ui] driver launch failed: {_e}', flush=True)
        import traceback; traceback.print_exc()

import webview

def _get_exe_path():
    if _is_frozen():
        return f'"{_installed_exe()}"'
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

def _stop_driver():
    global _driver_proc
    _send_driver_cmd('STOP')
    if _driver_proc is not None:
        try: _driver_proc.terminate()
        except: pass
    _driver_proc = None

# ── Keyboard API (exposed to JS via window.pywebview.api) ─────────────────────
class KeyboardAPI:
    def __init__(self):
        pass  # HID now owned by driver process

    def connect(self):
        import time as _t
        for _ in range(15):
            if _driver_proc is not None and _driver_proc.is_alive():
                return {'ok': True, 'message': 'Connected — VID:0C45 PID:800A', 'colors': {}}
            _t.sleep(0.2)
        return {'ok': False, 'message': 'Keyboard not found. Is AULA software closed?', 'colors': {}}

    def disconnect(self):
        return {'ok': True}

    def get_status(self):
        alive = _driver_proc is not None and _driver_proc.is_alive()
        return {'connected': alive}

    def apply_colors(self, colors):
        if _shm_frame:
            try:
                _shm_frame.write(_grouped_to_flat(colors))
                return {'ok': True}
            except Exception as e:
                return {'ok': False, 'message': str(e)}
        return {'ok': True}

    def apply_frame(self, colors):
        return self.apply_colors(colors)

    def clear(self):
        return self.apply_colors({})

    def save_to_flash(self, colors):
        """Send SAVE_FLASH command to driver process."""
        _send_driver_cmd('SAVE_FLASH', _grouped_to_flat(colors))
        return {'ok': True, 'message': 'Saved — colors will persist after power cycle'}


def animations_dir(): return _make_dir('animations')
def lighting_dir():   return _make_dir('lighting')
def colors_dir():     return _make_dir('colors')
def layers_dir():     return _make_dir('layers')
def reactive_dir():   return _make_dir('reactive')
def soundboard_dir(): return _make_dir('soundboard')
def sounds_dir():     return _make_dir('soundboard/sounds')

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

    def save_current_lighting(self, colors, name=None):
        """Overwrite lighting/current.json with the latest static color state."""
        try:
            data = {'type': 'static', 'colors': colors}
            if name: data['name'] = name
            with open(os.path.join(lighting_dir(), 'current.json'), 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def save_current_layers(self, layers_data, name=None):
        """Overwrite lighting/current.json with the latest layer stack state."""
        try:
            data = {'type': 'layers', 'layers': layers_data}
            if name: data['name'] = name
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
            name = current.get('name')
            if current.get('type') == 'layers':
                return {'ok': True, 'type': 'layers', 'layers': current.get('layers', []), 'name': name}
            if current.get('type') == 'animation':
                anim_path = current.get('file', '')
                if not os.path.exists(anim_path):
                    return {'ok': False, 'reason': 'missing_file'}
                with open(anim_path, 'r', encoding='utf-8') as f:
                    anim = json.load(f)
                return {'ok': True, 'type': 'animation', 'animation': anim, 'name': name}
            else:
                return {'ok': True, 'type': 'static', 'colors': current.get('colors', {}), 'name': name}
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

    # ── Reactive presets ───────────────────────────────────────────────────────
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

    def update_reactive_config(self, layers, enabled):
        """Send reactive config to driver via command file."""
        try:
            _send_driver_cmd('REACTIVE_CFG', {'layers': layers, 'enabled': enabled})
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def update_layer_config(self, layers, enabled):
        """Send full layer stack to driver for hardware-side compositing."""
        try:
            _send_driver_cmd('LAYER_CFG', {'layers': layers, 'enabled': bool(enabled)})
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

    def get_version(self):
        return {'ok': True, 'version': VERSION}

    def open_data_folder(self):
        """Open the user data directory in Windows Explorer."""
        try:
            _subprocess.Popen(['explorer', _userdata_base()])
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def check_for_update(self):
        result = _check_for_update()
        if result:
            return {'ok': True, 'available': True, 'version': result['version'],
                    'url': result['url'], 'notes': result['notes']}
        return {'ok': True, 'available': False}

    def open_url(self, url):
        """Open a URL in the default browser."""
        try:
            import webbrowser
            webbrowser.open(url)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}




# ── Soundboard API ───────────────────────────────────────────────────────────
class SoundboardAPI:
    def _sb_cards_path(self):
        return os.path.join(soundboard_dir(), 'cards.json')

    def _load_cards(self):
        p = self._sb_cards_path()
        if not os.path.exists(p):
            return []
        try:
            with open(p, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if not isinstance(data, list):
                print(f'[soundboard] cards.json is not a list, resetting', flush=True)
                return []
            return data
        except Exception as e:
            print(f'[soundboard] Failed to load cards.json: {e}', flush=True)
            bak = p + '.bak'
            if os.path.exists(bak):
                try:
                    with open(bak, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    print(f'[soundboard] Restored from backup', flush=True)
                    return data if isinstance(data, list) else []
                except Exception:
                    pass
            return []

    def _save_cards(self, cards):
        p = self._sb_cards_path()
        tmp = p + '.tmp'
        bak = p + '.bak'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(cards, f, indent=2)
        if os.path.exists(p):
            try: os.replace(p, bak)
            except: pass
        os.replace(tmp, p)

    _cards_lock = threading.Lock()

    def _sync_driver(self, cards):
        def _extract_vk(entry):
            if isinstance(entry, dict): return entry.get('vk', 0)
            return int(entry)
        _send_driver_cmd('SOUNDBOARD_CFG', {'cards': [
            {'id': c['id'], 'combo': [_extract_vk(e) for e in c.get('combo', [])], 'name': c.get('name', '')}
            for c in cards
        ]})

    def list_soundboard_cards(self):
        try:
            cards = self._load_cards()
            for card in cards:
                sp = card.get('soundPath')
                card['_soundMissing'] = bool(sp) and not os.path.exists(sp)
            return {'ok': True, 'cards': cards}
        except Exception as e:
            return {'ok': False, 'cards': [], 'message': str(e)}

    def save_soundboard_card(self, card):
        try:
            with self._cards_lock:
                cards = self._load_cards()
                idx = next((i for i,c in enumerate(cards) if c['id']==card['id']), None)
                if idx is not None:
                    cards[idx] = card
                else:
                    cards.append(card)
                self._save_cards(cards)
            self._sync_driver(cards)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def delete_soundboard_card(self, card_id):
        try:
            with self._cards_lock:
                all_cards = self._load_cards()
                deleted = next((c for c in all_cards if c['id'] == card_id), None)
                cards = [c for c in all_cards if c['id'] != card_id]
                self._save_cards(cards)
            # Delete the associated sound file if it exists
            if deleted and deleted.get('soundPath'):
                try:
                    if os.path.exists(deleted['soundPath']):
                        os.remove(deleted['soundPath'])
                        print(f'[soundboard] Deleted sound file: {deleted["soundPath"]}', flush=True)
                except Exception as e:
                    print(f'[soundboard] Failed to delete sound file: {e}', flush=True)
            self._sync_driver(cards)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def pick_and_copy_sound(self, card_id):
        """Open file dialog, copy chosen file to sounds dir, return path."""
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk(); root.withdraw(); root.attributes('-topmost', True)
            path = filedialog.askopenfilename(
                title='Choose a sound file',
                filetypes=[('Audio files', '*.mp3 *.wav *.ogg *.flac *.m4a'), ('All files', '*.*')]
            )
            root.destroy()
            if not path:
                return {'ok': False, 'cancelled': True}
            # Delete existing sound file for this card if there is one
            with self._cards_lock:
                cards = self._load_cards()
            existing = next((c for c in cards if c['id'] == card_id), None)
            if existing and existing.get('soundPath'):
                try:
                    if os.path.exists(existing['soundPath']):
                        os.remove(existing['soundPath'])
                except Exception:
                    pass
            import shutil
            dest_dir = sounds_dir()
            fname    = f'{card_id}_{os.path.basename(path)}'
            dest     = os.path.join(dest_dir, fname)
            shutil.copy2(path, dest)
            return {'ok': True, 'path': dest, 'filename': fname}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def cleanup_orphaned_sounds(self, active_paths):
        """Delete sound files in the sounds dir not referenced by any active card."""
        try:
            d = sounds_dir()
            active = set(os.path.normcase(p) for p in active_paths if p)
            removed = []
            for fname in os.listdir(d):
                fpath = os.path.join(d, fname)
                if os.path.isfile(fpath) and os.path.normcase(fpath) not in active:
                    os.remove(fpath)
                    removed.append(fname)
            if removed:
                print(f'[soundboard] Removed orphaned sounds: {removed}', flush=True)
            return {'ok': True, 'removed': removed}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def read_sound_file(self, path):
        """Read sound file as base64 so JS can play it via Web Audio."""
        try:
            import base64
            with open(path, 'rb') as f:
                data = base64.b64encode(f.read()).decode('utf-8')
            ext = os.path.splitext(path)[1].lower().lstrip('.')
            mime = {'mp3':'audio/mpeg','wav':'audio/wav','ogg':'audio/ogg',
                    'flac':'audio/flac','m4a':'audio/mp4'}.get(ext,'audio/mpeg')
            return {'ok': True, 'data': data, 'mime': mime}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def poll_soundboard_trigger(self, since_ts):
        """Check if a soundboard trigger has fired since since_ts."""
        try:
            if _is_frozen():
                base = os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'AulaF108Driver')
            else:
                base = os.path.dirname(os.path.abspath(__file__))
            path = os.path.join(base, 'soundboard_trigger.json')
            if not os.path.exists(path):
                return {'ok': True, 'triggered': False}
            with open(path, 'r') as f:
                data = json.load(f)
            if data.get('ts', 0) > since_ts:
                return {'ok': True, 'triggered': True, 'id': data['id'], 'ts': data['ts']}
            return {'ok': True, 'triggered': False}
        except Exception:
            return {'ok': True, 'triggered': False}

    def check_vb_audio(self):
        """Check if VB-Audio Virtual Cable is installed."""
        try:
            import subprocess

            # Method 1: Check via PowerShell audio endpoints (most reliable)
            ps = (
                'Add-Type -AssemblyName System.Runtime.InteropServices; '
                'Get-WmiObject Win32_SoundDevice | Select-Object -ExpandProperty Name'
            )
            result = subprocess.run(
                ['powershell', '-NonInteractive', '-Command',
                 'Get-WmiObject Win32_SoundDevice | Select-Object -ExpandProperty Name'],
                capture_output=True, text=True, timeout=8
            )
            devices = result.stdout.strip().lower()
            if 'cable' in devices or 'vb-audio' in devices or 'vbcable' in devices:
                # Find the actual name
                for line in result.stdout.strip().splitlines():
                    if any(k in line.lower() for k in ('cable', 'vb-audio', 'vbcable')):
                        return {'ok': True, 'installed': True, 'device': line.strip()}

            # Method 2: Check registry for the driver
            ps2 = (
                'Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Services" | '
                'Where-Object {$_.Name -like "*VBAudioVACMM*" -or $_.Name -like "*vbcable*"} | '
                'Select-Object -ExpandProperty Name'
            )
            result2 = subprocess.run(
                ['powershell', '-NonInteractive', '-Command', ps2],
                capture_output=True, text=True, timeout=8
            )
            if result2.stdout.strip():
                return {'ok': True, 'installed': True, 'device': 'VB-Audio Virtual Cable'}

            # Method 3: Check if the driver file exists
            driver_paths = [
                r'C:\Windows\System32\drivers\vbcable.sys',
                r'C:\Windows\SysWOW64\drivers\vbcable.sys',
            ]
            for p in driver_paths:
                if os.path.exists(p):
                    return {'ok': True, 'installed': True, 'device': 'VB-Audio Virtual Cable'}

            return {'ok': True, 'installed': False}

        except Exception as e:
            print(f'[soundboard] VB-Audio check failed: {e}', flush=True)
            # If we can't check, assume it might be there and let user try
            return {'ok': True, 'installed': False, 'message': str(e)}

    def install_vb_audio(self):
        """Download and silently install VB-Audio Virtual Cable."""
        try:
            import urllib.request
            import subprocess
            import zipfile
            import tempfile
            import shutil

            url = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip'
            tmp_dir  = tempfile.mkdtemp(prefix='vbcable_')
            zip_path = os.path.join(tmp_dir, 'vbcable.zip')

            print(f'[soundboard] Downloading to {zip_path}...', flush=True)
            urllib.request.urlretrieve(url, zip_path)
            zip_size = os.path.getsize(zip_path)
            print(f'[soundboard] Downloaded {zip_size} bytes', flush=True)

            if zip_size < 100000:
                return {'ok': False, 'message': f'Download too small ({zip_size} bytes) — check internet connection'}

            with zipfile.ZipFile(zip_path, 'r') as z:
                names = z.namelist()
                print(f'[soundboard] Zip contents: {names}', flush=True)
                z.extractall(tmp_dir)

            # List everything extracted
            all_files = []
            for root, dirs, files in os.walk(tmp_dir):
                for f in files:
                    all_files.append(os.path.join(root, f))
            print(f'[soundboard] Extracted files: {all_files}', flush=True)

            # Find the 64-bit setup exe — prefer x64, fall back to 32-bit
            installer = None
            for preferred in ('VBCABLE_Setup_x64.exe', 'VBCABLE_Setup.exe'):
                for f in all_files:
                    if os.path.basename(f) == preferred:
                        installer = f; break
                if installer: break

            if not installer:
                return {'ok': False, 'message': f'No installer found. Files: {[os.path.basename(f) for f in all_files]}'}

            print(f'[soundboard] Running installer: {installer}', flush=True)

            result = subprocess.run(
                [installer],
                timeout=120,
                capture_output=True,
            )
            stdout = result.stdout.decode(errors='ignore')
            stderr = result.stderr.decode(errors='ignore')
            print(f'[soundboard] pnputil exit code: {result.returncode}', flush=True)
            if stdout: print(f'[soundboard] stdout: {stdout}', flush=True)
            if stderr: print(f'[soundboard] stderr: {stderr}', flush=True)

            if result.returncode not in (0, 1, 3010):
                return {'ok': False, 'message': f'pnputil failed (exit {result.returncode}): {stderr[:300] if stderr else stdout[:300]}'}

            try: shutil.rmtree(tmp_dir, ignore_errors=True)
            except: pass

            # Poll for the device to actually appear — retry up to 10 seconds
            import time
            print('[soundboard] Waiting for device to appear...', flush=True)
            for attempt in range(10):
                time.sleep(1)
                check = self.check_vb_audio()
                if check.get('installed'):
                    print(f'[soundboard] Device detected after {attempt+1}s', flush=True)
                    return {'ok': True, 'installed': True, 'message': 'VB-Audio Virtual Cable installed successfully.'}
                print(f'[soundboard] Device not yet visible (attempt {attempt+1}/10)...', flush=True)

            # Device still not visible after 10s — needs reboot
            if result.returncode == 3010:
                return {'ok': True, 'installed': False, 'needs_restart': True,
                        'message': 'Driver installed — please restart Windows for the audio device to appear.'}

            # pnputil said success but device never appeared
            return {'ok': False, 'message': 'Driver install ran but the audio device did not appear. Try restarting Windows, or install VB-Audio manually.'}

        except Exception as e:
            import traceback
            print(f'[soundboard] VB-Audio install error:\n{traceback.format_exc()}', flush=True)
            return {'ok': False, 'message': str(e)}

    def open_vb_audio_page(self):
        """Open VB-Audio download page in browser as fallback."""
        try:
            import webbrowser
            webbrowser.open('https://vb-audio.com/Cable/')
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def sync_soundboard_to_driver(self):
        """Send all soundboard cards to the driver process."""
        try:
            cards = self._load_cards()
            self._sync_driver(cards)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

    def set_soundboard_recording(self, recording):
        """Tell driver to pause trigger matching while recording a combo."""
        try:
            _send_driver_cmd('SOUNDBOARD_RECORDING', {'recording': bool(recording)})
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'message': str(e)}


# ── App entry point ───────────────────────────────────────────────────────────
def main():
    # Driver already launched and shm already attached at module level
    # (before webview import, to avoid CEF subprocess conflicts)

    # Merge both APIs into a single object for pywebview
    class CombinedAPI(KeyboardAPI, AnimationAPI, SoundboardAPI):
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

    webview.start(debug=False, private_mode=False, storage_path=os.path.join(_appdata_dir(), 'webview_storage'))


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
