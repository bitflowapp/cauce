"""Smoke visual y DOM offline. Almacenamiento en memoria, NO E2E HTTP.
No modifica políticas del navegador ni solicita recursos de red.
"""
from pathlib import Path
import base64
import hashlib
import json
import os
import re
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parent.parent
EVIDENCE=ROOT/'evidence'
html=(ROOT/'index.html').read_text(encoding='utf-8')
css=(ROOT/'styles/cauce.css').read_text(encoding='utf-8')
bundle=(EVIDENCE/'offline.bundle.js').read_text(encoding='utf-8')
hash_css=base64.b64encode(hashlib.sha256(css.encode()).digest()).decode()
html=re.sub(r'<link[^>]+rel="(?:stylesheet|icon|modulepreload|preload)"[^>]*>','',html)
html=html.replace('<script type="module" src="js/app.js"></script>','')
html=html.replace("style-src 'self'",f"style-src 'sha256-{hash_css}'")
html=html.replace('</head>',f'<style>{css}</style></head>')
results=[]
errors=[]

def init(page):
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content(html)
    page.evaluate('''() => {
      const entries = new Map();
      Object.defineProperty(window, 'localStorage', {value: {
        getItem: key => entries.get(String(key)) ?? null,
        setItem: (key,value) => entries.set(String(key),String(value)),
        removeItem: key => entries.delete(String(key))
      }});
    }''')
    page.evaluate(bundle)

def nav(page,path):
    page.evaluate('(hash) => { location.hash = hash; }',path)
    page.wait_for_timeout(70)

def passed(name):results.append({'test':name,'status':'PASS'})

with sync_playwright() as p:
    executable=os.environ.get('CAUCE_CHROMIUM_PATH')
    if not executable and Path('/usr/bin/chromium').exists(): executable='/usr/bin/chromium'
    browser=p.chromium.launch(executable_path=executable,headless=True,args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1440,'height':1000},reduced_motion='reduce')
    page=context.new_page()
    try:
        init(page)
        expect(page.locator('[data-testid="store-card"]')).to_have_count(7)
        page.screenshot(path=str(EVIDENCE/'home-desktop.png'),full_page=True)
        passed('render desktop offline de home')
        page.get_by_label('Buscar comercio o comida').fill('pizza')
        expect(page.locator('[data-testid="store-card"]')).to_have_count(1)
        page.get_by_label('Buscar comercio o comida').fill('')
        passed('búsqueda en DOM')
        nav(page,'shop/orilla')
        page.get_by_role('button',name='Agregar La clásica',exact=True).click()
        expect(page.locator('#cart-count')).to_have_text('1')
        nav(page,'shop/horno')
        page.get_by_role('button',name='Agregar Muzzarella',exact=True).click()
        nav(page,'carts')
        expect(page.locator('[data-testid="continue-order-link"]')).to_have_count(2)
        passed('carritos por comercio en DOM')
        nav(page,'cart/orilla')
        page.locator('label[for="fulfillment-delivery"]').click()
        page.locator('[data-action="fill-demo-checkout"]').click()
        page.screenshot(path=str(EVIDENCE/'checkout-desktop.png'),full_page=True)
        page.locator('[data-testid="confirm-order"]').click()
        expect(page.get_by_role('heading',name='Recibido',exact=True)).to_be_visible()
        order_hash=page.evaluate('location.hash.slice(1)')
        passed('checkout demo en DOM con almacenamiento de prueba')
        nav(page,'business/horno')
        expect(page.locator('.order-card')).to_have_count(0)
        nav(page,'business/orilla')
        for action in ['Confirmar','Preparar','Marcar listo','Asignar repartidor demo']:
            page.get_by_role('button',name=action,exact=True).click()
        nav(page,'rider/orilla')
        for action in ['Confirmar retiro','Salir a reparto','Llegué al destino','Confirmar entrega']:
            page.get_by_role('button',name=action,exact=True).click()
        nav(page,order_hash)
        expect(page.get_by_role('heading',name='Entregado',exact=True)).to_be_visible()
        expect(page.locator('.timeline li')).to_have_count(9)
        page.screenshot(path=str(EVIDENCE/'tracking-desktop.png'),full_page=True)
        passed('pedido demo: nueve estados y reparto propio en DOM')
        nav(page,'cart/horno')
        page.locator('[data-action="fill-demo-checkout"]').click()
        page.locator('[data-testid="confirm-order"]').click()
        expect(page.get_by_role('heading',name='Recibido',exact=True)).to_be_visible()
        nav(page,'business/horno')
        for action in ['Confirmar','Preparar','Marcar listo','Confirmar entrega']:
            page.get_by_role('button',name=action,exact=True).click()
        expect(page.locator('.status')).to_have_text('Entregado')
        passed('pedido de retiro en DOM')
        mobile=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,reduced_motion='reduce')
        m=mobile.new_page();init(m)
        assert m.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        m.screenshot(path=str(EVIDENCE/'home-mobile.png'),full_page=True)
        nav(m,'shop/orilla')
        assert m.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        m.screenshot(path=str(EVIDENCE/'shop-mobile.png'),full_page=True)
        m.get_by_role('button',name='Agregar La clásica',exact=True).click()
        nav(m,'cart/orilla')
        assert m.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        m.screenshot(path=str(EVIDENCE/'checkout-mobile.png'),full_page=True)
        m.locator('[data-action="fill-demo-checkout"]').click()
        m.locator('[data-testid="confirm-order"]').click()
        expect(m.get_by_role('heading',name='Recibido',exact=True)).to_be_visible()
        passed('mobile 390 px: home, catálogo, checkout y sin overflow en DOM')
        assert not errors, errors
        passed('cero excepciones JS en el smoke DOM offline')
    except Exception as exc:
        results.append({'test':'offline DOM execution','status':'FAIL','message':str(exc)})
        page.screenshot(path=str(EVIDENCE/'offline-failure.png'),full_page=True)
        raise
    finally:
        (EVIDENCE/'offline-dom-results.json').write_text(json.dumps({'scope':'OFFLINE_DOM_WITH_IN_MEMORY_STORAGE_NOT_HTTP_E2E','results':results,'js_errors':errors},ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(results,ensure_ascii=False,indent=2))
        browser.close()
