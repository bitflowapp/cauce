// Vistas públicas del marketplace: inicio, explorar, tienda, producto, ferias,
// favoritos, comunidad fundadora, planes y "qué es CAUCE".
import { html, raw, attr } from '../../core/html.js';
import { formatARS, parseARS } from '../../core/money.js';
import { timeRange, longDate, monthRange, dayKey } from '../../core/dates.js';
import { addToCart } from '../../core/cart.js';
import { directionsUrl, mapUrl, whatsappUrl, instagramUrl, telUrl } from '../../core/links.js';
import { clean, isEmail, isPhone, isName } from '../../core/validators.js';
import { planFeatures } from '../../core/plans.js';
import { qrSvg } from '../../core/qr.js';
import { SURVEY, PILOT_LABEL, surveyFromForm } from '../../core/survey.js';
import { CONFIG } from '../../config.js';
import { icon } from '../icons.js';
import { sofia } from '../sofia.js';
import { productCard, storeCard, fairCard, emptyState, storeLogo, favButton, placeholderArt, fairArt, dateBadgeEl,
  banner, stepper, backButton, pageHeader } from '../components.js';

const sofiaRaw = (scene, options) => raw(sofia(scene, options));
const categoryIcon = (ref, id) => ref.categoryById.get(id)?.icon || 'otros';

function searchForm(value = '', { autofocus = false } = {}) {
  return html`<form class="search" role="search" data-form="search" action="#/explorar">
    ${icon('search', { size: 20 })}
    <label class="sr-only" for="search-q">Buscar</label>
    <input id="search-q" name="q" type="search" value="${value}" placeholder="Buscá productos, artesanos o ferias…" autocomplete="off" enterkeyhint="search"${attr('autofocus', autofocus)}>
  </form>`;
}

function bindSearch(root, ctx, extra = {}) {
  root.querySelector('[data-form="search"]')?.addEventListener('submit', event => {
    event.preventDefault();
    const q = clean(/** @type {HTMLInputElement} */ (/** @type {HTMLFormElement} */ (event.currentTarget).elements.namedItem('q')).value, 60);
    ctx.navigate(`/explorar?${new URLSearchParams({ ...extra, ...(q ? { q } : {}) }).toString()}`);
  });
}

