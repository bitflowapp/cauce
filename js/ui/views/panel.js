// Panel del comercio. Pensado para usarse desde el teléfono: botones grandes,
// mensajes claros y una lista de pasos mientras la tienda no está publicada.
// Los permisos los decide la base (owner, manager, staff); acá sólo se ocultan
// las acciones que de todas formas serían rechazadas.
import { html, raw, attr } from '../../core/html.js';
import { formatARS, parseARS } from '../../core/money.js';
import { longDate, timeRange, relative, dateTime } from '../../core/dates.js';
import { STATUS_LABEL, FULFILLMENT_LABEL, PAYMENT_LABEL, merchantActions, isOpen } from '../../core/order-status.js';
import { clean, cleanMultiline, normalizeWhatsapp, normalizeInstagram, isPhone, isEmail } from '../../core/validators.js';
import { stateInfo, planFeatures } from '../../core/plans.js';
import { whatsappUrl, telUrl, directionsUrl } from '../../core/links.js';
import { qrSvg } from '../../core/qr.js';
import { icon } from '../icons.js';
import { sofia } from '../sofia.js';
import { emptyState, storeLogo, placeholderArt, banner, statusPill, pageHeader, fairCard } from '../components.js';

const PANEL_KEY = 'ferias:panel-business:v1';
const SOUND_KEY = 'ferias:panel-sound:v1';
const ROLE_LABEL = { owner: 'Titular', manager: 'Encargado/a', staff: 'Ayudante' };
const BUSINESS_STATUS = { draft: 'Borrador', pending_review: 'En revisión', returned: 'Con cambios pedidos', active: 'Publicada', paused: 'Pausada', suspended: 'Suspendida' };
const STATUS_TEXT = {
  draft: ['terra', 'Tu tienda está en borrador', 'Completá los pasos y pedí la publicación.'],
  pending_review: ['', 'Estamos revisando tu tienda', 'Te avisamos cuando esté publicada. Mientras, podés seguir cargando productos.'],
  returned: ['warn', 'Tu tienda necesita algunos cambios', ''],
  paused: ['warn', 'Tu tienda está pausada', 'No aparece en CAUCE hasta que la reanudes.'],
  suspended: ['error', 'Tu tienda está suspendida', 'Escribí a la administración de CAUCE para revisarlo.'],
};

