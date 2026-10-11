// Compra: carrito, checkout (un pedido = una tienda), seguimiento por enlace y
// "Mis pedidos". El servidor vuelve a calcular precios, stock y total; acá se
// muestra la cotización y se manda el intento con su clave de idempotencia.
import { html, raw, attr } from '../../core/html.js';
import { formatARS } from '../../core/money.js';
import { longDate, timeRange, dateTime, relative } from '../../core/dates.js';
import { quoteCart, setQuantity, removeFromCart, cartCount } from '../../core/cart.js';
import { STATUS_LABEL, FULFILLMENT_LABEL, PAYMENT_LABEL, buyerMessage, timelineSteps, isOpen, buyerCanCancel } from '../../core/order-status.js';
import { clean, isEmail, isPhone, isName } from '../../core/validators.js';
import { directionsUrl, whatsappUrl, telUrl } from '../../core/links.js';
import { icon } from '../icons.js';
import { sofia } from '../sofia.js';
import { emptyState, storeLogo, placeholderArt, banner, statusPill, stepper, pageHeader } from '../components.js';

const thumb = (src) => html`<span class="cart-thumb">${src ? html`<img src="${src}" alt="" width="76" height="76" loading="lazy">` : placeholderArt()}</span>`;
const feeText = business => (business.deliveryFee === null ? 'a coordinar con la tienda' : business.deliveryFee === 0 ? 'sin costo' : formatARS(business.deliveryFee));

// ══════════ carrito ══════════
export async function cart(ctx) {
  const carts = ctx.stores.allCarts();
  if (carts.length === 1) return checkout({ ...ctx, params: { businessId: carts[0].businessId }, fromCart: true });
  if (!carts.length) {
    return { chrome: 'shop', nav: '', title: 'Mi carrito',
      html: html`${pageHeader('Mi carrito')}${emptyState({ scene: 'carrito-vacio', title: 'Tu carrito está vacío',
        text: 'Explorá productos hechos cerca tuyo y agregá los que te gusten.', action: html`<a class="btn btn-primary" href="#/explorar">Explorar productos</a>` })}` };
  }
  const groups = await Promise.all(carts.map(async c => {
    const data = await ctx.repo.cartCatalog(c.businessId, c.lines.map(l => l.productId)).catch(() => null);
    return { cart: c, data, quote: data ? quoteCart(c, data.products) : null };
  }));
  return {
    chrome: 'shop', nav: '', title: 'Mi carrito',
    html: html`
      ${pageHeader(`Mi carrito (${carts.reduce((n, c) => n + cartCount(c), 0)})`)}
      ${banner('', 'Tenés productos de varias tiendas', 'Cada tienda prepara y entrega su pedido: confirmalos de a uno.')}
      <div class="stack mt">${groups.map(({ cart: c, data, quote }) => html`<section class="card cart-group">
        <div class="cart-group-head">${data?.business ? storeLogo(data.business) : ''}<strong class="grow">${data?.business?.name || 'Tienda no disponible'}</strong>
          <span class="price">${quote ? formatARS(quote.subtotal) : ''}</span></div>
        ${quote ? quote.lines.map(line => html`<div class="cart-line">${thumb(line.product?.image)}
          <span class="stack gap-xs"><strong>${line.product?.name || 'Producto no disponible'}${line.variant ? ` · ${line.variant.name}` : ''}</strong>
          <span class="small muted">${line.quantity} × ${formatARS(line.unitPrice)}</span></span><span></span></div>`) : html`<p class="card-pad muted">Esta tienda ya no está disponible.</p>`}
        <div class="card-pad row between"><button type="button" class="btn btn-ghost btn-sm" data-action="drop" data-business="${c.businessId}">${icon('trash', { size: 16 })}Vaciar</button>
          ${data?.business ? html`<a class="btn btn-primary btn-sm" href="#/checkout/${c.businessId}">Continuar con esta tienda</a>` : ''}</div>
      </section>`)}</div>`,
    mount(root) {
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action="drop"]');
        if (!el) return;
        if (!await ctx.dialog({ title: 'Vaciar este carrito', text: 'Se quitan los productos de esta tienda.', confirm: 'Vaciar', tone: 'danger' })) return;
        ctx.stores.writeCart({ businessId: el.getAttribute('data-business'), lines: [] });
        ctx.refresh();
      });
    },
  };
}