// Compartir: Web Share en el teléfono, si no, hoja con enlace y QR.
async function share(ctx, { title, text, url, qr = false }) {
  if (!qr && navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (error) { if (error?.name === 'AbortError') return; }
  }
  const choice = await ctx.dialog({ title: `Compartir ${title}`, confirm: 'Copiar enlace', cancel: 'Cerrar',
    body: html`<div class="qr-card">${raw(qrSvg(url, { label: `Código QR de ${title}` }))}
      <p class="small muted">Escaneá el código con la cámara del teléfono.</p>
      <div class="share-url"><label class="sr-only" for="share-url">Enlace</label><input id="share-url" class="input" readonly value="${url}"></div></div>` });
  if (choice) {
    try { await navigator.clipboard.writeText(url); ctx.toast('Enlace copiado'); } catch { ctx.toast('Copiá el enlace desde el cuadro de texto.'); }
  }
}
const siteLink = (ctx, hashPath) => `${ctx.repo.siteUrl || location.href.split('#')[0].replace(/index\.html$/, '')}#${hashPath}`.replace(/([^:])\/\/#/, '$1/#');

// ══════════ inicio ══════════
export async function home(ctx) {
  const locality = ctx.stores.locality();
  const [ref, data] = await Promise.all([ctx.repo.referenceData(), ctx.repo.homeData({ locality })]);
  const favorites = ctx.stores.favorites();
  const localityName = ref.localityBySlug.get(locality)?.name || 'Neuquén';
  const empty = !data.featured.length && !data.fairs.length && !data.newStores.length;
  return {
    chrome: 'shop', nav: 'inicio', title: 'Hecho cerca tuyo',
    html: html`
      <div class="stack">
        ${searchForm()}
        <section class="hero" aria-labelledby="hero-title">
          <div class="hero-copy">
            <h1 class="hero-title" id="hero-title">Hecho cerca tuyo.</h1>
            <p class="hero-text"><strong>Descubrí algo único.</strong> Conocé artesanos y emprendedores, y explorá las próximas ferias de ${localityName}.</p>
            <div class="hero-actions">
              <a class="btn btn-dark" href="#/explorar">Explorar productos</a>
              <a class="btn btn-light" href="#/ferias">Ver ferias cercanas</a>
            </div>
          </div>
          <div class="hero-art">${sofiaRaw('bienvenida', { size: 320 })}</div>
        </section>
      </div>
      <section class="section" aria-labelledby="cat-title">
        <h2 class="sr-only" id="cat-title">Rubros</h2>
        <div class="categories">${ref.categories.map(c => html`<a class="category" href="#/explorar?cat=${c.slug}">
          <span class="category-tile">${icon(c.icon, { size: 38, strokeWidth: 1.7 })}</span><span>${c.name}</span></a>`)}</div>
      </section>
      ${empty ? emptyState({ scene: 'creando', title: 'Las primeras tiendas están en camino',
        text: `Todavía no hay productos publicados en ${localityName}. ¿Hacés artesanías o vendés en ferias? Abrí tu tienda o sumate a la comunidad fundadora.`,
        action: html`<div class="row wrap"><a class="btn btn-primary" href="#/alta">Abrir mi tienda</a><a class="btn btn-secondary" href="#/comunidad">Comunidad fundadora</a></div>` }) : ''}
      ${data.featured.length ? html`<section class="section" aria-labelledby="feat-title">
        <div class="section-head"><h2 class="section-title" id="feat-title">Productos destacados</h2><a class="link-more" href="#/explorar">Ver todo ${icon('chevron-right', { size: 16 })}</a></div>
        <div class="scroller">${data.featured.map(p => productCard(p, { favorites, categoryIcon: categoryIcon(ref, p.categoryId) }))}</div>
      </section>` : ''}
      ${data.fairs.length ? html`<section class="section" aria-labelledby="fairs-title">
        <div class="section-head"><h2 class="section-title" id="fairs-title">Ferias cercanas</h2><a class="link-more" href="#/ferias">Ver todas ${icon('chevron-right', { size: 16 })}</a></div>
        <div class="scroller scroller-wide">${data.fairs.slice(0, 4).map(fairCard)}</div>
      </section>` : ''}
      ${data.recommended.length ? html`<section class="section" aria-labelledby="rec-title">
        <div class="section-head"><h2 class="section-title" id="rec-title">Tiendas recomendadas</h2><a class="link-more" href="#/explorar?vista=tiendas">Ver todas ${icon('chevron-right', { size: 16 })}</a></div>
        <div class="stack gap-sm">${data.recommended.slice(0, 4).map(storeCard)}</div>
      </section>` : ''}
      ${data.newStores.length > 1 ? html`<section class="section" aria-labelledby="new-title">
        <div class="section-head"><h2 class="section-title" id="new-title">Nuevos emprendimientos</h2></div>
        <div class="scroller">${data.newStores.map(s => html`<a class="card card-pad stack reveal" href="#/tienda/${s.slug}">
          ${storeLogo(s)}<strong>${s.name}</strong><span class="small muted">${[s.category, s.locality].filter(Boolean).join(' · ')}</span></a>`)}</div>
      </section>` : ''}
      <section class="section">
        <a class="card community-teaser" href="#/comunidad">
          <span class="community-teaser-art">${sofiaRaw('comunidad', { size: 150 })}</span>
          <span class="stack gap-sm">
            <span class="mano community-teaser-title">Artesanos fundadores</span>
            <span class="small">Sumate a las primeras tiendas de CAUCE · Ferias y ayudanos a darle forma.</span>
            <span class="link-more">Quiero ser parte ${icon('chevron-right', { size: 16 })}</span>
          </span>
        </a>
      </section>`,
    mount(root) { bindSearch(root, ctx); },
  };
}

// ══════════ explorar ══════════
export async function explore(ctx) {
  const q = clean(ctx.query.q, 60);
  const category = ctx.query.cat || '';
  const locality = ctx.query.loc ?? ctx.stores.locality();
  const availability = ctx.query.disp || '';
  const min = parseARS(ctx.query.min);
  const max = parseARS(ctx.query.max);
  const sort = ctx.query.orden || 'recientes';
  const storesOnly = ctx.query.vista === 'tiendas';
  const ref = await ctx.repo.referenceData();
  const filters = { q, category, locality, availability, min, max, sort };
  const [result, stores] = await Promise.all([
    storesOnly ? { items: [], total: 0, page: 0, pageSize: 24 } : ctx.repo.searchProducts(filters),
    storesOnly || q.length >= 2 ? ctx.repo.searchStores({ q, locality }) : [],
  ]);
  const favorites = ctx.stores.favorites();
  const params = extra => new URLSearchParams(Object.fromEntries(Object.entries({ q, cat: category, loc: locality, disp: availability,
    min: min || '', max: max || '', orden: sort === 'recientes' ? '' : sort, ...extra }).filter(([, v]) => v !== '' && v !== null && v !== undefined))).toString();
  const activeFilters = [availability, min, max, sort !== 'recientes' ? sort : ''].filter(Boolean).length;
  let page = 0;
  let total = result.total;

  const grid = items => items.map(p => productCard(p, { favorites, categoryIcon: categoryIcon(ref, p.categoryId) }));
  return {
    chrome: 'shop', nav: 'explorar', title: q ? `Buscar «${q}»` : 'Explorar',
    html: html`
      ${pageHeader(storesOnly ? 'Tiendas' : 'Explorar', { actions: html`<button type="button" class="icon-btn solid" data-action="filters" aria-label="Filtros${activeFilters ? ` (${activeFilters} activos)` : ''}">${icon('filter')}${activeFilters ? html`<span class="badge-dot">${activeFilters}</span>` : ''}</button>` })}
      <div class="stack">
        ${searchForm(q)}
        ${storesOnly ? '' : html`<div class="chips" role="group" aria-label="Rubros">
          <a class="chip${category ? '' : ' is-active'}" href="#/explorar?${params({ cat: '' })}"${raw(category ? '' : ' aria-current="true"')}>Todos</a>
          ${ref.categories.map(c => html`<a class="chip${c.slug === category ? ' is-active' : ''}" href="#/explorar?${params({ cat: c.slug })}"${raw(c.slug === category ? ' aria-current="true"' : '')}>${c.name}</a>`)}
        </div>`}
      </div>
      ${stores.length ? html`<section class="section" aria-labelledby="stores-title">
        <div class="section-head"><h2 class="section-title" id="stores-title">Emprendimientos</h2><span class="small muted">${stores.length}</span></div>
        <div class="stack gap-sm">${stores.slice(0, storesOnly ? 30 : 3).map(storeCard)}</div>
      </section>` : ''}
      ${storesOnly ? (stores.length ? '' : emptyState({ scene: 'buscando', title: 'Sin tiendas por acá', text: 'Probá con otra localidad o volvé pronto.' })) : html`
      <section class="section" aria-labelledby="results-title">
        <div class="section-head"><h2 class="section-title" id="results-title">${q ? `Resultados para «${q}»` : 'Productos'}</h2>
          <span class="small muted" aria-live="polite">${total === 1 ? '1 producto' : `${total} productos`}</span></div>
        ${result.items.length ? html`<div class="grid-products" id="results">${grid(result.items)}</div>
          <div class="row center-row" id="more-wrap"${raw(result.items.length >= total ? ' hidden' : '')}>
            <button type="button" class="btn btn-secondary" data-action="more">Ver más productos</button></div>`
    : emptyState({ scene: 'buscando', title: 'No encontramos nada', text: 'Probá con otras palabras, otro rubro u otra localidad.',
      action: html`<a class="btn btn-secondary" href="#/explorar">Limpiar búsqueda</a>` })}
      </section>`}`,
    mount(root) {
      bindSearch(root, ctx, Object.fromEntries(Object.entries({ cat: category, loc: locality, disp: availability }).filter(([, v]) => v)));
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        if (action === 'more') {
          el.classList.add('is-busy');
          try {
            page += 1;
            const next = await ctx.repo.searchProducts({ ...filters, page });
            total = next.total;
            root.querySelector('#results').insertAdjacentHTML('beforeend', String(html`${grid(next.items)}`));
            const shown = root.querySelectorAll('#results .product-card').length;
            if (shown >= total || !next.items.length) root.querySelector('#more-wrap').hidden = true;
          } catch (error) { ctx.toast(error.message, 'error'); page -= 1; } finally { el.classList.remove('is-busy'); }
        }
        if (action === 'filters') {
          const ok = await ctx.dialog({ title: 'Filtrar productos', confirm: 'Aplicar', cancel: 'Cancelar', body: html`<div class="form" id="filter-form">
            <div class="field"><label for="f-loc">Localidad</label><select id="f-loc" class="select"><option value="">Todo Neuquén</option>
              ${ref.localities.map(l => html`<option value="${l.slug}"${raw(l.slug === locality ? ' selected' : '')}>${l.name}</option>`)}</select></div>
            <div class="field"><label for="f-disp">Disponibilidad</label><select id="f-disp" class="select">
              <option value="">Todo</option><option value="stock"${raw(availability === 'stock' ? ' selected' : '')}>Con stock para comprar ya</option>
              <option value="pedido"${raw(availability === 'pedido' ? ' selected' : '')}>Por encargo</option></select></div>
            <div class="grid-2"><div class="field"><label for="f-min">Precio desde</label><div class="input-group"><span class="addon">$</span><input id="f-min" class="input" inputmode="numeric" value="${min || ''}"></div></div>
              <div class="field"><label for="f-max">Precio hasta</label><div class="input-group"><span class="addon">$</span><input id="f-max" class="input" inputmode="numeric" value="${max || ''}"></div></div></div>
            <div class="field"><label for="f-sort">Ordenar</label><select id="f-sort" class="select">
              <option value="recientes">Más nuevos</option><option value="precio-asc"${raw(sort === 'precio-asc' ? ' selected' : '')}>Menor precio</option>
              <option value="precio-desc"${raw(sort === 'precio-desc' ? ' selected' : '')}>Mayor precio</option></select></div></div>` });
          if (!ok) return;
          const value = id => /** @type {HTMLInputElement} */ (document.getElementById(id)).value;
          ctx.navigate(`/explorar?${params({ loc: value('f-loc'), disp: value('f-disp'), min: parseARS(value('f-min')) || '', max: parseARS(value('f-max')) || '', orden: value('f-sort') === 'recientes' ? '' : value('f-sort') })}`);
        }
      });
    },
  };
}

