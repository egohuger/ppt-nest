"""LibreOffice 无头桥接层 —— macOS / Linux 上充当 PowerPoint COM 的替代。

Windows 版片巢用 PowerPoint COM 渲染缩略图、解析 .ppt 旧格式；
macOS 没有 COM，改用 LibreOffice（soffice）无头转换：

    .ppt/.pptx --(soffice)--> .pdf --(PyMuPDF)--> 逐页 PNG   （缩略图）
    .ppt/.pps  --(soffice)--> .pptx --(python-pptx)--> 文本  （旧格式解析）

找不到 LibreOffice 时本模块不抛异常退出，由调用方退回占位图（见 thumbnail.py）。
"""
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from logger import get_logger

_log = get_logger(__name__)

# 转换超时（秒）：每页约 0.1~0.3s，首次调用要等 LibreOffice 冷启动，给足余量
DEFAULT_TIMEOUT = 600

_SOFFICE_CANDIDATES = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/snap/bin/libreoffice',
]

# 生成 fonts.conf 时列出的字体目录（macOS；不存在的会自动跳过）
_FONT_DIRS = [
    '/System/Library/Fonts',
    '/System/Library/Fonts/Supplemental',
    '/Library/Fonts',
    os.path.expanduser('~/Library/Fonts'),
    '/Applications/LibreOffice.app/Contents/Resources/fonts/truetype',
]
_fontconfig_cache = {}


def find_soffice():
    """返回可执行的 soffice 路径；找不到返回 None。

    可用环境变量 PPTNEST_SOFFICE 指定自定义路径（便携版/非标准安装位置）。
    """
    env = (os.environ.get('PPTNEST_SOFFICE') or '').strip()
    if env and os.path.exists(env) and os.access(env, os.X_OK):
        return env
    for path in _SOFFICE_CANDIDATES:
        if os.path.exists(path) and os.access(path, os.X_OK):
            return path
    for name in ('soffice', 'libreoffice'):
        found = shutil.which(name)
        if found:
            return found
    return None


def is_available():
    return find_soffice() is not None


def missing_hint():
    """缺少渲染后端时给用户的提示（按平台给安装方式）。"""
    if sys.platform == 'darwin':
        return ('未检测到 LibreOffice，缩略图已退化为占位图。macOS 上渲染真实缩略图、'
                '解析 .ppt 旧格式都需要它：终端执行 brew install --cask libreoffice，'
                '或到 libreoffice.org 下载安装，装完重启片巢即可。')
    if sys.platform == 'win32':
        return ('未检测到 Microsoft PowerPoint，也未检测到 LibreOffice，'
                '缩略图已退化为占位图。装 PowerPoint，或装 LibreOffice'
                '（libreoffice.org）后重启片巢。')
    return ('未检测到 LibreOffice，缩略图已退化为占位图。请安装：'
            'Debian/Ubuntu `sudo apt install libreoffice`，'
            'Fedora `sudo dnf install libreoffice`。')


