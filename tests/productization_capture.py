"""Capture Before/After screenshots of Cart and Checkout."""
import argparse
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
BASE = os.environ.get('CAUCE_TEST_URL', 'http://localhost:4173').rstrip('/')

parser = argparse.ArgumentParser()
parser.add_argument('--phase', choices=['before', 'after'], default='before')
args = parser.parse_args()

OUT = ROOT / 'evidence' / 'productization' / args.phase
OUT.mkdir(parents=True, exist_ok=True)

VIEWPORTS = [
    ('cart-390', 390, 844, 'cart'),
    ('checkout-390', 390, 844, 'checkout'),
    ('checkout-430', 430, 932, 'checkout'),
    ('checkout-1440', 1440, 900, 'checkout'),
]

executable = os.environ.get('CAUCE_CHROMIUM_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe')

def reset_and_seed(page):
    page.goto(BASE + '/#home')
    page.evaluate('localStorage.clear()')
    page.reload()
    page.wait_for_timeout(100)
    page.goto(BASE + '/#shop/orilla')
    page.wait_for_selector('button[data-action="add"]')
    # Add a product to cart
    page.locator('button[data-action="add"]').first.click()
    expect(page.locator('#cart-count')).to_have_text('1')

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])
    for name, width, height, target in VIEWPORTS:
        ctx = browser.new_context(viewport={'width': width, 'height': height}, is_mobile=width < 600, has_touch=width < 600)
        page = ctx.new_page()
        reset_and_seed(page)

        if target == 'cart':
            page.goto(BASE + '/#carts')
            page.wait_for_timeout(300)
            page.screenshot(path=str(OUT / f'{name}.png'), full_page=True)
            page.screenshot(path=str(OUT / f'{name}-fold.png'))
            print(f"Captured {name} ({width}x{height})")
        elif target == 'checkout':
            page.goto(BASE + '/#cart/orilla')
            page.wait_for_timeout(300)
            page.screenshot(path=str(OUT / f'{name}.png'), full_page=True)
            page.screenshot(path=str(OUT / f'{name}-fold.png'))
            print(f"Captured {name} ({width}x{height})")

        ctx.close()
    browser.close()

print(f"All {args.phase} captures saved to {OUT}")
