"""COM automation utilities — safe context manager for PowerPoint COM lifecycle."""

import logging
from contextlib import contextmanager

from logger import get_logger

_log = get_logger(__name__)


@contextmanager
def powerpoint_app():
    """Context manager that yields a PowerPoint.Application and handles cleanup.

    Usage:
        with powerpoint_app() as ppt_app:
            presentation = ppt_app.Presentations.Open(...)
            ...
            presentation.Close()
    """
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    ppt_app = None
    try:
        ppt_app = win32com.client.Dispatch("PowerPoint.Application")
        yield ppt_app
    except Exception:
        _log.error("PowerPoint COM error", exc_info=True)
        raise
    finally:
        if ppt_app is not None:
            try:
                ppt_app.Quit()
            except Exception:
                _log.warning("Failed to quit PowerPoint COM")
        pythoncom.CoUninitialize()


@contextmanager
def open_presentation(ppt_app, file_path, read_only=True):
    """Context manager for a PowerPoint presentation. Auto-closes on exit.

    Usage:
        with powerpoint_app() as app:
            with open_presentation(app, file_path) as pres:
                for slide in pres.Slides:
                    ...
    """
    abs_path = __import__('os').path.abspath(file_path)
    presentation = None
    try:
        presentation = ppt_app.Presentations.Open(
            abs_path, ReadOnly=read_only, WithWindow=False)
        yield presentation
    finally:
        if presentation is not None:
            try:
                presentation.Close()
            except Exception:
                _log.warning("Failed to close presentation: %s", file_path)