// ══════════ tienda ══════════
export async function store(ctx) {
  const [ref, data] = await Promise.all([ctx.repo.referenceData(), ctx.repo.storeBySlug(ctx.params.slug)]);
  const { business, products, fairs } = data;
  const favorites = ctx.stores.favorites();
  const following = favorites.has(`store:${business.id}`);
  const tab = ['productos', 'ferias', 'sobre'].includes(ctx.query.tab) ? ctx.query.tab : 'productos';
  const url = siteLink(ctx, `/tienda/${business.slug}`);
  const cardData = p => ({ ...p, business: null });
  return {
    chrome: 'shop', nav: 'explorar', title: business.name,
    html: html`
      <div class="cover">
        ${business.cover ? html`<img src="${business.cover}" alt="" width="1200" height="400" fetchpriority="high">` : fairArt()}
        <div class="cover-actions">${backButton()}<div class="row">
          <button type="button" class="icon-btn solid" data-action="follow" aria-pressed="${following ? 'true' : 'false'}" aria-label="${following ? 'Dejar de seguir' : 'Seguir tienda'}">${icon('heart', { size: 20 })}</button>
          <button type="button" class="icon-btn solid" data-action="share" aria-label="Compartir tienda">${icon('share', { size: 20 })}</button></div></div>
      </div>
      <section class="store-head">
        ${storeLogo(business, 'store-head-logo')}
        <h1 class="store-name">${business.name}</h1>
        ${business.tagline ? html`<p class="store-tagline">${business.tagline}</p>` : ''}
        <div class="row wrap mt">
          ${business.locality ? html`<span class="meta-line">${icon('pin', { size: 18 })}${business.locality}</span>` : ''}
          ${business.category ? html`<a class="tag" href="#/explorar?cat=${business.categorySlug}">${business.category}</a>` : ''}
        </div>
        <div class="row mt">
          <button type="button" class="btn btn-primary grow" data-action="follow-btn">${following ? 'Siguiendo' : 'Seguir'}</button>
          <button type="button" class="btn btn-secondary grow" data-action="share-qr">${icon('share', { size: 18 })}Compartir</button>
        </div>
        ${business.takingOrders ? '' : html`<div class="mt">${banner('warn', 'Esta tienda no está tomando pedidos por el momento', 'Podés mirar sus productos y escribirle para consultar.', 'info')}</div>`}
      </section>
      <div class="tabs mt" role="tablist" aria-label="Secciones de la tienda">
        ${[['productos', `Productos (${products.length})`], ['ferias', 'Ferias'], ['sobre', 'Sobre mí']].map(([key, label]) => html`
          <button type="button" class="tab" role="tab" id="tab-${key}" aria-controls="panel-${key}" aria-selected="${key === tab ? 'true' : 'false'}" data-action="tab" data-tab="${key}">${label}</button>`)}
      </div>
      <section id="panel-productos" role="tabpanel" aria-labelledby="tab-productos" class="section"${raw(tab === 'productos' ? '' : ' hidden')}>
        ${products.length ? html`<div class="grid-products">${products.map(p => productCard(cardData(p), { favorites, showShop: false, categoryIcon: categoryIcon(ref, p.categoryId) }))}</div>`
    : emptyState({ scene: 'creando', title: 'Preparando piezas', text: 'Esta tienda todavía no publicó productos.' })}
      </section>
      <section id="panel-ferias" role="tabpanel" aria-labelledby="tab-ferias" class="section"${raw(tab === 'ferias' ? '' : ' hidden')}>
        ${fairs.length ? html`<div class="stack">${fairs.map(f => html`<a class="option-card" href="#/feria/${f.slug}">${icon('fairs')}
          <span class="grow"><strong>${f.name}</strong><span class="small muted block">${longDate(f.startsAt)} · ${timeRange(f.startsAt, f.endsAt)}</span>
          <span class="small muted block">${f.venue}${f.stall ? ` · Puesto ${f.stall}` : ''}</span></span>${icon('chevron-right', { size: 18 })}</a>`)}</div>`
    : emptyState({ scene: 'explorando', title: 'Sin ferias confirmadas', text: 'Cuando confirme su próxima feria, la vas a ver acá.' })}
      </section>
      <section id="panel-sobre" role="tabpanel" aria-labelledby="tab-sobre" class="section stack"${raw(tab === 'sobre' ? '' : ' hidden')}>
        ${business.description ? html`<p class="pre-line">${business.description}</p>` : html`<p class="muted">Esta tienda todavía no contó su historia.</p>`}
        <div class="card card-pad stack gap-sm">
          <h2 class="section-title">Entregas</h2>
          ${business.fairPickupEnabled && fairs.length ? html`<div class="fact">${icon('fairs')}Retiro en su puesto de feria</div>` : ''}
          ${business.pickupEnabled ? html`<div class="fact">${icon('hand')}Retiro acordado${business.pickupArea ? ` · ${business.pickupArea}` : ''}</div>` : ''}
          ${business.deliveryEnabled ? html`<div class="fact">${icon('truck')}Envío propio${business.deliveryZone ? ` · ${business.deliveryZone}` : ''} · ${business.deliveryFee === null ? 'costo a coordinar' : business.deliveryFee === 0 ? 'sin costo' : formatARS(business.deliveryFee)}</div>` : ''}
          <div class="fact">${icon('cash')}Pagás en efectivo o por transferencia directa a la tienda</div>
        </div>
        <div class="card card-pad stack gap-sm">
          <h2 class="section-title">Contacto</h2>
          <div class="row wrap">
            ${business.whatsapp ? html`<a class="btn btn-whatsapp btn-sm" href="${whatsappUrl(business.whatsapp, `Hola ${business.name}, te encontré en CAUCE · Ferias.`)}" target="_blank" rel="noopener noreferrer">${icon('whatsapp', { size: 18 })}WhatsApp</a>` : ''}
            ${business.publicPhone ? html`<a class="btn btn-secondary btn-sm" href="${telUrl(business.publicPhone)}">${icon('phone', { size: 18 })}Llamar</a>` : ''}
            ${business.instagram ? html`<a class="btn btn-secondary btn-sm" href="${instagramUrl(business.instagram)}" target="_blank" rel="noopener noreferrer">${icon('instagram', { size: 18 })}@${business.instagram}</a>` : ''}
          </div>
          <div class="share-url"><label class="sr-only" for="store-url">Enlace de la tienda</label><input id="store-url" class="input" readonly value="${url}">
            <button type="button" class="btn btn-secondary btn-sm" data-action="copy">${icon('copy', { size: 18 })}Copiar</button></div>
        </div>
      </section>`,
    mount(root) {
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        if (action === 'tab') {
          const key = el.getAttribute('data-tab');
          root.querySelectorAll('[role="tab"]').forEach(t => t.setAttribute('aria-selected', String(t === el)));
          root.querySelectorAll('[role="tabpanel"]').forEach(p => { p.hidden = p.id !== `panel-${key}`; });
          history.replaceState(null, '', `#/tienda/${business.slug}${key === 'productos' ? '' : `?tab=${key}`}`);
        }
        if (action === 'follow' || action === 'follow-btn') {
          const on = ctx.stores.toggleFavorite(`store:${business.id}`);
          root.querySelector('[data-action="follow"]').setAttribute('aria-pressed', String(on));
          root.querySelector('[data-action="follow-btn"]').textContent = on ? 'Siguiendo' : 'Seguir';
          ctx.toast(on ? `Seguís a ${business.name}. La encontrás en Favoritos.` : 'Dejaste de seguir esta tienda');
        }
        if (action === 'share') share(ctx, { title: business.name, text: business.tagline || 'Mirá esta tienda en CAUCE · Ferias', url });
        if (action === 'share-qr') share(ctx, { title: business.name, text: business.tagline, url, qr: true });
        if (action === 'copy') {
          try { await navigator.clipboard.writeText(url); ctx.toast('Enlace copiado'); }
          catch { /** @type {HTMLInputElement} */ (root.querySelector('#store-url')).select(); }
        }
      });
    },
  };
}

