import { CONFIG } from './config.js';
import { createRepository } from './repositories/repository-factory.js';
import { DEMO_CUSTOMER_ID, DEMO_STORAGE_KEY } from './repositories/demo-repository.js';
import { scopeOf } from './core/scope.js';
import { allowedActions, STATUS_LABELS } from './core/workflow-policy.js';
import { confirmedPrice, isCommerciallyPurchasable } from './core/commercial.js';
import { createBusinessSoundService } from './business/sound-service.js';
import { calculateBusinessMetrics } from './core/business-metrics.js';
import { buildKitchenTicket } from './core/kitchen-ticket.js';
import { getProductSvg, getAlumineMapSvg } from './data/food-assets.js';
import { renderPublicOrderTimeline, renderOrderTimeline } from './core/order-timeline.js';
import { formatDeliveryCode } from './core/delivery-code.js';
import { getRiderQueueOrder, getRiderStateLabel, getRouteProgress, isAwaitingPreparation } from './core/rider.js';
import { isValidArgentinePhone, formatArgentinePhone } from './core/validators.js';

const main = document.querySelector('#main');
const modalContainer = document.querySelector('#modal-container');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const money = value => new Intl.NumberFormat(CONFIG.locale, { style:'currency', currency:'ARS', maximumFractionDigits:0 }).format(value);

const customerActor = { kind:'customer', id:DEMO_CUSTOMER_ID };
const searchState = { query:'', category:'Todos', onlyOpen:false };
const formValues = new Map();
const soundService = createBusinessSoundService();

let repository;
let toastTimer;
let activeBusinessTab = 'all';
let pendingSwitchConflict = null;

function toast(message) {
  clearTimeout(toastTimer);
  const element = document.querySelector('#toast');
  if (!element) return;
  element.textContent = message;
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, 4200);
}

const go = hash => { location.hash = hash; };
const route = () => location.hash.slice(1).split('/').filter(Boolean);
const themes = new Set(['sage','clay','sand']);
const theme = business => themes.has(business.theme) ? business.theme : 'sage';
const back = (href = '#home', label = 'Volver a los comercios') => `<a class="back" href="${esc(href)}">← ${esc(label)}</a>`;
const empty = (title, message, href = '#home', label = 'Ver comercios') => `<section class="empty"><h2>${esc(title)}</h2><p>${esc(message)}</p><a class="button" href="${esc(href)}">${esc(label)}</a></section>`;
const demoNotice = () => `<div class="notice"><strong>Estás probando una demostración comercial local de CAUCE · Aluminé.</strong>Los comercios y los datos son de prueba. Los paneles permiten demostrar la experiencia real de un restaurante, un cliente y un repartidor.</div>`;
const merchantActor = business => ({ kind:'merchant', ...scopeOf(business) });
const countCart = cart => (cart?.lines || []).reduce((total, line) => total + line.quantity, 0);
const availability = b => `<span class="availability ${b.open ? '' : 'closed'}">${b.open ? 'Abierto en demo' : 'Cerrado en demo'}</span>`;

function updateNavigation() {
  if (!repository) return;
  const state = repository.snapshot();
  const totalItems = state.businesses.reduce((total, b) => total + countCart(repository.cart(b.id)), 0);
  const badge = document.querySelector('#cart-count');
  if (badge) badge.textContent = String(totalItems);

  const [currentPage = 'home'] = route();
  document.querySelectorAll('.bottom-nav-item').forEach(item => {
    const id = item.id;
    const isHome = (id === 'bnav-home' || id === 'bnav-stores') && (currentPage === 'home' || currentPage === 'shop');
    const isOrders = id === 'bnav-orders' && (currentPage === 'orders' || currentPage === 'order');
    const isCarts = id === 'bnav-carts' && (currentPage === 'carts' || currentPage === 'cart');
    item.classList.toggle('active', isHome || isOrders || isCarts);
  });
}

function storesMarkup() {
  const needle = searchState.query.trim().toLocaleLowerCase('es-AR').normalize('NFD').replace(/\p{Diacritic}/gu,'');
  const normalize = value => value.toLocaleLowerCase('es-AR').normalize('NFD').replace(/\p{Diacritic}/gu,'');
  const stores = repository.snapshot().businesses
    .filter(b => b.localityId === CONFIG.defaultLocality && b.active)
    .filter(b => !searchState.onlyOpen || b.open)
    .filter(b => searchState.category === 'Todos' || b.category === searchState.category)
    .filter(b => normalize(`${b.name} ${b.category} ${b.description} ${b.subtitle || ''}`).includes(needle));

  if (!stores.length) {
    return empty('No encontramos coincidencias', 'Probá buscar otra comida o restablecer los filtros de categoría.');
  }

  return `<div class="stores">${stores.map(b => {
    const sampleProduct = repository.products(b.id)[0];
    const previewSvg = getProductSvg(sampleProduct?.dishType || 'burger');
    return `<a class="store-card" href="#shop/${esc(b.id)}" data-testid="store-card">
      <div class="store-art theme-${theme(b)}" aria-hidden="true">
        <span class="demo-tag">COMERCIO FICTICIO</span>
        <span class="store-rating-tag"><span class="star">★</span> ${esc(b.ratingDemo || '4.9')}</span>
        <div class="store-art-preview">${previewSvg}</div>
        ${b.badge ? `<span class="badge-pill">${esc(b.badge)}</span>` : ''}
      </div>
      <div class="store-info">
        <div class="store-title">
          <h3>${esc(b.name)}</h3>
          ${availability(b)}
        </div>
        ${b.subtitle ? `<div class="store-subtitle">${esc(b.subtitle)}</div>` : ''}
        <p class="store-category">${esc(b.description)}</p>
        <div class="store-meta">
          <span>⏱️ ${esc(b.eta)}</span>
          <span>🛵 ${b.deliveryEnabled ? `Envío ${money(b.deliveryFee)}` : 'Solo retiro'}</span>
          <span>🛍️ Retiro gratis</span>
          ${b.minimumOrder > 0 ? `<span>Mínimo ${money(b.minimumOrder)}</span>` : ''}
        </div>
      </div>
    </a>`;
  }).join('')}</div>`;
}