function readLocal(key, fallback = '') { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function writeLocal(key, value) { try { localStorage.setItem(key, value); } catch { /* sin almacenamiento */ } }

/** Tienda activa del panel: ?tienda=… o la última usada. */
function pickMembership(ctx) {
  const memberships = ctx.session.memberships;
  if (!memberships.length) return null;
  const wanted = ctx.query.tienda || readLocal(PANEL_KEY);
  const found = memberships.find(m => m.businessId === wanted) || memberships[0];
  writeLocal(PANEL_KEY, found.businessId);
  return found;
}

function gate(ctx) {
  if (ctx.session.kind !== 'account') return { redirect: '/cuenta?next=%2Fpanel' };
  if (!ctx.session.memberships.length) return { redirect: '/alta' };
  return null;
}

function sideNav(active, role) {
  const items = [['/panel', 'Inicio', 'home', 'inicio'], ['/panel/pedidos', 'Pedidos', 'orders', 'pedidos'],
    ...(role !== 'staff' ? [['/panel/productos', 'Productos', 'box', 'productos']] : []),
    ['/panel/inventario', 'Inventario', 'stock', 'inventario'],
    ...(role !== 'staff' ? [['/panel/tienda', 'Mi tienda', 'store', 'tienda'], ['/panel/ferias', 'Mis ferias', 'fairs', 'ferias'],
      ['/panel/estadisticas', 'Estadísticas', 'chart', 'estadisticas'], ['/panel/plan', 'Mi plan', 'tag', 'plan']] : []),
    ...(role === 'owner' ? [['/panel/equipo', 'Equipo', 'users', 'equipo']] : [])];
  return html`<nav class="panel-side" aria-label="Panel">${items.map(([href, label, iconName, key]) => html`<a href="#${href}"${raw(key === active ? ' aria-current="page"' : '')}>${icon(iconName, { size: 20 })}${label}</a>`)}</nav>`;
}

function shell(active, role, content) {
  return html`<div class="panel-layout">${sideNav(active, role)}<div class="panel-content">${content}</div></div>`;
}

const navKey = section => ({ pedidos: 'pedidos', productos: 'productos', producto: 'productos', ferias: 'ferias' }[section] || (section ? 'mas' : 'panel'));

// ══════════ inicio ══════════
export async function home(ctx) {
  const blocked = gate(ctx); if (blocked) return blocked;
  const member = pickMembership(ctx);
  const [panel, orders, participations] = await Promise.all([
    ctx.repo.panelBusiness(member.businessId),
    ctx.repo.panelOrders(member.businessId, { open: true }),
    member.role === 'staff' ? [] : ctx.repo.myParticipations(member.businessId).catch(() => []),
  ]);
  const { business, rights, missing, reviews } = panel;
  const pending = orders.filter(o => o.status === 'submitted').length;
  const upcoming = participations.filter(p => p.status === 'confirmed' && new Date(p.fair.endsAt) > new Date());
  const statusInfo = STATUS_TEXT[business.status];
  const returnedNote = business.status === 'returned' ? reviews.find(r => r.to_status === 'returned')?.note : '';
  const plan = stateInfo(rights.state);
  const steps = [
    { done: Boolean(business.logo && business.tagline), label: 'Logo y una frase de tu tienda', href: '/panel/tienda' },
    { done: !missing.includes('Nombre de quien atiende') && !missing.includes('Teléfono o WhatsApp de contacto'), label: 'Contacto para coordinar pedidos', href: '/panel/tienda#contacto' },
    { done: !missing.includes('Al menos una forma de entrega') && !missing.includes('Zona de envío'), label: 'Formas de entrega', href: '/panel/tienda#entregas' },
    { done: !missing.includes('Al menos un producto con foto'), label: 'Tu primer producto con foto', href: '/panel/producto/nuevo' },
    { done: !['draft', 'returned'].includes(business.status), label: 'Pedir la publicación', href: '' },
  ];
  const progress = Math.round((steps.filter(s => s.done).length / steps.length) * 100);
  const showSteps = ['draft', 'returned', 'pending_review'].includes(business.status);
  const others = ctx.session.memberships.filter(m => m.businessId !== member.businessId);

  return {
    chrome: 'panel', nav: 'panel', title: `Mi tienda · ${business.name}`, navBadges: pending ? { pedidos: pending } : {},
    html: shell('inicio', member.role, html`
      <div class="panel-head">${storeLogo(business)}<div class="grow"><p class="panel-head-kicker">Mi tienda · ${ROLE_LABEL[member.role]}</p>
        <p class="panel-head-name">${business.name}</p></div>
        ${business.status === 'active' ? html`<a class="link-more" href="#/tienda/${business.slug}">Ver tienda ${icon('chevron-right', { size: 16 })}</a>` : ''}</div>
      ${others.length ? html`<div class="chips mb">${ctx.session.memberships.map(m => html`<a class="chip${m.businessId === member.businessId ? ' is-active' : ''}" href="#/panel?tienda=${m.businessId}">${m.name}</a>`)}<a class="chip" href="#/alta?nueva=1">${icon('plus', { size: 16 })}Otra tienda</a></div>` : ''}
      <div class="stack">
        ${statusInfo ? banner(statusInfo[0], statusInfo[1], returnedNote ? `Nota de CAUCE: ${returnedNote}` : statusInfo[2], business.status === 'suspended' ? 'alert' : 'info') : ''}
        ${business.status === 'active' && rights.state === 'grace' ? banner('warn', 'Tu plan venció: estás en período de gracia', `Seguís vendiendo hasta el ${longDate(rights.grace_until)}. Renovalo con CAUCE para no cortar los pedidos.`, 'clock') : ''}
        ${business.status === 'active' && ['expired', 'canceled'].includes(rights.state) ? banner('error', 'Tu plan no está vigente', 'La tienda se ve, pero no recibe pedidos nuevos. Los pedidos abiertos los podés terminar.', 'alert') : ''}
        ${business.status === 'active' && !business.acceptingOrders ? banner('warn', 'Pausaste los pedidos', 'La tienda se ve, pero nadie puede comprar hasta que los actives en «Mi tienda».') : ''}
        ${showSteps && member.role !== 'staff' ? html`<section class="card card-pad stack onboarding-card">
          <div class="row"><div class="grow stack gap-xs"><strong>Preparemos tu tienda</strong><span class="small muted">${progress}% listo</span></div>${raw(sofia('creando', { size: 96, animated: true }))}</div>
          <div class="progress" aria-hidden="true"><span data-progress="${progress}"></span></div>
          <ul class="checklist">${steps.map(step => html`<li><span class="check-circle${step.done ? '' : ' is-pending'}">${icon('check', { size: 14, strokeWidth: 3 })}</span>
            ${step.href && !step.done ? html`<a href="#${step.href}">${step.label}</a>` : html`<span${raw(step.done ? ' class="muted"' : '')}>${step.label}</span>`}</li>`)}</ul>
          ${['draft', 'returned'].includes(business.status) ? html`
            ${missing.length ? html`<p class="small muted">Para publicar falta: ${missing.join(', ')}.</p>` : ''}
            <button type="button" class="btn btn-primary" data-action="submit"${attr('disabled', missing.length > 0)}>Pedir la publicación</button>` : ''}
        </section>` : ''}
        <div class="stats">
          <a class="stat${pending ? ' is-alert' : ''}" href="#/panel/pedidos"><span class="stat-value">${orders.length}</span><span class="stat-label">Pedidos abiertos</span></a>
          <a class="stat" href="#/panel/${member.role === 'staff' ? 'inventario' : 'productos'}"><span class="stat-value">${rights.products_used}</span><span class="stat-label">Productos</span></a>
          <a class="stat" href="#/panel/ferias"><span class="stat-value">${upcoming.length}</span><span class="stat-label">Próximas ferias</span></a>
        </div>
        <nav class="menu" aria-label="Secciones del panel">
          <a class="menu-item" href="#/panel/pedidos">${icon('orders')}<span>Pedidos</span>${pending ? html`<span class="menu-note">${pending === 1 ? '1 nuevo' : `${pending} nuevos`}</span>` : ''}${icon('chevron-right', { size: 18 })}</a>
          ${member.role !== 'staff' ? html`<a class="menu-item" href="#/panel/productos">${icon('box')}<span>Mis productos</span>${icon('chevron-right', { size: 18 })}</a>` : ''}
          <a class="menu-item" href="#/panel/inventario">${icon('stock')}<span>Inventario</span>${icon('chevron-right', { size: 18 })}</a>
          ${member.role !== 'staff' ? html`
            <a class="menu-item" href="#/panel/ferias">${icon('fairs')}<span>Mis ferias</span>${upcoming.length ? html`<span class="menu-note">${upcoming.length} próximas</span>` : ''}${icon('chevron-right', { size: 18 })}</a>
            <a class="menu-item" href="#/panel/estadisticas">${icon('chart')}<span>Estadísticas</span>${icon('chevron-right', { size: 18 })}</a>
            <a class="menu-item" href="#/panel/tienda">${icon('edit')}<span>Editar mi tienda</span>${icon('chevron-right', { size: 18 })}</a>
            <a class="menu-item" href="#/panel/tienda#compartir">${icon('qr')}<span>Compartir tienda (QR y enlace)</span>${icon('chevron-right', { size: 18 })}</a>
            <a class="menu-item" href="#/panel/plan">${icon('tag')}<span>Mi plan</span><span class="menu-note">${rights.plan_name || plan.label}</span>${icon('chevron-right', { size: 18 })}</a>` : ''}
          ${member.role === 'owner' ? html`<a class="menu-item" href="#/panel/equipo">${icon('users')}<span>Equipo</span>${icon('chevron-right', { size: 18 })}</a>` : ''}
        </nav>
      </div>`),
    mount(root) {
      const bar = /** @type {HTMLElement} */ (root.querySelector('[data-progress]'));
      if (bar) requestAnimationFrame(() => { bar.style.width = `${bar.getAttribute('data-progress')}%`; });
      root.querySelector('[data-action="submit"]')?.addEventListener('click', async event => {
        const button = /** @type {HTMLElement} */ (event.currentTarget);
        button.classList.add('is-busy');
        try { await ctx.repo.submitForReview(business.id); ctx.toast('¡Enviada! La administración revisa tu tienda.', 'ok'); ctx.refresh(); }
        catch (error) { ctx.toast(error.message, 'error'); } finally { button.classList.remove('is-busy'); }
      });
    },
  };
}

// ══════════ despachador de secciones ══════════
export async function section(ctx) {
  const blocked = gate(ctx); if (blocked) return blocked;
  const member = pickMembership(ctx);
  const name = ctx.params.section;
  const views = { pedidos: orders, productos: products, producto: productForm, inventario: inventory, tienda: storeForm,
    ferias: fairs, estadisticas: stats, plan: planView, equipo: team, mas: more };
  const view = views[name];
  if (!view) return { redirect: '/panel' };
  const result = await view(ctx, member);
  return { chrome: 'panel', nav: navKey(name), ...result };
}

// ══════════ pedidos ══════════
/** @type {Array<[string, string, (o: any) => boolean]>} */
const FILTERS = [['nuevos', 'Nuevos', o => o.status === 'submitted'], ['curso', 'En curso', o => ['accepted', 'preparing'].includes(o.status)],
  ['listos', 'Listos', o => ['ready', 'on_the_way'].includes(o.status)], ['cerrados', 'Cerrados', o => !isOpen(o)]];

function beep() {
  try {
    const AudioCtx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    const audio = new AudioCtx();
    [0, 0.18].forEach(offset => {
      const osc = audio.createOscillator(); const gain = audio.createGain();
      osc.frequency.value = offset ? 880 : 660; gain.gain.setValueAtTime(0.0001, audio.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + offset + 0.16);
      osc.connect(gain).connect(audio.destination); osc.start(audio.currentTime + offset); osc.stop(audio.currentTime + offset + 0.18);
    });
    setTimeout(() => audio.close(), 800);
  } catch { /* sin audio */ }
}

function orderCard(o) {
  const actions = merchantActions(o);
  const pickup = o.fulfillment === 'fair_pickup' ? `${o.pickup.fairName}${o.pickup.stall ? ` · Puesto ${o.pickup.stall}` : ''}${o.pickup.startsAt ? ` · ${longDate(o.pickup.startsAt)}` : ''}` : '';
  const wa = whatsappUrl(normalizeWhatsapp(o.contact.phone), `Hola ${o.contact.name.split(' ')[0]}, te escribo de la tienda por tu pedido ${o.code} en CAUCE · Ferias.`);
  return html`<article class="card order-card" data-order="${o.id}">
    <div class="order-head"><span class="stack gap-xs"><span class="order-code">${o.code}</span><span class="small muted">${relative(o.createdAt)} · ${dateTime(o.createdAt)}</span></span>${statusPill(o.status)}</div>
    <div class="kv">
      <dt>Cliente</dt><dd>${o.contact.name}</dd>
      <dt>Teléfono</dt><dd><a href="${telUrl(o.contact.phone)}">${o.contact.phone}</a></dd>
      ${o.contact.email ? html`<dt>Correo</dt><dd>${o.contact.email}</dd>` : ''}
      <dt>Entrega</dt><dd>${FULFILLMENT_LABEL[o.fulfillment]}${pickup ? html`<span class="block small muted">${pickup}</span>` : ''}${o.contact.address ? html`<span class="block small muted">${o.contact.address}</span>` : ''}</dd>
      <dt>Pago</dt><dd>${PAYMENT_LABEL[o.paymentMethod]} · ${o.paymentStatus === 'paid' ? html`<span class="tag tag-ok">Cobrado</span>` : html`<span class="tag tag-warn">Pendiente</span>`}</dd>
      ${o.contact.notes ? html`<dt>Notas</dt><dd class="pre-line">${o.contact.notes}</dd>` : ''}
      ${o.cancelReason ? html`<dt>Motivo</dt><dd>${o.cancelReason}</dd>` : ''}
    </div>
    <ul class="order-lines">${o.lines.map(l => html`<li><span>${l.quantity} × ${l.name}${l.madeToOrder ? ' (por encargo)' : ''}</span><span class="tnum">${formatARS(l.total)}</span></li>`)}
      ${o.fulfillment === 'delivery' ? html`<li><span>Envío</span><span class="tnum">${o.deliveryFeePending ? 'A coordinar' : formatARS(o.deliveryFee)}</span></li>` : ''}
      <li class="strong"><span>Total</span><span class="tnum">${formatARS(o.total)}</span></li></ul>
    <div class="order-actions">
      ${actions.map(a => html`<button type="button" class="btn btn-${a.tone} btn-sm" data-action="transition" data-next="${a.next}" data-id="${o.id}">${a.label}</button>`)}
      ${o.status !== 'canceled' ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="paid" data-id="${o.id}" data-paid="${o.paymentStatus === 'paid' ? '0' : '1'}">${icon('cash', { size: 16 })}${o.paymentStatus === 'paid' ? 'Marcar pago pendiente' : 'Registrar cobro'}</button>` : ''}
      ${wa ? html`<a class="btn btn-whatsapp btn-sm" href="${wa}" target="_blank" rel="noopener noreferrer">${icon('whatsapp', { size: 16 })}WhatsApp</a>` : ''}
    </div>
  </article>`;
}

async function orders(ctx, member) {
  let list = await ctx.repo.panelOrders(member.businessId);
  let filter = FILTERS.some(([key]) => key === ctx.query.f) ? ctx.query.f : (list.some(o => o.status === 'submitted') ? 'nuevos' : 'curso');
  let sound = readLocal(SOUND_KEY, '1') === '1';
  const counts = () => Object.fromEntries(FILTERS.map(([key, , test]) => [key, list.filter(test).length]));
  const listHtml = () => {
    const [, , test] = FILTERS.find(([key]) => key === filter);
    const visible = list.filter(test);
    return visible.length ? html`<div class="stack">${visible.map(orderCard)}</div>`
      : emptyState({ scene: 'preparando', title: filter === 'nuevos' ? 'Sin pedidos nuevos' : 'Nada por acá', text: filter === 'nuevos' ? 'Cuando llegue un pedido, suena un aviso y aparece acá.' : 'Probá con otra pestaña.' });
  };
  const tabsHtml = () => { const c = counts(); return html`${FILTERS.map(([key, label]) => html`<button type="button" data-action="filter" data-f="${key}" aria-pressed="${key === filter ? 'true' : 'false'}">${label}${c[key] ? ` (${c[key]})` : ''}</button>`)}`; };
  return {
    title: 'Pedidos',
    navBadges: counts().nuevos ? { pedidos: counts().nuevos } : {},
    html: shell('pedidos', member.role, html`
      ${pageHeader('Pedidos', { backHref: '#/panel', actions: html`<button type="button" class="icon-btn solid" data-action="sound" aria-pressed="${sound ? 'true' : 'false'}" aria-label="${sound ? 'Silenciar avisos' : 'Activar sonido de avisos'}">${icon('bell')}</button>` })}
      <div class="board-filters"><div class="segmented" role="group" aria-label="Filtrar pedidos" id="order-tabs">${tabsHtml()}</div></div>
      <p class="small muted" id="live-note" aria-live="polite">${icon('refresh', { size: 14 })} Se actualiza solo cuando entra o cambia un pedido.</p>
      <div id="order-list" class="mt">${listHtml()}</div>`),
    mount(root) {
      const paint = () => {
        root.querySelector('#order-list').innerHTML = String(listHtml());
        root.querySelector('#order-tabs').innerHTML = String(tabsHtml());
        const pending = counts().nuevos;
        document.title = `${pending ? `(${pending}) ` : ''}Pedidos · CAUCE Ferias`;
      };
      const reload = async ({ degraded = false } = {}) => {
        if (!ctx.isCurrent()) return;
        const before = new Set(list.filter(o => o.status === 'submitted').map(o => o.id));
        list = await ctx.repo.panelOrders(member.businessId).catch(() => list);
        const fresh = list.filter(o => o.status === 'submitted' && !before.has(o.id));
        if (fresh.length) {
          ctx.toast(fresh.length === 1 ? `¡Nuevo pedido ${fresh[0].code}!` : `${fresh.length} pedidos nuevos`, 'ok');
          if (sound) beep();
          navigator.vibrate?.([120, 80, 120]);
        }
        if (degraded) root.querySelector('#live-note').textContent = 'Sin conexión en vivo: revisamos cada 30 segundos.';
        paint();
      };
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        if (action === 'filter') { filter = el.getAttribute('data-f'); paint(); return; }
        if (action === 'sound') {
          sound = !sound; writeLocal(SOUND_KEY, sound ? '1' : '0');
          el.setAttribute('aria-pressed', String(sound)); el.setAttribute('aria-label', sound ? 'Silenciar avisos' : 'Activar sonido de avisos');
          if (sound) beep();
          ctx.toast(sound ? 'Sonido de pedidos activado' : 'Sonido de pedidos silenciado');
          return;
        }
        const order = list.find(o => o.id === el.getAttribute('data-id'));
        if (!order) return;
        if (action === 'transition') {
          const next = el.getAttribute('data-next');
          let reason = '';
          if (next === 'canceled') {
            const answer = await ctx.dialog({ title: order.status === 'submitted' ? `Rechazar ${order.code}` : `Cancelar ${order.code}`,
              text: 'Contale a la persona por qué. Lo va a ver en su seguimiento.', confirm: order.status === 'submitted' ? 'Rechazar pedido' : 'Cancelar pedido', tone: 'danger',
              input: { label: 'Motivo', required: true, min: 3, placeholder: 'Ej.: se agotó la pieza, no llego a la feria…' } });
            if (answer === false) return;
            reason = String(answer);
          }
          el.classList.add('is-busy');
          try { await ctx.repo.transitionOrder(order, next, reason); ctx.toast(`${order.code}: ${STATUS_LABEL[next]}`, 'ok'); }
          catch (error) { ctx.toast(error.message, 'error'); }
          finally { await reload(); }
        }
        if (action === 'paid') {
          const paid = el.getAttribute('data-paid') === '1';
          if (paid && !await ctx.dialog({ title: `Registrar el cobro de ${order.code}`, text: `Confirmá que recibiste ${formatARS(order.total)} (${PAYMENT_LABEL[order.paymentMethod].toLowerCase()}). CAUCE no verifica pagos: lo registrás vos.`, confirm: 'Sí, lo cobré' })) return;
          el.classList.add('is-busy');
          try { await ctx.repo.setOrderPayment(order, paid); ctx.toast(paid ? 'Cobro registrado' : 'Pago marcado como pendiente', 'ok'); }
          catch (error) { ctx.toast(error.message, 'error'); }
          finally { await reload(); }
        }
      });
      paint();
      const stop = ctx.repo.subscribeOrders(`business_id=eq.${member.businessId}`, reload);
      const poll = setInterval(() => { if (!document.hidden) reload(); }, 30000);
      return () => { stop(); clearInterval(poll); document.title = 'CAUCE · Ferias Neuquén'; };
    },
  };
}

// ══════════ productos ══════════
async function products(ctx, member) {
  if (member.role === 'staff') return { redirect: '/panel/inventario' };
  const archived = ctx.query.archivados === '1';
  const [list, panel, ref] = await Promise.all([ctx.repo.panelProducts(member.businessId, { archived }), ctx.repo.panelBusiness(member.businessId), ctx.repo.referenceData()]);
  const { rights } = panel;
  const full = rights.products_used >= rights.max_products;
  return {
    title: 'Mis productos',
    html: shell('productos', member.role, html`
      ${pageHeader('Mis productos', { backHref: '#/panel', actions: html`<a class="btn btn-primary btn-sm${full ? ' is-disabled' : ''}" href="#/panel/producto/nuevo"${raw(full ? ' aria-disabled="true"' : '')}>${icon('plus', { size: 18 })}Nuevo</a>` })}
      <div class="row between wrap mt">
        <div class="segmented"><a href="#/panel/productos"${raw(archived ? '' : ' aria-current="page"')}>Publicados</a><a href="#/panel/productos?archivados=1"${raw(archived ? ' aria-current="page"' : '')}>Archivados</a></div>
        <span class="small muted">${rights.products_used} de ${rights.max_products} productos de tu plan</span>
      </div>
      ${full && !archived ? html`<div class="mt">${banner('warn', 'Llegaste al máximo de tu plan', 'Archivá productos que ya no vendés o pedí un plan con más lugar.')}</div>` : ''}
      ${list.length ? html`<div class="card mt">${list.map(p => html`<a class="list-row" href="#/panel/producto/${p.id}">
        <span class="thumb">${p.image ? html`<img src="${p.image}" alt="" width="56" height="56" loading="lazy">` : placeholderArt(ref.categoryById.get(p.categoryId)?.icon)}</span>
        <span class="grow stack gap-xs"><strong>${p.name}</strong><span class="small muted">${formatARS(p.price)} · ${p.madeToOrder ? 'por encargo' : p.trackStock ? `stock ${p.stock}` : 'sin control de stock'}${p.variants.length ? ` · ${p.variants.length} variantes` : ''}</span>
          <span class="row wrap gap-xs">${!p.available ? html`<span class="tag tag-error">Oculto</span>` : ''}${p.featured ? html`<span class="tag tag-terra">Destacado</span>` : ''}${!p.images.length ? html`<span class="tag tag-warn">Sin foto</span>` : ''}${p.trackStock && p.stock === 0 && !p.madeToOrder ? html`<span class="tag tag-error">Agotado</span>` : ''}</span></span>
        ${icon('chevron-right', { size: 18 })}</a>`)}</div>`
    : emptyState({ scene: 'creando', title: archived ? 'Nada archivado' : 'Cargá tu primer producto', text: archived ? 'Los productos que archives quedan acá.' : 'Una foto linda, un precio y listo. Lo podés hacer desde el teléfono.',
      action: archived ? '' : html`<a class="btn btn-primary" href="#/panel/producto/nuevo">${icon('camera', { size: 18 })}Cargar producto</a>` })}`),
  };
}

// ══════════ formulario de producto ══════════
async function productForm(ctx, member) {
  if (member.role === 'staff') return { redirect: '/panel/inventario' };
  const isNew = !ctx.params.id || ctx.params.id === 'nuevo';
  const [panel, ref, product] = await Promise.all([ctx.repo.panelBusiness(member.businessId), ctx.repo.referenceData(),
    isNew ? null : ctx.repo.panelProduct(ctx.params.id)]);
  const { business, rights } = panel;
  const p = product || { name: '', description: '', materials: '', price: null, categoryId: business.categoryId, trackStock: true, stock: 1, madeToOrder: false,
    productionMin: null, productionMax: null, handmade: true, available: true, featured: false, images: [], allVariants: [] };
  let images = p.images.map(i => ({ ...i }));
  const removed = [];
  let fresh = [];
  let variants = p.allVariants.filter(v => v.active).map(v => ({ ...v }));
  const maxImages = rights.max_images;
  const imagesHtml = () => html`${images.map((image, i) => html`<div class="image-slot">
      <img src="${image.url}" alt="Foto ${i + 1}" width="120" height="120">
      ${i === 0 ? html`<span class="tag tag-terra slot-cover">Portada</span>` : ''}
      <span class="slot-actions">${i > 0 ? html`<button type="button" data-action="cover" data-i="${i}" aria-label="Usar como portada">${icon('star', { size: 16 })}</button>` : ''}
        <button type="button" data-action="drop-image" data-i="${i}" aria-label="Quitar foto ${i + 1}">${icon('x', { size: 16 })}</button></span></div>`)}
    ${fresh.map((file, i) => html`<div class="image-slot"><img src="${file.preview}" alt="Foto nueva ${i + 1}" width="120" height="120">
      ${!images.length && i === 0 ? html`<span class="tag tag-terra slot-cover">Portada</span>` : ''}
      <span class="slot-actions"><button type="button" data-action="drop-fresh" data-i="${i}" aria-label="Quitar foto nueva ${i + 1}">${icon('x', { size: 16 })}</button></span></div>`)}
    ${images.length + fresh.length < maxImages ? html`<label class="image-slot">${icon('camera', { size: 26 })}<span>Agregar foto</span>
      <input type="file" accept="image/jpeg,image/png,image/webp" multiple data-input="images"></label>` : ''}`;
  const variantsHtml = () => (variants.length ? html`${variants.map((v, i) => html`<div class="variant-row">
      <div class="field"><label for="v-name-${i}">Opción</label><input id="v-name-${i}" class="input" data-variant="${i}" data-key="name" value="${v.name}" maxlength="40" placeholder="Ej.: Grande, Azul"></div>
      <div class="field"><label for="v-delta-${i}">± precio</label><input id="v-delta-${i}" class="input" data-variant="${i}" data-key="priceDelta" inputmode="numeric" value="${v.priceDelta || 0}"></div>
      <div class="field"><label for="v-stock-${i}">Stock</label><input id="v-stock-${i}" class="input" data-variant="${i}" data-key="stock" inputmode="numeric" value="${v.stock ?? 0}"></div>
      <button type="button" class="icon-btn" data-action="drop-variant" data-i="${i}" aria-label="Quitar opción ${v.name || i + 1}">${icon('trash', { size: 20 })}</button></div>`)}` : html`<p class="small muted">Sin variantes: se vende una sola versión.</p>`);
  return {
    title: isNew ? 'Nuevo producto' : `Editar ${p.name}`,
    html: shell('productos', member.role, html`
      ${pageHeader(isNew ? 'Nuevo producto' : 'Editar producto', { backHref: '#/panel/productos' })}
      <form class="form mt" data-form="product" novalidate>
        <section class="card card-pad stack">
          <div class="row between"><h2 class="section-title">Fotos</h2><span class="small muted">Hasta ${maxImages} con tu plan</span></div>
          <div class="image-uploader" id="images">${imagesHtml()}</div>
          <p class="field-hint">Las achicamos antes de subir para que carguen rápido. La primera es la portada.</p>
        </section>
        <section class="card card-pad stack">
          <div class="field"><label for="pr-name">Nombre</label><input id="pr-name" name="name" class="input" maxlength="80" value="${p.name}" required placeholder="Ej.: Taza patagónica"></div>
          <div class="grid-2">
            <div class="field"><label for="pr-price">Precio</label><div class="input-group"><span class="addon">$</span><input id="pr-price" name="price" class="input" inputmode="numeric" value="${p.price ?? ''}" required placeholder="12500"></div></div>
            <div class="field"><label for="pr-cat">Rubro</label><select id="pr-cat" name="category" class="select">${ref.categories.map(c => html`<option value="${c.id}"${raw(c.id === p.categoryId ? ' selected' : '')}>${c.name}</option>`)}</select></div>
          </div>
          <div class="field"><label for="pr-desc">Descripción</label><textarea id="pr-desc" name="description" class="textarea" maxlength="1000" rows="4" placeholder="Contá cómo está hecho, medidas, cuidados…">${p.description}</textarea></div>
          <div class="field"><label for="pr-mat">Materiales <span class="muted">(opcional)</span></label><input id="pr-mat" name="materials" class="input" maxlength="160" value="${p.materials}" placeholder="Ej.: gres esmaltado, lana de oveja"></div>
          <label class="check"><input type="checkbox" name="handmade"${raw(p.handmade ? ' checked' : '')}> Hecho a mano</label>
        </section>
        <section class="card card-pad stack">
          <fieldset class="fieldset-reset stack"><legend class="section-title">Disponibilidad</legend>
            <div class="radio-cards">
              <label class="radio-card"><input type="radio" name="mode" value="stock"${raw(!p.madeToOrder ? ' checked' : '')}><span><span class="radio-title">Tengo unidades listas</span><span class="radio-sub block">Se descuentan solas con cada pedido.</span></span></label>
              <label class="radio-card"><input type="radio" name="mode" value="encargo"${raw(p.madeToOrder ? ' checked' : '')}><span><span class="radio-title">Lo hago por encargo</span><span class="radio-sub block">Sin stock: lo elaborás después del pedido.</span></span></label>
            </div></fieldset>
          <div class="field" id="stock-field"${raw(p.madeToOrder || variants.length ? ' hidden' : '')}><label for="pr-stock">Unidades disponibles</label><input id="pr-stock" name="stock" class="input" inputmode="numeric" value="${p.stock ?? 0}"></div>
          <div class="grid-2" id="production-field">
            <div class="field"><label for="pr-min">Elaboración: días mínimos <span class="muted">(opcional)</span></label><input id="pr-min" name="productionMin" class="input" inputmode="numeric" value="${p.productionMin ?? ''}"></div>
            <div class="field"><label for="pr-max">Días máximos</label><input id="pr-max" name="productionMax" class="input" inputmode="numeric" value="${p.productionMax ?? ''}"></div>
          </div>
        </section>
        <section class="card card-pad stack">
          <div class="row between"><h2 class="section-title">Variantes</h2><button type="button" class="btn btn-secondary btn-sm" data-action="add-variant">${icon('plus', { size: 16 })}Agregar opción</button></div>
          <p class="field-hint">Tamaños, colores o diseños. Cada opción tiene su propio stock.</p>
          <div class="stack" id="variants">${variantsHtml()}</div>
        </section>
        <section class="card card-pad stack">
          <label class="switch"><span><strong>Visible en la tienda</strong><span class="small muted block">Si lo apagás, queda guardado pero nadie lo ve.</span></span><input type="checkbox" name="available"${raw(p.available ? ' checked' : '')}></label>
          <label class="switch"><span><strong>Destacado</strong><span class="small muted block">Aparece primero en tu tienda y puede salir en el inicio.</span></span><input type="checkbox" name="featured"${raw(p.featured ? ' checked' : '')}></label>
        </section>
        <p class="field-error" id="pr-error" role="alert" hidden></p>
        <div class="buy-bar">
          ${isNew ? '' : html`<button type="button" class="btn btn-secondary" data-action="archive">${p.archived ? 'Restaurar' : 'Archivar'}</button>`}
          <button class="btn btn-primary" type="submit">${isNew ? 'Publicar producto' : 'Guardar cambios'}</button>
        </div>
      </form>`),
    mount(root) {
      const form = /** @type {HTMLFormElement} */ (root.querySelector('[data-form="product"]'));
      const paintImages = () => { root.querySelector('#images').innerHTML = String(imagesHtml()); };
      const paintVariants = () => {
        root.querySelector('#variants').innerHTML = String(variantsHtml());
        root.querySelector('#stock-field').hidden = /** @type {HTMLInputElement} */ (form.elements.namedItem('mode')).value === 'encargo' || variants.length > 0;
      };
      root.addEventListener('change', event => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        if (input.getAttribute('data-input') === 'images') {
          const room = maxImages - images.length - fresh.length;
          const files = [...(input.files || [])].filter(f => ['image/jpeg', 'image/png', 'image/webp'].includes(f.type));
          if (files.length > room) ctx.toast(`Tu plan admite ${maxImages} fotos por producto: sumamos las primeras ${room}.`);
          fresh = [...fresh, ...files.slice(0, Math.max(0, room)).map(file => Object.assign(file, { preview: URL.createObjectURL(file) }))];
          paintImages();
        }
        if (input.name === 'mode') paintVariants();
      });
      root.addEventListener('input', event => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const index = input.getAttribute('data-variant');
        if (index !== null) variants[Number(index)][input.getAttribute('data-key')] = input.value;
      });
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        const i = Number(el.getAttribute('data-i'));
        if (action === 'drop-image') { removed.push(images[i]); images.splice(i, 1); paintImages(); }
        if (action === 'drop-fresh') { URL.revokeObjectURL(fresh[i].preview); fresh.splice(i, 1); paintImages(); }
        if (action === 'cover') { const [chosen] = images.splice(i, 1); images.unshift(chosen); paintImages(); }
        if (action === 'add-variant') { if (variants.length >= 12) { ctx.toast('Hasta 12 opciones por producto.'); return; } variants.push({ name: '', priceDelta: 0, stock: 0 }); paintVariants(); root.querySelector(`#v-name-${variants.length - 1}`)?.focus(); }
        if (action === 'drop-variant') { variants.splice(i, 1); paintVariants(); }
        if (action === 'archive') {
          const archive = !p.archived;
          if (archive && !await ctx.dialog({ title: 'Archivar producto', text: 'Deja de verse en tu tienda. Lo podés restaurar cuando quieras.', confirm: 'Archivar' })) return;
          try { await ctx.repo.archiveProduct(p.id, archive); ctx.toast(archive ? 'Producto archivado' : 'Producto restaurado', 'ok'); ctx.navigate(`/panel/productos${archive ? '' : ''}`); }
          catch (error) { ctx.toast(error.message, 'error'); }
        }
      });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const data = new FormData(form);
        const error = root.querySelector('#pr-error');
        const show = message => { error.textContent = message; error.hidden = false; error.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
        const price = parseARS(data.get('price'));
        const madeToOrder = data.get('mode') === 'encargo';
        const productionMin = parseARS(data.get('productionMin'));
        const productionMax = parseARS(data.get('productionMax'));
        const name = clean(data.get('name'), 80);
        const cleanVariants = variants.map((v, index) => ({ ...v, name: clean(v.name, 40), priceDelta: Number(String(v.priceDelta).replace(/[^0-9-]/g, '')) || 0,
          stock: parseARS(v.stock) || 0, position: index }));
        if (name.length < 2) return show('Escribí el nombre del producto.');
        if (!price || price <= 0) return show('Poné un precio en pesos (sólo números).');
        if (!images.length && !fresh.length) return show('Agregá al menos una foto: es lo primero que se ve.');
        if (cleanVariants.some(v => !v.name)) return show('Cada opción necesita un nombre (o quitala).');
        if (new Set(cleanVariants.map(v => v.name.toLowerCase())).size !== cleanVariants.length) return show('Hay opciones con el mismo nombre.');
        if (cleanVariants.some(v => price + v.priceDelta <= 0)) return show('Con el ajuste, alguna opción queda sin precio.');
        if (productionMin && productionMax && productionMax < productionMin) return show('Los días máximos no pueden ser menos que los mínimos.');
        error.hidden = true;
        const variantOps = [...p.allVariants.filter(v => v.active && !cleanVariants.some(c => c.id === v.id)).map(v => ({ id: v.id, remove: true })), ...cleanVariants];
        const button = form.querySelector('button[type="submit"]');
        button.classList.add('is-busy');
        try {
          const id = await ctx.repo.saveProduct(member.businessId, { id: product?.id, name, price, categoryId: String(data.get('category')),
            description: cleanMultiline(data.get('description'), 1000), materials: clean(data.get('materials'), 160), handmade: Boolean(data.get('handmade')),
            madeToOrder, trackStock: !madeToOrder, stock: parseARS(data.get('stock')) || 0, productionMin, productionMax,
            available: Boolean(data.get('available')), featured: Boolean(data.get('featured')) },
          { variants: variantOps, newImages: fresh, removedImages: removed, imageOrder: images.map(i => i.id) });
          fresh.forEach(f => URL.revokeObjectURL(f.preview));
          ctx.toast(isNew ? '¡Producto publicado en tu tienda!' : 'Cambios guardados', 'ok');
          ctx.navigate(isNew ? '/panel/productos' : `/panel/producto/${id}`, { replace: !isNew });
        } catch (caught) { show(caught.message); } finally { button.classList.remove('is-busy'); }
      });
    },
  };
}