// ══════════ producto ══════════
export async function product(ctx) {
  const [ref, data] = await Promise.all([ctx.repo.referenceData(), ctx.repo.product(ctx.params.id)]);
  const { product: p, business, related, fairs } = data;
  const favorites = ctx.stores.favorites();
  const variants = p.variants;
  let variantId = variants.find(v => !p.trackStock || v.stock > 0)?.id || variants[0]?.id || null;
  let quantity = 1;
  const variantOf = id => variants.find(v => v.id === id) || null;
  const availableFor = id => (!p.trackStock ? 99 : id ? (variantOf(id)?.stock ?? 0) : p.stock);
  const priceFor = id => p.price + (variantOf(id)?.priceDelta || 0);
  const canBuy = () => business.takingOrders && p.available && availableFor(variantId) > 0;
  const nextFair = fairs[0];
  const url = siteLink(ctx, `/producto/${p.id}`);
  const production = p.productionMin ? (p.productionMax && p.productionMax !== p.productionMin ? `${p.productionMin} a ${p.productionMax} días` : `${p.productionMin} días`) : '';
  const buyBar = () => html`${stepper({ value: quantity, min: 1, max: Math.max(1, Math.min(99, availableFor(variantId))) })}
    <button type="button" class="btn btn-primary" data-action="add"${attr('disabled', !canBuy())}>${canBuy() ? 'Agregar al carrito' : (!business.takingOrders ? 'No toma pedidos' : 'Sin stock')}</button>`;
  return {
    chrome: 'shop', nav: 'explorar', title: p.name,
    html: html`
      <div class="detail-layout">
        <div class="gallery">
          <div class="gallery-track" id="gallery" tabindex="0" aria-label="Fotos de ${p.name}">
            ${p.images.length ? p.images.map((image, i) => html`<div class="gallery-slide"><img src="${image.url}" alt="${image.alt || p.name}" width="900" height="900"${raw(i === 0 ? ' fetchpriority="high"' : ' loading="lazy"')}></div>`)
    : html`<div class="gallery-slide">${placeholderArt(categoryIcon(ref, p.categoryId))}</div>`}
          </div>
          ${p.images.length > 1 ? html`<div class="gallery-dots" aria-hidden="true">${p.images.map((_, i) => html`<span${raw(i === 0 ? ' class="is-active"' : '')}></span>`)}</div>` : ''}
          <div class="cover-actions">${backButton()}<div class="row">${raw(favButton(p.id, favorites.has(p.id)).value.replace('class="fav-btn"', 'class="icon-btn solid fav-inline"'))}
            <button type="button" class="icon-btn solid" data-action="share" aria-label="Compartir producto">${icon('share', { size: 20 })}</button></div></div>
        </div>
        <div class="stack">
          <div>
            <h1 class="detail-title">${p.name}</h1>
            <p class="detail-price" id="price">${formatARS(priceFor(variantId))}</p>
          </div>
          <a class="seller" href="#/tienda/${business.slug}">${storeLogo(business)}
            <span class="grow"><strong>${business.name}</strong><span class="meta-line small">${icon('pin', { size: 16 })}${business.locality || ref.localityById.get(business.localityId)?.name || ''}</span></span>
            ${icon('chevron-right', { size: 18 })}</a>
          ${p.description ? html`<p class="pre-line">${p.description}</p>` : ''}
          <div class="facts">
            ${p.handmade ? html`<div class="fact">${icon('hand')}Hecho a mano</div>` : ''}
            ${p.madeToOrder ? html`<div class="fact">${icon('clock')}Por encargo${production ? `: se elabora en ${production}` : ''}</div>`
    : p.trackStock ? html`<div class="fact" id="stock-fact">${icon('stock')}<span>${availableFor(variantId) > 0 ? `Stock disponible: ${availableFor(variantId)}` : 'Sin stock por ahora'}</span></div>` : ''}
            ${!p.madeToOrder && production ? html`<div class="fact">${icon('clock')}Tiempo de elaboración: ${production}</div>` : ''}
            ${p.materials ? html`<div class="fact">${icon('tag')}${p.materials}</div>` : ''}
          </div>
          ${variants.length ? html`<fieldset class="field fieldset-reset"><legend class="field-label">Elegí una opción</legend>
            <div class="variant-picker">${variants.map(v => html`<label><input type="radio" name="variant" value="${v.id}"${raw(v.id === variantId ? ' checked' : '')}${attr('disabled', p.trackStock && v.stock <= 0)}>
              <span>${v.name}${v.priceDelta ? ` (${v.priceDelta > 0 ? '+' : '−'}${formatARS(Math.abs(v.priceDelta))})` : ''}</span></label>`)}</div></fieldset>` : ''}
          <div class="stack gap-sm">
            ${business.fairPickupEnabled && nextFair ? html`<a class="option-card" href="#/feria/${nextFair.slug}">${icon('fairs')}<span class="grow"><strong>Retiro en feria</strong>
              <span class="small muted block">${longDate(nextFair.startsAt)} · ${nextFair.name}${nextFair.stall ? ` · Puesto ${nextFair.stall}` : ''}</span></span>${icon('chevron-right', { size: 18 })}</a>` : ''}
            ${business.pickupEnabled ? html`<div class="option-card">${icon('hand')}<span class="grow"><strong>Retiro acordado</strong>
              <span class="small muted block">${business.pickupArea || 'Coordinás el lugar con la tienda'}</span></span></div>` : ''}
            ${business.deliveryEnabled ? html`<div class="option-card">${icon('truck')}<span class="grow"><strong>Envío</strong>
              <span class="small muted block">${business.deliveryZone || 'Zona a consultar'} (${business.deliveryFee === null ? 'consultar costo' : business.deliveryFee === 0 ? 'sin costo' : formatARS(business.deliveryFee)})</span></span></div>` : ''}
          </div>
          ${business.takingOrders ? '' : banner('warn', 'Esta tienda no está tomando pedidos por el momento', 'Escribile para consultar disponibilidad.')}
          <div class="buy-bar" id="buy-bar">${buyBar()}</div>
        </div>
      </div>
      ${related.length ? html`<section class="section" aria-labelledby="rel-title">
        <div class="section-head"><h2 class="section-title" id="rel-title">También te puede gustar</h2></div>
        <div class="scroller">${related.map(r => productCard(r, { favorites, categoryIcon: categoryIcon(ref, r.categoryId) }))}</div>
      </section>` : ''}`,
    mount(root) {
      const refresh = () => {
        root.querySelector('#price').textContent = formatARS(priceFor(variantId));
        root.querySelector('#buy-bar').innerHTML = String(buyBar());
        const fact = root.querySelector('#stock-fact span');
        if (fact) fact.textContent = availableFor(variantId) > 0 ? `Stock disponible: ${availableFor(variantId)}` : 'Sin stock por ahora';
      };
      const track = root.querySelector('#gallery');
      track?.addEventListener('scroll', () => {
        const index = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        root.querySelectorAll('.gallery-dots span').forEach((dot, i) => dot.classList.toggle('is-active', i === index));
      }, { passive: true });
      root.addEventListener('change', event => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        if (input.name === 'variant') { variantId = input.value; quantity = 1; refresh(); }
      });
      root.addEventListener('click', event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        if (action === 'qty') { quantity = Math.max(1, Math.min(availableFor(variantId), quantity + Number(el.getAttribute('data-delta')))); refresh(); }
        if (action === 'share') share(ctx, { title: p.name, text: `${p.name} · ${formatARS(p.price)} en ${business.name}`, url });
        if (action === 'add') {
          const cart = ctx.stores.readCart(business.id);
          const { cart: next, added } = addToCart(cart, p.id, variantId, quantity, availableFor(variantId));
          if (!added) { ctx.toast('Ya tenés en el carrito todo el stock disponible.', 'error'); return; }
          ctx.stores.writeCart({ ...next, requestId: undefined });
          ctx.toast(`Agregado al carrito: ${p.name}${variantOf(variantId) ? ` · ${variantOf(variantId).name}` : ''}`, 'ok');
        }
      });
    },
  };
}

