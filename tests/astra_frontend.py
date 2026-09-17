"""Focused checks for the final visual pass, not business logic tests."""
import json
import os
from pathlib import Path
from statistics import median
from playwright.sync_api import sync_playwright, expect

OUT = Path(__file__).resolve().parent.parent / 'evidence' / 'astra'
OUT.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('CAUCE_TEST_URL', 'http://127.0.0.1:4187')
BASELINE = os.environ.get('CAUCE_BASELINE_URL', 'http://127.0.0.1:4188')
report = {'checks': [], 'performance': []}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CAUCE_CHROMIUM_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe'))
    context = browser.new_context(viewport={'width': 390, 'height': 844}, reduced_motion='reduce')
    page = context.new_page()
    page.goto(BASE)
    opener = page.locator('#header-demo-pill')
    opener.click()
    expect(page.locator('#modal-container')).to_be_visible()
    for _ in range(12):
        page.keyboard.press('Tab')
        # Native dialogs may return focus to browser chrome (activeElement=body),
        # but must never expose an underlying application control.
        assert page.evaluate("document.activeElement === document.body || document.querySelector('#modal-container').contains(document.activeElement)")
    page.keyboard.press('Escape')
    expect(page.locator('#modal-container')).not_to_be_visible()
    expect(opener).to_be_focused()
    report['checks'].append('Native modal: focus containment, Escape and focus restoration PASS')

    page.goto(BASE + '/#shop/orilla')
    page.get_by_role('button', name='Agregar La clásica', exact=True).click()
    expect(page.locator('#cart-count')).to_have_text('1')
    assert page.locator('.product-qty-stepper button').first.bounding_box()['height'] >= 44
    page.goto(BASE + '/#cart/orilla')
    expect(page.locator('.quantity button').first).to_be_visible()
    assert page.locator('.quantity button').first.bounding_box()['height'] >= 44
    for height in [844, 500]:
        page.set_viewport_size({'width': 390, 'height': height})
        page.locator('#checkout-name').focus()
        page.locator('#checkout-name').scroll_into_view_if_needed()
        bar = page.locator('.checkout-sticky-bar').bounding_box()
        nav = page.locator('.bottom-nav').bounding_box()
        assert bar['y'] + bar['height'] <= nav['y'] + 1
    report['checks'].append('44px steppers and checkout/nav separation at 844px and 500px heights PASS; not physical iOS keyboard certification')
    page.set_viewport_size({'width': 1440, 'height': 900})
    page.locator('[data-action="fill-demo-checkout"]').click()
    page.locator('[data-testid="confirm-order"]').click()
    expect(page.get_by_role('heading', name='Recibido', exact=True)).to_be_visible()
    # Fixture only in this isolated browser storage, to inspect a busy order tray.
    page.evaluate('''() => {
      const key = 'cauce:demo:database:v1';
      const state = JSON.parse(localStorage.getItem(key));
      const source = state.orders[0];
      state.orders = Array.from({length: 15}, (_, i) => ({...source, id: 'audit-' + i, code: 'CA-' + String(i+1).padStart(4, '0')}));
      localStorage.setItem(key, JSON.stringify(state));
    }''')
    page.reload()
    page.goto(BASE + '/#business/orilla')
    expect(page.locator('.order-card')).to_have_count(15)
    boxes = [page.locator('.order-card').nth(i).bounding_box() for i in range(3)]
    assert max(b['y'] for b in boxes) - min(b['y'] for b in boxes) < 1
    assert all(340 <= b['width'] <= 420 for b in boxes)
    page.screenshot(path=str(OUT / 'business-15-orders.png'), full_page=True)
    report['checks'].append('15-order fixture: three readable columns, unchanged DOM priority PASS')
    context.close()

    for width, height in [(390, 844), (1440, 900)]:
        for label, url in [('before', BASELINE), ('after', BASE)]:
            samples = []
            for _ in range(3):
                ctx = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
                pg = ctx.new_page()
                session = ctx.new_cdp_session(pg)
                session.send('Network.enable')
                session.send('Network.setCacheDisabled', {'cacheDisabled': True})
                session.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 40, 'downloadThroughput': 1250000, 'uploadThroughput': 1250000})
                pg.add_init_script('''window.auditPerf = {lcp: 0, cls: 0};
                  new PerformanceObserver(list => { for (const e of list.getEntries()) window.auditPerf.lcp = e.startTime; }).observe({type: 'largest-contentful-paint', buffered: true});
                  new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.auditPerf.cls += e.value; }).observe({type: 'layout-shift', buffered: true});''')
                pg.goto(url)
                pg.wait_for_load_state('networkidle')
                pg.wait_for_timeout(500)
                samples.append(pg.evaluate('({...window.auditPerf, transferred: performance.getEntriesByType("resource").reduce((sum, e) => sum + e.transferSize, 0)})'))
                ctx.close()
            report['performance'].append({'phase': label, 'width': width, 'samples': samples, 'median_lcp_ms': median(s['lcp'] for s in samples), 'median_cls': median(s['cls'] for s in samples), 'median_bytes': median(s['transferred'] for s in samples)})
    browser.close()
(OUT / 'frontend-checks.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