function home() {
  const businesses = repository.snapshot().businesses.filter(b => b.localityId === CONFIG.defaultLocality && b.active);
  const categories = ['Todos', ...new Set(businesses.map(b => b.category))];

  return `<section class="hero">
    <div class="hero-text">
      <span class="eyebrow">PLATAFORMA GASTRONÓMICA LOCAL · ALUMINÉ</span>
      <h1>Lo rico de acá,<br><em>a un toque.</em></h1>
      <p>Pedí comida en comercios de Aluminé desde un solo lugar. Elegí retiro en el local o delivery directo a tu puerta.</p>
      <div class="hero-stats">
        <span class="hero-stat">🌱 ${businesses.length} comercios locales</span>
        <span class="hero-stat">🛵 Retiro y delivery</span>
        <span class="hero-stat">⏱️ 20–45 min</span>
      </div>
    </div>
    <div class="river-art" aria-hidden="true">
      <span class="art-marker">c.</span>
      <span class="art-copy">Comercios de Aluminé.<br>En un solo lugar.</span>
    </div>
  </section>

  <section class="join-banner">
    <div>
      <h3>¿Tenés un comercio o emprendimiento en Aluminé?</h3>
      <p>Sumate a CAUCE: publicá tu menú digital, recibí pedidos ordenados para retiro o delivery y administrá tu cocina con panel propio.</p>
    </div>
    <button class="join-btn" type="button" data-action="open-join-modal">Quiero sumarme a CAUCE →</button>
  </section>

  <section aria-labelledby="stores-title">
    <div class="section-heading">
      <div>
        <h2 id="stores-title">Comercios en Aluminé</h2>
        <p>Explorá la oferta gastronómica y hacé tu pedido en simples pasos.</p>
      </div>
      <span class="quiet">${businesses.length} locales en demostración</span>
    </div>
    <div class="filters">
      <div class="search-box">
        <label class="sr-only" for="search">Buscar comercio o comida</label>
        <input id="search" type="search" aria-label="Buscar comercio o comida" value="${esc(searchState.query)}" placeholder="Buscar un comercio o algo rico…">
      </div>
      <div class="chips" aria-label="Categorías">
        ${categories.map(c => `<button type="button" class="chip ${c === searchState.category ? 'active' : ''}" data-action="filter" data-category="${esc(c)}" aria-pressed="${c === searchState.category}">${esc(c)}</button>`).join('')}
      </div>
      <label class="check-label"><input id="only-open" type="checkbox" ${searchState.onlyOpen ? 'checked' : ''}> Solo abiertos</label>
    </div>
    <div id="stores-results" aria-live="polite">${storesMarkup()}</div>
    <p class="microcopy below-note">Demostración comercial con comercios ficticios de Aluminé. Precios y disponibilidad de ejemplo.</p>
  </section>`;
}

function shop(businessId) {
  const b = repository.business(businessId);
  const products = repository.products(b.id);
  const cart = repository.cart(b.id);
  const categories = [...new Set(products.map(p => p.category))];
  const sampleProduct = products[0];
  const previewSvg = getProductSvg(sampleProduct?.dishType || 'burger');
  const cartItemCount = countCart(cart);
  let currentQuote = null;
  try { if (cartItemCount > 0) currentQuote = repository.quote(b.id, b.pickupEnabled ? 'pickup' : 'delivery'); } catch (_) {}

  return `${back()}
  <section class="shop-hero">
    <div class="shop-initials theme-${theme(b)}" aria-hidden="true">${previewSvg}</div>
    <div>
      <span class="eyebrow">${esc(b.category)} · COMERCIO LOCAL DEMO</span>
      <h1>${esc(b.name)}</h1>
      ${b.subtitle ? `<div class="store-subtitle" style="font-size:15px;margin-bottom:6px;">${esc(b.subtitle)}</div>` : ''}
      <p>${esc(b.description)}</p>
      <div class="shop-info">
        ${availability(b)}
        <span>⏱️ Demora estimada: ${esc(b.eta)}</span>
        <span>🛵 ${b.deliveryEnabled ? `Envío ${money(b.deliveryFee)}` : 'Solo retiro'}</span>
        <span>🛍️ Retiro gratis</span>
        ${b.minimumOrder > 0 ? `<span>Mínimo ${money(b.minimumOrder)}</span>` : ''}
      </div>
      <div class="shop-address" style="margin-top:10px;">📍 ${esc(b.address || 'Aluminé, Neuquén')} · ${esc(b.hoursLabel)}</div>
    </div>
  </section>

  ${!b.open ? '<div class="notice">Este local figura cerrado en la demo. Podés revisar su carta completa o abrirlo desde el panel demo del comercio.</div>' : ''}

  <div class="shop-layout">
    <div>
      ${categories.map(category => `
        <section class="product-group" id="cat-${esc(category.replace(/\s+/g,'-'))}">
          <h2>${esc(category)}</h2>
          ${products.filter(p => p.category === category).map(p => {
            const quantity = cart.lines.find(l => l.productId === p.id)?.quantity || 0;
            const price = confirmedPrice(p);
            const foodSvg = getProductSvg(p.dishType || 'burger');
            return `<article class="product">
              <div class="product-img">${foodSvg}</div>
              <div class="product-details">
                <h3>${esc(p.name)} ${p.badge ? `<span class="dish-badge">${esc(p.badge)}</span>` : ''}</h3>
                <p>${esc(p.description)}</p>
                <span class="product-price">${price === null ? 'No disponible' : money(price)}</span>
              </div>
              <div class="product-action">
                <button class="add-btn add" type="button" data-action="add" data-business="${esc(b.id)}" data-product="${esc(p.id)}" aria-label="Agregar ${esc(p.name)}" ${!b.open || !isCommerciallyPurchasable(p) || quantity >= p.stock ? 'disabled' : ''}>
                  + Agregar
                </button>
                <span class="product-qty">${quantity ? `${quantity} en tu pedido` : (!isCommerciallyPurchasable(p) ? 'Agotado' : '')}</span>
              </div>
            </article>`;
          }).join('')}
        </section>
      `).join('')}
    </div>

    <aside class="sidebox">
      <h3>Tu pedido en este comercio</h3>
      <p>Un solo pedido por comercio para asegurar comida recién hecha y entrega directa.</p>
      ${cart.lines.length > 0 ? `
        <div class="sidebox-cart-items">
          ${cart.lines.map(line => {
            const p = products.find(prod => prod.id === line.productId);
            return `<div class="sidebox-item"><span>${line.quantity} × ${esc(p?.name || line.productId)}</span><strong>${money((p?.price || 0) * line.quantity)}</strong></div>`;
          }).join('')}
        </div>
        <div class="inline-total">
          <span>Subtotal estimado:</span>
          <strong>${currentQuote ? money(currentQuote.subtotal) : '—'}</strong>
        </div>
        <a class="button full" href="#cart/${esc(b.id)}">Ir al checkout →</a>
      ` : `
        <p class="inline-total" style="font-weight:400;color:var(--muted);">El carrito de este comercio está vacío.</p>
      `}
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line);">
        <p class="microcopy">¿Querés ver este local desde adentro?</p>
        <a class="link-button" href="#business/${esc(b.id)}">Abrir panel del comercio →</a>
      </div>
    </aside>
  </div>

  ${cartItemCount > 0 ? `
    <div class="floating-cart-bar">
      <div>
        <strong>${cartItemCount} producto${cartItemCount === 1 ? '' : 's'} en ${esc(b.name)}</strong>
        <div style="font-size:12px;opacity:.9;">Total estimado: ${currentQuote ? money(currentQuote.subtotal) : ''}</div>
      </div>
      <a href="#cart/${esc(b.id)}">Ver mi pedido →</a>
    </div>
  ` : ''}`;
}