// ══════════ ferias ══════════
export async function fairs(ctx) {
  const ref = await ctx.repo.referenceData();
  const locality = ctx.query.loc ?? ctx.stores.locality();
  const period = ctx.query.periodo || 'proximas';
  const q = clean(ctx.query.q, 40);
  const today = new Date();
  const ranges = {
    'este-mes': { from: null, to: monthRange(today).to },
    'proximo-mes': { from: monthRange(today, 1).from, to: monthRange(today, 1).to },
    proximas: { from: null, to: null },
  };
  const range = ranges[period] || ranges.proximas;
  const list = await ctx.repo.fairs({ locality, from: range.from, to: range.to, q });
  const params = extra => new URLSearchParams(Object.fromEntries(Object.entries({ loc: locality, periodo: period === 'proximas' ? '' : period, q, ...extra })
    .filter(([, v]) => v))).toString();
  return {
    chrome: 'shop', nav: 'ferias', title: 'Ferias cerca tuyo',
    html: html`
      ${pageHeader('Ferias cerca tuyo')}
      <div class="row wrap mt">
        <label class="sr-only" for="fair-loc">Localidad</label>
        <select id="fair-loc" class="select chip-select" data-filter="loc"><option value="">Todo Neuquén</option>
          ${ref.localities.map(l => html`<option value="${l.slug}"${raw(l.slug === locality ? ' selected' : '')}>${l.name}</option>`)}</select>
        <label class="sr-only" for="fair-period">Período</label>
        <select id="fair-period" class="select chip-select" data-filter="periodo">
          <option value="proximas"${raw(period === 'proximas' ? ' selected' : '')}>Próximas</option>
          <option value="este-mes"${raw(period === 'este-mes' ? ' selected' : '')}>Este mes</option>
          <option value="proximo-mes"${raw(period === 'proximo-mes' ? ' selected' : '')}>Próximo mes</option></select>
      </div>
      <form class="search mt" role="search" data-form="fair-search">${icon('search', { size: 20 })}<label class="sr-only" for="fair-q">Buscar feria</label>
        <input id="fair-q" name="q" type="search" value="${q}" placeholder="Buscar por nombre o lugar" enterkeyhint="search"></form>
      <section class="section" aria-label="Calendario de ferias">
        ${list.length ? html`<div class="stack fairs-grid">${list.map(fairCard)}</div>`
    : emptyState({ scene: 'explorando', title: 'No hay ferias en ese período', text: 'Probá con otra localidad o mirá las próximas fechas.',
      action: html`<a class="btn btn-secondary" href="#/ferias">Ver todas las próximas</a>` })}
      </section>
      <section class="section card card-pad row wrap between">
        <span class="stack gap-xs"><strong>¿Organizás una feria?</strong><span class="small muted">Publicala, recibí inscripciones y asigná puestos desde CAUCE.</span></span>
        <a class="btn btn-secondary btn-sm" href="#/planes">Plan Organizador</a>
      </section>`,
    mount(root) {
      root.querySelectorAll('[data-filter]').forEach(select => select.addEventListener('change', () => {
        const key = select.getAttribute('data-filter');
        const value = /** @type {HTMLSelectElement} */ (select).value;
        if (key === 'loc') ctx.stores.setLocality(value);
        ctx.navigate(`/ferias?${params({ [key]: value === 'proximas' ? '' : value, ...(key === 'loc' && !value ? { loc: '' } : {}) })}${key === 'loc' && !value ? '&loc=' : ''}`);
      }));
      root.querySelector('[data-form="fair-search"]').addEventListener('submit', event => {
        event.preventDefault();
        ctx.navigate(`/ferias?${params({ q: clean(/** @type {HTMLInputElement} */ (/** @type {HTMLFormElement} */ (event.currentTarget).elements.namedItem('q')).value, 40) })}`);
      });
    },
  };
}

