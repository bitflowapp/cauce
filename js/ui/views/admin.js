// Administración de CAUCE · Ferias: el día de la plataforma, revisión de
// tiendas, suscripciones manuales del piloto, organizadores, comunidad
// fundadora, auditoría y errores. Todo pasa por funciones que verifican
// `private.platform_admins` y dejan registro.
import { html, raw } from '../../core/html.js';
import { formatARS } from '../../core/money.js';
import { longDate, dateTime, relative } from '../../core/dates.js';
import { stateInfo } from '../../core/plans.js';
import { clean, isEmail } from '../../core/validators.js';
import { SURVEY, answerLabel } from '../../core/survey.js';
import { icon } from '../icons.js';
import { emptyState, banner, pageHeader, storeLogo } from '../components.js';

const BUSINESS_STATUS = { draft: ['', 'Borrador'], pending_review: ['tag-warn', 'En revisión'], returned: ['tag-info', 'Devuelta'],
  active: ['tag-ok', 'Publicada'], paused: ['', 'Pausada'], suspended: ['tag-error', 'Suspendida'] };
const FOUNDING_STATUS = { new: ['tag-warn', 'Nueva'], contacted: ['tag-info', 'Contactada'], joined: ['tag-ok', 'Se sumó'], declined: ['', 'No sigue'] };
const SECTIONS = [['', 'Resumen', 'resumen'], ['tiendas', 'Tiendas', 'tiendas'], ['organizadores', 'Ferias y organizadores', 'organizadores'],
  ['comunidad', 'Comunidad', 'comunidad'], ['registro', 'Registro', 'registro']];

