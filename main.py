"""
AULA F108 Pro — RGB Driver App
Run with: python main.py
Build exe: pyinstaller aula_driver.spec
"""

import sys
import os
import json
import threading
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
        Burn colors to onboard flash. Blocks ~2s.
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

    def load_current_lighting(self):
        """
        Read lighting/current.json and return the last-used state.
        Returns {ok, type, colors} for static, or {ok, type, animation} for animation.
        """
        try:
            path = os.path.join(lighting_dir(), 'current.json')
            if not os.path.exists(path):
                return {'ok': False, 'reason': 'no_current'}
            with open(path, 'r', encoding='utf-8') as f:
                current = json.load(f)
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