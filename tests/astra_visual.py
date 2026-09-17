"""Repeatable visual review using real UI actions and isolated demo storage."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
BASE = os.environ.get('BASE_URL', 'https://bitflowapp.github.io/cauce').rstrip('/')
PHASE = os.environ.get('AUDIT_PHASE', 'before')
OUT = ROOT / 'evidence' / 'astra' / PHASE
OUT.mkdir(parents=True, exist_ok=True)
results, errors, network, csp = [], [], [], []

def nav(page, path):
    page.goto(BASE + '/#' + path)
    page.wait_for_timeout(250)
    page.evaluate('document.fonts.ready')

def capture(page, screen, width):
    expect(page.locator('#toast')).to_be_hidden(timeout=6000)
    page.evaluate('window.scrollTo(0, 0)')
    page.wait_for_timeout(200)
    page.screenshot(path=str(OUT / f'{screen}-{width}.png'), full_page=True)
    page.screenshot(path=str(OUT / f'{screen}-{width}-fold.png'))
    results.append({'screen': screen, 'width': width, **page.evaluate('''() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        firstStoreTop: document.querySelector('.store-card')?.getBoundingClientRect().top,
        heroBackground: document.querySelector('.hero-territory-backdrop') && getComputedStyle(document.querySelector('.hero-territory-backdrop')).backgroundImage,
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
    })''')})

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CAUCE_CHROMIUM_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe'))
    for width, height in [(390, 844), (393, 852), (430, 932), (768, 1024), (1440, 900)]:
        ctx = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce', is_mobile=width < 600, has_touch=width < 600)
        ctx.on('requestfailed', lambda r: network.append(f'{r.url}: {r.failure}'))
        ctx.on('response', lambda r: network.append(f'{r.status} {r.url}') if r.status >= 400 else None)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.add_init_script("document.addEventListener('securitypolicyviolation', e => console.error('CSP: ' + e.violatedDirective))")
        nav(page, 'home')
        page.wait_for_load_state('networkidle')
        capture(page, 'home', width)
        page.get_by_label('Buscar comercio o comida').fill('pizza')
        expect(page.locator('[data-testid="store-card"]')).to_have_count(1)
        page.get_by_label('Buscar comercio o comida').fill('')
        page.locator('[data-testid="store-card"]').first.click()
        page.wait_for_timeout(200)
        capture(page, 'shop', width)
        page.get_by_role('button', name='Agregar La clásica', exact=True).click()
        expect(page.locator('#cart-count')).to_have_text('1')
        nav(page, 'carts')
        page.wait_for_timeout(2400)
        capture(page, 'cart', width)
        page.locator('[data-testid="continue-order-link"]').click()
        page.locator('label[for="fulfillment-delivery"]').click()
        page.locator('[data-action="fill-demo-checkout"]').click()
        page.locator('input[name="address"]').fill('Av. 4 de Febrero 450')
        capture(page, 'checkout', width)
        page.locator('[data-testid="confirm-order"]').click()
        expect(page.get_by_role('heading', name='Recibido', exact=True)).to_be_visible()
        page.wait_for_timeout(2400)
        capture(page, 'tracking', width)
        nav(page, 'business/orilla')
        capture(page, 'business', width)
        for action in ['Confirmar', 'Preparar', 'Marcar listo', 'Asignar repartidor demo']:
            page.get_by_role('button', name=action, exact=True).click()
            page.wait_for_timeout(250)
        nav(page, 'rider/orilla')
        page.wait_for_timeout(2400)
        capture(page, 'rider', width)
        nav(page, 'presentacion')
        capture(page, 'presentacion', width)
        for action in ['open-demo-modal', 'open-join-modal']:
            nav(page, 'home')
            page.locator(f'[data-action="{action}"]').first.click()
            capture(page, action, width)
            page.locator('.modal-close').click()
        ctx.close()
    browser.close()
(OUT / 'results.json').write_text(json.dumps({'base': BASE, 'screens': results, 'console_errors': errors, 'network_errors': network}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'screens': len(results), 'overflow': sum(r['overflow'] for r in results), 'console_errors': len(errors), 'network_errors': len(network), 'output': str(OUT)}, indent=2))