// CSV para contactar a quienes se preinscribieron (se abre en planillas). Las
// celdas que empiezan con = + - @ se neutralizan: nadie puede inyectar fórmulas.
const csvCell = value => {
  const text = String(value ?? '').replace(/^[=+\-@\t\r]/, "'$&");
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
function foundingCsv(list) {
  const head = ['Fecha', 'Nombre', 'Emprendimiento', 'Contacto', 'Localidad', 'Rubro', 'Vende en ferias', 'Estado', 'Mensaje',
    ...SURVEY.map(q => q.key), 'pilot'];
  const rows = list.map(a => [a.created_at, a.name, a.business_name, a.contact, a.locality, a.category, a.sells_at_fairs ? 'sí' : 'no',
    FOUNDING_STATUS[a.status][1], a.message, ...SURVEY.map(q => a.survey?.[q.key] === undefined ? '' : answerLabel(q.key, a.survey[q.key])),
    a.survey?.pilot ? 'sí' : '']);
  return [head, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
}

function surveySummary(summary, entryPrice) {
  const total = summary.answered || 0;
  const block = (key, label, options) => {
    const counts = summary.answers?.[key] || {};
    return html`<div class="stack gap-xs"><strong>${label}</strong>${options.map(([code, text]) => {
      const n = Number(counts[code] || 0);
      return html`<div class="survey-bar"><span class="stack gap-xs"><span>${text}</span><meter min="0" max="${Math.max(total, 1)}" value="${n}" aria-label="${text}: ${n} de ${total}"></meter></span><span class="right">${n}</span></div>`;
    })}</div>`;
  };
  return html`<section class="card card-pad stack mt">
    <h2 class="section-title">Encuesta</h2>
    <p class="small muted">${total} de ${summary.applications || 0} preinscripciones respondieron. Cada respuesta cuenta una vez; «Dónde vendés» admite varias.</p>
    <div class="grid-2">${SURVEY.map(q => block(q.key, q.label.replace('{price}', entryPrice), q.options))}
      ${block('pilot', 'Quieren entrar al piloto', [['true', 'Sí']])}</div>
  </section>`;
}

const plusDays = days => { const d = new Date(Date.now() + days * 86400000); return d.toISOString().slice(0, 10); };

function subscriptionForm(ref, subject, current, audience) {
  const plans = ref.plans.filter(p => p.audience === audience);
  return html`<form class="form sub-form" data-form="subscription" data-${subject.kind}="${subject.id}" novalidate>
    <div class="grid-2">
      <div class="field"><label for="sp-${subject.id}">Plan</label><select id="sp-${subject.id}" name="plan" class="select">${plans.map(p => html`<option value="${p.code}"${raw(p.code === (current?.plan || plans[0].code) ? ' selected' : '')}>${p.name} · ${formatARS(p.monthly_price_ars)}</option>`)}</select></div>
      <div class="field"><label for="ss-${subject.id}">Estado</label><select id="ss-${subject.id}" name="status" class="select">
        ${[['trial', 'Prueba'], ['active', 'Vigente (pagó)'], ['canceled', 'Cancelada']].map(([v, l]) => html`<option value="${v}"${raw(v === (current?.status || 'active') ? ' selected' : '')}>${l}</option>`)}</select></div>
    </div>
    <div class="grid-2">
      <div class="field"><label for="se-${subject.id}">Vence</label><input id="se-${subject.id}" name="period_end" type="date" class="input" value="${current?.period_end || plusDays(30)}"></div>
      <div class="field"><label for="sg-${subject.id}">Días de gracia</label><input id="sg-${subject.id}" name="grace" class="input" inputmode="numeric" value="${current?.grace_days ?? 10}"></div>
    </div>
    <div class="field"><label for="sn-${subject.id}">Nota interna</label><input id="sn-${subject.id}" name="note" class="input" maxlength="300" value="${current?.note || ''}" placeholder="Ej.: pagó por transferencia el 10/10"></div>
    <button class="btn btn-secondary btn-sm" type="submit">Guardar suscripción</button>
  </form>`;
}

export async function home(ctx) {
  if (ctx.session.kind !== 'account') return { redirect: '/cuenta?next=%2Fadmin' };
  if (!ctx.session.admin) {
    return { chrome: 'shop', nav: '', title: 'Administración', html: html`${pageHeader('Administración')}
      ${emptyState({ scene: 'buscando', title: 'Sección exclusiva', text: 'Tu cuenta no tiene acceso a la administración de CAUCE.' })}` };
  }
  const sectionName = ctx.params.section || '';
  const ref = await ctx.repo.referenceData();
  const nav = SECTIONS.find(([key]) => key === sectionName)?.[2] || 'resumen';
  const tabs = html`<nav class="tabs mt" aria-label="Secciones de administración">${SECTIONS.map(([key, label]) => html`<a class="tab" href="#/admin${key ? `/${key}` : ''}"${raw(key === sectionName ? ' aria-current="page"' : '')}>${label}</a>`)}</nav>`;
  let body;
  let foundingList = [];

  if (!sectionName) {
    const [o, businesses] = await Promise.all([ctx.repo.adminOverview(), ctx.repo.adminBusinesses()]);
    const pending = businesses.filter(b => b.status === 'pending_review');
    const today = new Date().toISOString().slice(0, 10);
    const expiring = businesses.filter(b => b.subscription && b.subscription.status !== 'canceled' && b.subscription.period_end >= today && b.subscription.period_end <= plusDays(7));
    const grace = businesses.filter(b => b.entitlements.state === 'grace');
    body = html`
      <div class="stats stats-6 mt">
        <div class="stat"><span class="stat-value">${o.businesses.active || 0}</span><span class="stat-label">Tiendas publicadas</span></div>
        <a class="stat${o.pending_review ? ' is-alert' : ''}" href="#/admin/tiendas?f=pending_review"><span class="stat-value">${o.pending_review}</span><span class="stat-label">En revisión</span></a>
        <div class="stat"><span class="stat-value">${o.orders_today}</span><span class="stat-label">Pedidos hoy</span></div>
        <div class="stat"><span class="stat-value">${o.orders_week}</span><span class="stat-label">Pedidos 7 días</span></div>
        <div class="stat"><span class="stat-value">${formatARS(o.gross_week_ars)}</span><span class="stat-label">Entregado 7 días</span></div>
        <div class="stat"><span class="stat-value">${o.fairs_upcoming}</span><span class="stat-label">Ferias próximas</span></div>
      </div>
      <section class="section stack">
        <h2 class="section-title">Necesitan atención</h2>
        ${!pending.length && !o.stale_orders && !expiring.length && !grace.length && !o.founding_new ? html`<p class="muted">Todo en orden.</p>` : ''}
        ${pending.length ? html`<a class="option-card" href="#/admin/tiendas?f=pending_review">${icon('store')}<span class="grow"><strong>${pending.length} ${pending.length === 1 ? 'tienda espera' : 'tiendas esperan'} revisión</strong><span class="small muted block">${pending.map(b => b.name).join(', ')}</span></span>${icon('chevron-right', { size: 18 })}</a>` : ''}
        ${o.stale_orders ? html`<div class="option-card">${icon('alert')}<span class="grow"><strong>${o.stale_orders} pedidos sin responder hace más de 24 h</strong><span class="small muted block">Conviene escribir a esas tiendas.</span></span></div>` : ''}
        ${expiring.length ? html`<a class="option-card" href="#/admin/tiendas?f=vence">${icon('clock')}<span class="grow"><strong>${expiring.length} suscripciones vencen en 7 días</strong><span class="small muted block">${expiring.map(b => b.name).join(', ')}</span></span>${icon('chevron-right', { size: 18 })}</a>` : ''}
        ${grace.length ? html`<a class="option-card" href="#/admin/tiendas?f=gracia">${icon('alert')}<span class="grow"><strong>${grace.length} en período de gracia</strong><span class="small muted block">${grace.map(b => b.name).join(', ')}</span></span>${icon('chevron-right', { size: 18 })}</a>` : ''}
        ${o.founding_new ? html`<a class="option-card" href="#/admin/comunidad">${icon('users')}<span class="grow"><strong>${o.founding_new} preinscripciones nuevas</strong></span>${icon('chevron-right', { size: 18 })}</a>` : ''}
      </section>
      <section class="section card card-pad"><div class="kv">
        <dt>Pedidos abiertos</dt><dd>${o.open_orders}</dd><dt>Organizadores</dt><dd>${o.organizers}</dd>
        <dt>Suscripciones vencidas</dt><dd>${o.subscriptions_expired}</dd><dt>Errores (24 h)</dt><dd><a href="#/admin/registro">${o.errors_day}</a></dd>
      </div></section>`;
  }

  if (sectionName === 'tiendas') {
    const all = await ctx.repo.adminBusinesses();
    const filter = ctx.query.f || '';
    const today = new Date().toISOString().slice(0, 10);
    const filters = { '': () => true, pending_review: b => b.status === 'pending_review', active: b => b.status === 'active',
      gracia: b => b.entitlements.state === 'grace', vence: b => b.subscription && b.subscription.period_end >= today && b.subscription.period_end <= plusDays(7),
      suspended: b => b.status === 'suspended', draft: b => ['draft', 'returned'].includes(b.status) };
    const list = all.filter(filters[filter] || filters['']);
    body = html`
      <div class="chips mt">${[['', 'Todas'], ['pending_review', 'En revisión'], ['active', 'Publicadas'], ['draft', 'Borradores'], ['vence', 'Vencen pronto'], ['gracia', 'En gracia'], ['suspended', 'Suspendidas']]
    .map(([key, label]) => html`<a class="chip${key === filter ? ' is-active' : ''}" href="#/admin/tiendas${key ? `?f=${key}` : ''}">${label}</a>`)}</div>
      ${list.length ? html`<div class="stack mt">${list.map(b => {
    const st = BUSINESS_STATUS[b.status];
    const info = stateInfo(b.entitlements.state);
    return html`<details class="card admin-item"${raw(b.status === 'pending_review' ? ' open' : '')}>
          <summary class="list-row">${storeLogo(b)}<span class="grow stack gap-xs"><strong>${b.name}</strong><span class="small muted">${b.locality} · ${b.category || 'sin rubro'} · ${b.products} productos</span></span>
            <span class="stack gap-xs align-end"><span class="tag ${st[0]}">${st[1]}</span><span class="tag tag-${info.tone === 'neutral' ? '' : info.tone}">${b.entitlements.plan_name || info.label}</span></span></summary>
          <div class="card-pad stack">
            <div class="kv"><dt>Titular</dt><dd>${b.owner_email || '—'}</dd><dt>Contacto</dt><dd>${b.contact?.name || '—'} · ${b.contact?.phone || '—'}</dd>
              <dt>Enlace</dt><dd><a href="#/tienda/${b.slug}">/${b.slug}</a></dd><dt>Alta</dt><dd>${longDate(b.created_at)}</dd>
              ${b.subscription ? html`<dt>Suscripción</dt><dd>${b.subscription.plan} · ${b.subscription.status} · vence ${b.subscription.period_end}</dd>` : ''}
              ${b.last_review_note ? html`<dt>Última nota</dt><dd>${b.last_review_note}</dd>` : ''}</div>
            ${b.missing.length ? html`<p class="small muted">Faltan: ${b.missing.join(', ')}</p>` : ''}
            ${b.status === 'pending_review' ? html`<div class="card card-pad stack gap-sm review-box">
              <strong>Revisión del alta</strong>
              <div class="grid-2"><div class="field"><label for="rp-${b.id}">Plan de prueba</label><select id="rp-${b.id}" class="select">${ref.plans.filter(p => p.audience === 'business').map(p => html`<option value="${p.code}">${p.name}</option>`)}</select></div>
                <div class="field"><label for="rd-${b.id}">Días de prueba</label><input id="rd-${b.id}" class="input" inputmode="numeric" value="30"></div></div>
              <div class="row wrap"><button type="button" class="btn btn-primary btn-sm" data-action="approve" data-id="${b.id}">Aprobar y publicar</button>
                <button type="button" class="btn btn-secondary btn-sm" data-action="return" data-id="${b.id}" data-name="${b.name}">Devolver con nota</button></div></div>` : ''}
            ${['active', 'paused'].includes(b.status) ? html`<button type="button" class="btn btn-danger btn-sm" data-action="suspend" data-id="${b.id}" data-name="${b.name}">Suspender</button>` : ''}
            ${b.status === 'suspended' ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="reactivate" data-id="${b.id}">Rehabilitar</button>` : ''}
            <details><summary class="link-more">Editar suscripción</summary>${subscriptionForm(ref, { kind: 'business', id: b.id }, b.subscription, 'business')}</details>
          </div></details>`;
  })}</div>` : html`<p class="muted mt">No hay tiendas en este filtro.</p>`}`;
  }

  if (sectionName === 'organizadores') {
    const list = await ctx.repo.adminOrganizers();
    body = html`
      <form class="card card-pad form mt" data-form="organizer" novalidate>
        <h2 class="section-title">Habilitar una organización de ferias</h2>
        <p class="field-hint">La persona titular tiene que tener una cuenta de CAUCE confirmada.</p>
        <div class="grid-2"><div class="field"><label for="no-name">Nombre de la organización</label><input id="no-name" name="name" class="input" maxlength="80" required></div>
          <div class="field"><label for="no-email">Correo de la titular</label><input id="no-email" name="email" type="email" class="input" required></div></div>
        <button class="btn btn-primary" type="submit">Crear organización</button>
      </form>
      ${list.length ? html`<div class="stack mt">${list.map(o => {
    const info = stateInfo(o.entitlements.state);
    return html`<details class="card admin-item"><summary class="list-row"><span class="store-logo">${o.name.slice(0, 1)}</span><span class="grow stack gap-xs"><strong>${o.name}</strong>
          <span class="small muted">${o.members.map(m => `${m.email} (${m.role === 'owner' ? 'titular' : 'equipo'})`).join(', ')} · ${o.fairs} ferias</span></span>
          <span class="stack gap-xs align-end"><span class="tag ${o.status === 'active' ? 'tag-ok' : 'tag-error'}">${o.status === 'active' ? 'Activa' : 'Suspendida'}</span><span class="tag tag-${info.tone === 'neutral' ? '' : info.tone}">${info.label}</span></span></summary>
          <div class="card-pad stack">${subscriptionForm(ref, { kind: 'organizer', id: o.id }, o.subscription, 'organizer')}
            <button type="button" class="btn btn-${o.status === 'active' ? 'danger' : 'secondary'} btn-sm" data-action="org-status" data-id="${o.id}" data-next="${o.status === 'active' ? 'suspended' : 'active'}">${o.status === 'active' ? 'Suspender organización' : 'Reactivar organización'}</button></div></details>`;
  })}</div>` : html`<p class="muted mt">Todavía no hay organizaciones.</p>`}`;
  }

  if (sectionName === 'comunidad') {
    const [all, summary, ref] = await Promise.all([ctx.repo.adminFounding(), ctx.repo.adminSurveySummary(), ctx.repo.referenceData()]);
    const entry = ref.plans.filter(p => p.audience === 'business').sort((a, b) => a.monthly_price_ars - b.monthly_price_ars)[0];
    const pilotOnly = ctx.query.piloto === '1';
    const list = pilotOnly ? all.filter(a => a.survey?.pilot) : all;
    foundingList = list;
    body = html`
      <p class="small muted mt">Preinscripciones con consentimiento (versión registrada). Si alguien pide que borren sus datos, usá «Borrar».</p>
      ${surveySummary(summary, entry ? formatARS(entry.monthly_price_ars) : 'el plan de entrada')}
      <div class="row between wrap mt">
        <div class="segmented"><a href="#/admin/comunidad"${raw(pilotOnly ? '' : ' aria-current="page"')}>Todas (${all.length})</a><a href="#/admin/comunidad?piloto=1"${raw(pilotOnly ? ' aria-current="page"' : '')}>Quieren el piloto (${all.filter(a => a.survey?.pilot).length})</a></div>
        ${list.length ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="founding-csv">${icon('download', { size: 16 })}Descargar CSV</button>` : ''}
      </div>
      ${list.length ? html`<div class="stack mt">${list.map(a => html`<article class="card card-pad stack gap-sm">
        <div class="row between wrap"><strong>${a.name}${a.business_name ? ` · ${a.business_name}` : ''}</strong><span class="tag ${FOUNDING_STATUS[a.status][0]}">${FOUNDING_STATUS[a.status][1]}</span></div>
        <div class="kv"><dt>Contacto</dt><dd>${a.contact}</dd><dt>Localidad</dt><dd>${a.locality || '—'}</dd><dt>Rubro</dt><dd>${a.category || '—'}</dd>
          <dt>Vende en ferias</dt><dd>${a.sells_at_fairs ? 'Sí' : 'No'}</dd><dt>Fecha</dt><dd>${dateTime(a.created_at)}</dd><dt>Consentimiento</dt><dd>${a.consent_version}</dd>
          ${Object.entries(a.survey || {}).map(([key, value]) => html`<dt>${key === 'pilot' ? 'Piloto' : SURVEY.find(q => q.key === key)?.label.replace(/[¿?…]|\{price\}/g, '').trim() || key}</dt><dd>${answerLabel(key, value)}</dd>`)}</div>
        ${a.message ? html`<p class="pre-line small">${a.message}</p>` : ''}
        <div class="row wrap">${['contacted', 'joined', 'declined'].filter(s => s !== a.status).map(s => html`<button type="button" class="btn btn-secondary btn-sm" data-action="founding" data-id="${a.id}" data-next="${s}">${FOUNDING_STATUS[s][1]}</button>`)}
          <button type="button" class="btn btn-ghost btn-sm" data-action="founding" data-id="${a.id}" data-next="deleted">${icon('trash', { size: 16 })}Borrar</button></div>
      </article>`)}</div>` : emptyState({ scene: 'comunidad', title: 'Sin preinscripciones todavía', text: 'Compartí #/comunidad con feriantes de la zona.' })}`;
  }

  if (sectionName === 'registro') {
    const [audit, errors] = await Promise.all([ctx.repo.adminAudit(80), ctx.repo.adminErrors(60)]);
    body = html`
      <section class="section"><h2 class="section-title mb">Auditoría</h2>
        ${audit.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Cuándo</th><th>Quién</th><th>Acción</th><th>Detalle</th></tr></thead>
          <tbody>${audit.map(a => html`<tr><td>${relative(a.at)}</td><td>${a.actor_email || a.actor_role}</td><td>${a.action}</td><td class="small">${Object.entries(a.detail || {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">Sin acciones registradas.</p>`}
      </section>
      <section class="section"><h2 class="section-title mb">Errores de la interfaz (sin datos personales)</h2>
        ${errors.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Cuándo</th><th>Tipo</th><th>Código</th><th>Mensaje</th><th>Ruta</th></tr></thead>
          <tbody>${errors.map(e => html`<tr><td>${relative(e.created_at)}</td><td>${e.kind}</td><td>${e.code}</td><td class="small">${e.message}</td><td>${e.route}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">Sin errores registrados.</p>`}
      </section>`;
  }

  const mount = root => {
    root.addEventListener('click', async event => {
      const el = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
      if (!el) return;
      const action = el.getAttribute('data-action');
      const id = el.getAttribute('data-id');
      const run = async (fn, message) => { el.classList.add('is-busy'); try { await fn(); ctx.toast(message, 'ok'); ctx.refresh(); } catch (error) { ctx.toast(error.message, 'error'); } finally { el.classList.remove('is-busy'); } };
      if (action === 'approve') {
        const plan = /** @type {HTMLSelectElement} */ (root.querySelector(`#rp-${id}`)).value;
        const days = Number(/** @type {HTMLInputElement} */ (root.querySelector(`#rd-${id}`)).value) || 30;
        await run(() => ctx.repo.reviewBusiness(id, 'active', 'Aprobada', plan, days), 'Tienda publicada con período de prueba');
      }
      if (action === 'return') {
        const note = await ctx.dialog({ title: `Devolver ${el.getAttribute('data-name')}`, text: 'La tienda ve esta nota en su panel.', confirm: 'Devolver', input: { label: 'Qué tiene que cambiar', required: true, min: 3 } });
        if (note === false) return;
        await run(() => ctx.repo.reviewBusiness(id, 'returned', String(note)), 'Devuelta con nota');
      }
      if (action === 'suspend') {
        const note = await ctx.dialog({ title: `Suspender ${el.getAttribute('data-name')}`, text: 'Deja de verse en CAUCE. Queda registrado.', confirm: 'Suspender', tone: 'danger', input: { label: 'Motivo', required: true, min: 3 } });
        if (note === false) return;
        await run(() => ctx.repo.adminSetBusinessStatus(id, 'suspended', String(note)), 'Tienda suspendida');
      }
      if (action === 'reactivate') await run(() => ctx.repo.adminSetBusinessStatus(id, 'active', ''), 'Tienda rehabilitada');
      if (action === 'org-status') await run(() => ctx.repo.adminSetOrganizerStatus(id, el.getAttribute('data-next')), 'Organización actualizada');
      if (action === 'founding-csv') {
        const blob = new Blob(['\ufeff', foundingCsv(foundingList)], { type: 'text/csv;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `cauce-ferias-comunidad-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        return;
      }
      if (action === 'founding') {
        const next = el.getAttribute('data-next');
        if (next === 'deleted' && !await ctx.dialog({ title: 'Borrar preinscripción', text: 'Se borran los datos de esta persona. No se puede deshacer.', confirm: 'Borrar', tone: 'danger' })) return;
        await run(() => ctx.repo.adminUpdateFounding(id, next), next === 'deleted' ? 'Datos borrados' : 'Actualizada');
      }
    });
    root.querySelectorAll('[data-form="subscription"]').forEach(form => form.addEventListener('submit', async event => {
      event.preventDefault();
      const f = /** @type {HTMLFormElement} */ (event.currentTarget);
      const data = new FormData(f);
      const button = f.querySelector('button');
      button.classList.add('is-busy');
      try {
        await ctx.repo.adminSetSubscription({ businessId: f.getAttribute('data-business'), organizerId: f.getAttribute('data-organizer'),
          plan: String(data.get('plan')), status: String(data.get('status')), periodEnd: String(data.get('period_end')),
          graceDays: Math.max(0, Math.min(60, Number(data.get('grace')) || 0)), note: clean(data.get('note'), 300) });
        ctx.toast('Suscripción guardada', 'ok'); ctx.refresh();
      } catch (error) { ctx.toast(error.message, 'error'); } finally { button.classList.remove('is-busy'); }
    }));
    root.querySelector('[data-form="organizer"]')?.addEventListener('submit', async event => {
      event.preventDefault();
      const data = new FormData(/** @type {HTMLFormElement} */ (event.currentTarget));
      const name = clean(data.get('name'), 80); const email = clean(data.get('email'), 120);
      if (name.length < 2 || !isEmail(email)) { ctx.toast('Completá nombre y correo.', 'error'); return; }
      try { await ctx.repo.adminCreateOrganizer(name, email); ctx.toast('Organización creada', 'ok'); ctx.refresh(); } catch (error) { ctx.toast(error.message, 'error'); }
    });
  };

  return {
    chrome: 'admin', nav, title: 'Administración',
    html: html`${pageHeader('Administración', { back: false })}
      ${banner('', 'Piloto: suscripciones manuales', 'No hay cobros automáticos. Activá o renová planes cuando confirmes el pago por fuera de CAUCE.', 'shield')}
      ${tabs}${body}`,
    mount,
  };
}
