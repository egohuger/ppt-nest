"""
Build PPT Nest portable distribution package.
Assembles: Electron shell + Python backend exe + frontend → release/PPT Nest/
"""
import os, sys, shutil, json

PROJECT = os.path.dirname(os.path.abspath(__file__))
RELEASE = os.path.join(PROJECT, 'release', 'PPT Nest')
PYTHON_EXE = os.path.join(PROJECT, 'dist-python', 'server.exe')

def die(msg):
    print(f'ERROR: {msg}')
    sys.exit(1)

# ── Check prerequisites ──
if not os.path.exists(PYTHON_EXE):
    die(f'server.exe not found at {PYTHON_EXE}. Run: pyinstaller --onefile --name server backend/server.py')
if not os.path.exists(os.path.join(PROJECT, 'node_modules', 'electron', 'dist')):
    die('Electron runtime not found. Run: npm install')

# ── Clean and create release dir ──
if os.path.exists(RELEASE):
    shutil.rmtree(RELEASE)
os.makedirs(RELEASE, exist_ok=True)

# ── Copy Electron runtime ──
electron_dist = os.path.join(PROJECT, 'node_modules', 'electron', 'dist')
print('Copying Electron runtime...')
for item in os.listdir(electron_dist):
    src = os.path.join(electron_dist, item)
    dst = os.path.join(RELEASE, item)
    if os.path.isdir(src):
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)

# Rename electron.exe → PPT Nest.exe
electron_exe = os.path.join(RELEASE, 'electron.exe')
ppt_exe = os.path.join(RELEASE, 'PPT Nest.exe')
if os.path.exists(electron_exe):
    os.rename(electron_exe, ppt_exe)

# ── Copy app files into resources/app ──
app_dir = os.path.join(RELEASE, 'resources', 'app')
os.makedirs(app_dir, exist_ok=True)

print('Copying app files...')
# package.json
shutil.copy2(os.path.join(PROJECT, 'package.json'), app_dir)

# electron/
shutil.copytree(os.path.join(PROJECT, 'electron'), os.path.join(app_dir, 'electron'))

# frontend/
shutil.copytree(os.path.join(PROJECT, 'frontend'), os.path.join(app_dir, 'frontend'))

# ── Copy Python backend exe ──
backend_dir = os.path.join(RELEASE, 'backend')
os.makedirs(backend_dir, exist_ok=True)
print(f'Copying server.exe ({os.path.getsize(PYTHON_EXE) / 1024 / 1024:.0f} MB)...')
shutil.copy2(PYTHON_EXE, os.path.join(backend_dir, 'server.exe'))

# ── Create launcher batch file ──
launcher = os.path.join(RELEASE, '启动 PPT Nest.bat')
with open(launcher, 'w', encoding='ascii') as f:
    f.write('@echo off\r\n')
    f.write('setlocal enabledelayedexpansion\r\n')
    f.write('cd /d "%~dp0"\r\n')
    f.write('echo Starting PPT Nest...\r\n')
    f.write('start "" "%~dp0PPT Nest.exe"\r\n')

# ── Create data directory placeholder ──
os.makedirs(os.path.join(RELEASE, 'data'), exist_ok=True)

# ── Create zip ──
print('Creating zip...')
zip_path = os.path.join(PROJECT, 'release', 'PPT-Nest-v2.3-portable.zip')
shutil.make_archive(zip_path.replace('.zip', ''), 'zip', os.path.join(PROJECT, 'release'), 'PPT Nest')

size_mb = os.path.getsize(zip_path) / 1024 / 1024
print(f'\nDone! Distribution package:')
print(f'  {zip_path} ({size_mb:.0f} MB)')
print(f'  Folder: {RELEASE}')
