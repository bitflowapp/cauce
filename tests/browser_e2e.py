"""Pruebas de navegador de la demo. Requiere Playwright Python y Chromium.
No requiere acceso a Internet ni prueba servicios productivos.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / 'evidence'
BASE = os.environ.get('CAUCE_TEST_URL', 'http://127.0.0.1:4173')
EVIDENCE.mkdir(exist_ok=True)
results=[]
errors=[]
external=[]

def passed(name):
    results.append({'test':name,'status':'PASS'})

def navigate(page, path):
    page.wait_for_timeout(250)
    page.goto(BASE + '/#' + path)
    page.wait_for_timeout(250)

with sync_playwright() as playwright:
    executable = os.environ.get('CAUCE_CHROMIUM_PATH')
    if not executable and Path('/usr/bin/chromium').exists():
        executable = '/usr/bin/chromium'
    browser=playwright.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1440,'height':1000}, reduced_motion='reduce')
    context.on('page', lambda page: page.on('pageerror', lambda err: errors.append(str(err))))
    context.on('request', lambda request: external.append(request.url) if not request.url.startswith(BASE) else None)
    page=context.new_page()
    try:
        navigate(page,'home')
        expect(page.locator('[data-testid="store-card"]')).to_have_count(7)
        page.screenshot(path=str(EVIDENCE/'home-desktop.png'),full_page=True)
        passed('home desktop: siete comercios ficticios')
        page.get_by_label('Buscar comercio o comida').fill('pizza')
        expect(page.locator('[data-testid="store-card"]')).to_have_count(1)
        page.get_by_label('Buscar comercio o comida').fill('')
        page.get_by_label('Solo abiertos').check()
        expect(page.locator('[data-testid="store-card"]')).to_have_count(6)
        page.get_by_label('Solo abiertos').uncheck()
        passed('búsqueda y filtro de apertura')
        navigate(page,'shop/orilla')
        page.get_by_role('button',name='Agregar La clásica',exact=True).click()
        expect(page.locator('#cart-count')).to_have_text('1')
        navigate(page,'shop/horno')
        page.get_by_role('button',name='Agregar Muzzarella',exact=True).click()
        expect(page.locator('#cart-count')).to_have_text('2')
        navigate(page,'carts')
        expect(page.get_by_role('link',name='Revisar carrito')).to_have_count(2)
        page.reload()
        expect(page.get_by_role('link',name='Revisar carrito')).to_have_count(2)
        passed('dos carritos independientes sobreviven a recarga')
        navigate(page,'cart/orilla')
        expect(page.locator('.cart-line')).to_have_count(1)
        expect(page.locator('.cart-line')).to_contain_text('La clásica')
        page.get_by_label('Modalidad de entrega').select_option('delivery')
        page.get_by_label('Dirección de ejemplo').fill('Calle de prueba 123')
        page.screenshot(path=str(EVIDENCE/'checkout-desktop.png'),full_page=True)
        page.get_by_role('button',name='Crear pedido de prueba',exact=True).click()
        expect(page.get_by_role('heading',name='Recibido',exact=True)).to_be_visible()
        delivery_path=page.url.split('#',1)[1]
        passed('checkout delivery y seguimiento inicial')
        navigate(page,'business/horno')
        expect(page.locator('.order-card')).to_have_count(0)
        navigate(page,'business/orilla')
        expect(page.locator('.order-card')).to_have_count(1)
        for action in ['Confirmar','Preparar','Marcar listo','Asignar repartidor demo']:
            page.get_by_role('button',name=action,exact=True).click()
        passed('bandeja por comercio y asignación de rider propio')
        navigate(page,'rider/horno')
        expect(page.locator('.order-card')).to_have_count(0)
        navigate(page,'rider/orilla')
        for action in ['Confirmar retiro','Salir a reparto','Llegué al destino','Confirmar entrega']:
            page.get_by_role('button',name=action,exact=True).click()
        navigate(page,delivery_path)
        expect(page.get_by_role('heading',name='Entregado',exact=True)).to_be_visible()
        expect(page.locator('.timeline li')).to_have_count(9)
        page.screenshot(path=str(EVIDENCE/'tracking-desktop.png'),full_page=True)
        passed('delivery completo y nueve eventos de seguimiento')
        navigate(page,'cart/horno')
        page.get_by_role('button',name='Crear pedido de prueba',exact=True).click()
        expect(page.get_by_role('heading',name='Recibido',exact=True)).to_be_visible()
        pickup_path=page.url.split('#',1)[1]
        navigate(page,'business/horno')
        for action in ['Confirmar','Preparar','Marcar listo','Confirmar entrega']:
            page.get_by_role('button',name=action,exact=True).click()
        navigate(page,pickup_path)
        expect(page.get_by_role('heading',name='Entregado',exact=True)).to_be_visible()
        passed('circuito retiro sin asignación de reparto')
        navigate(page,'business/ronda')
        page.get_by_role('button',name='Abrir comercio demo',exact=True).click()
        navigate(page,'shop/ronda')
        expect(page.get_by_role('button',name='Agregar Tarta de verduras',exact=True)).to_be_enabled()
        passed('apertura del comercio cambia disponibilidad')
        navigate(page,'business/orilla')
        form=page.locator('form[data-product="papas"]')
        form.get_by_label('Precio de ejemplo').fill('6000')
        form.get_by_label('Stock de ejemplo').fill('1')
        form.get_by_role('button',name='Guardar cambios demo').click()
        navigate(page,'shop/orilla')
        page.get_by_role('button',name='Agregar Papas para compartir',exact=True).click()
        expect(page.get_by_role('button',name='Agregar Papas para compartir',exact=True)).to_be_disabled()
        passed('edición de producto: precio y stock reflejados')
        navigate(page,'cart/orilla')
        page.get_by_label('Nombre de ejemplo').fill('<img src=x onerror=alert(1)>')
        page.get_by_role('button',name='Crear pedido de prueba',exact=True).click()
        navigate(page,'business/orilla')
        expect(page.locator('.order-card')).to_have_count(2)
        expect(page.locator('.order-card img')).to_have_count(0)
        expect(page.locator('.order-card').first).to_contain_text('<img src=x onerror=alert(1)>')
        passed('datos introducidos se muestran escapados, sin HTML ejecutable')
        mobile=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,reduced_motion='reduce')
        mobile.on('page',lambda p:p.on('pageerror',lambda err:errors.append(str(err))))
        m=mobile.new_page()
        navigate(m,'home')
        assert m.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Overflow en home móvil'
        m.screenshot(path=str(EVIDENCE/'home-mobile.png'),full_page=True)
        navigate(m,'shop/orilla')
        assert m.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Overflow en catálogo móvil'
        m.get_by_role('button',name='Agregar La clásica',exact=True).click()
        navigate(m,'cart/orilla')
        assert m.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Overflow en checkout móvil'
        m.screenshot(path=str(EVIDENCE/'checkout-mobile.png'),full_page=True)
        m.get_by_role('button',name='Crear pedido de prueba',exact=True).click()
        expect(m.get_by_role('heading',name='Recibido',exact=True)).to_be_visible()
        passed('móvil 390 px: navegación, checkout y ausencia de overflow')
        mobile.close()
        assert not external, f'Solicitudes externas: {external}'
        assert not errors, f'Errores JS: {errors}'
        passed('cero solicitudes externas y cero errores JavaScript')
    except Exception as exc:
        results.append({'test':'browser execution','status':'FAIL','message':str(exc)})
        page.screenshot(path=str(EVIDENCE/'failure.png'),full_page=True)
        raise
    finally:
        (EVIDENCE/'browser-results.json').write_text(json.dumps({'scope':'DEMO_LOCAL_ONLY','results':results,'js_errors':errors,'external_requests':external},ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(results,ensure_ascii=False,indent=2))
        browser.close()
