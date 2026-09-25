// Auditoría visual y de accesibilidad en los anchos pedidos.
// Mide sobre la página real: desbordes, área táctil, superposición de la barra
// inferior, contraste calculado y estabilidad de imágenes.
//   node tests/visual-audit.mjs [--backend]
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser, findChrome } from './lib/cdp.mjs';
import { createStaticServer } from '../scripts/server.mjs';
import { createDevServer, openDatabase } from '../scripts/dev-server.mjs';

const useBackend = process.argv.includes('--backend');
const WIDTHS = [360, 390, 430];
const DESKTOP = 1440;
const ROUTES = [
  ['inicio', '#inicio'],
  ['comercios', '#comercios'],
  ['comercio', '#comercio/orilla'],
  ['carrito', '#carrito/orilla'],
  ['confirmar', '#carrito/orilla/confirmar'],
  ['taxi', '#taxi'],
  ['actividad', '#actividad'],
  ['cuenta', '#cuenta'],
  ['institucional', '#institucional'],
];

// Mide en la propia página: es el layout real, no una simulación.
const AUDIT = `(() => {
  const toRgb = value => {
    const parts = String(value).match(/[\\d.]+/g);
    if (!parts) return null;
    return parts.slice(0, 3).map(Number);
  };
  const luminance = rgb => {
    const channels = rgb.map(value => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (a, b) => {
    const first = luminance(a);
    const second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };
  const effectiveBackground = element => {
    let node = element;
    while (node && node !== document.documentElement) {
      const background = getComputedStyle(node).backgroundColor;
      const rgb = toRgb(background);
      const alpha = String(background).startsWith('rgba') ? Number(String(background).match(/[\\d.]+/g)[3]) : 1;
      if (rgb && alpha > 0.5) return rgb;
      node = node.parentElement;
    }
    return [255, 255, 255];
  };

  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  // Área táctil: 44 px es el mínimo cómodo en móvil.
  const onScreen = element => {
    const rect = element.getBoundingClientRect();
    return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth;
  };
  const interactive = [...document.querySelectorAll('a[href], button, input, select, textarea')]
    .filter(visible)
    .filter(onScreen)
    .filter(element => !element.closest('.footer'));
  // Una casilla chica dentro de una etiqueta grande sí es cómoda de tocar:
  // el destino real es la etiqueta entera.
  const targetHeight = element => {
    const label = element.closest('label');
    const own = element.getBoundingClientRect().height;
    return label ? Math.max(own, label.getBoundingClientRect().height) : own;
  };
  const smallTargets = interactive
    .filter(element => {
      const rect = element.getBoundingClientRect();
      return targetHeight(element) < 44 || rect.width < 24;
    })
    .map(element => ({
      tag: element.tagName.toLowerCase(),
      text: (element.textContent || element.value || '').trim().slice(0, 32),
      height: Math.round(element.getBoundingClientRect().height),
      width: Math.round(element.getBoundingClientRect().width),
    }));

  // Contraste del texto principal contra su fondo real.
  const textNodes = [...document.querySelectorAll('#main h1, #main h2, #main h3, #main p, #main strong, #main .quiet, #main .microcopy, .bottom-nav-item, .env-chip')]
    .filter(visible)
    .filter(element => (element.textContent || '').trim().length > 2);
  const lowContrast = textNodes
    .map(element => {
      const style = getComputedStyle(element);
      const color = toRgb(style.color);
      if (!color) return null;
      const size = parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      const ratio = contrast(color, effectiveBackground(element));
      return { ratio: Math.round(ratio * 100) / 100, required: large ? 3 : 4.5, text: element.textContent.trim().slice(0, 40) };
    })
    .filter(entry => entry && entry.ratio < entry.required);

  // Texto cortado: el contenido no entra y no está previsto que se recorte.
  // Se excluyen los carruseles horizontales y lo que use puntos suspensivos a propósito.
  const clipped = [...document.querySelectorAll('#main p, #main li, #main label, #main span, #main h1, #main h2, #main h3, .check-label > span')]
    .filter(visible)
    .filter(element => !element.closest('.category-nav-bar, .tabs, .op-card-body'))
    // Las etiquetas sólo para lectores de pantalla miden 1 px a propósito.
    .filter(element => !element.classList.contains('visually-hidden') && element.clientWidth > 4)
    .filter(element => {
      const style = getComputedStyle(element);
      if (style.textOverflow === 'ellipsis' || style.overflowX === 'auto' || style.overflowX === 'scroll') return false;
      return element.scrollWidth > element.clientWidth + 2 && element.clientWidth > 0;
    })
    .map(element => ({
      text: (element.textContent || '').trim().slice(0, 40),
      visible: element.clientWidth,
      needed: element.scrollWidth,
    }));

  // Imágenes sin medidas declaradas: provocan saltos de layout al cargar.
  const unsizedImages = [...document.querySelectorAll('img')]
    .filter(image => !image.getAttribute('width') || !image.getAttribute('height'))
    .map(image => image.getAttribute('src'));

  // La barra inferior no debe taparse con el contenido.
  const nav = document.querySelector('.bottom-nav');
  const navHeight = nav ? nav.getBoundingClientRect().height : 0;
  const bodyPadding = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
  const lastMainChild = document.querySelector('#main')?.lastElementChild;
  // La barra es fija: el contenido pasa por debajo al hacer scroll, y eso es
  // normal. Lo que no puede pasar es que el final del contenido quede tapado
  // cuando ya no se puede seguir bajando.
  const overlapped = (() => {
    if (!nav || !lastMainChild) return false;
    window.scrollTo(0, document.documentElement.scrollHeight);
    const navTop = nav.getBoundingClientRect().top;
    const bottom = lastMainChild.getBoundingClientRect().bottom;
    window.scrollTo(0, 0);
    return bottom > navTop + 1;
  })();

  return {
    horizontalOverflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    smallTargets,
    lowContrast,
    clipped,
    unsizedImages,
    navHeight: Math.round(navHeight),
    bodyPaddingBottom: Math.round(bodyPadding),
    navCoversContent: overlapped,
    hasSafeAreaPadding: getComputedStyle(document.body).paddingBottom !== '0px',
    mainText: (document.querySelector('#main')?.innerText || '').length,
  };
})()`;

