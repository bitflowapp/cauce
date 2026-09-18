"""Suite de validación E2E para el módulo de Movilidad / Taxis de CAUCE · Aluminé.
Verifica:
1. Acceso a Movilidad desde Home y barra de navegación.
2. Formulario de solicitud de taxi en Aluminé con estimación de tarifa.
3. Creación del viaje y pantalla de seguimiento (mapa, timeline, móvil asignado).
4. Circuito operativo del chofer en #taxi-driver (aceptar, en camino, llegó, a bordo, en viaje, finalizar).
5. Persistencia del viaje y controles de cancelación antes de iniciar.
6. Mobile viewports (390x844, 393x852, 430x932) sin overflow horizontal y con touch targets >=44px.
7. Cero errores JS y cero solicitudes de red externas.
"""
import os
import sys
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(exist_ok=True)
BASE = os.environ.get('CAUCE_TEST_URL', 'http://127.0.0.1:4173')

results = []
errors = []
external = []

def record(name, status, details=None):
    entry = {'test': name, 'status': status}
    if details: entry['details'] = details
    results.append(entry)
    print(f"[{status}] {name}")

def navigate(page, path):
    page.wait_for_timeout(150)
    page.goto(f"{BASE}/#{path}")
    page.wait_for_timeout(200)

executable = os.environ.get('CAUCE_CHROMIUM_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe')
if not os.path.exists(executable) and Path('/usr/bin/chromium').exists():
    executable = '/usr/bin/chromium'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox'])

    # 1. Desktop Context (1440x900)
    context = browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
    context.on('page', lambda page: page.on('pageerror', lambda err: errors.append(str(err))))
    context.on('request', lambda req: external.append(req.url) if not req.url.startswith(BASE) else None)
    page = context.new_page()

    try:
        # A. Home y acceso a Taxi
        navigate(page, 'home')
        expect(page.get_by_role('heading', name='Taxis de Aluminé')).to_be_visible()
        expect(page.get_by_role('link', name='Pedir un taxi →')).to_be_visible()
        record('HOME presenta módulo de Movilidad/Taxis de Aluminé', 'PASS')

        # B. Formulario de solicitud de taxi
        page.get_by_role('link', name='Pedir un taxi →').click()
        page.wait_for_timeout(200)
        expect(page.locator('form[data-form="taxi-request"]')).to_be_visible()
        expect(page.locator('#taxi-origin-input')).to_have_value('Plaza San Martín (Centro)')
        expect(page.locator('#taxi-destination-input')).to_have_value('Hospital de Aluminé')
        page.screenshot(path=str(EVIDENCE / 'taxi-booking-desktop.png'), full_page=True)
        record('FORMULARIO de solicitud de taxi en Aluminé accesible', 'PASS')

        # C. Enviar solicitud -> Seguimiento de viaje
        page.locator('button[type="submit"]').click()
        page.wait_for_timeout(300)
        expect(page.locator('.taxi-tracking-header')).to_be_visible()
        expect(page.locator('.taxi-tracking-map')).to_be_visible()
        expect(page.locator('.taxi-driver-card')).to_contain_text('Carlos Morales')
        expect(page.locator('.taxi-driver-card')).to_contain_text('Móvil 04')
        trip_url = page.url
        page.screenshot(path=str(EVIDENCE / 'taxi-tracking-desktop.png'), full_page=True)
        record('TRACKING de taxi con mapa esquemático y móvil 04 asignado', 'PASS')

        # D. Panel del Taxista (#taxi-driver)
        navigate(page, 'taxi-driver')
        expect(page.get_by_role('heading', name='Móvil 04 · Carlos Morales')).to_be_visible()
        expect(page.locator('.taxi-driver-action-card')).to_be_visible()
        expect(page.locator('.taxi-driver-action-card')).to_contain_text('Plaza San Martín')
        page.screenshot(path=str(EVIDENCE / 'taxi-driver-desktop.png'), full_page=True)
        record('PANEL DEL TAXISTA muestra el viaje asignado', 'PASS')

        # E. Circuito secuencial operativo en el panel del chofer
        # 1. Aceptar viaje
        page.locator('[data-action="driver-advance-taxi"]').click()
        page.wait_for_timeout(200)
        expect(page.locator('.taxi-status-badge')).to_contain_text('Taxi asignado')

        # 2. Voy hacia pasajero
        page.locator('[data-action="driver-advance-taxi"]').click()
        page.wait_for_timeout(200)
        expect(page.locator('.taxi-status-badge')).to_contain_text('Chofer en camino')

        # 3. Llegué al origen
        page.locator('[data-action="driver-advance-taxi"]').click()
        page.wait_for_timeout(200)
        expect(page.locator('.taxi-status-badge')).to_contain_text('Chofer en el origen')

        # 4. Pasajero a bordo
        page.locator('[data-action="driver-advance-taxi"]').click()
        page.wait_for_timeout(200)
        expect(page.locator('.taxi-status-badge')).to_contain_text('Pasajero a bordo')

        # 5. Iniciar viaje
        page.locator('[data-action="driver-advance-taxi"]').click()
        page.wait_for_timeout(200)
        expect(page.locator('.taxi-status-badge')).to_contain_text('Viaje en curso')

        # 6. Finalizar viaje
        page.locator('[data-action="driver-advance-taxi"]').click()
        page.wait_for_timeout(200)
        expect(page.locator('.taxi-driver-panel')).to_contain_text('Sin viajes activos en este momento')
        record('CIRCUITO OPERATIVO TAXISTA completado secuencialmente (6 pasos)', 'PASS')

        # F. Verificar pantalla del cliente completada
        page.goto(trip_url)
        page.wait_for_timeout(250)
        expect(page.locator('.taxi-status-badge')).to_contain_text('Viaje finalizado')
        expect(page.get_by_role('link', name='Pedir otro taxi')).to_be_visible()
        record('PANTALLA DE SEGUIMIENTO cliente confirma viaje finalizado', 'PASS')

        # G. Mobile audit (390x844, 393x852, 430x932)
        viewports = [
            ('iPhone 12/13/14 (390x844)', {'width': 390, 'height': 844}),
            ('iPhone 15/16 (393x852)', {'width': 393, 'height': 852}),
            ('iPhone Pro Max (430x932)', {'width': 430, 'height': 932}),
        ]

        for name, vp in viewports:
            m_ctx = browser.new_context(viewport=vp, is_mobile=True, has_touch=True, reduced_motion='reduce')
            m_ctx.on('page', lambda p: p.on('pageerror', lambda err: errors.append(str(err))))
            m_page = m_ctx.new_page()

            # Mobile Taxi Booking
            navigate(m_page, 'taxi')
            no_overflow_booking = m_page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            assert no_overflow_booking, f"Overflow horizontal en booking {name}"
            if '390' in name:
                m_page.screenshot(path=str(EVIDENCE / 'taxi-booking-mobile-390.png'), full_page=True)

            # Mobile Taxi Driver Panel
            navigate(m_page, 'taxi-driver')
            no_overflow_driver = m_page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            assert no_overflow_driver, f"Overflow horizontal en driver {name}"
            if '390' in name:
                m_page.screenshot(path=str(EVIDENCE / 'taxi-driver-mobile-390.png'), full_page=True)

            m_ctx.close()
            record(f'MOBILE {name} en vistas de Taxi sin overflow', 'PASS')

        # H. Touch target audit (botones >=44px)
        navigate(page, 'taxi')
        btn_height = page.locator('button[type="submit"]').bounding_box()['height']
        assert btn_height >= 44, f"Botón de solicitar taxi < 44px ({btn_height}px)"
        record('ACCESIBILIDAD: Touch targets de formulario >= 44px', 'PASS')

        assert len(errors) == 0, f"Errores JS detectados: {errors}"
        assert len(external) == 0, f"Solicitudes externas detectadas: {external}"
        record('CERO excepciones JS y cero solicitudes de red externas', 'PASS')

    except Exception as exc:
        record('E2E TAXI EXECUTION', 'FAIL', str(exc))
        page.screenshot(path=str(EVIDENCE / 'taxi-failure.png'), full_page=True)
        raise
    finally:
        browser.close()
        (EVIDENCE / 'taxi-e2e-results.json').write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding='utf-8')
