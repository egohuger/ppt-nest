import os
import sys
import json


def _is_frozen():
    """Detect PyInstaller / cx_Freeze bundled executable."""
    return getattr(sys, 'frozen', False)


def _default_data_dir():
    """Default data dir before applying env / config overrides."""
    if _is_frozen():
        # Installed: use %APPDATA% so config + DB survive reinstalls
        base = os.environ.get('APPDATA', '')
        if base:
            return os.path.join(base, 'PPT Nest')
        return os.path.join(
            os.path.dirname(os.path.abspath(__file__)), '..', 'data')
    # Dev / non-frozen: use the project-relative 'data' directory
    _DIR = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(_DIR), 'data')


def _read_override(cfg_dir):
    """Read a persisted data_dir override from <cfg_dir>/config.json."""
    try:
        with open(os.path.join(cfg_dir, 'config.json'), 'r', encoding='utf-8') as f:
            override = json.load(f).get('data_dir')
        if override and isinstance(override, str) and override.strip():
            return override.strip()
    except (json.JSONDecodeError, OSError, ValueError, AttributeError):
        pass
    return None


def _app_data_dir():
    """Persistent data directory that survives PyInstaller temp extraction.

    Priority:
      1. PPTNEST_DATA_DIR env var (set by Electron main.js, already
         resolved against the persisted override in packaged mode)
      2. Persisted 'data_dir' override in config.json (dev mode)
      3. %APPDATA%/PPT Nest/ (installed) or project 'data/' (dev)
    """
    env = os.environ.get('PPTNEST_DATA_DIR', '').strip()
    if env:
        return env
    default = _default_data_dir()
    return _read_override(default) or default


# ══ Paths resolved once at import time ══

_DATA_DIR = _app_data_dir()

os.makedirs(_DATA_DIR, exist_ok=True)


def _base_data_dir():
    """Directory where the data_dir override config.json must be persisted.

    In packaged mode this is Electron's default data dir (passed via
    PPTNEST_BASE_DATA_DIR) — the launcher reads its config.json on every
    start. In dev mode it's the pre-override default dir."""
    base = os.environ.get('PPTNEST_BASE_DATA_DIR', '').strip()
    if base:
        return base
    return _default_data_dir()


def _config_path():
    """Config file path — always follows current _DATA_DIR."""
    return os.path.join(_DATA_DIR, 'config.json')


def load_config():
    cp = _config_path()
    if os.path.exists(cp):
        try:
            with open(cp, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_config(cfg):
    with open(_config_path(), 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def get_data_dir():
    return _DATA_DIR


def set_data_dir(path):
    """Update data dir and persist to config. Validates path exists."""
    if not os.path.isdir(path):
        os.makedirs(path, exist_ok=True)
    cfg = load_config()
    cfg['data_dir'] = path
    save_config(cfg)

    # Also persist the override into the BASE dir's config.json — that's the
    # file the launcher (Electron / next startup) reads to resolve the data
    # dir. Without this, the change resets to the default after a restart.
    base_cfg_path = os.path.join(_base_data_dir(), 'config.json')
    if os.path.realpath(base_cfg_path) != os.path.realpath(_config_path()):
        try:
            base_cfg = {}
            if os.path.exists(base_cfg_path):
                with open(base_cfg_path, 'r', encoding='utf-8') as f:
                    base_cfg = json.load(f)
            base_cfg['data_dir'] = path
            os.makedirs(os.path.dirname(base_cfg_path), exist_ok=True)
            with open(base_cfg_path, 'w', encoding='utf-8') as f:
                json.dump(base_cfg, f, ensure_ascii=False, indent=2)
        except (json.JSONDecodeError, OSError):
            pass

    global _DATA_DIR
    _DATA_DIR = path


def get_db_path():
    return os.path.join(get_data_dir(), 'db.sqlite')


def get_thumbnail_dir():
    d = os.path.join(get_data_dir(), 'thumbnails')
    os.makedirs(d, exist_ok=True)
    return d


def get_default_ppt_folder():
    """Default scan folder for first-run onboarding."""
    # 1. Slide_home (common material location)
    slide_home = r'D:\Slide_home'
    if os.path.isdir(slide_home):
        return os.path.abspath(slide_home)
    # 2. User Documents
    docs = os.path.expanduser(r'~\Documents')
    if os.path.isdir(docs):
        return docs
    return os.path.expanduser('~')


def resolve_ppt_folder(db):
    """Read or initialize the PPT folder path in the database."""
    configured = db.get_setting('ppt_folder')
    if configured and os.path.isdir(configured):
        return os.path.abspath(configured)
    default = get_default_ppt_folder()
    db.set_setting('ppt_folder', default)
    return default
