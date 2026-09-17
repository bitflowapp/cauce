"""Capture Before/After screenshots of Home for commercial conversion pass."""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BASE = os.environ.get('CAUCE_TEST_URL', 'http://127.0.0.1:4173').rstrip('/')

parser = argparse.ArgumentParser()
parser.add_argument('--phase', choices=['before', 'after'], default='before')
args = parser.parse_args()

OUT = ROOT / 'evidence' / 'commercial' / args.phase
OUT.mkdir(parents=True, exist_ok=True)

VIEWPORTS = [
    ('home-390', 390, 844),
    ('home-393', 393, 852),
    ('home-430', 430, 932),
    ('home-1440', 1440, 900),
]

executable = os.environ.get('CAUCE_CHROMIUM_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe')

server_proc = None
try:
    import urllib.request
    urllib.request.urlopen(BASE + '/', timeout=1)
    print(f"Server already running at {BASE}")
except Exception:
    print("Starting local server at port 4173...")
    server_proc = subprocess.Popen(['node', str(ROOT / 'scripts' / 'server.mjs')], cwd=str(ROOT), env=dict(os.environ, PORT='4173'))
    time.sleep(1.5)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])
        for name, width, height in VIEWPORTS:
            ctx = browser.new_context(
                viewport={'width': width, 'height': height},
                is_mobile=width < 600,
                has_touch=width < 600,
                reduced_motion='reduce'
            )
            page = ctx.new_page()
            page.goto(BASE + '/#home')
            page.wait_for_load_state('networkidle')
            page.wait_for_timeout(400)

            # Viewport fold capture
            fold_path = OUT / f'{name}-fold.png'
            page.screenshot(path=str(fold_path), full_page=False)

            # Full page capture
            full_path = OUT / f'{name}-full.png'
            page.screenshot(path=str(full_path), full_page=True)

            print(f"Captured {name} ({width}x{height}) -> fold & full")
            ctx.close()
        browser.close()
finally:
    if server_proc:
        server_proc.terminate()
        server_proc.wait()

print(f"All {args.phase} captures saved to {OUT}")