// ══════════ checkout ══════════
export async function checkout(ctx) {
  const businessId = ctx.params.businessId;
  let current = ctx.stores.readCart(businessId);
  if (!current.lines.length) return { redirect: '/carrito' };
  let data = await ctx.repo.cartCatalog(businessId, current.lines.map(l => l.productId));
  const business = data.business;
  if (!business) {
    return { chrome: 'shop', nav: '', title: 'Mi carrito', html: html`${pageHeader('Mi carrito')}
      ${emptyState({ scene: 'carrito-vacio', title: 'Esta tienda ya no está disponible', text: 'Podés vaciar este carrito y seguir explorando.',
        action: html`<button class="btn btn-secondary" type="button" data-action="drop">Vaciar carrito</button>` })}`,
    mount(root) { root.querySelector('[data-action="drop"]').addEventListener('click', () => { ctx.stores.writeCart({ businessId, lines: [] }); ctx.navigate('/carrito'); }); } };
  }
  const fairs = business.offersFairPickup ? data.fairs : [];
  const options = [
    ...fairs.map(f => ({ value: `fair:${f.id}`, fulfillment: 'fair_pickup', fairId: f.id, title: 'Retiro en feria',
      sub: `${f.name} · ${longDate(f.startsAt)} · ${timeRange(f.startsAt, f.endsAt)}${f.stall ? ` · Puesto ${f.stall}` : ''}` })),
    ...(business.pickupEnabled ? [{ value: 'pickup', fulfillment: 'pickup', title: 'Retiro acordado', sub: business.pickupArea || 'Coordinás el lugar con la tienda' }] : []),
    ...(business.deliveryEnabled ? [{ value: 'delivery', fulfillment: 'delivery', title: 'Envío a domicilio',
      sub: `${business.deliveryZone || 'Zona a consultar'} · envío ${feeText(business)}${business.minimumOrder ? ` · mínimo ${formatARS(business.minimumOrder)}` : ''}` }] : []),
  ];
  let selected = options[0]?.value || '';
  let payment = 'transfer';
  const account = ctx.session.kind === 'account' ? ctx.session.user : null;
  const quote = () => quoteCart(current, data.products);
  const option = () => options.find(o => o.value === selected);
  const fee = () => (option()?.fulfillment === 'delivery' && business.deliveryFee ? business.deliveryFee : 0);
  const count = cartCount(current);

  const linesHtml = q => q.lines.map(line => html`<div class="cart-line">
    ${thumb(line.product?.image)}
    <span class="stack gap-xs">
      <strong>${line.product?.name || 'Producto no disponible'}${line.variant ? ` · ${line.variant.name}` : ''}</strong>
      <span class="small muted">${business.name}</span>
      <span class="price">${formatARS(line.unitPrice)}</span>
      ${line.issue === 'out' ? html`<span class="field-error">Sin stock: quitalo para seguir.</span>` : ''}
      ${line.issue === 'short' ? html`<span class="field-error">Quedan ${line.available}: ajustá la cantidad.</span>` : ''}
      ${line.issue === 'unavailable' ? html`<span class="field-error">Ya no está disponible.</span>` : ''}
      ${line.issue === 'variant' ? html`<span class="field-error">Elegí una opción en el producto.</span>` : ''}
      ${line.product && line.issue !== 'unavailable' ? stepper({ value: line.quantity, min: 1, max: Math.max(1, Math.min(99, line.available ?? 99)), small: true,
    id: `${line.productId}|${line.variantId || ''}` }) : ''}
    </span>
    <button type="button" class="icon-btn" data-action="remove" data-id="${line.productId}|${line.variantId || ''}" aria-label="Quitar ${line.product?.name || 'producto'}">${icon('trash', { size: 20 })}</button>
  </div>`);
  const summaryHtml = q => html`<div class="summary">
    <div class="summary-row"><span>Productos</span><span>${formatARS(q.subtotal)}</span></div>
    ${option()?.fulfillment === 'delivery' ? html`<div class="summary-row"><span>Envío</span><span>${business.deliveryFee === null ? 'A coordinar' : formatARS(fee())}</span></div>` : ''}
    <div class="summary-row summary-total"><span>Total</span><span>${formatARS(q.subtotal + fee())}</span></div>
    ${option()?.fulfillment === 'delivery' && business.deliveryFee === null ? html`<p class="small muted">El costo del envío lo coordinás con la tienda.</p>` : ''}
  </div>`;

  return {
    chrome: 'shop', nav: '', title: 'Mi carrito',
    html: html`
      ${pageHeader(`Mi carrito (${count})`, { backHref: ctx.fromCart ? '' : '#/carrito' })}
      <div class="two-col mt">
        <div class="stack">
          <section class="card" aria-label="Productos" id="lines">${linesHtml(quote())}</section>
          <a class="link-more" href="#/tienda/${business.slug}">${icon('plus', { size: 16 })}Agregar más de ${business.name}</a>
          ${business.takingOrders ? '' : banner('warn', 'Esta tienda no está tomando pedidos por el momento', 'Guardamos tu carrito para más adelante.')}
          <form class="form" data-form="checkout" novalidate>
            <fieldset class="fieldset-reset stack">
              <legend class="section-title">¿Cómo querés recibirlo?</legend>
              ${options.length ? html`<div class="radio-cards">${options.map(o => html`<label class="radio-card">
                <input type="radio" name="fulfillment" value="${o.value}"${raw(o.value === selected ? ' checked' : '')}>
                <span><span class="radio-title">${o.title}</span><span class="radio-sub block">${o.sub}</span></span></label>`)}</div>`
    : banner('warn', 'La tienda no configuró formas de entrega', 'Escribile para coordinar.')}
            </fieldset>
            <div class="field" id="address-field"${raw(option()?.fulfillment === 'delivery' ? '' : ' hidden')}>
              <label for="co-address">Dirección de entrega</label><input id="co-address" name="address" class="input" autocomplete="street-address" maxlength="200" placeholder="Calle, número, barrio">
            </div>
            <fieldset class="fieldset-reset stack">
              <legend class="section-title">Tus datos</legend>
              <div class="field"><label for="co-name">Nombre y apellido</label><input id="co-name" name="name" class="input" autocomplete="name" maxlength="80" value="${account?.name || ''}" required></div>
              <div class="field"><label for="co-phone">Teléfono o WhatsApp</label><input id="co-phone" name="phone" class="input" type="tel" autocomplete="tel" maxlength="24" value="${account?.phone || ''}" required>
                <span class="field-hint">La tienda lo usa para coordinar la entrega.</span></div>
              <div class="field"><label for="co-email">Correo <span class="muted">(opcional)</span></label><input id="co-email" name="email" class="input" type="email" autocomplete="email" maxlength="120" value="${account?.email || ''}"></div>
              <div class="field"><label for="co-notes">Notas para la tienda <span class="muted">(opcional)</span></label><textarea id="co-notes" name="notes" class="textarea" rows="2" maxlength="280" placeholder="Color preferido, para regalo, horario…"></textarea></div>
            </fieldset>
            <fieldset class="fieldset-reset stack">
              <legend class="section-title">¿Cómo vas a pagar?</legend>
              <div class="radio-cards">
                <label class="radio-card"><input type="radio" name="payment" value="transfer" checked><span><span class="radio-title">Transferencia a la tienda</span>
                  <span class="radio-sub block">La tienda te pasa sus datos. CAUCE no recibe tu dinero.</span></span></label>
                <label class="radio-card"><input type="radio" name="payment" value="cash"><span><span class="radio-title">Efectivo</span>
                  <span class="radio-sub block">Pagás al retirar o al recibir.</span></span></label>
              </div>
            </fieldset>
            <p class="field-error" id="co-error" role="alert" hidden></p>
          </form>
        </div>
        <aside class="card card-pad stack sticky-aside">
          <div id="summary">${summaryHtml(quote())}</div>
          <button type="button" class="btn btn-primary btn-block" data-action="confirm"${attr('disabled', !business.takingOrders || !options.length)}>Confirmar pedido</button>
          <p class="xsmall muted center">Al confirmar, la tienda recibe tu pedido y te contacta. El pago se coordina directamente con ella.</p>
        </aside>
      </div>`,
    mount(root) {
      const sync = () => {
        const q = quote();
        root.querySelector('#lines').innerHTML = String(html`${linesHtml(q)}`);
        root.querySelector('#summary').innerHTML = String(summaryHtml(q));
        root.querySelector('#address-field').hidden = option()?.fulfillment !== 'delivery';
        if (!q.lines.length) ctx.navigate('/carrito', { replace: true });
      };
      const save = next => { current = ctx.stores.writeCart({ ...next, requestId: undefined }); sync(); };
      root.addEventListener('change', event => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        if (input.name === 'fulfillment') { selected = input.value; sync(); }
        if (input.name === 'payment') payment = input.value;
      });
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        const [productId, variantId] = String(el.getAttribute('data-id') || '').split('|');
        if (action === 'qty') {
          const line = current.lines.find(l => l.productId === productId && (l.variantId || '') === variantId);
          if (line) save(setQuantity(current, productId, variantId || null, line.quantity + Number(el.getAttribute('data-delta'))));
        }
        if (action === 'remove') save(removeFromCart(current, productId, variantId || null));
        if (action === 'confirm') await confirm(el);
      });

      async function confirm(button) {
        const form = /** @type {HTMLFormElement} */ (root.querySelector('[data-form="checkout"]'));
        const values = new FormData(form);
        const error = root.querySelector('#co-error');
        const show = message => { error.textContent = message; error.hidden = false; error.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
        const q = quote();
        const chosen = option();
        const contact = { name: clean(values.get('name'), 80), phone: clean(values.get('phone'), 24), email: clean(values.get('email'), 120),
          address: clean(values.get('address'), 200), notes: clean(values.get('notes'), 280) };
        if (!q.ready) return show('Revisá los productos marcados antes de confirmar.');
        if (!chosen) return show('Elegí cómo querés recibir tu pedido.');
        if (!isName(contact.name)) return show('Ingresá tu nombre.');
        if (!isPhone(contact.phone)) return show('Ingresá un teléfono válido para que la tienda te contacte.');
        if (contact.email && !isEmail(contact.email)) return show('Revisá el correo o dejalo vacío.');
        if (chosen.fulfillment === 'delivery' && contact.address.length < 5) return show('Ingresá la dirección de entrega.');
        if (chosen.fulfillment === 'delivery' && q.subtotal < business.minimumOrder) return show(`El mínimo para envío es ${formatARS(business.minimumOrder)}.`);
        error.hidden = true;
        // La misma clave en cada reintento: si el pedido ya llegó, la base devuelve el mismo.
        if (!current.requestId) current = ctx.stores.writeCart({ ...current, requestId: crypto.randomUUID() });
        button.classList.add('is-busy');
        try {
          const created = await ctx.repo.createOrder({ businessId, idem: current.requestId, fulfillment: chosen.fulfillment, paymentMethod: payment,
            fairId: chosen.fairId || null, contact: { ...contact, address: chosen.fulfillment === 'delivery' ? contact.address : '' },
            items: current.lines.map(l => ({ product_id: l.productId, variant_id: l.variantId || null, quantity: l.quantity })),
            expectedTotal: q.subtotal + fee() });
          ctx.stores.writeCart({ businessId, lines: [] });
          ctx.navigate(`/pedido/${created.trackingToken}?nuevo=1`);
        } catch (caught) {
          if (caught.code === 'PRICES_CHANGED' || caught.code === 'U0003' || caught.code === '23514') {
            data = await ctx.repo.cartCatalog(businessId, current.lines.map(l => l.productId)).catch(() => data);
            current = ctx.stores.writeCart({ ...current, requestId: undefined });
            sync();
          }
          show(caught.message);
        } finally { button.classList.remove('is-busy'); }
      }
    },
  };
}

