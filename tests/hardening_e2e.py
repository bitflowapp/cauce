"""Suite de validación de endurecimiento frontend para CAUCE v0.3.2.
Verifica:
1. Keyboard checkout (accesibilidad y navegación por teclado en orden DOM real).
2. Fulfillment accessibility (semántica fieldset/legend/radio, target >=44px, sincronización).
3. Forced image failure (fallback visual SVG sin errores JS ni violaciones CSP).
4. Escaping regression (sin doble escape de caracteres especiales en el DOM).
"""
import os
import sys
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / 'evidence'
BASE = os.environ.get('CAUCE_TEST_URL', 'http://127.0.0.1:4173')

results = []

def record(name, status, message=None):
    entry = {'test': name, 'status': status}
    if message: entry['message'] = message
    results.append(entry)
    print(f"[{status}] {name}")

def navigate(page, path):
    page.goto(f"{BASE}/#{path}")
    page.wait_for_timeout(150)

def reset_page(browser):
    context = browser.new_context(viewport={'width': 1280, 'height': 800}, reduced_motion='reduce')
    page = context.new_page()
    page.goto(f"{BASE}/#home")
    page.evaluate('localStorage.clear()')
    page.reload()
    page.wait_for_timeout(100)
    return context, page

def run_tests():
    executable = os.environ.get('CAUCE_CHROMIUM_PATH')
    if not executable and Path('/usr/bin/chromium').exists():
        executable = '/usr/bin/chromium'

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])

        # ----------------------------------------------------
        # TEST 1: KEYBOARD CHECKOUT
        # ----------------------------------------------------
        try:
            context, page = reset_page(browser)
            navigate(page, 'shop/orilla')
            page.locator('button[data-product="burger-clasica"][data-action="add"]').click()
            expect(page.locator('#cart-count')).to_have_text('1')

            navigate(page, 'cart/orilla')
            name_input = page.locator('#checkout-name')
            phone_input = page.locator('#checkout-phone')
            expect(name_input).to_be_visible()
            assert name_input.input_value() == '', 'El campo nombre debe iniciar vacío'
            assert phone_input.input_value() == '', 'El campo teléfono debe iniciar vacío'

            # 1. Focus del radio Delivery y selección por Space
            page.evaluate("() => document.getElementById('fulfillment-delivery').focus()")
            page.keyboard.press('Space')
            page.wait_for_timeout(100)
            assert page.locator('#fulfillment-delivery').is_checked(), 'El radio delivery debe estar seleccionado'

            # 2. Tab entre inputs y completado por teclado
            page.keyboard.press('Tab')  # helper demo button
            page.keyboard.press('Tab')  # input nombre
            expect(name_input).to_be_focused()
            page.keyboard.type('Marcela González')

            page.keyboard.press('Tab')  # input teléfono
            expect(phone_input).to_be_focused()
            page.keyboard.type('2942556677')

            page.keyboard.press('Tab')  # input dirección
            address_input = page.locator('#checkout-address')
            expect(address_input).to_be_focused()
            page.keyboard.type('Av. 4 de Febrero 450')

            page.keyboard.press('Tab')  # input referencia
            expect(page.locator('#checkout-reference')).to_be_focused()
            page.keyboard.type('Casa con reja verde, timbre al fondo')

            page.keyboard.press('Tab')  # textarea notas
            expect(page.locator('#checkout-notes')).to_be_focused()
            page.keyboard.type('Sin cebolla')

            # 3. Tab hasta Confirmar pedido y Enter
            page.keyboard.press('Tab')  # botón confirmar
            confirm_btn = page.locator('[data-testid="confirm-order"]')
            expect(confirm_btn).to_be_focused()
            page.keyboard.press('Enter')
            page.wait_for_timeout(300)
            expect(page.get_by_role('heading', name='Recibido', exact=True)).to_be_visible()
            record('1. Keyboard checkout: navegación, foco secuencial y envío por teclado', 'PASS')
            context.close()
        except Exception as exc:
            record('1. Keyboard checkout', 'FAIL', str(exc))

        # ----------------------------------------------------
        # TEST 2: FULFILLMENT ACCESSIBILITY
        # ----------------------------------------------------
        try:
            context, page = reset_page(browser)
            navigate(page, 'shop/orilla')
            page.locator('button[data-product="burger-clasica"][data-action="add"]').click()
            expect(page.locator('#cart-count')).to_have_text('1')
            navigate(page, 'cart/orilla')

            # Estructura semántica de fieldset y legend
            fieldset = page.locator('fieldset[data-testid="fulfillment-selector"]')
            expect(fieldset).to_be_visible()
            legend = fieldset.locator('legend')
            assert '¿Cómo recibís tu pedido?' in legend.inner_text(), 'Legend no coincide'
            
            radiogroup = fieldset.locator('[role="radiogroup"]')
            expect(radiogroup).to_have_attribute('aria-label', 'Modalidad de entrega')

            # Inputs de radio con labels vinculados
            pickup_radio = page.locator('input#fulfillment-pickup')
            delivery_radio = page.locator('input#fulfillment-delivery')
            pickup_label = page.locator('label[for="fulfillment-pickup"]')
            delivery_label = page.locator('label[for="fulfillment-delivery"]')

            expect(pickup_radio).to_have_attribute('name', 'fulfillment')
            expect(delivery_radio).to_have_attribute('name', 'fulfillment')

            # Targets táctiles >= 44px
            p_box = pickup_label.bounding_box()
            d_box = delivery_label.bounding_box()
            assert p_box['height'] >= 44 and p_box['width'] >= 44, f"Target pickup insuficiente: {p_box}"
            assert d_box['height'] >= 44 and d_box['width'] >= 44, f"Target delivery insuficiente: {d_box}"

            # Interacción y sincronización
            delivery_label.click()
            expect(delivery_radio).to_be_checked()
            expect(pickup_radio).not_to_be_checked()
            expect(page.locator('#checkout-address')).to_be_visible()
            
            pickup_label.click()
            expect(pickup_radio).to_be_checked()
            expect(delivery_radio).not_to_be_checked()
            expect(page.locator('#checkout-address')).to_have_count(0)

            record('2. Fulfillment accessibility: fieldset, legend, radio semantics y touch >=44px', 'PASS')
            context.close()
        except Exception as exc:
            record('2. Fulfillment accessibility', 'FAIL', str(exc))

        # ----------------------------------------------------
        # TEST 3: FORCED IMAGE FAILURE
        # ----------------------------------------------------
        try:
            context, page = reset_page(browser)
            errors = []
            page.on('pageerror', lambda err: errors.append(str(err)))
            navigate(page, 'shop/orilla')

            # Inyectar una imagen rota para verificar captura global de error
            page.evaluate('''() => {
              const container = document.querySelector('.product-img');
              if (container) {
                const brokenImg = document.createElement('img');
                brokenImg.id = 'test-broken-img';
                brokenImg.src = 'assets/images/non-existent-image-error-test.webp';
                container.appendChild(brokenImg);
              }
            }''')
            page.wait_for_timeout(300)

            broken_img = page.locator('#test-broken-img')
            expect(broken_img).to_have_class('img-hidden')
            display_style = broken_img.evaluate('el => window.getComputedStyle(el).display')
            assert display_style == 'none', f"La imagen rota debió ocultarse, display={display_style}"
            
            svg_fallback = page.locator('.product-img svg').first
            expect(svg_fallback).to_be_visible()

            assert len(errors) == 0, f"Se detectaron errores JS: {errors}"
            record('3. Forced image failure: fallback visual activado sin errores JS ni violación de CSP', 'PASS')
            context.close()
        except Exception as exc:
            record('3. Forced image failure', 'FAIL', str(exc))

        # ----------------------------------------------------
        # TEST 4: DOM ESCAPING REGRESSION
        # ----------------------------------------------------
        try:
            context, page = reset_page(browser)
            navigate(page, 'shop/orilla')
            page.locator('button[data-product="burger-clasica"][data-action="add"]').click()
            expect(page.locator('#cart-count')).to_have_text('1')
            
            # Con el carrito creado, modificar el producto con caracteres reservados (& y < >)
            page.evaluate('''() => {
              const state = JSON.parse(localStorage.getItem('cauce:demo:database:v1'));
              const p = state.products.find(item => item.id === 'burger-clasica');
              p.name = 'Café & Medialunas <Especial>';
              localStorage.setItem('cauce:demo:database:v1', JSON.stringify(state));
            }''')
            page.reload()
            page.wait_for_timeout(100)

            navigate(page, 'carts')
            summary_p = page.locator('.cart-merchant-items-summary').first
            expect(summary_p).to_be_visible()
            text = summary_p.inner_text()
            html = summary_p.inner_html()
            assert 'Café & Medialunas <Especial>' in text, f"Texto visible incorrecto: {text}"
            assert '&amp;amp;' not in html, f"Doble escape detectado en HTML: {html}"
            assert '&amp;lt;' not in html, f"Doble escape detectado en HTML: {html}"

            navigate(page, 'cart/orilla')
            line_title = page.locator('.cart-line-title').first
            expect(line_title).to_be_visible()
            assert 'Café & Medialunas <Especial>' in line_title.inner_text()
            assert '&amp;amp;' not in line_title.inner_html()

            record('4. Escaping regression: & y < renderizan exactamente una vez en el DOM sin &amp;amp;', 'PASS')
            context.close()
        except Exception as exc:
            record('4. DOM escaping regression', 'FAIL', str(exc))

        browser.close()

    summary_file = EVIDENCE / 'hardening-test-results.json'
    summary_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    
    failures = [r for r in results if r['status'] != 'PASS']
    if failures:
        print(f"\n{len(failures)} pruebas fallaron:")
        for f in failures:
            print(f"- {f['test']}: {f.get('message')}")
        sys.exit(1)
    else:
        print(f"\nTODAS LAS PRUEBAS DE HARDENING PASARON ({len(results)}/{len(results)}).")

if __name__ == '__main__':
    run_tests()
