"""Captura visual completa para auditoría de diseño y producto.
Genera screenshots en Mobile (390x844) y Desktop (1440x900) para:
- HOME
- CATÁLOGO (SHOP)
- CARRITO (CARTS)
- CHECKOUT
- TRACKING PEDIDO
- PANEL COMERCIO (BUSINESS)
- PANEL RIDER
- MOVILIDAD (TAXI BOOKING)
- TRACKING TAXI
- PANEL TAXISTA
- PRESENTACIÓN INSTITUCIONAL
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
AUDIT_DIR = ROOT / 'evidence' / 'visual_audit'
AUDIT_DIR.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('CAUCE_TEST_URL', 'http://127.0.0.1:4173')

executable = os.environ.get('CAUCE_CHROMIUM_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe')
if not os.path.exists(executable) and Path('/usr/bin/chromium').exists():
    executable = '/usr/bin/chromium'

def capture_all():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox'])

        for vp_label, vp in [('desktop', {'width': 1440, 'height': 900}), ('mobile', {'width': 390, 'height': 844})]:
            is_mobile = vp_label == 'mobile'
            ctx = browser.new_context(viewport=vp, is_mobile=is_mobile, has_touch=is_mobile, reduced_motion='reduce')
            page = ctx.new_page()

            # 1. HOME
            page.goto(f"{BASE}/#home")
            page.wait_for_timeout(350)
            page.screenshot(path=str(AUDIT_DIR / f'01-home-{vp_label}.png'), full_page=True)

            # 2. CATÁLOGO
            page.goto(f"{BASE}/#shop/orilla")
            page.wait_for_timeout(350)
            page.screenshot(path=str(AUDIT_DIR / f'02-catalogo-{vp_label}.png'), full_page=True)

            # Agregar un producto para tener carrito
            page.get_by_role('button', name='Agregar La clásica', exact=True).click()
            page.wait_for_timeout(200)

            # 3. CARRITO
            page.goto(f"{BASE}/#carts")
            page.wait_for_timeout(350)
            page.screenshot(path=str(AUDIT_DIR / f'03-carrito-{vp_label}.png'), full_page=True)

            # 4. CHECKOUT
            page.goto(f"{BASE}/#cart/orilla")
            page.wait_for_timeout(300)
            page.locator('label[for="fulfillment-delivery"]').click()
            page.locator('[data-action="fill-demo-checkout"]').click()
            page.locator('input[name="address"]').fill('Av. 4 de Febrero 420')
            page.screenshot(path=str(AUDIT_DIR / f'04-checkout-{vp_label}.png'), full_page=True)

            # Confirmar pedido para tener tracking real
            page.locator('[data-testid="confirm-order"]').click()
            page.wait_for_timeout(350)

            # 5. TRACKING PEDIDO
            order_url = page.url
            page.screenshot(path=str(AUDIT_DIR / f'05-tracking-pedido-{vp_label}.png'), full_page=True)

            # 6. BUSINESS PANEL
            page.goto(f"{BASE}/#business/orilla")
            page.wait_for_timeout(350)
            page.screenshot(path=str(AUDIT_DIR / f'06-panel-comercio-{vp_label}.png'), full_page=True)

            # 7. RIDER PANEL
            # Avanzar el pedido a reparto para ver el panel de rider con actividad
            for action in ['Confirmar', 'Preparar', 'Marcar listo', 'Asignar repartidor demo']:
                btn = page.get_by_role('button', name=action, exact=True)
                if btn.is_visible():
                    btn.click()
                    page.wait_for_timeout(150)
            page.goto(f"{BASE}/#rider/orilla")
            page.wait_for_timeout(350)
            page.screenshot(path=str(AUDIT_DIR / f'07-panel-rider-{vp_label}.png'), full_page=True)

            # 8. MOVILIDAD (TAXI BOOKING)
            page.goto(f"{BASE}/#taxi")
            page.wait_for_timeout(350)
            # Si ya hay un viaje activo, lo limpiamos temporalmente o mostramos el formulario
            page.screenshot(path=str(AUDIT_DIR / f'08-movilidad-{vp_label}.png'), full_page=True)

            # Si está en el formulario, pedir un taxi para capturar tracking
            req_form = page.locator('form[data-form="taxi-request"]')
            if req_form.is_visible():
                page.locator('button[type="submit"]').click()
                page.wait_for_timeout(350)

            # 9. TRACKING TAXI
            page.screenshot(path=str(AUDIT_DIR / f'09-tracking-taxi-{vp_label}.png'), full_page=True)

            # 10. PANEL TAXISTA
            page.goto(f"{BASE}/#taxi-driver")
            page.wait_for_timeout(350)
            page.screenshot(path=str(AUDIT_DIR / f'10-panel-taxista-{vp_label}.png'), full_page=True)

            # 11. PRESENTACIÓN INSTITUCIONAL
            page.goto(f"{BASE}/#presentacion")
            page.wait_for_timeout(400)
            page.screenshot(path=str(AUDIT_DIR / f'11-presentacion-{vp_label}.png'), full_page=True)

            ctx.close()
        browser.close()
        print("Captura visual completa generada en evidence/visual_audit/")

if __name__ == '__main__':
    capture_all()