// ══════════ seguimiento ══════════
function timelineHtml(order) {
  if (order.status === 'canceled') {
    return html`<ol class="timeline"><li class="is-done"><span class="dot">${icon('check', { size: 14, strokeWidth: 3 })}</span><span><span class="t-title">Enviado</span></span></li>
      <li class="is-current"><span class="dot">${icon('x', { size: 14, strokeWidth: 3 })}</span><span><span class="t-title">Cancelado</span>
      ${order.cancel_reason ? html`<span class="small muted block">${order.cancel_reason}</span>` : ''}</span></li></ol>`;
  }
  const steps = timelineSteps(order.fulfillment);
  const reached = new Map((order.history || []).map(h => [h.status, h.at]));
  const currentIndex = steps.indexOf(order.status);
  return html`<ol class="timeline">${steps.map((step, i) => {
    const state = i < currentIndex || (i === currentIndex && step === 'delivered') ? 'is-done' : i === currentIndex ? 'is-current' : '';
    return html`<li class="${state}"><span class="dot">${state === 'is-done' ? icon('check', { size: 14, strokeWidth: 3 }) : html`<span class="xsmall">${i + 1}</span>`}</span>
      <span><span class="t-title">${STATUS_LABEL[step]}</span>${reached.get(step) ? html`<span class="small muted block">${dateTime(reached.get(step))}</span>` : ''}</span></li>`;
  })}</ol>`;
}

