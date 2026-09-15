"""
Smoke test exhaustivo sobre la URL pública de GitHub Pages:
https://bitflowapp.github.io/cauce/
Verifica flujo comercial completo, consolas, persistencia, 404s y viewports de iPhone.
"""
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(exist_ok=True)
BASE = os.environ.get('BASE_URL', 'https://bitflowapp.github.io/cauce').rstrip('/')

results = []
errors = []
failed_requests = []

def record(name, status, details=None):
    entry = {'test': name, 'status': status}
    if details: entry['details'] = details
    results.append(entry)
    print(f"[{status}] {name}")

def navigate(page, path):
    page.wait_for_timeout(300)
    page.goto(BASE + '/#' + path)
    page.wait_for_timeout(400)

executable = os.environ.get('CAUCE_CHROMIUM_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox'])
    
    # 1. Desktop Context
    context = browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
    context.on('page', lambda page: page.on('pageerror', lambda err: errors.append(str(err))))
    context.on('requestfailed', lambda req: failed_requests.append(f"{req.method} {req.url} - {req.failure}"))
    context.on('response', lambda res: failed_requests.append(f"{res.status} {res.url}") if res.status >= 400 else None)
    
    page = context.new_page()
    
    try:
        # HOME
        page.goto(BASE + '/#home')
        page.wait_for_load_state('networkidle')
        expect(page.locator('[data-testid="store-card"]')).to_have_count(7)
        page.screenshot(path=str(EVIDENCE / 'pages-home-desktop.png'), full_page=True)
        record('HOME en GitHub Pages (7 comercios)', 'PASS')
        
        # CATALOG & FILTERS
        page.get_by_role('button', name='Pizzas', exact=True).click()
        expect(page.locator('[data-testid="store-card"]')).to_have_count(1)
        page.get_by_role('button', name='Todos', exact=True).click()
        expect(page.locator('[data-testid="store-card"]')).to_have_count(7)
        record('CATALOG y filtros en GitHub Pages', 'PASS')
        
        # MULTI-CART
        navigate(page, 'shop/orilla')
        page.get_by_role('button', name='Agregar La clásica', exact=True).click()
        expect(page.locator('#cart-count')).to_have_text('1')
        
        navigate(page, 'shop/horno')
        page.get_by_role('button', name='Agregar Muzzarella', exact=True).click()
        expect(page.locator('#cart-count')).to_have_text('2')
        
        navigate(page, 'carts')
        expect(page.get_by_role('link', name='Revisar carrito')).to_have_count(2)
        
        # PERSISTENCE ACROSS RELOAD
        page.reload()
        page.wait_for_load_state('networkidle')
        expect(page.get_by_role('link', name='Revisar carrito')).to_have_count(2)
        record('CART y persistencia tras recarga en Pages', 'PASS')
        
        # CHECKOUT
        navigate(page, 'cart/orilla')
        expect(page.locator('.cart-line')).to_have_count(1)
        page.get_by_label('Modalidad de entrega').select_option('delivery')
        page.get_by_label('Dirección de ejemplo').fill('Av. 4 de Febrero 500')
        page.screenshot(path=str(EVIDENCE / 'pages-checkout-desktop.png'), full_page=True)
        page.get_by_role('button', name='Crear pedido de prueba', exact=True).click()
        expect(page.get_by_role('heading', name='Recibido', exact=True)).to_be_visible()
        order_path = page.url.split('#', 1)[1]
        record('CHECKOUT delivery en GitHub Pages', 'PASS')
        
        # TRACKING MAP & STEPS
        expect(page.locator('.alumine-tracking-map')).to_be_visible()
        page.screenshot(path=str(EVIDENCE / 'pages-tracking-desktop.png'), full_page=True)
        record('TRACKING y mapa interactivo en GitHub Pages', 'PASS')
        
        # BUSINESS PANEL
        navigate(page, 'business/orilla')
        expect(page.locator('.order-card')).to_have_count(1)
        for action in ['Confirmar', 'Preparar', 'Marcar listo', 'Asignar repartidor demo']:
            page.get_by_role('button', name=action, exact=True).click()
            page.wait_for_timeout(200)
        record('BUSINESS_PANEL y ciclo de cocina en Pages', 'PASS')
        
        # RIDER PANEL
        navigate(page, 'rider/orilla')
        for action in ['Confirmar retiro', 'Salir a reparto', 'Llegué al destino', 'Confirmar entrega']:
            page.get_by_role('button', name=action, exact=True).click()
            page.wait_for_timeout(200)
        record('RIDER panel y despacho propio en Pages', 'PASS')
        
        # FINAL ORDER TRACKING CONFIRMATION
        navigate(page, order_path)
        expect(page.get_by_role('heading', name='Entregado', exact=True)).to_be_visible()
        expect(page.locator('.timeline li')).to_have_count(9)
        record('CIRCUITO COMPLETO 9 ESTADOS entregado', 'PASS')
        
        # 2. IPHONE VIEWPORTS (390x844, 393x852, 430x932)
        iphones = [
            ('iPhone 12/13/14 (390x844)', {'width': 390, 'height': 844}),
            ('iPhone 15/16 (393x852)', {'width': 393, 'height': 852}),
            ('iPhone Plus/Pro Max (430x932)', {'width': 430, 'height': 932}),
        ]
        
        for name, vp in iphones:
            m_ctx = browser.new_context(viewport=vp, is_mobile=True, has_touch=True, reduced_motion='reduce')
            m_ctx.on('page', lambda p: p.on('pageerror', lambda err: errors.append(str(err))))
            m_page = m_ctx.new_page()
            navigate(m_page, 'home')
            no_overflow = m_page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            assert no_overflow, f'Overflow horizontal en {name}'
            expect(m_page.locator('.bottom-nav')).to_be_visible()
            if '390' in name:
                m_page.screenshot(path=str(EVIDENCE / 'pages-home-iphone390.png'), full_page=True)
            elif '430' in name:
                m_page.screenshot(path=str(EVIDENCE / 'pages-home-iphone430.png'), full_page=True)
            m_ctx.close()
            record(f'MOBILE {name} sin overflow y con nav', 'PASS')
            
        # 3. VERIFY NO CRITICAL ERRORS & NO 404s
        assert len(errors) == 0, f"JS errors: {errors}"
        record('JS_CONSOLE sin errores (0 excepciones)', 'PASS')
        
        assert len(failed_requests) == 0, f"Solicitudes fallidas: {failed_requests}"
        record('404_ASSETS 0 errores de red en Pages', 'PASS')
        
    except Exception as exc:
        record('PAGES SMOKE EXECUTION', 'FAIL', str(exc))
        page.screenshot(path=str(EVIDENCE / 'pages-failure.png'), full_page=True)
        raise
    finally:
        report = {
            'scope': 'GITHUB_PAGES_LIVE_VERIFICATION',
            'base_url': BASE,
            'results': results,
            'js_errors': errors,
            'failed_requests': failed_requests
        }
        (EVIDENCE / 'pages-smoke-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.close()
