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
        """Try to connect to the keyboard. Returns {ok, message}."""
        try:
            from aula_f108_pro_final import AulaF108Pro
            with self._lock:
                if self._kb:
                    self._kb.disconnect()
                self._kb = AulaF108Pro()
                ok = self._kb.connect()
                if ok:
                    self._kb.start()
                    return {'ok': True,  'message': 'Connected — VID:0C45 PID:800A'}
                else:
                    self._kb = None
                    return {'ok': False, 'message': 'Keyboard not found. Is AULA software closed?'}
        except Exception as e:
            return {'ok': False, 'message': str(e)}

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


# ── App entry point ───────────────────────────────────────────────────────────
def main():
    api = KeyboardAPI()

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