export async function tracking(ctx) {
  const token = ctx.params.token;
  let order = await ctx.repo.trackOrder(token);
  const fresh = ctx.query.nuevo === '1';
  const link = `${ctx.repo.siteUrl || location.href.split('#')[0]}#/pedido/${token}`;
  const waText = o => `Hola ${o.business.name}, te hice el pedido ${o.code} por CAUCE · Ferias. Lo sigo acá: ${link}`;
  const body = o => html`
    ${fresh && o.status === 'submitted' ? html`<section class="empty">${raw(sofia('celebrando', { size: 220 }))}
      <h1 class="empty-title">¡Pedido enviado!</h1><p class="empty-text">${o.business.name} ya lo recibió. Guardá este enlace para seguirlo.</p></section>`
    : pageHeader(`Pedido ${o.code}`, { backHref: '#/mis-pedidos' })}
    <div class="two-col mt">
      <div class="stack">
        <section class="card card-pad stack">
          <div class="order-head"><span class="order-code">${o.code}</span>${statusPill(o.status)}</div>
          <p>${buyerMessage(o)}</p>
          ${timelineHtml(o)}
        </section>
        ${o.pickup && o.fulfillment === 'fair_pickup' ? html`<section class="card card-pad stack gap-sm">
          <h2 class="section-title">Dónde retirar</h2>
          ${o.pickup.fair_status === 'canceled' ? banner('error', 'La feria fue cancelada', 'Escribile a la tienda para coordinar otra entrega.', 'alert') : ''}
          <div class="fact">${icon('fairs')}<span><strong>${o.pickup.fair_name}</strong>${o.pickup.stall ? html` · Puesto <strong>${o.pickup.stall}</strong>` : ''}</span></div>
          ${o.pickup.starts_at ? html`<div class="fact">${icon('calendar')}<span class="first-cap">${longDate(o.pickup.starts_at)}${o.pickup.ends_at ? ` · ${timeRange(o.pickup.starts_at, o.pickup.ends_at)}` : ''}</span></div>` : ''}
          <div class="fact">${icon('pin')}${[o.pickup.venue, o.pickup.address].filter(Boolean).join(', ')}</div>
          <a class="btn btn-secondary btn-sm" href="${directionsUrl({ latitude: o.pickup.latitude, longitude: o.pickup.longitude, venue: o.pickup.venue, address: o.pickup.address })}" target="_blank" rel="noopener noreferrer">${icon('route', { size: 18 })}Cómo llegar</a>
        </section>` : ''}
        ${o.fulfillment === 'pickup' ? html`<section class="card card-pad stack gap-sm"><h2 class="section-title">Retiro acordado</h2>
          <p>${o.pickup?.area ? `Zona: ${o.pickup.area}. ` : ''}La tienda te escribe para coordinar el lugar y el horario.</p></section>` : ''}
        ${o.fulfillment === 'delivery' ? html`<section class="card card-pad stack gap-sm"><h2 class="section-title">Envío</h2>
          <div class="fact">${icon('truck')}${o.address}</div>${o.delivery_fee_pending ? html`<p class="small muted">El costo del envío se coordina con la tienda.</p>` : ''}</section>` : ''}
      </div>
      <div class="stack">
        <section class="card card-pad stack">
          <a class="seller" href="#/tienda/${o.business.slug}">${storeLogo(o.business)}<strong class="grow">${o.business.name}</strong>${icon('chevron-right', { size: 18 })}</a>
          <div class="row wrap">
            ${o.business.whatsapp ? html`<a class="btn btn-whatsapp btn-sm" href="${whatsappUrl(o.business.whatsapp, waText(o))}" target="_blank" rel="noopener noreferrer">${icon('whatsapp', { size: 18 })}${fresh ? 'Avisar por WhatsApp' : 'WhatsApp'}</a>` : ''}
            ${o.business.public_phone ? html`<a class="btn btn-secondary btn-sm" href="${telUrl(o.business.public_phone)}">${icon('phone', { size: 18 })}Llamar</a>` : ''}
          </div>
          <ul class="order-lines">${o.items.map(item => html`<li><span>${item.quantity} × ${item.product_name}${item.variant_name ? ` · ${item.variant_name}` : ''}${item.made_to_order ? ' (por encargo)' : ''}</span><span class="tnum">${formatARS(item.total_ars)}</span></li>`)}</ul>
          <div class="summary">
            ${o.fulfillment === 'delivery' ? html`<div class="summary-row"><span>Envío</span><span>${o.delivery_fee_pending ? 'A coordinar' : formatARS(o.delivery_fee_ars)}</span></div>` : ''}
            <div class="summary-row summary-total"><span>Total</span><span>${formatARS(o.total_ars)}</span></div>
          </div>
          <div class="fact small">${icon(o.payment_method === 'cash' ? 'cash' : 'transfer')}${PAYMENT_LABEL[o.payment_method]} · ${o.payment_status === 'paid' ? 'pago registrado por la tienda' : 'pago pendiente'}</div>
        </section>
        <section class="card card-pad stack gap-sm">
          <strong>Enlace de seguimiento</strong>
          <div class="share-url"><label class="sr-only" for="track-url">Enlace</label><input id="track-url" class="input" readonly value="${link}">
            <button type="button" class="btn btn-secondary btn-sm" data-action="copy">${icon('copy', { size: 18 })}Copiar</button></div>
          <span class="xsmall muted">Quien tenga este enlace ve el estado del pedido (no tus datos de contacto).</span>
        </section>
      </div>
    </div>`;
  return {
    chrome: 'shop', nav: '', title: `Pedido ${order.code}`,
    html: html`<div id="tracking">${body(order)}</div>`,
    mount(root) {
      root.addEventListener('click', async event => {
        if (!/** @type {HTMLElement} */ (event.target).closest('[data-action="copy"]')) return;
        try { await navigator.clipboard.writeText(link); ctx.toast('Enlace copiado'); } catch { /** @type {HTMLInputElement} */ (root.querySelector('#track-url')).select(); }
      });
      if (!isOpen(order)) return null;
      // Quien sólo tiene el enlace no recibe Realtime (RLS): se consulta cada 20 s.
      const timer = setInterval(async () => {
        if (document.hidden || !ctx.isCurrent()) return;
        try {
          const next = await ctx.repo.trackOrder(token);
          if (next.status !== order.status || next.payment_status !== order.payment_status) {
            order = next;
            root.querySelector('#tracking').innerHTML = String(body(order));
            ctx.toast(`Tu pedido ahora está: ${STATUS_LABEL[order.status]}`);
          }
        } catch { /* reintenta en la próxima vuelta */ }
      }, 20000);
      return () => clearInterval(timer);
    },
  };
}