export async function fair(ctx) {
  const { fair: f, participants } = await ctx.repo.fairBySlug(ctx.params.slug);
  const session = ctx.session;
  const merchantBusinesses = session.memberships.filter(m => ['owner', 'manager'].includes(m.role) && m.status === 'active');
  const finished = new Date(f.endsAt).getTime() < Date.now();
  const url = siteLink(ctx, `/feria/${f.slug}`);
  const days = dayKey(f.startsAt) === dayKey(f.endsAt) ? longDate(f.startsAt) : `${longDate(f.startsAt)} al ${longDate(f.endsAt)}`;
  return {
    chrome: 'shop', nav: 'ferias', title: f.name,
    html: html`
      <div class="cover">
        ${f.cover ? html`<img src="${f.cover}" alt="" width="1200" height="400" fetchpriority="high">` : fairArt()}
        <div class="cover-actions">${backButton('#/ferias')}<button type="button" class="icon-btn solid" data-action="share" aria-label="Compartir feria">${icon('share', { size: 20 })}</button></div>
        ${raw(dateBadgeEl(f.startsAt).value.replace('class="date-badge"', 'class="date-badge date-badge-cover"'))}
      </div>
      <section class="stack mt">
        ${f.status === 'canceled' ? banner('error', 'Esta feria fue cancelada', f.cancelReason, 'alert') : ''}
        ${finished && f.status !== 'canceled' ? banner('', 'Esta feria ya terminó', 'Mirá las próximas fechas en el calendario.') : ''}
        <h1 class="store-name">${f.name}</h1>
        <div class="stack gap-sm">
          <span class="meta-line">${icon('calendar', { size: 18 })}<span class="first-cap">${days}</span></span>
          <span class="meta-line">${icon('clock', { size: 18 })}${timeRange(f.startsAt, f.endsAt)}</span>
          <span class="meta-line">${icon('pin', { size: 18 })}${[f.venue, f.address, f.locality].filter(Boolean).join(', ')}</span>
          ${f.organizer ? html`<span class="meta-line">${icon('users', { size: 18 })}Organiza ${f.organizer}</span>` : ''}
        </div>
        <div class="row wrap">
          <a class="btn btn-primary" href="${directionsUrl(f)}" target="_blank" rel="noopener noreferrer">${icon('route', { size: 18 })}Cómo llegar</a>
          <a class="btn btn-secondary" href="${mapUrl(f)}" target="_blank" rel="noopener noreferrer">${icon('map', { size: 18 })}Ver mapa</a>
          <button type="button" class="btn btn-secondary" data-action="share-qr">${icon('qr', { size: 18 })}Compartir</button>
        </div>
        ${f.description ? html`<p class="pre-line">${f.description}</p>` : ''}
        ${f.organizerContact?.whatsapp ? html`<a class="link-more" href="${whatsappUrl(f.organizerContact.whatsapp, `Hola, consulto por ${f.name}.`)}" target="_blank" rel="noopener noreferrer">${icon('whatsapp', { size: 18 })}Consultar a la organización</a>` : ''}
        ${merchantBusinesses.length && f.status === 'published' && f.applicationsOpen && !finished ? html`<div class="card card-pad stack gap-sm">
          <strong>¿Querés exponer en esta feria?</strong>
          <span class="small muted">La organización revisa la solicitud y te asigna un puesto.</span>
          <div class="row wrap">${merchantBusinesses.map(m => html`<button type="button" class="btn btn-primary btn-sm" data-action="apply" data-business="${m.businessId}">Inscribir ${m.name}</button>`)}</div>
        </div>` : ''}
      </section>
      <section class="section" aria-labelledby="part-title">
        <div class="section-head"><h2 class="section-title" id="part-title">Expositores confirmados</h2><span class="small muted">${participants.length}</span></div>
        ${participants.length ? html`<div class="stack gap-sm">${participants.map(p => html`<a class="store-card" href="#/tienda/${p.business.slug}">
          ${storeLogo(p.business)}<span class="grow"><span class="store-card-name">${p.business.name}</span>
          <span class="store-card-meta">${[p.business.category, p.business.locality].filter(Boolean).join(' · ')}</span></span>
          ${p.stall ? html`<span class="tag tag-terra">Puesto ${p.stall}</span>` : ''}</a>`)}</div>`
    : html`<p class="muted">Todavía no hay expositores confirmados.</p>`}
      </section>`,
    mount(root) {
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        if (action === 'share') share(ctx, { title: f.name, text: `${f.name} · ${longDate(f.startsAt)} en ${f.venue}`, url });
        if (action === 'share-qr') share(ctx, { title: f.name, text: f.venue, url, qr: true });
        if (action === 'apply') {
          el.classList.add('is-busy');
          try { await ctx.repo.applyToFair(f.id, el.getAttribute('data-business')); ctx.toast('¡Solicitud enviada! La organización te va a responder.', 'ok'); ctx.navigate('/panel/ferias'); }
          catch (error) { ctx.toast(error.message, 'error'); } finally { el.classList.remove('is-busy'); }
        }
      });
    },
  };
}