// ══════════ inventario ══════════
async function inventory(ctx, member) {
  let list = await ctx.repo.panelProducts(member.businessId);
  const rowHtml = (p, v = null) => {
    const stock = v ? v.stock : p.stock;
    const id = `${p.id}|${v?.id || ''}`;
    return html`<div class="list-row">
      ${v ? html`<span class="thumb thumb-variant" aria-hidden="true">${icon('tag', { size: 20 })}</span>` : html`<span class="thumb">${p.image ? html`<img src="${p.image}" alt="" width="56" height="56" loading="lazy">` : placeholderArt()}</span>`}
      <span class="grow stack gap-xs"><strong>${v ? v.name : p.name}</strong><span class="small muted">${v ? p.name : (p.madeToOrder ? 'Por encargo' : !p.trackStock ? 'Sin control de stock' : p.variants.length ? 'Stock total de las opciones' : '')}</span></span>
      ${p.trackStock && (v || !p.variants.length) ? html`<span class="stepper sm" role="group" aria-label="Stock de ${v ? `${p.name} ${v.name}` : p.name}">
        <button type="button" data-action="stock" data-delta="-1" data-id="${id}" aria-label="Restar uno"${attr('disabled', stock <= 0)}>${icon('minus', { size: 16 })}</button>
        <output>${stock}</output><button type="button" data-action="stock" data-delta="1" data-id="${id}" aria-label="Sumar uno">${icon('plus', { size: 16 })}</button></span>`
    : p.trackStock ? html`<span class="tag">${stock}</span>` : ''}
      ${!v ? html`<label class="switch switch-inline"><span class="sr-only">Visible ${p.name}</span><input type="checkbox" data-action="visible" data-id="${p.id}"${raw(p.available ? ' checked' : '')}></label>` : ''}
    </div>`;
  };
  const listHtml = () => (list.length ? html`<div class="card">${list.map(p => html`${rowHtml(p)}${p.trackStock ? p.variants.map(v => rowHtml(p, v)) : ''}`)}</div>`
    : emptyState({ scene: 'creando', title: 'Todavía no hay productos', text: 'Cuando cargues productos, ajustás el stock desde acá.' }));
  return {
    title: 'Inventario',
    html: shell('inventario', member.role, html`
      ${pageHeader('Inventario', { backHref: '#/panel' })}
      <p class="small muted mt">Sumá o restá unidades con un toque. El interruptor oculta o muestra el producto.</p>
      <div class="mt" id="inventory">${listHtml()}</div>`),
    mount(root) {
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action="stock"]');
        if (!el) return;
        const [productId, variantId] = el.getAttribute('data-id').split('|');
        const product = list.find(p => p.id === productId);
        const variant = variantId ? product.allVariants.find(v => v.id === variantId) : null;
        const next = Math.max(0, Math.min(10000, (variant ? variant.stock : product.stock) + Number(el.getAttribute('data-delta'))));
        el.closest('.stepper').querySelector('output').textContent = String(next);
        try {
          await ctx.repo.setStock({ productId, variantId: variantId || null, stock: next });
          list = await ctx.repo.panelProducts(member.businessId);
          root.querySelector('#inventory').innerHTML = String(listHtml());
        } catch (error) { ctx.toast(error.message, 'error'); ctx.refresh(); }
      });
      root.addEventListener('change', async event => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        if (input.getAttribute('data-action') !== 'visible') return;
        try { await ctx.repo.setStock({ productId: input.getAttribute('data-id'), available: input.checked }); ctx.toast(input.checked ? 'Producto visible' : 'Producto oculto'); }
        catch (error) { input.checked = !input.checked; ctx.toast(error.message, 'error'); }
      });
    },
  };
}

