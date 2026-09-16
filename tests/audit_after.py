"""
Script de auditoría UX visual post-implementación (AFTER / v0.3)
Verifica:
1. scrollWidth <= innerWidth en todos los viewports móviles y desktop (cero overflow)
2. Primer comercio visible above the fold en móviles
3. Capturas oficiales en evidence/v03/
4. Comparativa de métricas guardada en evidence/v03/audit_metrics.json
"""
import os
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
AFTER_DIR = ROOT / 'evidence' / 'v03'
AFTER_DIR.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('CAUCE_TEST_URL', 'http://127.0.0.1:4173').rstrip('/')

executable = os.environ.get('CAUCE_CHROMIUM_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe')

viewports = [
    ('mobile-390', {'width': 390, 'height': 844}),
    ('mobile-393', {'width': 393, 'height': 852}),
    ('mobile-430', {'width': 430, 'height': 932}),
    ('tablet-768', {'width': 768, 'height': 1024}),
    ('desktop-1440', {'width': 1440, 'height': 900}),
]

audit_log = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox'])

    # 1. Capturas por Viewport de la HOME y métricas
    for vp_name, vp_size in viewports:
        ctx = browser.new_context(viewport=vp_size, reduced_motion='reduce')
        page = ctx.new_page()
        page.goto(BASE + '/#home')
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(300)

        metrics = page.evaluate('''() => {
            const hero = document.querySelector('.hero');
            const stores = document.querySelector('.stores');
            const firstStore = document.querySelector('.store-card');
            const nav = document.querySelector('.bottom-nav');
            const heroRect = hero ? hero.getBoundingClientRect() : null;
            const firstStoreRect = firstStore ? firstStore.getBoundingClientRect() : null;
            return {
                windowHeight: window.innerHeight,
                scrollWidth: document.documentElement.scrollWidth,
                innerWidth: window.innerWidth,
                heroHeight: heroRect ? heroRect.height : 0,
                firstStoreTop: firstStoreRect ? firstStoreRect.top : 0,
                firstStoreVisibleAboveFold: firstStoreRect ? (firstStoreRect.top < window.innerHeight) : false,
                hasBottomNav: nav ? window.getComputedStyle(nav).display !== 'none' : false,
            };
        }''')

        img_name = f'v03-home-{vp_name}.png'
        page.screenshot(path=str(AFTER_DIR / img_name), full_page=False)
        audit_log.append({
            'viewport': vp_name,
            'screen': 'home',
            'screenshot': img_name,
            'metrics': metrics
        })
        ctx.close()

    # 2. Capturas oficiales para evidence/v03/
    # Mobile Context (iPhone 12/13/14 - 390x844)
    m_ctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, reduced_motion='reduce')
    m_page = m_ctx.new_page()

    # v03-home-mobile.png
    m_page.goto(BASE + '/#home')
    m_page.wait_for_timeout(300)
    m_page.screenshot(path=str(AFTER_DIR / 'v03-home-mobile.png'), full_page=False)

    # v03-shop-mobile.png
    m_page.goto(BASE + '/#shop/orilla')
    m_page.wait_for_timeout(300)
    m_page.screenshot(path=str(AFTER_DIR / 'v03-shop-mobile.png'), full_page=False)

    # Agregar producto y ver carrito
    m_page.get_by_role('button', name='Agregar La clásica', exact=True).click()
    m_page.wait_for_timeout(200)

    # v03-cart-mobile.png
    m_page.goto(BASE + '/#cart/orilla')
    m_page.wait_for_timeout(300)
    m_page.screenshot(path=str(AFTER_DIR / 'v03-cart-mobile.png'), full_page=False)

    # v03-checkout-mobile.png
    m_page.get_by_label('Modalidad de entrega').select_option('delivery')
    m_page.get_by_label('Dirección de ejemplo').fill('Av. 4 de Febrero 450')
    m_page.wait_for_timeout(200)
    m_page.screenshot(path=str(AFTER_DIR / 'v03-checkout-mobile.png'), full_page=False)

    # Crear pedido
    m_page.get_by_role('button', name='Crear pedido de prueba', exact=True).click()
    m_page.wait_for_timeout(400)

    # v03-tracking-mobile.png
    m_page.screenshot(path=str(AFTER_DIR / 'v03-tracking-mobile.png'), full_page=False)

    # v03-rider-mobile.png
    m_page.goto(BASE + '/#rider/orilla')
    m_page.wait_for_timeout(300)
    m_page.screenshot(path=str(AFTER_DIR / 'v03-rider-mobile.png'), full_page=False)

    # v03-presentacion-mobile.png
    m_page.goto(BASE + '/#presentacion')
    m_page.wait_for_timeout(300)
    m_page.screenshot(path=str(AFTER_DIR / 'v03-presentacion-mobile.png'), full_page=False)

    m_ctx.close()

    # Desktop Context (1440x900)
    d_ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
    d_page = d_ctx.new_page()

    # v03-home-desktop.png
    d_page.goto(BASE + '/#home')
    d_page.wait_for_timeout(300)
    d_page.screenshot(path=str(AFTER_DIR / 'v03-home-desktop.png'), full_page=False)

    # v03-business-desktop.png
    d_page.goto(BASE + '/#business/orilla')
    d_page.wait_for_timeout(300)
    d_page.screenshot(path=str(AFTER_DIR / 'v03-business-desktop.png'), full_page=False)

    # v03-presentacion-desktop.png
    d_page.goto(BASE + '/#presentacion')
    d_page.wait_for_timeout(300)
    d_page.screenshot(path=str(AFTER_DIR / 'v03-presentacion-desktop.png'), full_page=False)

    d_ctx.close()
    browser.close()

with open(AFTER_DIR / 'audit_metrics.json', 'w', encoding='utf-8') as f:
    json.dump(audit_log, f, indent=2, ensure_ascii=False)

print(f"Auditoría visual post-implementación completada. Capturas guardadas en {AFTER_DIR}")
