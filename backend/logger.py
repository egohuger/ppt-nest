"""Centralized logging for PPT Nest.

Usage:
    from logger import get_logger
    log = get_logger(__name__)
    log.info("Processing file: %s", file_name)
    log.warning("Thumbnail generation failed for %s", file_path)
    log.error("Unexpected error", exc_info=True)
"""

import logging
import os
import sys


def _default_log_path():
    """Determine log file path using config.py's data directory."""
    from config import get_data_dir
    data_dir = get_data_dir()
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, 'pptnest.log')


_LOG_FORMAT = '%(asctime)s [%(levelname)s] %(name)s: %(message)s'
_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'

_log_initialized = False


def _init_logging():
    global _log_initialized
    if _log_initialized:
        return
    _log_initialized = True

    root = logging.getLogger('pptnest')
    root.setLevel(logging.DEBUG)

    # File handler — DEBUG level, rotating by size
    try:
        from logging.handlers import RotatingFileHandler
        fh = RotatingFileHandler(
            _default_log_path(), maxBytes=2 * 1024 * 1024, backupCount=3,
            encoding='utf-8')
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(logging.Formatter(_LOG_FORMAT, _DATE_FORMAT))
        root.addHandler(fh)
    except Exception:
        pass

    # Console handler — WARNING and above to stderr
    ch = logging.StreamHandler(sys.stderr)
    ch.setLevel(logging.WARNING)
    ch.setFormatter(logging.Formatter(_LOG_FORMAT, _DATE_FORMAT))
    root.addHandler(ch)


def get_logger(name):
    """Return a logger under the 'pptnest' hierarchy."""
    _init_logging()
    return logging.getLogger(f'pptnest.{name}')
