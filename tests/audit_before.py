"""
Script de auditoría UX visual inicial (BEFORE) sobre la versión LIVE:
https://bitflowapp.github.io/cauce/
Captura viewports: 390x844, 393x852, 430x932, 768x1024, 1440x900.
Recorre el circuito completo y genera capturas en evidence/before/.
"""
import os
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BEFORE_DIR = ROOT / 'evidence' / 'before'
BEFORE_DIR.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('BASE_URL', 'https://bitflowapp.github.io/cauce').rstrip('/')

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
    
    # 1. Capturas por Viewport de la HOME
    for vp_name, vp_size in viewports:
        ctx = browser.new_context(viewport=vp_size, reduced_motion='reduce')
        page = ctx.new_page()
        page.goto(BASE + '/#home')
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(400)
        
        # Evaluar métricas de densidad y visibilidad
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
        
        img_path = BEFORE_DIR / f'before-home-{vp_name}.png'
        page.screenshot(path=str(img_path), full_page=False)
        audit_log.append({
            'viewport': vp_name,
            'screen': 'home',
            'screenshot': str(img_path.name),
            'metrics': metrics
        })
        ctx.close()
        
    # 2. Recorrido del circuito completo en Desktop (1440x900) y Mobile (390x844)
    for flow_mode, vp_size in [('desktop', {'width': 1440, 'height': 900}), ('mobile', {'width': 390, 'height': 844})]:
        ctx = browser.new_context(viewport=vp_size, reduced_motion='reduce')
        page = ctx.new_page()
        
        # HOME
        page.goto(BASE + '/#home')
        page.wait_for_timeout(300)
        page.screenshot(path=str(BEFORE_DIR / f'before-flow-home-{flow_mode}.png'))
        
        # COMERCIO / SHOP
        page.goto(BASE + '/#shop/orilla')
        page.wait_for_timeout(300)
        page.screenshot(path=str(BEFORE_DIR / f'before-flow-shop-{flow_mode}.png'))
        
        # AGREGAR PRODUCTO
        page.get_by_role('button', name='Agregar La clásica', exact=True).click()
        page.wait_for_timeout(200)
        
        # CARRITO
        page.goto(BASE + '/#cart/orilla')
        page.wait_for_timeout(300)
        page.screenshot(path=str(BEFORE_DIR / f'before-flow-cart-{flow_mode}.png'))
        
        # CHECKOUT
        page.get_by_label('Modalidad de entrega').select_option('delivery')
        page.get_by_label('Dirección de ejemplo').fill('Av. 4 de Febrero 450')
        page.wait_for_timeout(200)
        page.screenshot(path=str(BEFORE_DIR / f'before-flow-checkout-{flow_mode}.png'))
        
        # CREAR PEDIDO
        page.get_by_role('button', name='Crear pedido de prueba', exact=True).click()
        page.wait_for_timeout(400)
        
        # TRACKING
        page.screenshot(path=str(BEFORE_DIR / f'before-flow-tracking-{flow_mode}.png'))
        order_url = page.url
        order_id = order_url.split('#order/')[1] if '#order/' in order_url else ''
        
        # PANEL COMERCIO
        page.goto(BASE + '/#business/orilla')
        page.wait_for_timeout(300)
        page.screenshot(path=str(BEFORE_DIR / f'before-flow-business-{flow_mode}.png'))
        
        # AVANZAR PEDIDO EN COCINA
        for action in ['Confirmar', 'Preparar', 'Marcar listo', 'Asignar repartidor demo']:
            btn = page.get_by_role('button', name=action, exact=True)
            if btn.is_visible():
                btn.click()
                page.wait_for_timeout(200)
                
        # RIDER
        page.goto(BASE + '/#rider/orilla')
        page.wait_for_timeout(300)
        page.screenshot(path=str(BEFORE_DIR / f'before-flow-rider-{flow_mode}.png'))
        
        ctx.close()
        
    browser.close()

with open(BEFORE_DIR / 'audit_metrics.json', 'w', encoding='utf-8') as f:
    json.dump(audit_log, f, indent=2, ensure_ascii=False)

print(f"Auditoría visual inicial completada. Capturas guardadas en {BEFORE_DIR}")