function carts() {
  const nonempty = repository.snapshot().businesses.filter(b => repository.cart(b.id).lines.length);
  return `${back()}
  <h1 class="page-title">Tus pedidos en curso</h1>
  <p class="quiet">Cada pedido se procesa de forma independiente en su comercio correspondiente.</p>
  ${nonempty.length ? nonempty.map(b => {
    const cart = repository.cart(b.id);
    const count = countCart(cart);
    let q = null;
    try { q = repository.quote(b.id, b.pickupEnabled ? 'pickup' : 'delivery'); } catch (_) {}
    return `<article class="card row">
      <div>
        <span class="eyebrow">${esc(b.category)}</span>
        <h3>${esc(b.name)}</h3>
        <p class="quiet">${count} producto${count === 1 ? '' : 's'} · Subtotal ${q ? money(q.subtotal) : '—'}</p>
      </div>
      <div style="display:flex;gap:10px;">
        <button class="button secondary" type="button" data-action="clear-cart" data-business="${esc(b.id)}">Vaciar</button>
        <a class="button" href="#cart/${esc(b.id)}">Revisar carrito</a>
      </div>
    </article>`;
  }).join('') : empty('Todavía no elegiste nada', 'Entrá a un comercio y agregá algo rico.')}`;
}

function cartPage(businessId) {
  const b = repository.business(businessId);
  const cart = repository.cart(b.id);
  const products = repository.products(b.id);

  if (!cart.lines.length) {
    return `${back(`#shop/${b.id}`, b.name)}${empty('Tu carrito está vacío', 'Los productos de este comercio aparecerán acá.', `#shop/${b.id}`, 'Ver la carta')}`;
  }

  const values = formValues.get(b.id) || {
    fulfillment: b.pickupEnabled ? 'pickup' : 'delivery',
    name: 'Cliente de prueba',
    phone: '0000000000',
    address: 'Calle de prueba 123',
    reference: '',
    paymentMethod: 'cash_demo',
    notes: '',
  };

  let quote = null;
  let quoteError = '';
  try { quote = repository.quote(b.id, values.fulfillment); } catch (error) { quoteError = error.message; }

  return `${back(`#shop/${b.id}`, `Seguir eligiendo en ${b.name}`)}
  <h1 class="page-title">Tu pedido en ${esc(b.name)}</h1>
  <p class="quiet">Revisá todo antes de probar el circuito.</p>
  <div class="cart-layout">
    <div>
      <section class="card">
        ${cart.lines.map(line => {
          const p = products.find(item => item.id === line.productId);
          const price = confirmedPrice(p);
          return `<div class="cart-line">
            <div>
              <h3>${esc(p?.name || 'Producto no disponible')}</h3>
              <span class="microcopy">${price === null ? 'Precio no disponible' : `${money(price)} cada uno`}</span>
            </div>
            <div class="quantity">
              <button type="button" data-action="quantity" data-business="${esc(b.id)}" data-product="${esc(line.productId)}" data-quantity="${line.quantity - 1}" aria-label="Quitar una unidad de ${esc(p?.name)}">−</button>
              <span>${line.quantity}</span>
              <button type="button" data-action="quantity" data-business="${esc(b.id)}" data-product="${esc(line.productId)}" data-quantity="${line.quantity + 1}" aria-label="Agregar una unidad de ${esc(p?.name)}" ${!p || line.quantity >= p.stock || line.quantity >= 99 ? 'disabled' : ''}>+</button>
            </div>
          </div>`;
        }).join('')}
        <button class="link-button" type="button" data-action="clear-cart" data-business="${esc(b.id)}">Vaciar este carrito</button>
      </section>

      <form id="checkout-form" data-form="checkout" data-business="${esc(b.id)}" class="card">
        <h2>¿Cómo lo recibís?</h2>
        <p class="microcopy">Usá datos ficticios. Se guardan únicamente en este navegador.</p>
        <div class="field"><label for="fulfillment">Modalidad de entrega</label>
          <select id="fulfillment" name="fulfillment">
            ${b.pickupEnabled ? `<option value="pickup" ${values.fulfillment === 'pickup' ? 'selected' : ''}>Retiro por el comercio · sin costo</option>` : ''}
            ${b.deliveryEnabled ? `<option value="delivery" ${values.fulfillment === 'delivery' ? 'selected' : ''}>Delivery del comercio · ${money(b.deliveryFee)}</option>` : ''}
          </select>
        </div>
        <div class="form-grid">
          <label class="field">Nombre de ejemplo
            <input name="name" required minlength="2" maxlength="80" value="${esc(values.name)}" autocomplete="off">
          </label>
          <label class="field">Teléfono de ejemplo
            <input name="phone" type="tel" required minlength="8" maxlength="24" value="${esc(values.phone)}" autocomplete="off">
          </label>
          ${values.fulfillment === 'delivery' ? `
            <label class="field wide">Dirección de ejemplo
              <input name="address" required minlength="5" maxlength="200" value="${esc(values.address)}" autocomplete="off">
            </label>
          ` : ''}
          <label class="field wide">Notas para el comercio
            <textarea name="notes" maxlength="300">${esc(values.notes)}</textarea>
          </label>
        </div>
      </form>
    </div>

    <aside class="sidebox">
      <h3>Resumen</h3>
      <div class="totals">
        <div class="row"><span>Productos</span><strong>${quote ? money(quote.subtotal) : '—'}</strong></div>
        <div class="row"><span>${values.fulfillment === 'pickup' ? 'Retiro' : 'Envío'}</span><strong>${values.fulfillment === 'pickup' ? 'Gratis' : money(b.deliveryFee)}</strong></div>
        <div class="row total"><span>Total demo</span><strong>${quote ? money(quote.total) : '—'}</strong></div>
      </div>
      ${quoteError ? `<div class="notice error">${esc(quoteError)}</div>` : ''}
      <p class="microcopy">Pago simulado contra entrega. Mercado Pago y cualquier cobro real están deshabilitados.</p>
      <button class="button full" type="submit" form="checkout-form" ${quote ? '' : 'disabled'}>Crear pedido de prueba</button>
      <p class="microcopy below-note">Ningún comercio recibirá este pedido.</p>
    </aside>
  </div>`;
}

function tracking(orderId) {
  const order = repository.orders(customerActor).find(o => o.id === orderId);
  if (!order) {
    return empty('Pedido no encontrado', 'Este pedido no está guardado en el navegador.', '#orders', 'Ver mis pedidos');
  }
  const b = repository.business(order.businessId);
  const mapSvg = getAlumineMapSvg({
    merchantName: b.name,
    customerAddress: order.customer?.address || 'Mostrador local',
    status: order.status,
    fulfillment: order.fulfillment,
  });

  const deliveryCodeMarkup = (order.fulfillment === 'delivery' && order.deliveryCode?.code)
    ? `<div class="delivery-code-badge"><span>🔑 Código de entrega al recibir:</span><strong>${esc(formatDeliveryCode(order.deliveryCode.code))}</strong></div>`
    : '';

  return `${back('#orders', 'Volver a mis pedidos')}
  <div class="narrow">
    <span class="eyebrow">SEGUIMIENTO DE DEMOSTRACIÓN</span>
    <h1 class="page-title">${esc(STATUS_LABELS[order.status] || order.status)}</h1>
    <p class="quiet">${esc(order.code)} · ${esc(b.name)}</p>
    ${renderPublicOrderTimeline(order.status)}
    ${deliveryCodeMarkup}
    ${orderCard(order, customerActor)}
    ${mapSvg}
    <section class="card">
      <h2>Así va tu pedido</h2>
      <ol class="timeline">
        ${order.history.map(event => `<li>${esc(STATUS_LABELS[event.status] || event.status)}<small>${esc(new Date(event.at).toLocaleString('es-AR'))}</small></li>`).join('')}
      </ol>
      <p class="microcopy">Los estados cambian desde los paneles demo. No hay GPS ni seguimiento de repartidores reales.</p>
    </section>
    <div class="notice"><strong>Probá el otro lado del mostrador.</strong>Abrí el panel demo para confirmar y preparar este pedido.</div>
    <div class="order-actions">
      <a class="button" href="#business/${esc(b.id)}">Abrir panel demo de ${esc(b.name)}</a>
      ${order.fulfillment === 'delivery' ? `<a class="button secondary" href="#rider/${esc(b.id)}">Abrir reparto demo</a>` : ''}
    </div>
  </div>`;
}

function orders() {
  const all = repository.orders(customerActor);
  return `${back()}
  <h1 class="page-title">Mis pedidos de prueba</h1>
  <p class="quiet">Historial local de este navegador. No son pedidos reales.</p>
  ${all.length ? all.map(o => orderCard(o, customerActor)).join('') : empty('Todavía no hay pedidos', 'Probá el circuito completo: catálogo, carrito, pedido y seguimiento.')}`;
}

function orderCard(order, actor) {
  const b = repository.business(order.businessId);
  const actions = allowedActions(order, actor);
  const actionLabels = {
    accepted: 'Confirmar',
    preparing: 'Preparar',
    ready: 'Marcar listo',
    assigned: 'Asignar repartidor demo',
    picked_up: 'Confirmar retiro',
    on_the_way: 'Salir a reparto',
    arrived: 'Llegué al destino',
    delivered: 'Confirmar entrega',
    canceled: 'Cancelar pedido',
  };

  const isRiderAwaiting = actor.kind === 'rider' && isAwaitingPreparation(order);
  const formattedPhone = order.customer?.phone ? formatArgentinePhone(order.customer.phone) : '';
  const deliveryCodeBadge = (order.fulfillment === 'delivery' && order.deliveryCode?.code)
    ? `<div style="margin:6px 0;font-size:12px;color:var(--clay);font-weight:600;">🔑 Código de entrega: <strong>${esc(formatDeliveryCode(order.deliveryCode.code))}</strong></div>`
    : '';

  return `<article class="card order-card"><div class="row"><div>
    <span class="order-code">${esc(order.code)} · PEDIDO DE PRUEBA</span>
    <h3>${esc(b.name)}</h3>
    <span class="microcopy">${order.fulfillment === 'pickup' ? 'Retiro por el local' : 'Delivery del comercio'}</span></div>
    <span class="status">${esc(STATUS_LABELS[order.status] || order.status)}</span></div>
    ${actor.kind !== 'customer' ? renderOrderTimeline(order.status) : ''}
    <p class="order-items">${order.lines.map(l => `${l.quantity} × ${esc(l.name)}`).join(' · ')}</p>
    <div class="row"><strong>${money(order.total)}</strong>
      <div style="display:flex;gap:10px;align-items:center;">
        ${actor.kind === 'merchant' ? `<button class="link-button" type="button" data-action="view-ticket" data-order="${esc(order.id)}" data-business="${esc(b.id)}">🧾 Ver comanda</button>` : ''}
        <a class="link-button" href="#order/${esc(order.id)}">Ver seguimiento</a>
      </div>
    </div>
    ${deliveryCodeBadge}
    ${actor.kind !== 'customer' ? (
      isRiderAwaiting
        ? `<p class="microcopy below-note" style="color:var(--clay);">⏳ Pedido en cocina. Los datos de contacto y entrega se activan al retirar del local.</p>`
        : `<p class="microcopy below-note">${esc(order.customer?.name)} · ${esc(formattedPhone || order.customer?.phone)}
          ${order.customer?.address ? `<br>${esc(order.customer.address)}` : ''}
          ${order.customer?.notes ? `<br>Nota: ${esc(order.customer.notes)}` : ''}</p>`
    ) : ''}
    ${actions.length > 0 ? `
      <div class="order-actions">
        ${actions.map(status => `<button type="button" class="button ${status === 'canceled' ? 'danger' : ''}" data-action="transition" data-order="${esc(order.id)}" data-version="${order.version}" data-status="${esc(status)}" data-business="${esc(order.businessId)}" data-actor="${esc(actor.kind)}" data-rider="${esc(actor.kind === 'rider' ? actor.id : '')}">${esc(actionLabels[status] || status)}</button>`).join('')}
      </div>
    ` : ''}
  </article>`;
}

function manage() {
  return `${back()}
  <h1 class="page-title">Paneles de demostración</h1>
  ${demoNotice()}
  <div class="stores">
    ${repository.snapshot().businesses.map(b => `<section class="card"><span class="eyebrow">COMERCIO FICTICIO</span><h2>${esc(b.name)}</h2><p class="quiet">Probá la bandeja, los productos y la apertura del local.</p><div class="stack"><a class="button" href="#business/${esc(b.id)}">Panel del comercio</a>${b.deliveryEnabled ? `<a class="button secondary" href="#rider/${esc(b.id)}">Panel de reparto</a>` : ''}</div></section>`).join('')}
  </div>`;
}

function businessPanel(businessId) {
  const b = repository.business(businessId);
  const actor = merchantActor(b);
  const allOrders = repository.orders(actor);
  const products = repository.products(b.id);
  const metrics = calculateBusinessMetrics(allOrders, products);

  return `${back('#manage', 'Todos los paneles demo')}
  <div class="manage-header">
    <div><span class="eyebrow">PANEL DE COMERCIO · DEMO</span><h1 class="page-title">${esc(b.name)}</h1>${availability(b)}</div>
    <div class="manage-controls">
      <button class="sound-toggle ${!soundService.muted ? 'on' : ''}" type="button" data-action="toggle-sound">
        ${!soundService.muted ? '🔔 Aviso sonoro: ACTIVO' : '🔕 Aviso sonoro: SILENCIADO'}
      </button>
      <a class="button secondary" href="#shop/${esc(b.id)}">Ver mi carta</a>
      <button class="button" type="button" data-action="toggle-open" data-business="${esc(b.id)}">${b.open ? 'Cerrar' : 'Abrir'} comercio demo</button>
    </div>
  </div>
  ${demoNotice()}

  <div class="tab-bar">
    <button type="button" class="tab-btn ${activeBusinessTab === 'all' ? 'active' : ''}" data-action="set-biz-tab" data-tab="all">🏢 Todo</button>
    <button type="button" class="tab-btn ${activeBusinessTab === 'orders' ? 'active' : ''}" data-action="set-biz-tab" data-tab="orders">📋 Pedidos (${allOrders.length})</button>
    <button type="button" class="tab-btn ${activeBusinessTab === 'products' ? 'active' : ''}" data-action="set-biz-tab" data-tab="products">🍽️ Productos (${products.length})</button>
    <button type="button" class="tab-btn ${activeBusinessTab === 'settings' ? 'active' : ''}" data-action="set-biz-tab" data-tab="settings">⚙️ Configuración</button>
    <button type="button" class="tab-btn ${activeBusinessTab === 'metrics' ? 'active' : ''}" data-action="set-biz-tab" data-tab="metrics">📊 Resumen comercial</button>
  </div>

  ${activeBusinessTab === 'all' || activeBusinessTab === 'orders' ? `
    <div class="section-heading"><div><h2>Pedidos del comercio</h2><p>${allOrders.length} pedidos de prueba. No se muestran los de otros comercios en esta vista.</p></div>
    ${b.deliveryEnabled ? `<a class="link-button" href="#rider/${esc(b.id)}">Ir a reparto demo →</a>` : ''}</div>
    ${allOrders.length ? allOrders.map(o => orderCard(o, actor)).join('') : empty('La bandeja está vacía', 'Creá un pedido de prueba desde la carta de este comercio.', `#shop/${b.id}`, 'Abrir la carta')}
  ` : ''}

  ${activeBusinessTab === 'all' || activeBusinessTab === 'products' ? `
    <section class="product-group"><h2>Productos</h2><p class="quiet">Modificá precios, stock y disponibilidad de esta demostración.</p><div class="edit-products">
      ${products.map(p => `<form class="card edit-product" data-form="product" data-business="${esc(b.id)}" data-product="${esc(p.id)}"><h3>${esc(p.name)}</h3><div class="edit-fields"><label class="field">Precio de ejemplo<input name="price" type="number" min="1" max="10000000" step="1" required value="${p.price}"></label><label class="field">Stock de ejemplo<input name="stock" type="number" min="0" max="10000" step="1" required value="${p.stock}"></label></div><label class="check-label"><input name="available" type="checkbox" ${p.available ? 'checked' : ''}> Disponible</label><button class="button secondary full" type="submit">Guardar cambios demo</button></form>`).join('')}
    </div></section>
  ` : ''}

  ${activeBusinessTab === 'all' || activeBusinessTab === 'settings' ? `
    <div class="narrow"><div class="card">
      <h2>Configuración del local</h2><p class="quiet">Ajustá tiempos y modalidad de entrega en Aluminé.</p>
      <form data-form="business-config" data-business="${esc(b.id)}">
        <div class="form-grid">
          <label class="field">Demora estimada<select name="eta">
            <option value="15–25 min" ${b.eta === '15–25 min' ? 'selected' : ''}>15–25 min</option>
            <option value="20–35 min" ${b.eta === '20–35 min' ? 'selected' : ''}>20–35 min</option>
            <option value="25–40 min" ${b.eta === '25–40 min' ? 'selected' : ''}>25–40 min</option>
            <option value="30–45 min" ${b.eta === '30–45 min' ? 'selected' : ''}>30–45 min</option>
            <option value="45–60 min" ${b.eta === '45–60 min' ? 'selected' : ''}>45–60 min</option>
          </select></label>
          <label class="field">Costo de envío demo ($)<input name="deliveryFee" type="number" min="0" step="100" value="${b.deliveryFee}"></label>
          <label class="field wide">Horario de atención<input name="hoursLabel" maxlength="60" value="${esc(b.hoursLabel)}"></label>
          <div class="field wide">
            <label class="check-label" style="margin-bottom:8px;"><input name="deliveryEnabled" type="checkbox" ${b.deliveryEnabled ? 'checked' : ''}> Habilitar delivery</label>
            <label class="check-label"><input name="pickupEnabled" type="checkbox" ${b.pickupEnabled ? 'checked' : ''}> Habilitar retiro</label>
          </div>
        </div>
        <button class="button" style="margin-top:16px;" type="submit">Guardar configuración demo</button>
      </form>
    </div></div>
  ` : ''}

  ${activeBusinessTab === 'all' || activeBusinessTab === 'metrics' ? `
    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-label">Ventas demo hoy</div><div class="metric-value">${money(metrics.todayRevenue)}</div><small class="quiet">${metrics.todayOrderCount} pedidos</small></div>
      <div class="metric-card"><div class="metric-label">Ticket promedio</div><div class="metric-value">${money(metrics.averageTicket)}</div><small class="quiet">Por pedido</small></div>
      <div class="metric-card"><div class="metric-label">Pedidos activos</div><div class="metric-value" style="color:var(--clay);">${metrics.activeCount}</div><small class="quiet">En preparación</small></div>
      <div class="metric-card"><div class="metric-label">Stock bajo</div><div class="metric-value" style="color:#b87023;">${metrics.lowStockCount}</div><small class="quiet">5 o menos</small></div>
    </div>
    <div class="card"><h3>Platos más pedidos</h3>
      ${metrics.topProducts.length ? `<div style="margin-top:10px;">${metrics.topProducts.map((p, i) => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line);"><span><strong>#${i+1}</strong> ${esc(p.name)}</span><strong>${p.quantity} u.</strong></div>`).join('')}</div>` : '<p class="quiet">Los pedidos generarán estadísticas acá.</p>'}
    </div>
  ` : ''}`;
}

function riderPanel(businessId) {
  const b = repository.business(businessId);
  const rider = repository.snapshot().riders.find(r => r.businessId === b.id && r.localityId === b.localityId);
  if (!rider) return `${back('#manage', 'Paneles demo')}${empty('Este comercio no tiene delivery', 'En esta demostración trabaja únicamente con retiro.')}`;

  const actor = { ...rider, kind: 'rider' };
  const all = repository.orders(actor);
  const activeOrder = getRiderQueueOrder(all);
  const riderStatusLabel = getRiderStateLabel(activeOrder);
  const progress = Math.round(getRouteProgress(activeOrder) * 100);

  return `${back(`#business/${b.id}`, 'Volver al panel del comercio')}
  <span class="eyebrow">REPARTO DEL COMERCIO · DEMO</span><h1 class="page-title">${esc(b.name)}</h1>
  ${demoNotice()}
  <div class="card" style="margin-bottom:20px;border-left:4px solid var(--green);">
    <div class="row">
      <div>
        <span class="eyebrow" style="color:var(--green);">ESTADO DE RUTA (${esc(rider.name)})</span>
        <h3 style="margin:4px 0;">${esc(riderStatusLabel)}</h3>
        <p class="microcopy">Progreso estimado del circuito: <strong>${progress}%</strong></p>
      </div>
      ${activeOrder ? `<a class="button secondary" href="#order/${esc(activeOrder.id)}">Ver en mapa</a>` : ''}
    </div>
  </div>
  <p class="quiet">Solo aparecen los pedidos asignados a ${esc(rider.name)}. No se comparte una flota entre comercios.</p>
  ${all.length ? all.map(o => orderCard(o, actor)).join('') : empty('Todavía no hay pedidos asignados', 'Prepará un pedido con delivery y asignalo desde el panel de este comercio.', `#business/${b.id}`, 'Ir al panel del comercio')}`;
}

function render({ focus = false } = {}) {
  if (!repository) return;
  try {
    const [page = 'home', id] = route();
    const pages = {
      home,
      shop: () => shop(id),
      cart: () => cartPage(id),
      carts,
      orders,
      order: () => tracking(id),
      manage,
      business: () => businessPanel(id),
      rider: () => riderPanel(id)
    };
    main.innerHTML = Object.hasOwn(pages, page) ? pages[page]() : empty('Página no encontrada', 'Volvé al inicio para seguir explorando.');
    updateNavigation();
  } catch (error) {
    main.innerHTML = `<section class="notice error"><h2>No pudimos abrir esta vista</h2><p>${esc(error.message)}</p><a href="#home" class="button secondary">Volver al inicio</a></section>`;
  }
  if (focus) {
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}

function rememberForm(form) {
  if (form?.dataset.form === 'checkout') {
    formValues.set(form.dataset.business, {
      ...formValues.get(form.dataset.business),
      ...Object.fromEntries(new FormData(form))
    });
  }
}

function openJoinModal() {
  if (!modalContainer) return;
  modalContainer.innerHTML = `<div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="join-modal-title">
    <div class="modal-card">
      <button class="modal-close" type="button" data-action="close-modal" aria-label="Cerrar modal">×</button>
      <span class="eyebrow">SUMATE A CAUCE · ALUMINÉ</span>
      <h2 id="join-modal-title">Tu comercio en la plataforma local</h2>
      <p class="quiet">Sumá tu restaurante, pizzería, cafetería o rotisería a la red gastronómica de Aluminé.</p>
      <div style="background:var(--soft);padding:14px;border-radius:12px;font-size:12px;margin-bottom:18px;">
        <div>✓ <strong>Catálogo digital</strong> listo para compartir con vecinos y turistas.</div>
        <div>✓ <strong>Control directo de pedidos</strong> con tiempos de espera y stock.</div>
        <div>✓ <strong>Retiro y delivery</strong> gestionados desde tu propio panel en celular o PC.</div>
      </div>
      <form id="join-form">
        <div class="form-grid">
          <label class="field">Tu nombre y apellido<input name="name" required minlength="2" placeholder="Ej: Patricia Morales"></label>
          <label class="field">Nombre de tu comercio<input name="businessName" required minlength="2" placeholder="Ej: Pizzería del Valle"></label>
          <label class="field">Rubro gastronómico<select name="category">
            <option value="Hamburguesería">Hamburguesería</option>
            <option value="Pizzería / Empanadas">Pizzería / Empanadas</option>
            <option value="Rotisería / Minutas">Rotisería / Minutas</option>
            <option value="Cafetería / Pastelería">Cafetería / Pastelería</option>
            <option value="Cervecería / Cocina">Cervecería / Cocina</option>
            <option value="Comida casera / Pastas">Comida casera / Pastas</option>
            <option value="Panadería">Panadería / Confitería</option>
          </select></label>
          <label class="field">Teléfono o WhatsApp<input name="phone" type="tel" required minlength="8" placeholder="Ej: 2942-556677"></label>
          <label class="field wide">Comentario o consulta<textarea name="notes" placeholder="Contanos sobre tu local o tus horarios…"></textarea></label>
        </div>
        <div style="display:flex;gap:12px;margin-top:20px;">
          <button class="button full" type="submit">Enviar solicitud de incorporación demo</button>
          <button class="button secondary" type="button" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>
  </div>`;
}

function openSwitchStoreModal(conflict) {
  if (!modalContainer) return;
  modalContainer.innerHTML = `<div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="switch-modal-title">
    <div class="modal-card">
      <span class="eyebrow" style="color:var(--clay);">CAMBIO DE COMERCIO</span>
      <h2 id="switch-modal-title">¿Querés cambiar de comercio?</h2>
      <p>Ya tenés productos de <strong>${esc(conflict.existingBusiness.name)}</strong> en tu pedido.</p>
      <p class="quiet" style="font-size:13px;">En CAUCE cada pedido se procesa por comercio individual para garantizar tiempos de elaboración y frescura.</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:22px;">
        <button class="button danger full" type="button" data-action="confirm-switch-store">
          Vaciar pedido de ${esc(conflict.existingBusiness.name)} y pedir en ${esc(conflict.newBusiness.name)}
        </button>
        <button class="button secondary full" type="button" data-action="close-modal">
          Mantener mi pedido en ${esc(conflict.existingBusiness.name)}
        </button>
      </div>
    </div>
  </div>`;
}

function openTicketModal(order, businessName) {
  if (!modalContainer) return;
  const ticketText = buildKitchenTicket(order, businessName);
  modalContainer.innerHTML = `<div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="ticket-modal-title">
    <div class="modal-card">
      <button class="modal-close" type="button" data-action="close-modal" aria-label="Cerrar modal">×</button>
      <span class="eyebrow">VISTA DE COCINA / MOSTRADOR</span>
      <h2 id="ticket-modal-title">Comanda de cocina</h2>
      <p class="quiet" style="font-size:12px;">Formato de impresión térmica para cocina y despacho.</p>
      <div class="ticket-container">${esc(ticketText)}</div>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="button full" type="button" data-action="copy-ticket" data-text="${esc(ticketText)}">📋 Copiar comanda</button>
        <button class="button secondary" type="button" data-action="close-modal">Cerrar</button>
      </div>
    </div>
  </div>`;
}

function closeModal() {
  if (modalContainer) modalContainer.innerHTML = '';
  pendingSwitchConflict = null;
}

async function doAction(button) {
  const { action, business: businessId, product: productId } = button.dataset;

  if (action === 'filter') {
    searchState.category = button.dataset.category;
    render();
    return;
  }

  if (action === 'open-join-modal') {
    openJoinModal();
    return;
  }

  if (action === 'close-modal') {
    closeModal();
    return;
  }

  if (action === 'toggle-sound') {
    soundService.setMuted(!soundService.muted);
    if (!soundService.muted) {
      await soundService.playNewOrder();
      toast('🔔 Aviso sonoro activado (probando tono armónico).');
    } else {
      toast('🔕 Aviso sonoro silenciado.');
    }
    render();
    return;
  }

  if (action === 'set-biz-tab') {
    activeBusinessTab = button.dataset.tab;
    render();
    return;
  }

  if (action === 'view-ticket') {
    const b = repository.business(businessId);
    const order = repository.orders(merchantActor(b)).find(o => o.id === button.dataset.order);
    if (order) openTicketModal(order, b.name);
    return;
  }

  if (action === 'copy-ticket') {
    const text = button.dataset.text;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        toast('Comanda copiada al portapapeles.');
      } else {
        toast('Comanda lista para imprimir.');
      }
    } catch (_) {
      toast('Comanda lista para imprimir.');
    }
    return;
  }

  if (action === 'add') {
    const current = repository.cart(businessId).lines.find(l => l.productId === productId)?.quantity || 0;
    await repository.setQuantity(businessId, productId, current + 1);
    toast('Agregado al carrito de este comercio.');
    return;
  }

  if (action === 'confirm-switch-store') {
    if (pendingSwitchConflict) {
      await repository.clearCart(pendingSwitchConflict.existingBusiness.id);
      await repository.setQuantity(pendingSwitchConflict.newBusiness.id, pendingSwitchConflict.productId, 1);
      closeModal();
      toast(`Carrito anterior vaciado. Agregado a ${pendingSwitchConflict.newBusiness.name}.`);
      render();
    }
    return;
  }

  if (action === 'quantity') {
    await repository.setQuantity(businessId, productId, Number(button.dataset.quantity));
    return;
  }

  if (action === 'clear-cart') {
    await repository.clearCart(businessId);
    return;
  }

  if (action === 'toggle-open') {
    const b = repository.business(businessId);
    await repository.setBusinessOpen(b.id, !b.open, merchantActor(b));
    return;
  }

  if (action === 'transition') {
    const b = repository.business(businessId);
    let actor;
    if (button.dataset.actor === 'customer') actor = customerActor;
    else if (button.dataset.actor === 'merchant') actor = merchantActor(b);
    else actor = { kind: 'rider', ...scopeOf(b), id: button.dataset.rider };

    const rider = repository.snapshot().riders.find(r => r.businessId === b.id && r.localityId === b.localityId);
    await repository.transition({
      orderId: button.dataset.order,
      expectedVersion: Number(button.dataset.version),
      nextStatus: button.dataset.status,
      actor,
      riderId: rider?.id,
    });

    if (['accepted', 'preparing'].includes(button.dataset.status) && !soundService.muted) {
      await soundService.playNewOrder();
    }
    toast('Estado del pedido demo actualizado.');
    return;
  }
}

main.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const currentHash = location.hash;
  button.disabled = true;
  try {
    await doAction(button);
    if (location.hash === currentHash) render();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
});

if (modalContainer) {
  modalContainer.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
      await doAction(button);
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  });

  modalContainer.addEventListener('submit', async event => {
    if (event.target.id === 'join-form') {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      await repository.addMerchantLead(data);
      closeModal();
      toast('¡Solicitud demo registrada! En un piloto real te contactaremos en 24 hs.');
    }
  });
}

main.addEventListener('input', event => {
  if (event.target.id === 'search') {
    searchState.query = event.target.value;
    const results = document.querySelector('#stores-results');
    if (results) results.innerHTML = storesMarkup();
  }
  rememberForm(event.target.closest('form'));
});

main.addEventListener('change', event => {
  if (event.target.id === 'only-open') {
    searchState.onlyOpen = event.target.checked;
    const results = document.querySelector('#stores-results');
    if (results) results.innerHTML = storesMarkup();
  }
  if (event.target.id === 'fulfillment') {
    rememberForm(event.target.closest('form'));
    render();
    document.querySelector('#fulfillment')?.focus();
  }
});

main.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.dataset.form) return;
  event.preventDefault();
  const buttons = [...document.querySelectorAll('button[type="submit"]')];
  buttons.forEach(b => b.disabled = true);
  const values = Object.fromEntries(new FormData(form));

  try {
    if (form.dataset.form === 'checkout') {
      rememberForm(form);
      const businessId = form.dataset.business;
      const requestId = await repository.prepareRequest(businessId);
      const lines = repository.cart(businessId).lines;
      const order = await repository.createOrder({
        businessId,
        requestId,
        lines,
        fulfillment: values.fulfillment,
        customer: values,
        paymentMethod: 'cash_demo',
      });
      formValues.delete(businessId);
      go(`order/${order.id}`);
      if (!soundService.muted) await soundService.playNewOrder();
      toast('Pedido de prueba creado. No se envió a ningún comercio.');
    } else if (form.dataset.form === 'product') {
      const b = repository.business(form.dataset.business);
      await repository.updateProduct(
        b.id,
        form.dataset.product,
        {
          price: Number(values.price),
          stock: Number(values.stock),
          available: values.available === 'on',
        },
        merchantActor(b)
      );
      render();
      toast('Producto de demostración actualizado.');
    } else if (form.dataset.form === 'business-config') {
      const b = repository.business(form.dataset.business);
      await repository.updateBusinessConfig(
        b.id,
        {
          eta: values.eta,
          deliveryFee: Number(values.deliveryFee),
          hoursLabel: values.hoursLabel,
          deliveryEnabled: values.deliveryEnabled === 'on',
          pickupEnabled: values.pickupEnabled === 'on',
        },
        merchantActor(b)
      );
      render();
      toast('Configuración del local guardada.');
    }
  } catch (error) {
    toast(error.message);
    buttons.forEach(b => b.disabled = false);
  }
});

async function resetDemonstration() {
  if (!confirm('¿Borrar todos los pedidos, carritos y cambios de esta demostración?')) return;
  try {
    if (repository) {
      try {
        await repository.reset();
      } catch (error) {
        if (error.code !== 'CORRUPT_STORAGE') throw error;
        localStorage.removeItem(DEMO_STORAGE_KEY);
      }
    } else {
      localStorage.removeItem(DEMO_STORAGE_KEY);
    }
    formValues.clear();
    repository = createRepository(CONFIG, { storage: localStorage });
    go('home');
    render();
    toast('Demostración reiniciada.');
  } catch (error) {
    toast(error.message);
  }
}

document.querySelector('#reset-demo')?.addEventListener('click', resetDemonstration);
document.querySelector('#banner-reset-demo')?.addEventListener('click', resetDemonstration);

window.addEventListener('hashchange', () => render({ focus: true }));
window.addEventListener('storage', event => {
  if (event.key === DEMO_STORAGE_KEY) {
    render();
    toast('Se actualizaron los datos de otra pestaña.');
  }
});

try {
  if (typeof location !== 'undefined' && location.search.includes('demo=1')) {
    localStorage.removeItem(DEMO_STORAGE_KEY);
  }
  repository = createRepository(CONFIG, { storage: localStorage });
  render();
} catch (error) {
  main.innerHTML = `<div class="notice error"><h1 class="page-title">No se pudo iniciar</h1><p>${esc(error.message)}</p></div>`;
}