// ══════════ mi tienda ══════════
async function storeForm(ctx, member) {
  if (member.role === 'staff') return { redirect: '/panel' };
  const [panel, ref] = await Promise.all([ctx.repo.panelBusiness(member.businessId), ctx.repo.referenceData()]);
  const { business, rights, missing } = panel;
  const url = `${ctx.repo.siteUrl || location.href.split('#')[0]}#/tienda/${business.slug}`;
  const c = business.contact || { ownerName: '', phone: '', email: '' };
  const qr = qrSvg(url, { label: `QR de ${business.name}` });
  return {
    title: 'Mi tienda',
    html: shell('tienda', member.role, html`
      ${pageHeader('Mi tienda', { backHref: '#/panel', actions: business.status === 'active' ? html`<a class="btn btn-secondary btn-sm" href="#/tienda/${business.slug}">${icon('eye', { size: 16 })}Ver</a>` : '' })}
      <form class="form mt" data-form="store" novalidate>
        <section class="card card-pad stack">
          <h2 class="section-title">Imagen de tu tienda</h2>
          <div class="row wrap">
            <label class="image-slot logo-slot">${business.logo ? html`<img src="${business.logo}" alt="Logo actual" width="120" height="120">` : html`${icon('camera', { size: 24 })}<span>Logo</span>`}
              <input type="file" accept="image/jpeg,image/png,image/webp" data-upload="logo"></label>
            <label class="image-slot cover-slot">${business.cover ? html`<img src="${business.cover}" alt="Portada actual" width="240" height="120">` : html`${icon('image', { size: 24 })}<span>Portada</span>`}
              <input type="file" accept="image/jpeg,image/png,image/webp" data-upload="cover"></label>
          </div>
          <p class="field-hint">Tocá para cambiar. La portada se ve arriba en tu tienda (ideal: foto horizontal de tu puesto o taller).</p>
        </section>
        <section class="card card-pad stack">
          <h2 class="section-title">Datos públicos</h2>
          <div class="field"><label for="st-name">Nombre</label><input id="st-name" name="name" class="input" maxlength="80" value="${business.name}" required></div>
          <div class="field"><label for="st-tag">Frase corta</label><input id="st-tag" name="tagline" class="input" maxlength="140" value="${business.tagline}" placeholder="Ej.: Cerámica artesanal inspirada en la Patagonia"></div>
          <div class="field"><label for="st-desc">Sobre mí</label><textarea id="st-desc" name="description" class="textarea" maxlength="1200" rows="5" placeholder="Tu historia, tu técnica, dónde trabajás…">${business.description}</textarea></div>
          <div class="grid-2">
            <div class="field"><label for="st-loc">Localidad</label><select id="st-loc" name="locality" class="select">${ref.localities.map(l => html`<option value="${l.id}"${raw(l.id === business.localityId ? ' selected' : '')}>${l.name}</option>`)}</select></div>
            <div class="field"><label for="st-cat">Rubro</label><select id="st-cat" name="category" class="select">${ref.categories.map(cat => html`<option value="${cat.id}"${raw(cat.id === business.categoryId ? ' selected' : '')}>${cat.name}</option>`)}</select></div>
          </div>
          <div class="grid-2">
            <div class="field"><label for="st-wa">WhatsApp</label><input id="st-wa" name="whatsapp" class="input" inputmode="tel" value="${business.whatsapp}" placeholder="299 155 12345"><span class="field-hint">Para que te escriban desde tu tienda.</span></div>
            <div class="field"><label for="st-ig">Instagram</label><div class="input-group"><span class="addon">@</span><input id="st-ig" name="instagram" class="input" value="${business.instagram}" maxlength="40"></div></div>
          </div>
          <div class="field"><label for="st-phone">Teléfono público <span class="muted">(opcional)</span></label><input id="st-phone" name="publicPhone" class="input" inputmode="tel" value="${business.publicPhone}" maxlength="24"></div>
        </section>
        <section class="card card-pad stack" id="contacto">
          <h2 class="section-title">Contacto privado</h2>
          <p class="field-hint">Sólo lo ve la administración de CAUCE. No se publica.</p>
          <div class="field"><label for="st-owner">Nombre de quien atiende</label><input id="st-owner" name="ownerName" class="input" maxlength="80" value="${c.ownerName}"></div>
          <div class="grid-2">
            <div class="field"><label for="st-cphone">Teléfono</label><input id="st-cphone" name="contactPhone" class="input" inputmode="tel" maxlength="24" value="${c.phone}"></div>
            <div class="field"><label for="st-cmail">Correo</label><input id="st-cmail" name="contactEmail" class="input" type="email" maxlength="120" value="${c.email}"></div>
          </div>
        </section>
        <section class="card card-pad stack" id="entregas">
          <h2 class="section-title">Formas de entrega</h2>
          <label class="switch"><span><strong>Retiro en mi puesto de feria</strong><span class="small muted block">${rights.fair_pickup ? 'Se ofrece en las ferias donde estés confirmada/o.' : 'Incluido en el Plan Feriante y en Emprendedor Pro.'}</span></span>
            <input type="checkbox" name="fairPickup"${raw(business.fairPickupEnabled ? ' checked' : '')}${attr('disabled', !rights.fair_pickup)}></label>
          <label class="switch"><span><strong>Retiro acordado</strong><span class="small muted block">Coordinás el lugar con cada persona.</span></span><input type="checkbox" name="pickup"${raw(business.pickupEnabled ? ' checked' : '')}></label>
          <div class="field"><label for="st-area">Zona de retiro</label><input id="st-area" name="pickupArea" class="input" maxlength="160" value="${business.pickupArea}" placeholder="Ej.: Barrio Santa Genoveva (no pongas tu dirección exacta)"></div>
          <label class="switch"><span><strong>Envío propio</strong><span class="small muted block">Lo llevás vos o alguien de tu confianza.</span></span><input type="checkbox" name="delivery"${raw(business.deliveryEnabled ? ' checked' : '')}></label>
          <div class="field"><label for="st-zone">Zona de envío</label><input id="st-zone" name="deliveryZone" class="input" maxlength="160" value="${business.deliveryZone}" placeholder="Ej.: Neuquén capital y Plottier"></div>
          <div class="grid-2">
            <div class="field"><label for="st-feemode">Costo de envío</label><select id="st-feemode" name="feeMode" class="select">
              <option value="agree"${raw(business.deliveryFee === null ? ' selected' : '')}>A coordinar</option><option value="fixed"${raw(business.deliveryFee !== null ? ' selected' : '')}>Precio fijo</option></select></div>
            <div class="field"><label for="st-fee">Precio fijo</label><div class="input-group"><span class="addon">$</span><input id="st-fee" name="deliveryFee" class="input" inputmode="numeric" value="${business.deliveryFee ?? ''}"></div></div>
          </div>
          <div class="field"><label for="st-min">Compra mínima para envío</label><div class="input-group"><span class="addon">$</span><input id="st-min" name="minimumOrder" class="input" inputmode="numeric" value="${business.minimumOrder || ''}"></div></div>
        </section>
        <section class="card card-pad stack">
          <label class="switch"><span><strong>Recibir pedidos</strong><span class="small muted block">Apagalo si te vas de vacaciones: la tienda sigue visible.</span></span><input type="checkbox" name="accepting"${raw(business.acceptingOrders ? ' checked' : '')}></label>
        </section>
        <p class="field-error" id="st-error" role="alert" hidden></p>
        <div class="buy-bar"><button class="btn btn-primary" type="submit">Guardar cambios</button></div>
      </form>
      <section class="card card-pad stack mt" id="compartir">
        <h2 class="section-title">Compartí tu tienda</h2>
        ${business.status === 'active' ? '' : html`<p class="small muted">El enlace funciona cuando la tienda esté publicada.</p>`}
        <div class="qr-card">${raw(qr)}
          <div class="share-url"><label class="sr-only" for="st-url">Enlace</label><input id="st-url" class="input" readonly value="${url}">
            <button type="button" class="btn btn-secondary btn-sm" data-action="copy">${icon('copy', { size: 16 })}Copiar</button></div>
          <div class="row wrap"><button type="button" class="btn btn-secondary btn-sm" data-action="download-qr">${icon('upload', { size: 16 })}Descargar QR</button>
            <a class="btn btn-whatsapp btn-sm" href="https://wa.me/?text=${encodeURIComponent(`Mirá mi tienda en CAUCE · Ferias: ${url}`)}" target="_blank" rel="noopener noreferrer">${icon('whatsapp', { size: 16 })}Mandar por WhatsApp</a></div>
          <p class="xsmall muted">Imprimí el QR para tu puesto: quien lo escanea ve tus productos y puede pedirte.</p>
        </div>
      </section>
      <section class="card card-pad stack mt">
        <h2 class="section-title">Estado de la tienda</h2>
        <p><span class="tag ${business.status === 'active' ? 'tag-ok' : business.status === 'suspended' ? 'tag-error' : 'tag-warn'}">${BUSINESS_STATUS[business.status]}</span></p>
        ${['draft', 'returned'].includes(business.status) ? html`${missing.length ? html`<p class="small muted">Para publicar falta: ${missing.join(', ')}.</p>` : ''}
          <button type="button" class="btn btn-primary" data-action="submit"${attr('disabled', missing.length > 0)}>Pedir la publicación</button>` : ''}
        ${business.status === 'active' ? html`<button type="button" class="btn btn-secondary" data-action="pause">Pausar la tienda</button>` : ''}
        ${business.status === 'paused' ? html`<button type="button" class="btn btn-primary" data-action="resume">Reanudar la tienda</button>` : ''}
      </section>`),
    mount(root) {
      root.addEventListener('change', async event => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const kind = input.getAttribute('data-upload');
        if (!kind || !input.files?.[0]) return;
        const slot = input.closest('.image-slot');
        slot.classList.add('is-loading');
        try { await ctx.repo.setBusinessImage(business, kind, input.files[0]); ctx.toast(kind === 'logo' ? 'Logo actualizado' : 'Portada actualizada', 'ok'); ctx.refresh(); }
        catch (error) { ctx.toast(error.message, 'error'); } finally { slot.classList.remove('is-loading'); }
      });
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        if (action === 'copy') { try { await navigator.clipboard.writeText(url); ctx.toast('Enlace copiado'); } catch { /** @type {HTMLInputElement} */ (root.querySelector('#st-url')).select(); } }
        if (action === 'download-qr') {
          const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${qr.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" ')}`], { type: 'image/svg+xml' });
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob); link.download = `qr-${business.slug}.svg`;
          document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(link.href), 2000);
        }
        if (action === 'submit') {
          el.classList.add('is-busy');
          try { await ctx.repo.submitForReview(business.id); ctx.toast('¡Enviada a revisión!', 'ok'); ctx.refresh(); } catch (error) { ctx.toast(error.message, 'error'); } finally { el.classList.remove('is-busy'); }
        }
        if (action === 'pause' || action === 'resume') {
          if (action === 'pause' && !await ctx.dialog({ title: 'Pausar la tienda', text: 'Deja de aparecer en CAUCE hasta que la reanudes. Los pedidos abiertos siguen en tu panel.', confirm: 'Pausar' })) return;
          try { await ctx.repo.setPresence(business.id, action === 'pause' ? 'paused' : 'active'); ctx.toast(action === 'pause' ? 'Tienda pausada' : 'Tienda publicada de nuevo', 'ok'); ctx.refresh(); }
          catch (error) { ctx.toast(error.message, 'error'); }
        }
      });
      root.querySelector('[data-form="store"]').addEventListener('submit', async event => {
        event.preventDefault();
        const form = /** @type {HTMLFormElement} */ (event.currentTarget);
        const data = new FormData(form);
        const error = root.querySelector('#st-error');
        const show = message => { error.textContent = message; error.hidden = false; error.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
        const whatsappRaw = clean(data.get('whatsapp'), 30);
        const whatsapp = normalizeWhatsapp(whatsappRaw);
        const publicPhone = clean(data.get('publicPhone'), 24);
        const contactPhone = clean(data.get('contactPhone'), 24);
        const contactEmail = clean(data.get('contactEmail'), 120);
        const delivery = Boolean(data.get('delivery'));
        const fixedFee = data.get('feeMode') === 'fixed';
        const fee = parseARS(data.get('deliveryFee'));
        if (clean(data.get('name'), 80).length < 2) return show('El nombre necesita al menos 2 letras.');
        if (whatsappRaw && !whatsapp) return show('Revisá el WhatsApp: con código de área (ej.: 299 155 12345).');
        if (publicPhone && !isPhone(publicPhone)) return show('Revisá el teléfono público.');
        if (contactPhone && !isPhone(contactPhone)) return show('Revisá el teléfono de contacto.');
        if (contactEmail && !isEmail(contactEmail)) return show('Revisá el correo de contacto.');
        if (delivery && !clean(data.get('deliveryZone'), 160)) return show('Contá a qué zona hacés envíos.');
        if (delivery && fixedFee && fee === null) return show('Poné el precio del envío o elegí «A coordinar».');
        if (!data.get('pickup') && !delivery && !data.get('fairPickup')) return show('Elegí al menos una forma de entrega.');
        error.hidden = true;
        const button = form.querySelector('button[type="submit"]');
        button.classList.add('is-busy');
        try {
          await ctx.repo.updateBusiness(business.id, {
            name: clean(data.get('name'), 80), tagline: clean(data.get('tagline'), 140), description: cleanMultiline(data.get('description'), 1200),
            locality_id: String(data.get('locality')), category_id: String(data.get('category')), whatsapp, instagram: normalizeInstagram(data.get('instagram')),
            public_phone: publicPhone, pickup_enabled: Boolean(data.get('pickup')), pickup_area: clean(data.get('pickupArea'), 160),
            fair_pickup_enabled: rights.fair_pickup ? Boolean(data.get('fairPickup')) : business.fairPickupEnabled,
            delivery_enabled: delivery, delivery_zone: clean(data.get('deliveryZone'), 160), delivery_fee_ars: fixedFee ? (fee ?? 0) : null,
            minimum_order_ars: parseARS(data.get('minimumOrder')) || 0, accepting_orders: Boolean(data.get('accepting')),
          });
          await ctx.repo.updateContact(business.id, { owner_name: clean(data.get('ownerName'), 80), phone: contactPhone, email: contactEmail });
          ctx.repo.invalidate();
          ctx.toast('Cambios guardados', 'ok');
          ctx.refresh();
        } catch (caught) { show(caught.message); } finally { button.classList.remove('is-busy'); }
      });
    },
  };
}

