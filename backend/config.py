import os
import sys
import json


def _is_frozen():
    """Detect PyInstaller / cx_Freeze bundled executable."""
    return getattr(sys, 'frozen', False)


def _default_data_dir():
    """Default data dir before applying env / config overrides."""
    if _is_frozen():
        # 打包版：数据放用户级目录，重装/升级不丢
        if sys.platform == 'darwin':
            return os.path.expanduser('~/Library/Application Support/PPT Nest')
        if sys.platform != 'win32':
            return os.path.expanduser('~/.local/share/PPT Nest')
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
    # 1. Slide_home（素材目录约定；macOS 在 ~/ 或 ~/Documents 下）
    candidates = [
        os.path.expanduser('~/Slide_home'),
        os.path.expanduser('~/Documents/Slide_home'),
        r'D:\Slide_home',
    ]
    for path in candidates:
        if os.path.isdir(path):
            return os.path.abspath(path)
    # 2. User Documents
    docs = os.path.expanduser('~/Documents')
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


def resolve_scan_roots(db):
    """扫描位置（可以配多个）。

    老库里只有 ppt_folder 一个路径，第一次读时自动转成一个 scan_roots 位置，
    之后以 scan_roots 为准；ppt_folder 保留作为兼容字段。
    """
    raw = db.get_setting('scan_roots')
    roots = []
    if raw:
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            data = []
        if isinstance(data, str):
            data = [{'path': data}]
        for item in data or []:
            if isinstance(item, str):
                item = {'path': item}
            if not isinstance(item, dict):
                continue
            path = (item.get('path') or '').strip()
            if not path:
                continue
            roots.append({
                'path': os.path.abspath(os.path.expanduser(path)),
                'enabled': bool(item.get('enabled', True)),
            })
    if not roots:
        legacy = db.get_setting('ppt_folder')
        base = legacy if (legacy and os.path.isdir(legacy)) else get_default_ppt_folder()
        roots = [{'path': os.path.abspath(base), 'enabled': True}]
        db.set_setting('scan_roots', json.dumps(roots, ensure_ascii=False))
    return roots


def effective_scan_roots(roots):
    """去掉被其它启用位置包含的嵌套位置。

    父目录递归扫描已经覆盖子目录，两个位置同时启用会让同一个文件进两次队列
    （一轮导入里被写一遍再删一遍重建）。返回 (生效位置, 被覆盖的嵌套位置)。
    配置本身不改，用户把父目录关掉后子目录会重新生效。
    """
    enabled = [r['path'] for r in roots if r.get('enabled')]
    effective, nested = [], []
    for path in enabled:
        real = os.path.realpath(path)
        covered = False
        for other in enabled:
            if other == path:
                continue
            oreal = os.path.realpath(other)
            if oreal == real:
                # 完全相同的两个位置：只留第一个
                if enabled.index(other) < enabled.index(path):
                    covered = True
                    break
                continue
            if real.startswith(oreal.rstrip(os.sep) + os.sep):
                covered = True
                break
        (nested if covered else effective).append(path)
    return effective, nested