async function main() {
  if (!findChrome()) {
    console.error('No se encontró Chrome ni Edge. Definí CAUCE_CHROME_PATH.');
    process.exitCode = 1;
    return;
  }
  const database = useBackend ? openDatabase(':memory:') : null;
  const server = useBackend ? createDevServer({ database }) : createStaticServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const output = `evidence/audit${useBackend ? '-backend' : ''}`;
  await mkdir(output, { recursive: true });
  console.log(`Auditando ${useBackend ? 'entorno con backend' : 'demostración estática'} en ${base}`);

  const browser = await launchBrowser();
  const findings = [];
  const rows = [];

  try {
    for (const width of [...WIDTHS, DESKTOP]) {
      const mobile = width !== DESKTOP;
      const page = await browser.newPage({ width, height: mobile ? 844 : 900, mobile });
      for (const [name, hash] of ROUTES) {
        await page.goto('about:blank');
        await page.goto(`${base}/index.html${hash}`);
        await page.waitForFunction('document.querySelector("#main")?.getAttribute("aria-busy") === "false"');
        const report = await page.evaluate(AUDIT);
        await page.screenshot(`${output}/${width}-${name}.png`, { fullPage: true });
        rows.push({ width, route: hash, ...report });

        if (report.horizontalOverflowPx > 0) {
          findings.push(`${width}px ${hash}: scroll horizontal de ${report.horizontalOverflowPx}px`);
        }
        if (report.navCoversContent) {
          findings.push(`${width}px ${hash}: la barra inferior tapa el contenido`);
        }
        if (mobile && report.smallTargets.length) {
          findings.push(`${width}px ${hash}: ${report.smallTargets.length} controles por debajo de 44px`
            + ` (${report.smallTargets.slice(0, 3).map(item => `${item.tag} "${item.text}" ${item.width}×${item.height}`).join('; ')})`);
        }
        if (report.lowContrast.length) {
          findings.push(`${width}px ${hash}: ${report.lowContrast.length} textos con contraste bajo`
            + ` (${report.lowContrast.slice(0, 3).map(item => `"${item.text}" ${item.ratio}:1 < ${item.required}`).join('; ')})`);
        }
        if (report.clipped.length) {
          findings.push(`${width}px ${hash}: ${report.clipped.length} textos cortados`
            + ` (${report.clipped.slice(0, 3).map(item => `"${item.text}" ${item.visible}px de ${item.needed}px`).join('; ')})`);
        }
        if (report.unsizedImages.length) {
          findings.push(`${width}px ${hash}: ${report.unsizedImages.length} imágenes sin width/height`);
        }
        if (!report.mainText) findings.push(`${width}px ${hash}: la vista quedó vacía`);
      }
      await page.close();
    }
  } finally {
    await browser.close().catch(() => {});
    server.close();
    database?.close();
  }

  await writeFile(`evidence/audit-results${useBackend ? '-backend' : ''}.json`, JSON.stringify({
    ejecutadoEl: new Date().toISOString(),
    entorno: useBackend ? 'backend local' : 'demostración estática',
    nota: 'Medición sobre Chrome de escritorio con emulación móvil. NO es una prueba en un teléfono físico.',
    anchos: [...WIDTHS, DESKTOP],
    hallazgos: findings,
    mediciones: rows,
  }, null, 2), 'utf8');

  console.log(`\n${rows.length} pantallas auditadas · ${findings.length} hallazgos`);
  for (const finding of findings) console.log(`  · ${finding}`);
  console.log(`Capturas en ${output}/`);
  if (findings.length) process.exitCode = 1;
}

await main();
