import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
AFTER_DIR = ROOT / 'evidence' / 'after'
AFTER_DIR.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:4173')
executable = os.environ.get('CAUCE_CHROMIUM_PATH')
if not executable and Path('/usr/bin/chromium').exists():
    executable = '/usr/bin/chromium'
elif not executable and Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe').exists():
    executable = r'C:\Program Files\Google\Chrome\Application\chrome.exe'

def nav(page, path):
    page.wait_for_timeout(250)
    page.goto(BASE + '/#' + path)
    page.wait_for_timeout(350)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox'])

    # 1. Mobile 390x844 above-the-fold check and screenshots
    m_ctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    m_page = m_ctx.new_page()
    nav(m_page, 'home')

    # Measure first store card position
    first_card = m_page.locator('[data-testid="store-card"]').first
    box = first_card.bounding_box()
    print(f"Mobile 390x844 Viewport: Height=844px")
    print(f"First store card bounding box: y={box['y']}, height={box['height']}, bottom={box['y'] + box['height']}")
    is_above_fold = box['y'] < 844
    print(f"Is first store card visible above the fold? {is_above_fold}")

    # Viewport screenshot (what user sees without scrolling)
    m_page.screenshot(path=str(AFTER_DIR / 'after-home-mobile-390-fold.png'), full_page=False)
    # Full page screenshot
    m_page.screenshot(path=str(AFTER_DIR / 'after-home-mobile-390.png'), full_page=True)

    # Mobile shop
    nav(m_page, 'shop/orilla')
    m_page.screenshot(path=str(AFTER_DIR / 'after-shop-mobile-390.png'), full_page=True)

    # Add item and checkout
    m_page.get_by_role('button', name='Agregar La clásica', exact=True).click()
    m_page.wait_for_timeout(200)
    nav(m_page, 'cart/orilla')
    m_page.screenshot(path=str(AFTER_DIR / 'after-checkout-mobile-390.png'), full_page=True)
    m_page.get_by_label('Modalidad de entrega').select_option('delivery')
    m_page.get_by_label('Dirección de ejemplo').fill('Av. 4 de Febrero 500')
    m_page.get_by_role('button', name='Crear pedido de prueba', exact=True).click()
    m_page.wait_for_timeout(350)
    m_page.screenshot(path=str(AFTER_DIR / 'after-tracking-mobile-390.png'), full_page=True)
    order_path = m_page.url.split('#', 1)[1]

    m_ctx.close()

    # 2. Desktop 1440x900 screenshots
    d_ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    d_page = d_ctx.new_page()

    nav(d_page, 'home')
    d_page.screenshot(path=str(AFTER_DIR / 'after-home-desktop.png'), full_page=True)

    nav(d_page, 'shop/orilla')
    d_page.screenshot(path=str(AFTER_DIR / 'after-shop-desktop.png'), full_page=True)

    nav(d_page, 'cart/orilla')
    d_page.screenshot(path=str(AFTER_DIR / 'after-checkout-desktop.png'), full_page=True)

    nav(d_page, order_path)
    d_page.screenshot(path=str(AFTER_DIR / 'after-tracking-desktop.png'), full_page=True)

    nav(d_page, 'business/orilla')
    d_page.screenshot(path=str(AFTER_DIR / 'after-business-desktop.png'), full_page=True)

    nav(d_page, 'rider/orilla')
    d_page.screenshot(path=str(AFTER_DIR / 'after-rider-desktop.png'), full_page=True)

    nav(d_page, 'presentacion')
    d_page.screenshot(path=str(AFTER_DIR / 'after-presentacion-desktop.png'), full_page=True)

    d_ctx.close()
    browser.close()
    print("All AFTER screenshots captured successfully in evidence/after/")