// ══════════ favoritos ══════════
export async function favorites(ctx) {
  const ref = await ctx.repo.referenceData();
  const set = ctx.stores.favorites();
  const productIds = [...set].filter(id => !id.startsWith('store:'));
  const storeIds = [...set].filter(id => id.startsWith('store:')).map(id => id.slice(6));
  const [products, allStores] = await Promise.all([ctx.repo.productsByIds(productIds),
    storeIds.length ? ctx.repo.searchStores({}) : []]);
  const followed = allStores.filter(s => storeIds.includes(s.id));
  return {
    chrome: 'shop', nav: 'favoritos', title: 'Favoritos',
    html: html`
      ${pageHeader('Favoritos', { back: false })}
      <p class="small muted mt">Se guardan en este dispositivo.</p>
      ${!products.length && !followed.length ? emptyState({ scene: 'explorando', title: 'Todavía no guardaste nada',
        text: 'Tocá el corazón en un producto o «Seguir» en una tienda para encontrarlos acá.', action: html`<a class="btn btn-primary" href="#/explorar">Explorar productos</a>` }) : ''}
      ${followed.length ? html`<section class="section"><h2 class="section-title mb">Tiendas que seguís</h2><div class="stack gap-sm">${followed.map(storeCard)}</div></section>` : ''}
      ${products.length ? html`<section class="section"><h2 class="section-title mb">Productos guardados</h2>
        <div class="grid-products">${products.map(p => productCard(p, { favorites: set, categoryIcon: categoryIcon(ref, p.categoryId) }))}</div></section>` : ''}`,
  };
}

// ══════════ comunidad fundadora ══════════
export async function community(ctx) {
  const ref = await ctx.repo.referenceData();
  const enabled = ctx.status?.features?.founding_community !== false;
  const entry = ref.plans.filter(p => p.audience === 'business').sort((a, b) => a.monthly_price_ars - b.monthly_price_ars)[0];
  const survey = html`<details class="survey">
    <summary><strong>Encuesta breve</strong> <span class="muted">(opcional, un minuto)</span></summary>
    <p class="small muted">Nos ayuda a armar el piloto con lo que de verdad necesitás.</p>
    ${SURVEY.map(q => html`<fieldset class="survey-q"><legend>${q.label.replace('{price}', entry ? formatARS(entry.monthly_price_ars) : 'el plan de entrada')}</legend>
      <div class="survey-options">${q.options.map(([value, label]) => html`<label class="check"><input type="${q.multiple ? 'checkbox' : 'radio'}" name="sv-${q.key}" value="${value}"> ${label}</label>`)}</div>
    </fieldset>`)}
    <label class="check"><input type="checkbox" name="sv-pilot"> <strong>${PILOT_LABEL}</strong></label>
  </details>`;
  return {
    chrome: 'shop', nav: '', title: 'Comunidad fundadora',
    html: html`
      <div class="community-wrap mt">
        <section class="community-hero" aria-labelledby="com-title">
          ${sofiaRaw('comunidad', { size: 300 })}
          <div class="community-body stack">
            <h1 class="community-title" id="com-title">Artesanos fundadores</h1>
            <p>Estamos creando una plataforma para que tus productos lleguen más lejos. Sé de los primeros en conocer y probar CAUCE.</p>
            <ul class="benefits">
              ${['Sin costo inicial durante la etapa fundadora', 'Prioridad en el lanzamiento', 'Te ayudamos a crear tu tienda', 'Tus sugerencias cuentan']
    .map(b => html`<li><span class="check-circle">${icon('check', { size: 14, strokeWidth: 3 })}</span>${b}</li>`)}
            </ul>
          </div>
        </section>
        <section class="card card-pad" aria-labelledby="form-title">
          <div id="founding-area">
            ${enabled ? html`<h2 class="section-title" id="form-title">Quiero ser parte</h2>
            <p class="small muted mb">Dejanos tus datos y te escribimos. Sin compromiso de contratación.</p>
            <form class="form" data-form="founding" novalidate>
              <div class="field"><label for="fd-name">Tu nombre</label><input id="fd-name" name="name" class="input" autocomplete="name" required maxlength="80"></div>
              <div class="field"><label for="fd-business">Nombre de tu emprendimiento <span class="muted">(si tiene)</span></label><input id="fd-business" name="business_name" class="input" maxlength="80"></div>
              <div class="grid-2">
                <div class="field"><label for="fd-loc">Localidad</label><select id="fd-loc" name="locality" class="select">${ref.localities.map(l => html`<option value="${l.slug}">${l.name}</option>`)}</select></div>
                <div class="field"><label for="fd-cat">Rubro</label><select id="fd-cat" name="category" class="select">${ref.categories.map(c => html`<option value="${c.slug}">${c.name}</option>`)}</select></div>
              </div>
              <div class="field"><label for="fd-contact">WhatsApp o correo</label><input id="fd-contact" name="contact" class="input" required maxlength="120" autocomplete="email" inputmode="email">
                <span class="field-hint">Lo usamos sólo para contactarte por CAUCE.</span></div>
              <label class="check"><input type="checkbox" name="sells_at_fairs" checked> Vendo en ferias</label>
              <div class="field"><label for="fd-msg">¿Algo que quieras contarnos? <span class="muted">(opcional)</span></label><textarea id="fd-msg" name="message" class="textarea" maxlength="400" rows="3"></textarea></div>
              ${survey}
              <label class="check"><input type="checkbox" name="consent" required> <span>Acepto que LUNA Proyectos guarde estos datos para contactarme sobre CAUCE · Ferias. Puedo pedir que los borren cuando quiera.</span></label>
              <p class="field-error" id="fd-error" role="alert" hidden></p>
              <button class="btn btn-primary btn-block" type="submit">Quiero ser parte</button>
              <p class="small muted center">Sin compromiso de contratación</p>
            </form>` : banner('', 'La preinscripción está pausada', 'Volvé a intentar en unos días.')}
          </div>
        </section>
      </div>`,
    mount(root) {
      root.querySelector('[data-form="founding"]')?.addEventListener('submit', async event => {
        event.preventDefault();
        const form = /** @type {HTMLFormElement} */ (event.currentTarget);
        const data = new FormData(form);
        const error = root.querySelector('#fd-error');
        const contact = clean(data.get('contact'), 120);
        const problem = !isName(data.get('name')) ? 'Escribí tu nombre.'
          : !(isEmail(contact) || isPhone(contact)) ? 'Dejanos un WhatsApp o un correo válido.'
            : !data.get('consent') ? 'Necesitamos tu consentimiento para guardar los datos.' : '';
        if (problem) { error.textContent = problem; error.hidden = false; return; }
        error.hidden = true;
        const button = form.querySelector('button[type="submit"]');
        button.classList.add('is-busy');
        try {
          await ctx.repo.applyFounding({ name: clean(data.get('name'), 80), business_name: clean(data.get('business_name'), 80),
            locality: data.get('locality'), category: data.get('category'), contact, sells_at_fairs: Boolean(data.get('sells_at_fairs')),
            message: clean(data.get('message'), 400), survey: surveyFromForm(data), consent: true, consent_version: CONFIG.consentVersion });
          root.querySelector('#founding-area').innerHTML = String(emptyState({ scene: 'celebrando', title: '¡Gracias por sumarte!',
            text: 'Recibimos tus datos. Te vamos a escribir para contarte los próximos pasos.', action: html`<a class="btn btn-primary" href="#/alta">Abrir mi tienda ahora</a>` }));
        } catch (caught) {
          error.textContent = caught.message; error.hidden = false;
        } finally { button.classList.remove('is-busy'); }
      });
    },
  };
}