// ══════════ mis ferias ══════════
async function fairs(ctx, member) {
  if (member.role === 'staff') return { redirect: '/panel' };
  const [participations, panel, open] = await Promise.all([ctx.repo.myParticipations(member.businessId), ctx.repo.panelBusiness(member.businessId), ctx.repo.fairs({})]);
  const { business, rights } = panel;
  const now = Date.now();
  const mine = new Set(participations.filter(p => ['requested', 'confirmed', 'rejected'].includes(p.status)).map(p => p.fair.id));
  const available = open.filter(f => f.status === 'published' && f.applicationsOpen && !mine.has(f.id));
  const upcoming = participations.filter(p => new Date(p.fair.endsAt).getTime() > now);
  const past = participations.filter(p => new Date(p.fair.endsAt).getTime() <= now && p.status === 'confirmed');
  const label = { requested: ['tag-warn', 'Solicitud enviada'], confirmed: ['tag-ok', 'Confirmada'], rejected: ['tag-error', 'No confirmada'], withdrawn: ['', 'Te diste de baja'] };
  return {
    title: 'Mis ferias',
    html: shell('ferias', member.role, html`
      ${pageHeader('Mis ferias', { backHref: '#/panel' })}
      ${business.status !== 'active' ? html`<div class="mt">${banner('', 'Tu tienda tiene que estar publicada para inscribirse en ferias', 'Mientras, podés mirar el calendario.')}</div>` : ''}
      ${business.status === 'active' && !rights.fair_pickup ? html`<div class="mt">${banner('terra', 'Podés exponer en ferias con tu plan', 'Para que te compren online y retiren en tu puesto, necesitás el Plan Feriante.', 'info')}</div>` : ''}
      <section class="section">
        <h2 class="section-title mb">Próximas</h2>
        ${upcoming.length ? html`<div class="stack">${upcoming.map(p => html`<article class="card card-pad stack gap-sm">
          <div class="row between wrap"><a class="fair-link" href="#/feria/${p.fair.slug}"><strong>${p.fair.name}</strong></a><span class="tag ${label[p.status][0]}">${label[p.status][1]}</span></div>
          <span class="meta-line">${icon('calendar', { size: 18 })}<span class="first-cap">${longDate(p.fair.startsAt)} · ${timeRange(p.fair.startsAt, p.fair.endsAt)}</span></span>
          <span class="meta-line">${icon('pin', { size: 18 })}${[p.fair.venue, p.fair.address].filter(Boolean).join(', ')}</span>
          ${p.status === 'confirmed' ? html`<span class="meta-line strong">${icon('store', { size: 18 })}${p.stall ? `Tu puesto: ${p.stall}` : 'Puesto a confirmar por la organización'}</span>` : ''}
          ${p.status === 'rejected' && p.note ? html`<p class="small muted">Nota de la organización: ${p.note}</p>` : ''}
          ${p.announcements.length ? html`<div class="announcements">${p.announcements.map(a => html`<div class="announcement">${icon('megaphone', { size: 16 })}<span><span class="pre-line">${a.body}</span><span class="xsmall muted block">${relative(a.created_at)}</span></span></div>`)}</div>` : ''}
          <div class="row wrap">
            <a class="btn btn-secondary btn-sm" href="${directionsUrl(p.fair)}" target="_blank" rel="noopener noreferrer">${icon('route', { size: 16 })}Cómo llegar</a>
            ${['requested', 'confirmed'].includes(p.status) && new Date(p.fair.startsAt).getTime() > now ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="withdraw" data-id="${p.id}">Darme de baja</button>` : ''}
            ${p.status === 'withdrawn' && p.fair.applicationsOpen ? html`<button type="button" class="btn btn-primary btn-sm" data-action="apply" data-fair="${p.fair.id}">Volver a inscribirme</button>` : ''}
          </div>
        </article>`)}</div>` : html`<p class="muted">No tenés ferias próximas.</p>`}
      </section>
      ${business.status === 'active' ? html`<section class="section">
        <h2 class="section-title mb">Ferias con inscripción abierta</h2>
        ${available.length ? html`<div class="stack fairs-grid">${available.map(f => html`<div class="stack gap-sm">${fairCard(f)}
          <button type="button" class="btn btn-primary btn-sm" data-action="apply" data-fair="${f.id}">Inscribir mi tienda</button></div>`)}</div>`
    : emptyState({ scene: 'explorando', title: 'Sin inscripciones abiertas', text: 'Cuando una organización abra una feria, la vas a ver acá.' })}
      </section>` : ''}
      ${past.length ? html`<section class="section"><h2 class="section-title mb">Ferias anteriores</h2><div class="card">${past.map(p => html`<div class="list-row"><span class="grow">${p.fair.name}</span><span class="small muted">${longDate(p.fair.startsAt)}</span></div>`)}</div></section>` : ''}`),
    mount(root) {
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        if (action === 'apply') {
          el.classList.add('is-busy');
          try { await ctx.repo.applyToFair(el.getAttribute('data-fair'), member.businessId); ctx.toast('¡Solicitud enviada!', 'ok'); ctx.refresh(); }
          catch (error) { ctx.toast(error.message, 'error'); } finally { el.classList.remove('is-busy'); }
        }
        if (action === 'withdraw') {
          if (!await ctx.dialog({ title: 'Darte de baja de la feria', text: 'La organización deja de contar con tu puesto.', confirm: 'Darme de baja', tone: 'danger' })) return;
          try { await ctx.repo.withdrawParticipation(el.getAttribute('data-id')); ctx.toast('Te diste de baja.'); ctx.refresh(); }
          catch (error) { ctx.toast(error.message, 'error'); }
        }
      });
    },
  };
}

// ══════════ estadísticas ══════════
async function stats(ctx, member) {
  if (member.role === 'staff') return { redirect: '/panel' };
  const days = [7, 30, 90].includes(Number(ctx.query.dias)) ? Number(ctx.query.dias) : 30;
  const data = await ctx.repo.stats(member.businessId, days);
  const max = Math.max(1, ...data.daily.map(d => d.orders));
  return {
    title: 'Estadísticas',
    html: shell('estadisticas', member.role, html`
      ${pageHeader('Estadísticas', { backHref: '#/panel' })}
      <div class="segmented mt">${[7, 30, 90].map(n => html`<a href="#/panel/estadisticas?dias=${n}"${raw(n === days ? ' aria-current="page"' : '')}>${n} días</a>`)}</div>
      <div class="stats stats-6 mt">
        <div class="stat"><span class="stat-value">${data.orders}</span><span class="stat-label">Pedidos</span></div>
        <div class="stat"><span class="stat-value">${data.delivered}</span><span class="stat-label">Entregados</span></div>
        <div class="stat"><span class="stat-value">${data.open}</span><span class="stat-label">Abiertos</span></div>
        <div class="stat"><span class="stat-value">${formatARS(data.sales_ars)}</span><span class="stat-label">Vendido (entregado)</span></div>
        <div class="stat"><span class="stat-value">${formatARS(data.paid_ars)}</span><span class="stat-label">Cobrado</span></div>
        <div class="stat${data.pending_payment_ars ? ' is-alert' : ''}"><span class="stat-value">${formatARS(data.pending_payment_ars)}</span><span class="stat-label">Por cobrar</span></div>
      </div>
      <section class="card card-pad stack mt">
        <h2 class="section-title">Pedidos por día</h2>
        ${data.daily.length ? html`<div class="chart" role="img" aria-label="Pedidos por día en los últimos ${days} días">${data.daily.map(d => html`<span data-height="${Math.round((d.orders / max) * 100)}" title="${d.day}: ${d.orders}"></span>`)}</div>` : html`<p class="muted">Sin pedidos en este período.</p>`}
        <div class="row wrap small muted"><span>Ticket promedio: <strong>${formatARS(data.average_ars)}</strong></span><span>Cancelados: <strong>${data.canceled}</strong></span></div>
      </section>
      <section class="card card-pad stack mt">
        <h2 class="section-title">Cómo te compran</h2>
        <div class="kv"><dt>Retiro en feria</dt><dd>${data.by_fulfillment.fair_pickup}</dd><dt>Retiro acordado</dt><dd>${data.by_fulfillment.pickup}</dd><dt>Envío</dt><dd>${data.by_fulfillment.delivery}</dd></div>
      </section>
      ${data.advanced ? html`
        <section class="card card-pad stack mt"><h2 class="section-title">Más vendidos</h2>
          ${data.top_products.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Producto</th><th>Unidades</th><th>Total</th></tr></thead>
            <tbody>${data.top_products.map(t => html`<tr><td>${t.name}</td><td class="tnum">${t.units}</td><td class="tnum">${formatARS(t.sales_ars)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Todavía sin datos.</p>`}</section>
        <section class="card card-pad stack mt"><h2 class="section-title">Pedidos por feria</h2>
          ${data.by_fair.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Feria</th><th>Pedidos</th><th>Total</th></tr></thead>
            <tbody>${data.by_fair.map(t => html`<tr><td>${t.fair}</td><td class="tnum">${t.orders}</td><td class="tnum">${formatARS(t.total_ars)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Sin retiros en ferias en este período.</p>`}</section>`
    : html`<div class="mt">${banner('terra', 'Más detalle con Emprendedor Pro', 'Productos más vendidos y pedidos por feria.', 'chart')}</div>`}`),
    mount(root) {
      requestAnimationFrame(() => root.querySelectorAll('.chart [data-height]').forEach(bar => { /** @type {HTMLElement} */ (bar).style.height = `${bar.getAttribute('data-height')}%`; }));
    },
  };
}

// ══════════ mi plan ══════════
async function planView(ctx, member) {
  if (member.role === 'staff') return { redirect: '/panel' };
  const [panel, ref] = await Promise.all([ctx.repo.panelBusiness(member.businessId), ctx.repo.referenceData()]);
  const { rights } = panel;
  const info = stateInfo(rights.state);
  const usage = Math.min(100, Math.round((rights.products_used / Math.max(1, rights.max_products)) * 100));
  return {
    title: 'Mi plan',
    html: shell('plan', member.role, html`
      ${pageHeader('Mi plan', { backHref: '#/panel' })}
      <section class="card card-pad stack mt">
        <div class="row between wrap"><h2 class="section-title">${rights.plan_name || 'Sin plan vigente'}</h2><span class="tag tag-${info.tone === 'neutral' ? '' : info.tone}">${info.label}</span></div>
        ${rights.period_end ? html`<p class="small">${rights.state === 'grace' ? `Venció el ${longDate(rights.period_end)}. Seguís vendiendo hasta el ${longDate(rights.grace_until)}.`
    : ['expired', 'canceled'].includes(rights.state) ? 'No está vigente: tu tienda no recibe pedidos nuevos.' : `Vigente hasta el ${longDate(rights.period_end)}.`}</p>`
    : html`<p class="small">Se activa cuando la administración aprueba tu tienda (con un período de prueba).</p>`}
        <div class="stack gap-xs"><span class="small">Productos: <strong>${rights.products_used}</strong> de ${rights.max_products}</span><div class="progress"><span data-progress="${usage}"></span></div></div>
        <div class="kv"><dt>Fotos por producto</dt><dd>${rights.max_images}</dd><dt>Personas de ayuda</dt><dd>${rights.team_used} de ${rights.staff_seats}</dd>
          <dt>Retiro en feria</dt><dd>${rights.fair_pickup ? 'Incluido' : 'No incluido'}</dd><dt>Estadísticas</dt><dd>${rights.advanced_stats ? 'Ampliadas' : 'Básicas'}</dd></div>
      </section>
      ${banner('', 'Cambios de plan durante el piloto', 'La administración de CAUCE activa, cambia y renueva los planes a mano (sin cobros automáticos). Hablalo con la persona de CAUCE que te acompaña; tus pedidos abiertos nunca se cortan por un vencimiento.', 'info')}
      <div class="plans-grid mt">${ref.plans.filter(p => p.audience === 'business').map(p => html`<article class="card plan-card${p.code === rights.plan ? ' is-current' : ''}">
        <div class="row between"><h3 class="section-title">${p.name}</h3>${p.code === rights.plan ? html`<span class="tag tag-terra">Tu plan</span>` : ''}</div>
        <p class="plan-price">${formatARS(p.monthly_price_ars)} <span class="small muted">/ mes (orientativo)</span></p>
        <ul class="plan-list">${planFeatures(p).map(f => html`<li>${icon('check', { size: 16, strokeWidth: 3 })}${f}</li>`)}</ul></article>`)}</div>`),
    mount(root) {
      const bar = /** @type {HTMLElement} */ (root.querySelector('[data-progress]'));
      if (bar) requestAnimationFrame(() => { bar.style.width = `${bar.getAttribute('data-progress')}%`; });
    },
  };
}

// ══════════ equipo ══════════
async function team(ctx, member) {
  if (member.role !== 'owner') return { redirect: '/panel' };
  const [people, panel] = await Promise.all([ctx.repo.team(member.businessId), ctx.repo.panelBusiness(member.businessId)]);
  const { rights } = panel;
  const room = rights.staff_seats - rights.team_used;
  return {
    title: 'Equipo',
    html: shell('equipo', member.role, html`
      ${pageHeader('Equipo', { backHref: '#/panel' })}
      <p class="small muted mt">Encargado/a: edita productos y la tienda. Ayudante: atiende pedidos y stock. Tu plan admite ${rights.staff_seats} ${rights.staff_seats === 1 ? 'persona' : 'personas'}.</p>
      <div class="card mt">${people.map(p => html`<div class="list-row"><span class="store-logo">${(p.display_name || '?').slice(0, 1).toUpperCase()}</span>
        <span class="grow stack gap-xs"><strong>${p.display_name}${p.is_self ? ' (vos)' : ''}</strong><span class="small muted">${p.email} · ${ROLE_LABEL[p.role]}</span></span>
        ${p.role !== 'owner' ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="remove" data-id="${p.user_id}" data-name="${p.display_name}">Quitar</button>` : ''}</div>`)}</div>
      ${room > 0 ? html`<form class="card card-pad form mt" data-form="member" novalidate>
        <h2 class="section-title">Sumar a alguien</h2>
        <p class="field-hint">Tiene que tener una cuenta de CAUCE confirmada.</p>
        <div class="field"><label for="tm-email">Correo de su cuenta</label><input id="tm-email" name="email" type="email" class="input" required></div>
        <div class="field"><label for="tm-role">Rol</label><select id="tm-role" name="role" class="select"><option value="staff">Ayudante</option><option value="manager">Encargado/a</option></select></div>
        <button class="btn btn-primary" type="submit">Sumar</button></form>`
    : html`<div class="mt">${banner('terra', 'Tu plan no admite más personas', 'Emprendedor Pro permite un equipo de 3.')}</div>`}`),
    mount(root) {
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action="remove"]');
        if (!el || !await ctx.dialog({ title: `Quitar a ${el.getAttribute('data-name')}`, text: 'Pierde el acceso al panel en el acto.', confirm: 'Quitar', tone: 'danger' })) return;
        try { await ctx.repo.removeMember(member.businessId, el.getAttribute('data-id')); ctx.toast('Listo'); ctx.refresh(); } catch (error) { ctx.toast(error.message, 'error'); }
      });
      root.querySelector('[data-form="member"]')?.addEventListener('submit', async event => {
        event.preventDefault();
        const form = /** @type {HTMLFormElement} */ (event.currentTarget);
        const data = new FormData(form);
        const email = clean(data.get('email'), 120);
        if (!isEmail(email)) { ctx.toast('Revisá el correo.', 'error'); return; }
        try { await ctx.repo.addMember(member.businessId, email, String(data.get('role'))); ctx.toast('¡Sumada al equipo!', 'ok'); ctx.refresh(); } catch (error) { ctx.toast(error.message, 'error'); }
      });
    },
  };
}

