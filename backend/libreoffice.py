"""LibreOffice 无头桥接层 —— macOS / Linux 上充当 PowerPoint COM 的替代。

Windows 版片巢用 PowerPoint COM 渲染缩略图、解析 .ppt 旧格式；
macOS 没有 COM，改用 LibreOffice（soffice）无头转换：

    .ppt/.pptx --(soffice)--> .pdf --(PyMuPDF)--> 逐页 PNG   （缩略图）
    .ppt/.pps  --(soffice)--> .pptx --(python-pptx)--> 文本  （旧格式解析）

找不到 LibreOffice 时本模块不抛异常退出，由调用方退回占位图（见 thumbnail.py）。
"""
import os
import shutil
import subprocess
import sys
import tempfile

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


def convert(file_path, target='pdf', timeout=DEFAULT_TIMEOUT):
    """用无头 LibreOffice 转换文档。

    target: LibreOffice 过滤器名，如 'pdf' / 'pptx'。
    返回 (输出文件路径, 临时根目录)。调用方用完自行 shutil.rmtree(临时根目录)。
    """
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
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=timeout)
        except subprocess.TimeoutExpired:
            shutil.rmtree(out_root, ignore_errors=True)
            raise RuntimeError(
                f'LibreOffice 转换超时（>{timeout}s）：{os.path.basename(src)}')

    if not os.path.exists(expected):
        detail = (proc.stderr or proc.stdout or '').strip().replace('\n', ' ')
        shutil.rmtree(out_root, ignore_errors=True)
        raise RuntimeError(
            f'LibreOffice 未产出 {ext} 文件（{os.path.basename(src)}）：{detail[:300]}')

    _log.info('LibreOffice 转换完成：%s -> %s', os.path.basename(src), expected)
    return expected, out_root