// ══════════ mis pedidos ══════════
export async function myOrders(ctx) {
  const orders = ctx.session.kind === 'visitor' ? [] : await ctx.repo.myOrders();
  const card = o => html`<article class="card order-card reveal">
    <div class="order-head"><span class="row">${o.business ? storeLogo(o.business) : ''}<span class="stack gap-xs"><strong>${o.business?.name || 'Tienda'}</strong>
      <span class="small muted">${o.code} · ${relative(o.createdAt)}</span></span></span>${statusPill(o.status)}</div>
    <p class="small">${FULFILLMENT_LABEL[o.fulfillment]}${o.fulfillment === 'fair_pickup' && o.pickup.fairName ? ` · ${o.pickup.fairName}${o.pickup.stall ? ` · Puesto ${o.pickup.stall}` : ''}` : ''}</p>
    <ul class="order-lines">${o.lines.map(l => html`<li><span>${l.quantity} × ${l.name}</span><span class="tnum">${formatARS(l.total)}</span></li>`)}</ul>
    <div class="row between"><strong class="price">${formatARS(o.total)}</strong>
      <span class="row">${buyerCanCancel(o) ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="cancel" data-id="${o.id}">Cancelar</button>` : ''}
      <a class="btn btn-secondary btn-sm" href="#/pedido/${o.trackingToken}">Ver seguimiento</a></span></div>
  </article>`;
  const listHtml = list => (list.length ? html`<div class="stack">${list.map(card)}</div>` : emptyState({ scene: 'carrito-vacio', title: 'Sin pedidos por ahora',
    text: ctx.session.kind === 'account' ? 'Cuando hagas un pedido lo vas a ver acá.' : 'Los pedidos que hagas desde este dispositivo aparecen acá. Si compraste con tu cuenta, ingresá.',
    action: html`<div class="row wrap"><a class="btn btn-primary" href="#/explorar">Explorar productos</a>${ctx.session.kind === 'account' ? '' : html`<a class="btn btn-secondary" href="#/cuenta">Ingresar</a>`}</div>` }));
  let orderList = orders;
  return {
    chrome: 'shop', nav: '', title: 'Mis pedidos',
    html: html`${pageHeader('Mis pedidos')}<div class="mt" id="orders">${listHtml(orderList)}</div>`,
    mount(root) {
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action="cancel"]');
        if (!el) return;
        const order = orderList.find(o => o.id === el.getAttribute('data-id'));
        if (!order || !await ctx.dialog({ title: `Cancelar el pedido ${order.code}`, text: 'La tienda todavía no lo aceptó. ¿Querés cancelarlo?', confirm: 'Sí, cancelar', cancel: 'No', tone: 'danger' })) return;
        try { await ctx.repo.cancelMyOrder(order); ctx.toast('Pedido cancelado'); ctx.refresh(); } catch (error) { ctx.toast(error.message, 'error'); ctx.refresh(); }
      });
      if (!ctx.session.user) return null;
      const reload = async () => {
        if (!ctx.isCurrent()) return;
        orderList = await ctx.repo.myOrders().catch(() => orderList);
        root.querySelector('#orders').innerHTML = String(listHtml(orderList));
      };
      const stop = ctx.repo.subscribeOrders(`customer_id=eq.${ctx.session.user.id}`, reload);
      return stop;
    },
  };
}