// ══════════ más (menú del teléfono) ══════════
async function more(ctx, member) {
  return {
    title: 'Más',
    html: shell('', member.role, html`
      ${pageHeader('Más', { backHref: '#/panel' })}
      <nav class="menu mt" aria-label="Más opciones">
        <a class="menu-item" href="#/panel/inventario">${icon('stock')}<span>Inventario</span>${icon('chevron-right', { size: 18 })}</a>
        ${member.role !== 'staff' ? html`
          <a class="menu-item" href="#/panel/estadisticas">${icon('chart')}<span>Estadísticas</span>${icon('chevron-right', { size: 18 })}</a>
          <a class="menu-item" href="#/panel/tienda">${icon('edit')}<span>Editar mi tienda</span>${icon('chevron-right', { size: 18 })}</a>
          <a class="menu-item" href="#/panel/tienda#compartir">${icon('qr')}<span>QR y enlace de mi tienda</span>${icon('chevron-right', { size: 18 })}</a>
          <a class="menu-item" href="#/panel/plan">${icon('tag')}<span>Mi plan</span>${icon('chevron-right', { size: 18 })}</a>` : ''}
        ${member.role === 'owner' ? html`<a class="menu-item" href="#/panel/equipo">${icon('users')}<span>Equipo</span>${icon('chevron-right', { size: 18 })}</a>` : ''}
        ${ctx.session.organizers.length ? html`<a class="menu-item" href="#/organizador">${icon('fairs')}<span>Panel del organizador</span>${icon('chevron-right', { size: 18 })}</a>` : ''}
        ${ctx.session.admin ? html`<a class="menu-item" href="#/admin">${icon('shield')}<span>Administración</span>${icon('chevron-right', { size: 18 })}</a>` : ''}
        <a class="menu-item" href="#/">${icon('home')}<span>Ir al marketplace</span>${icon('chevron-right', { size: 18 })}</a>
        <a class="menu-item" href="#/cuenta">${icon('user')}<span>Mi cuenta</span>${icon('chevron-right', { size: 18 })}</a>
      </nav>`),
  };
}