// ══════════ planes ══════════
export async function plans(ctx) {
  const ref = await ctx.repo.referenceData();
  const business = ref.plans.filter(p => p.audience === 'business');
  const organizer = ref.plans.filter(p => p.audience === 'organizer');
  const card = plan => html`<article class="card plan-card">
    <h2 class="section-title">${plan.name}</h2>
    <p class="plan-price">${formatARS(plan.monthly_price_ars)} <span class="small muted">por mes</span></p>
    <p class="small muted">${plan.summary}</p>
    <ul class="plan-list">${planFeatures(plan).map(f => html`<li>${icon('check', { size: 16, strokeWidth: 3 })}${f}</li>`)}</ul>
  </article>`;
  return {
    chrome: 'shop', nav: '', title: 'Planes',
    html: html`
      ${pageHeader('Planes para vender')}
      <div class="stack mt">
        ${banner('terra', 'Precios orientativos del piloto', 'Son una propuesta inicial: los definimos junto a las primeras tiendas. Durante el piloto la administración activa los planes a mano; no hay cobros automáticos.', 'info')}
        <div class="plans-grid">${business.map(card)}</div>
        <h2 class="section-title mt">Para quienes organizan ferias</h2>
        <div class="plans-grid">${organizer.map(card)}</div>
        <div class="card card-pad stack gap-sm">
          <strong>¿Cómo empiezo?</strong>
          <p class="small">Abrí tu tienda gratis, cargá tus productos y pedí la publicación. Al aprobarla te activamos un período de prueba del plan que mejor te quede.</p>
          <div class="row wrap"><a class="btn btn-primary" href="#/alta">Abrir mi tienda</a><a class="btn btn-secondary" href="#/comunidad">Hablar con CAUCE</a></div>
        </div>
      </div>`,
  };
}

// ══════════ qué es CAUCE ══════════
export async function about() {
  return {
    chrome: 'shop', nav: '', title: 'Qué es CAUCE',
    html: html`
      <div class="two-col mt">
        <section class="stack">
          ${pageHeader('Qué es CAUCE · Ferias')}
          <p>Un lugar para descubrir lo que se crea cerca: piezas de artesanos, feriantes y emprendedores de Neuquén, con la feria como punto de encuentro.</p>
          <div class="card card-pad stack gap-sm">
            <h2 class="section-title">Si comprás</h2>
            <div class="fact">${icon('search')}Explorás productos y tiendas sin crear cuenta.</div>
            <div class="fact">${icon('fairs')}Elegís retirar en el puesto de una feria, en un lugar acordado o con envío de la tienda.</div>
            <div class="fact">${icon('cash')}Pagás en efectivo o por transferencia directa a quien vende: CAUCE no maneja tu dinero.</div>
            <div class="fact">${icon('bell')}Seguís tu pedido con un enlace privado.</div>
          </div>
          <div class="card card-pad stack gap-sm">
            <h2 class="section-title">Si vendés</h2>
            <div class="fact">${icon('store')}Abrís tu tienda y cargás productos con fotos desde el teléfono.</div>
            <div class="fact">${icon('orders')}Recibís pedidos y los gestionás desde tu panel.</div>
            <div class="fact">${icon('qr')}Compartís tu tienda con un enlace y un código QR para tu puesto.</div>
            <div class="row wrap"><a class="btn btn-primary" href="#/alta">Abrir mi tienda</a><a class="btn btn-secondary" href="#/planes">Ver planes</a></div>
          </div>
          <div class="card card-pad stack gap-sm">
            <h2 class="section-title">Tus datos</h2>
            <p class="small">Guardamos lo necesario para que funcione tu pedido o tu tienda. Quien vende ve tu nombre y tu teléfono para coordinar la entrega; nadie más. Los errores técnicos se registran sin datos personales.</p>
          </div>
        </section>
        <aside class="card card-pad stack center-items">
          <p class="mano hello-title">¡Hola! Descubrí lo que se crea cerca tuyo.</p>
          ${sofiaRaw('taza', { size: 280 })}
        </aside>
      </div>`,
  };
}