def _fontconfig_file():
    """返回给 soffice 用的 fonts.conf 路径（首次调用时生成），失败返回 None。

    macOS 上无头 LibreOffice 走 fontconfig 找字体，而系统没装 fonts.conf，
    结果只认它自带的那几个拉丁字体：中文全渲染成空心方块（豆腐块）。
    这里生成一份临时配置显式列出 macOS 的字体目录，仅通过 FONTCONFIG_FILE
    作用于 soffice 子进程，不改用户/系统的 fontconfig 配置。
    """
    if 'path' in _fontconfig_cache:
        return _fontconfig_cache['path']
    path = None
    try:
        dirs = [d for d in _FONT_DIRS if os.path.isdir(d)]
        if not dirs:
            raise RuntimeError('没有找到任何字体目录')
        cache = os.path.join(tempfile.gettempdir(), 'pptnest_fontconfig_cache')
        os.makedirs(cache, exist_ok=True)
        path = os.path.join(tempfile.gettempdir(), 'pptnest_fonts.conf')
        lines = ['<?xml version="1.0"?>', '<fontconfig>']
        lines += [f'  <dir>{d}</dir>' for d in dirs]
        lines.append(f'  <cachedir>{cache}</cachedir>')
        lines.append('</fontconfig>')
        with open(path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')
        _log.info('已生成字体配置 %s（%d 个字体目录）', path, len(dirs))
    except Exception as exc:
        _log.warning('生成字体配置失败，沿用系统默认：%s', exc)
        path = None
    _fontconfig_cache['path'] = path
    return path


def _subprocess_env():
    """子进程环境：macOS 上补 FONTCONFIG_FILE，让 soffice 能看见中文字体。"""
    env = os.environ.copy()
    if sys.platform == 'darwin' and not env.get('FONTCONFIG_FILE'):
        fc = _fontconfig_file()
        if fc:
            env['FONTCONFIG_FILE'] = fc
    return env


def convert(file_path, target='pdf', timeout=DEFAULT_TIMEOUT, cancel=None):
    """用无头 LibreOffice 转换文档。

    target: LibreOffice 过滤器名，如 'pdf' / 'pptx'。
    cancel: 可选的回调，返回 True 表示用户已取消 —— 立刻杀掉 soffice 并抛 Interrupted。
    返回 (输出文件路径, 临时根目录)。调用方用完自行 shutil.rmtree(临时根目录)。
    """
    from interrupt import Interrupted

    soffice = find_soffice()
    if not soffice:
        raise RuntimeError(missing_hint())

    src = os.path.abspath(file_path)
    if not os.path.exists(src):
        raise FileNotFoundError(f'源文件不存在：{src}')

    out_root = tempfile.mkdtemp(prefix='pptnest_lo_out_')
    ext = target.split(':', 1)[0].lower().lstrip('.')
    stem = os.path.splitext(os.path.basename(src))[0]
    expected = os.path.join(out_root, f'{stem}.{ext}')

    # 用一次性 UserInstallation profile：避免与用户正在用的 LibreOffice 抢锁，
    # 也避免首次启动向导让无头进程挂住。
    with tempfile.TemporaryDirectory(prefix='pptnest_lo_profile_') as profile:
        cmd = [
            soffice, '--headless', '--norestore', '--invisible',
            '--nodefault', '--nologo', '--nolockcheck', '--nofirststartwizard',
            f'-env:UserInstallation=file://{profile}',
            '--convert-to', target,
            '--outdir', out_root,
            src,
        ]
        # 用 Popen 而不是 run：soffice 转换一个几十页的 deck 要几秒到几十秒，
        # 用户点取消必须马上停 —— 只有自己在轮询里才杀得掉它。
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env=_subprocess_env(), start_new_session=True,
        )
        deadline = time.time() + timeout
        try:
            while True:
                try:
                    out, err = proc.communicate(timeout=0.25)
                    break
                except subprocess.TimeoutExpired:
                    if cancel and cancel():
                        _kill_tree(proc)
                        raise Interrupted()
                    if time.time() > deadline:
                        _kill_tree(proc)
                        raise RuntimeError(
                            f'LibreOffice 转换超时（>{timeout}s）：{os.path.basename(src)}')
        except BaseException:
            shutil.rmtree(out_root, ignore_errors=True)
            raise

    if not os.path.exists(expected):
        detail = ((err or out) or '').strip().replace('\n', ' ')
        shutil.rmtree(out_root, ignore_errors=True)
        raise RuntimeError(
            f'LibreOffice 未产出 {ext} 文件（{os.path.basename(src)}）：{detail[:300]}')

    _log.info('LibreOffice 转换完成：%s -> %s', os.path.basename(src), expected)
    return expected, out_root


def _kill_tree(proc, wait=3.0):
    """杀掉 soffice 及其子进程（start_new_session 让它自成进程组）。"""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    try:
        proc.wait(timeout=wait)
    except Exception:
        pass
