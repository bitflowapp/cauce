// Panel del organizador: crear y editar ferias, publicar o cancelar, revisar
// inscripciones, asignar puestos, avisar a participantes, compartir y métricas.
// La base sólo deja tocar las ferias de la propia organización.
import { html, raw, attr } from '../../core/html.js';
import { longDate, timeRange, toLocalInput, fromLocalInput, relative } from '../../core/dates.js';
import { clean, cleanMultiline, normalizeWhatsapp, normalizeInstagram, isEmail } from '../../core/validators.js';
import { stateInfo } from '../../core/plans.js';
import { mapUrl, whatsappUrl } from '../../core/links.js';
import { qrSvg } from '../../core/qr.js';
import { icon } from '../icons.js';
import { emptyState, banner, pageHeader, fairArt, storeLogo, initials } from '../components.js';

const ORG_KEY = 'ferias:organizer:v1';
const TENT = '<svg viewBox="0 0 64 56" width="64" height="56"><path d="M6 24 32 6l26 18" fill="none" stroke="#e8572a" stroke-width="4" stroke-linejoin="round"/><path d="M6 24h52v6c-4 4-9 4-13 0-4 4-9 4-13 0-4 4-9 4-13 0-4 4-9 4-13 0z" fill="#e8572a"/><path d="M12 30v22M52 30v22M22 52V36h20v16" fill="none" stroke="#b5432a" stroke-width="4" stroke-linecap="round"/><path d="M32 6V2" stroke="#b5432a" stroke-width="3" stroke-linecap="round"/></svg>';
const STATUS = { draft: ['tag-warn', 'Borrador'], published: ['tag-ok', 'Publicada'], canceled: ['tag-error', 'Cancelada'] };
function pickOrganizer(ctx) {
  const list = ctx.session.organizers;
  let stored = '';
  try { stored = localStorage.getItem(ORG_KEY) || ''; } catch { /* sin almacenamiento */ }
  const found = list.find(o => o.organizerId === (ctx.query.org || stored)) || list[0];
  try { localStorage.setItem(ORG_KEY, found.organizerId); } catch { /* sin almacenamiento */ }
  return found;
}
function gate(ctx) {
  if (ctx.session.kind !== 'account') return { redirect: '/cuenta?next=%2Forganizador' };
  if (!ctx.session.organizers.length) {
    return { chrome: 'shop', nav: '', title: 'Organizador', html: html`${pageHeader('Organizar ferias')}
      ${emptyState({ scene: 'explorando', title: 'Todavía no organizás ferias', text: 'La administración de CAUCE habilita a las organizaciones de ferias. Contanos de tu feria y te sumamos.',
        action: html`<div class="row wrap"><a class="btn btn-primary" href="#/comunidad">Contactar a CAUCE</a><a class="btn btn-secondary" href="#/planes">Ver Plan Organizador</a></div>` })}` };
  }
  return null;
}

function fairFormHtml(ref, fair = null) {
  const f = fair || { name: '', venue: '', address: '', description: '', localitySlug: 'neuquen', startsAt: '', endsAt: '', stallCapacity: '', applicationsOpen: true, latitude: null, longitude: null };
  return html`<form class="form" data-form="fair" novalidate>
    <section class="card card-pad stack">
      <div class="field"><label for="fa-name">Nombre de la feria</label><input id="fa-name" name="name" class="input" maxlength="100" required value="${f.name}" placeholder="Ej.: Feria del Parque Central"></div>
      <div class="grid-2">
        <div class="field"><label for="fa-start">Empieza</label><input id="fa-start" name="starts" type="datetime-local" class="input" required value="${f.startsAt ? toLocalInput(f.startsAt) : ''}"></div>
        <div class="field"><label for="fa-end">Termina</label><input id="fa-end" name="ends" type="datetime-local" class="input" required value="${f.endsAt ? toLocalInput(f.endsAt) : ''}"></div>
      </div>
      <p class="field-hint">Hora de Neuquén.</p>
      <div class="grid-2">
        <div class="field"><label for="fa-venue">Lugar</label><input id="fa-venue" name="venue" class="input" maxlength="120" required value="${f.venue}" placeholder="Ej.: Parque Central"></div>
        <div class="field"><label for="fa-loc">Localidad</label><select id="fa-loc" name="locality" class="select">${ref.localities.map(l => html`<option value="${l.slug}"${raw(l.slug === f.localitySlug ? ' selected' : '')}>${l.name}</option>`)}</select></div>
      </div>
      <div class="field"><label for="fa-address">Dirección o referencia</label><input id="fa-address" name="address" class="input" maxlength="200" value="${f.address}" placeholder="Ej.: Av. Argentina y Roca"></div>
      <div class="grid-2">
        <div class="field"><label for="fa-lat">Latitud <span class="muted">(opcional)</span></label><input id="fa-lat" name="latitude" class="input" inputmode="decimal" value="${f.latitude ?? ''}"></div>
        <div class="field"><label for="fa-lng">Longitud</label><input id="fa-lng" name="longitude" class="input" inputmode="decimal" value="${f.longitude ?? ''}"></div>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-action="locate">${icon('pin', { size: 16 })}Usar mi ubicación actual</button>
      <p class="field-hint">Con la ubicación, el botón «Cómo llegar» lleva justo al lugar.</p>
      <div class="field"><label for="fa-desc">Descripción</label><textarea id="fa-desc" name="description" class="textarea" maxlength="1200" rows="4" placeholder="Qué se va a encontrar, música, comida, accesibilidad…">${f.description}</textarea></div>
      <div class="grid-2">
        <div class="field"><label for="fa-cap">Cantidad de puestos <span class="muted">(opcional)</span></label><input id="fa-cap" name="capacity" class="input" inputmode="numeric" value="${f.stallCapacity ?? ''}"></div>
        <label class="switch"><span><strong>Inscripciones abiertas</strong></span><input type="checkbox" name="open"${raw(f.applicationsOpen ? ' checked' : '')}></label>
      </div>
    </section>
    <p class="field-error" id="fa-error" role="alert" hidden></p>
    <div class="buy-bar"><button class="btn btn-primary" type="submit">${fair ? 'Guardar cambios' : 'Crear feria'}</button></div>
  </form>`;
}

function readFairForm(form) {
  const data = new FormData(form);
  const startsAt = fromLocalInput(String(data.get('starts')));
  const endsAt = fromLocalInput(String(data.get('ends')));
  const lat = String(data.get('latitude') || '').replace(',', '.').trim();
  const lng = String(data.get('longitude') || '').replace(',', '.').trim();
  const capacity = String(data.get('capacity') || '').replace(/\D/g, '');
  const value = { name: clean(data.get('name'), 100), venue: clean(data.get('venue'), 120), address: clean(data.get('address'), 200),
    locality: String(data.get('locality')), description: cleanMultiline(data.get('description'), 1200), startsAt, endsAt,
    latitude: lat === '' ? null : Number(lat), longitude: lng === '' ? null : Number(lng),
    capacity: capacity ? Number(capacity) : null, open: Boolean(data.get('open')) };
  const problem = value.name.length < 3 ? 'El nombre necesita al menos 3 letras.' : value.venue.length < 2 ? 'Indicá el lugar.'
    : !startsAt || !endsAt ? 'Completá fecha y hora de inicio y de cierre.' : new Date(endsAt) <= new Date(startsAt) ? 'El cierre tiene que ser después del inicio.'
      : (value.latitude === null) !== (value.longitude === null) ? 'Completá latitud y longitud, o dejá ambas vacías.'
        : value.latitude !== null && (!Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90 || !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180) ? 'Revisá las coordenadas.'
          : value.capacity !== null && (value.capacity < 1 || value.capacity > 2000) ? 'Los puestos van de 1 a 2000.' : '';
  return { value, problem };
}

function bindLocate(root, ctx) {
  root.querySelector('[data-action="locate"]')?.addEventListener('click', () => {
    if (!navigator.geolocation) { ctx.toast('Este dispositivo no comparte ubicación.', 'error'); return; }
    navigator.geolocation.getCurrentPosition(position => {
      /** @type {HTMLInputElement} */ (root.querySelector('#fa-lat')).value = position.coords.latitude.toFixed(6);
      /** @type {HTMLInputElement} */ (root.querySelector('#fa-lng')).value = position.coords.longitude.toFixed(6);
      ctx.toast('Ubicación cargada.', 'ok');
    }, () => ctx.toast('No pudimos obtener la ubicación. Podés escribirla.', 'error'), { enableHighAccuracy: true, timeout: 10000 });
  });
}

// ══════════ inicio / nueva / equipo ══════════
export async function home(ctx) {
  const blocked = gate(ctx); if (blocked) return blocked;
  const org = pickOrganizer(ctx);
  const sectionName = ctx.params.section || '';
  const ref = await ctx.repo.referenceData();
  if (sectionName === 'nueva') {
    return { chrome: 'organizer', nav: 'nueva', title: 'Nueva feria',
      html: html`${pageHeader('Nueva feria', { backHref: '#/organizador' })}<p class="small muted mt">Se crea como borrador: la publicás cuando esté lista.</p><div class="mt">${fairFormHtml(ref)}</div>`,
      mount(root) {
        bindLocate(root, ctx);
        root.querySelector('[data-form="fair"]').addEventListener('submit', async event => {
          event.preventDefault();
          const form = /** @type {HTMLFormElement} */ (event.currentTarget);
          const { value, problem } = readFairForm(form);
          const error = root.querySelector('#fa-error');
          if (problem) { error.textContent = problem; error.hidden = false; return; }
          const button = form.querySelector('button[type="submit"]');
          button.classList.add('is-busy');
          try {
            const created = await ctx.repo.createFair(org.organizerId, { name: value.name, venue: value.venue, address: value.address, locality: value.locality,
              description: value.description, starts_at: value.startsAt, ends_at: value.endsAt, latitude: value.latitude, longitude: value.longitude,
              stall_capacity: value.capacity, applications_open: value.open });
            ctx.toast('Feria creada como borrador.', 'ok');
            ctx.navigate(`/organizador/feria/${created.id}`);
          } catch (caught) { error.textContent = caught.message; error.hidden = false; } finally { button.classList.remove('is-busy'); }
        });
      } };
  }
  if (sectionName === 'equipo') {
    const organizer = await ctx.repo.organizer(org.organizerId);
    return { chrome: 'organizer', nav: 'equipo', title: 'Organización',
      html: html`${pageHeader('Tu organización', { backHref: '#/organizador' })}
        <form class="card card-pad form mt" data-form="org" novalidate>
          <div class="field"><label for="og-name">Nombre</label><input id="og-name" name="name" class="input" maxlength="80" value="${organizer.name}"${attr('disabled', org.role !== 'owner')}></div>
          <div class="field"><label for="og-desc">Descripción</label><textarea id="og-desc" name="description" class="textarea" maxlength="400" rows="3"${attr('disabled', org.role !== 'owner')}>${organizer.description}</textarea></div>
          <div class="grid-2"><div class="field"><label for="og-wa">WhatsApp de consultas</label><input id="og-wa" name="whatsapp" class="input" value="${organizer.whatsapp}"${attr('disabled', org.role !== 'owner')}></div>
          <div class="field"><label for="og-ig">Instagram</label><input id="og-ig" name="instagram" class="input" value="${organizer.instagram}"${attr('disabled', org.role !== 'owner')}></div></div>
          ${org.role === 'owner' ? html`<button class="btn btn-secondary" type="submit">Guardar</button>` : html`<p class="small muted">Sólo la persona titular edita estos datos.</p>`}
        </form>
        ${org.role === 'owner' ? html`<form class="card card-pad form mt" data-form="editor" novalidate>
          <h2 class="section-title">Sumar a alguien del equipo</h2><p class="field-hint">Puede editar ferias e inscripciones. Necesita una cuenta de CAUCE.</p>
          <div class="field"><label for="og-email">Correo</label><input id="og-email" name="email" type="email" class="input" required></div>
          <button class="btn btn-primary" type="submit">Sumar</button></form>` : ''}`,
      mount(root) {
        root.querySelector('[data-form="org"]')?.addEventListener('submit', async event => {
          event.preventDefault();
          const data = new FormData(/** @type {HTMLFormElement} */ (event.currentTarget));
          const wa = clean(data.get('whatsapp'), 30);
          if (wa && !normalizeWhatsapp(wa)) { ctx.toast('Revisá el WhatsApp.', 'error'); return; }
          try { await ctx.repo.updateOrganizer(org.organizerId, { name: clean(data.get('name'), 80), description: cleanMultiline(data.get('description'), 400),
            whatsapp: normalizeWhatsapp(wa), instagram: normalizeInstagram(data.get('instagram')) }); ctx.toast('Guardado', 'ok'); }
          catch (error) { ctx.toast(error.message, 'error'); }
        });
        root.querySelector('[data-form="editor"]')?.addEventListener('submit', async event => {
          event.preventDefault();
          const email = clean(new FormData(/** @type {HTMLFormElement} */ (event.currentTarget)).get('email'), 120);
          if (!isEmail(email)) { ctx.toast('Revisá el correo.', 'error'); return; }
          try { await ctx.repo.addOrganizerMember(org.organizerId, email); ctx.toast('¡Sumada al equipo!', 'ok'); } catch (error) { ctx.toast(error.message, 'error'); }
        });
      } };
  }
  const [overview, fairs] = await Promise.all([ctx.repo.organizerOverview(org.organizerId), ctx.repo.organizerFairs(org.organizerId)]);
  const now = Date.now();
  const upcoming = fairs.filter(f => f.status !== 'draft' && new Date(f.endsAt).getTime() > now).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const drafts = fairs.filter(f => f.status === 'draft');
  const past = fairs.filter(f => f.status !== 'draft' && new Date(f.endsAt).getTime() <= now);
  const info = stateInfo(overview.state);
  const row = f => html`<a class="list-row" href="#/organizador/feria/${f.id}"><span class="thumb">${f.cover ? html`<img src="${f.cover}" alt="" width="56" height="56">` : fairArt()}</span>
    <span class="grow stack gap-xs"><strong>${f.name}</strong><span class="small muted">${longDate(f.startsAt)} · ${f.venue}</span></span>
    <span class="tag ${STATUS[f.status][0]}">${STATUS[f.status][1]}</span>${icon('chevron-right', { size: 18 })}</a>`;
  return {
    chrome: 'organizer', nav: 'ferias', title: 'Mis ferias',
    html: html`
      <div class="panel-head"><span class="store-logo">${initials(org.name)}</span><div class="grow"><p class="panel-head-kicker">Organización</p><p class="panel-head-name">${org.name}</p></div>
        <a class="btn btn-primary btn-sm" href="#/organizador/nueva">${icon('plus', { size: 16 })}Nueva feria</a></div>
      ${ctx.session.organizers.length > 1 ? html`<div class="chips mb">${ctx.session.organizers.map(o => html`<a class="chip${o.organizerId === org.organizerId ? ' is-active' : ''}" href="#/organizador?org=${o.organizerId}">${o.name}</a>`)}</div>` : ''}
      <div class="stack">
        ${overview.can_publish ? html`<p class="small muted">${info.label}${overview.period_end ? ` hasta el ${longDate(overview.period_end)}` : ''} · ${overview.active_fairs} de ${overview.max_active_fairs} ferias publicadas.</p>`
    : banner('warn', 'Para publicar ferias necesitás el Plan Organizador vigente', 'Podés armar borradores. La administración de CAUCE activa el plan durante el piloto.', 'info')}
        <section><h2 class="section-title mb">Próximas</h2>${upcoming.length ? html`<div class="card">${upcoming.map(row)}</div>` : html`<p class="muted">No hay ferias publicadas próximas.</p>`}</section>
        ${drafts.length ? html`<section><h2 class="section-title mb">Borradores</h2><div class="card">${drafts.map(row)}</div></section>` : ''}
        ${past.length ? html`<section><h2 class="section-title mb">Anteriores</h2><div class="card">${past.map(row)}</div></section>` : ''}
        ${!fairs.length ? emptyState({ scene: 'explorando', title: 'Creá tu primera feria', text: 'Fecha, lugar y puestos. Después recibís inscripciones de las tiendas.',
          action: html`<a class="btn btn-primary" href="#/organizador/nueva">Nueva feria</a>` }) : ''}
      </div>`,
  };
}

// ══════════ una feria ══════════
export async function fair(ctx) {
  const blocked = gate(ctx); if (blocked) return blocked;
  const tab = ['resumen', 'participantes', 'puestos', 'avisos', 'editar'].includes(ctx.query.tab) ? ctx.query.tab : 'resumen';
  const [ref, f] = await Promise.all([ctx.repo.referenceData(), ctx.repo.organizerFair(ctx.params.id)]);
  const [stats, applications, announcements] = await Promise.all([ctx.repo.fairStats(f.id), ctx.repo.fairApplications(f.id), ctx.repo.announcements(f.id)]);
  const url = `${ctx.repo.siteUrl || location.href.split('#')[0]}#/feria/${f.slug}`;
  const requested = applications.filter(a => a.status === 'requested');
  const confirmed = applications.filter(a => a.status === 'confirmed');
  const others = applications.filter(a => ['rejected', 'withdrawn'].includes(a.status));
  const tabLink = (key, label) => html`<a href="#/organizador/feria/${f.id}?tab=${key}"${raw(key === tab ? ' aria-current="page"' : '')}>${label}</a>`;
  const businessLine = a => html`${storeLogo(a.business)}<span class="grow stack gap-xs"><a class="fair-link" href="#/tienda/${a.business.slug}"><strong>${a.business.name}</strong></a>
    <span class="small muted">${[a.business.category, a.business.locality].filter(Boolean).join(' · ')}</span></span>`;
  let content;
  if (tab === 'resumen') {
    content = html`
      <div class="stats mt">
        <div class="stat"><span class="stat-value">${stats.requested + stats.confirmed}</span><span class="stat-label">Artesanos</span></div>
        <a class="stat${stats.requested ? ' is-alert' : ''}" href="#/organizador/feria/${f.id}?tab=participantes"><span class="stat-value">${stats.requested}</span><span class="stat-label">Pendientes</span></a>
        <div class="stat"><span class="stat-value">${stats.confirmed}${stats.capacity ? html`<span class="small muted">/${stats.capacity}</span>` : ''}</span><span class="stat-label">Confirmados</span></div>
      </div>
      <nav class="menu mt">
        <a class="menu-item" href="#/organizador/feria/${f.id}?tab=editar">${icon('edit')}<span>Editar información</span>${icon('chevron-right', { size: 18 })}</a>
        <a class="menu-item" href="#/organizador/feria/${f.id}?tab=puestos">${icon('store')}<span>Gestionar puestos</span><span class="menu-note">${stats.stalls_assigned} asignados</span>${icon('chevron-right', { size: 18 })}</a>
        <a class="menu-item" href="${mapUrl(f)}" target="_blank" rel="noopener noreferrer">${icon('map')}<span>Ver mapa de la feria</span>${icon('chevron-right', { size: 18 })}</a>
        <a class="menu-item" href="#/organizador/feria/${f.id}?tab=avisos">${icon('megaphone')}<span>Comunicar a participantes</span><span class="menu-note">${stats.announcements || ''}</span>${icon('chevron-right', { size: 18 })}</a>
        <button type="button" class="menu-item" data-action="share">${icon('qr')}<span>Compartir evento</span>${icon('chevron-right', { size: 18 })}</button>
      </nav>
      <section class="card card-pad stack mt">
        <h2 class="section-title">Estado</h2>
        <p><span class="tag ${STATUS[f.status][0]}">${STATUS[f.status][1]}</span> ${f.status === 'canceled' && f.cancelReason ? html`<span class="small muted">· ${f.cancelReason}</span>` : ''}</p>
        <p class="small muted">Pedidos con retiro en esta feria: ${stats.pickup_orders} (los importes son privados de cada tienda).</p>
        <div class="row wrap">
          ${f.status === 'draft' ? html`<button type="button" class="btn btn-primary" data-action="status" data-next="published">Publicar feria</button>` : ''}
          ${f.status === 'published' ? html`<a class="btn btn-secondary" href="#/feria/${f.slug}">${icon('eye', { size: 16 })}Ver página pública</a>
            <button type="button" class="btn btn-danger" data-action="status" data-next="canceled">Cancelar feria</button>
            ${!applications.some(a => ['requested', 'confirmed'].includes(a.status)) ? html`<button type="button" class="btn btn-ghost" data-action="status" data-next="draft">Volver a borrador</button>` : ''}` : ''}
          ${f.status === 'canceled' ? html`<button type="button" class="btn btn-primary" data-action="status" data-next="published">Reactivar</button>` : ''}
        </div>
      </section>`;
  } else if (tab === 'participantes') {
    content = html`
      <section class="section"><h2 class="section-title mb">Solicitudes (${requested.length})</h2>
        ${requested.length ? html`<div class="card">${requested.map(a => html`<div class="list-row list-row-wrap">${businessLine(a)}
          <span class="row wrap"><label class="sr-only" for="stall-${a.id}">Puesto para ${a.business.name}</label><input id="stall-${a.id}" class="input input-stall" maxlength="12" placeholder="Puesto">
          <button type="button" class="btn btn-primary btn-sm" data-action="confirm" data-id="${a.id}">Confirmar</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="reject" data-id="${a.id}" data-name="${a.business.name}">Rechazar</button></span></div>`)}</div>`
    : html`<p class="muted">No hay solicitudes pendientes.</p>`}
      </section>
      <section class="section"><h2 class="section-title mb">Confirmados (${confirmed.length})</h2>
        ${confirmed.length ? html`<div class="card">${confirmed.map(a => html`<div class="list-row">${businessLine(a)}${a.stall_code ? html`<span class="tag tag-terra">Puesto ${a.stall_code}</span>` : html`<span class="tag tag-warn">Sin puesto</span>`}
          ${a.business.whatsapp ? html`<a class="icon-btn" href="${whatsappUrl(a.business.whatsapp, `Hola ${a.business.name}, te escribo por ${f.name}.`)}" target="_blank" rel="noopener noreferrer" aria-label="WhatsApp a ${a.business.name}">${icon('whatsapp')}</a>` : ''}</div>`)}</div>`
    : html`<p class="muted">Todavía nadie confirmado.</p>`}
      </section>
      <form class="card card-pad form mt" data-form="add" novalidate>
        <h2 class="section-title">Sumar una tienda directamente</h2>
        <p class="field-hint">Pegá el enlace de su tienda en CAUCE (o la parte final, por ejemplo «tierra-viva»).</p>
        <div class="grid-2"><div class="field"><label for="ad-slug">Tienda</label><input id="ad-slug" name="slug" class="input" required></div>
          <div class="field"><label for="ad-stall">Puesto <span class="muted">(opcional)</span></label><input id="ad-stall" name="stall" class="input" maxlength="12"></div></div>
        <button class="btn btn-secondary" type="submit">Sumar a la feria</button>
      </form>
      ${others.length ? html`<section class="section"><h2 class="section-title mb">Rechazadas o dadas de baja</h2><div class="card">${others.map(a => html`<div class="list-row">${businessLine(a)}<span class="tag">${a.status === 'rejected' ? 'Rechazada' : 'Se dio de baja'}</span></div>`)}</div></section>` : ''}`;
  } else if (tab === 'puestos') {
    content = html`
      <p class="small muted mt">Asigná un código a cada puesto (letras, números o guiones). Las tiendas lo ven en su panel y quien compra lo ve en su pedido.</p>
      ${confirmed.length ? html`<div class="card mt">${confirmed.sort((a, b) => String(a.stall_code || '~').localeCompare(String(b.stall_code || '~'))).map(a => html`<div class="list-row list-row-wrap">${businessLine(a)}
        <span class="row"><label class="sr-only" for="ps-${a.id}">Puesto de ${a.business.name}</label><input id="ps-${a.id}" class="input input-stall" maxlength="12" value="${a.stall_code || ''}" placeholder="A1">
        <button type="button" class="btn btn-secondary btn-sm" data-action="stall" data-id="${a.id}">Guardar</button></span></div>`)}</div>`
    : emptyState({ scene: 'explorando', title: 'Sin participantes confirmados', text: 'Confirmá solicitudes para asignar puestos.' })}`;
  } else if (tab === 'avisos') {
    content = html`
      <form class="card card-pad form mt" data-form="announce" novalidate>
        <div class="field"><label for="an-body">Aviso para las tiendas confirmadas</label><textarea id="an-body" name="body" class="textarea" maxlength="600" rows="3" placeholder="Ej.: El armado empieza a las 8:00 por calle Roca."></textarea></div>
        <button class="btn btn-primary" type="submit">${icon('megaphone', { size: 16 })}Publicar aviso</button>
        <p class="xsmall muted">Lo ven sólo las tiendas confirmadas, en «Mis ferias».</p>
      </form>
      ${announcements.length ? html`<div class="card mt">${announcements.map(a => html`<div class="list-row"><span class="grow stack gap-xs"><span class="pre-line">${a.body}</span><span class="xsmall muted">${relative(a.created_at)}</span></span>
        <button type="button" class="icon-btn" data-action="delete-announcement" data-id="${a.id}" aria-label="Borrar aviso">${icon('trash', { size: 18 })}</button></div>`)}</div>` : ''}`;
  } else {
    content = html`<div class="mt">
      <section class="card card-pad stack mb"><h2 class="section-title">Foto de portada</h2>
        <label class="image-slot cover-slot">${f.cover ? html`<img src="${f.cover}" alt="Portada actual" width="240" height="120">` : html`${icon('image', { size: 24 })}<span>Subir foto</span>`}
          <input type="file" accept="image/jpeg,image/png,image/webp" data-upload="cover"></label></section>
      ${fairFormHtml(ref, f)}</div>`;
  }
  return {
    chrome: 'organizer', nav: 'ferias', title: f.name,
    html: html`
      <div class="row mb"><a class="icon-btn solid" href="#/organizador" aria-label="Volver a mis ferias">${icon('chevron-left')}</a><span class="small muted">Mis ferias</span></div>
      <section class="card card-pad org-fair-head">
        <span class="store-logo">${f.cover ? html`<img src="${f.cover}" alt="" width="56" height="56">` : initials(f.name)}</span>
        <div class="grow stack gap-xs"><h1 class="panel-head-name">${f.name}</h1>
          <span class="small muted"><span class="first-cap">${longDate(f.startsAt)}</span> · ${timeRange(f.startsAt, f.endsAt)} · ${f.locality}</span></div>
        <span class="org-tent" aria-hidden="true">${raw(TENT)}</span>
      </section>
      <nav class="segmented mt" aria-label="Secciones de la feria">${tabLink('resumen', 'Resumen')}${tabLink('participantes', `Participantes${requested.length ? ` (${requested.length})` : ''}`)}${tabLink('puestos', 'Puestos')}${tabLink('avisos', 'Avisos')}${tabLink('editar', 'Editar')}</nav>
      ${content}`,
    mount(root) {
      bindLocate(root, ctx);
      root.addEventListener('click', async event => {
        const el = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        const id = el.getAttribute('data-id');
        const run = async (fn, message) => { el.classList.add('is-busy'); try { await fn(); ctx.toast(message, 'ok'); ctx.refresh(); } catch (error) { ctx.toast(error.message, 'error'); } finally { el.classList.remove('is-busy'); } };
        if (action === 'share') {
          const ok = await ctx.dialog({ title: `Compartir ${f.name}`, confirm: 'Copiar enlace', cancel: 'Cerrar', body: html`<div class="qr-card">${raw(qrSvg(url, { label: `QR de ${f.name}` }))}
            <input class="input" readonly value="${url}" aria-label="Enlace"></div>` });
          if (ok) { try { await navigator.clipboard.writeText(url); ctx.toast('Enlace copiado'); } catch { ctx.toast('Copiá el enlace del cuadro.'); } }
        }
        if (action === 'status') {
          const next = el.getAttribute('data-next');
          let reason = '';
          if (next === 'canceled') {
            const answer = await ctx.dialog({ title: 'Cancelar la feria', text: 'Se muestra como cancelada en el calendario y en los pedidos con retiro.', confirm: 'Cancelar feria', tone: 'danger', input: { label: 'Motivo', required: true, min: 3 } });
            if (answer === false) return;
            reason = String(answer);
          }
          await run(() => ctx.repo.setFairStatus(f.id, next, reason), next === 'published' ? '¡Feria publicada!' : next === 'canceled' ? 'Feria cancelada' : 'Volvió a borrador');
        }
        if (action === 'confirm') {
          const stall = /** @type {HTMLInputElement} */ (root.querySelector(`#stall-${id}`)).value.trim();
          await run(() => ctx.repo.decideParticipation(id, 'confirmed', stall || null), 'Participación confirmada');
        }
        if (action === 'reject') {
          const answer = await ctx.dialog({ title: `Rechazar a ${el.getAttribute('data-name')}`, text: 'La tienda va a ver el motivo.', confirm: 'Rechazar', tone: 'danger', input: { label: 'Motivo (opcional)', required: false } });
          if (answer === false) return;
          await run(() => ctx.repo.decideParticipation(id, 'rejected', null, String(answer)), 'Solicitud rechazada');
        }
        if (action === 'stall') {
          const stall = /** @type {HTMLInputElement} */ (root.querySelector(`#ps-${id}`)).value.trim();
          await run(() => ctx.repo.decideParticipation(id, 'confirmed', stall || null), 'Puesto guardado');
        }
        if (action === 'delete-announcement') {
          if (!await ctx.dialog({ title: 'Borrar aviso', confirm: 'Borrar', tone: 'danger' })) return;
          await run(() => ctx.repo.deleteAnnouncement(id), 'Aviso borrado');
        }
      });
      root.querySelector('[data-form="add"]')?.addEventListener('submit', async event => {
        event.preventDefault();
        const data = new FormData(/** @type {HTMLFormElement} */ (event.currentTarget));
        const slug = String(data.get('slug') || '').trim().replace(/^.*#\/tienda\//, '').replace(/[/?#].*$/, '').toLowerCase();
        try { await ctx.repo.addFairParticipant(f.id, slug, clean(data.get('stall'), 12) || null); ctx.toast('Tienda sumada', 'ok'); ctx.refresh(); } catch (error) { ctx.toast(error.message, 'error'); }
      });
      root.querySelector('[data-form="announce"]')?.addEventListener('submit', async event => {
        event.preventDefault();
        const body = cleanMultiline(new FormData(/** @type {HTMLFormElement} */ (event.currentTarget)).get('body'), 600);
        if (body.length < 3) { ctx.toast('Escribí el aviso.', 'error'); return; }
        try { await ctx.repo.postAnnouncement(f.id, body); ctx.toast('Aviso publicado', 'ok'); ctx.refresh(); } catch (error) { ctx.toast(error.message, 'error'); }
      });
      root.querySelector('[data-upload="cover"]')?.addEventListener('change', async event => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        if (!input.files?.[0]) return;
        try { await ctx.repo.setFairCover(f, input.files[0]); ctx.toast('Portada actualizada', 'ok'); ctx.refresh(); } catch (error) { ctx.toast(error.message, 'error'); }
      });
      root.querySelector('[data-form="fair"]')?.addEventListener('submit', async event => {
        event.preventDefault();
        const form = /** @type {HTMLFormElement} */ (event.currentTarget);
        const { value, problem } = readFairForm(form);
        const error = root.querySelector('#fa-error');
        if (problem) { error.textContent = problem; error.hidden = false; return; }
        const button = form.querySelector('button[type="submit"]');
        button.classList.add('is-busy');
        try {
          await ctx.repo.updateFair(f.id, { name: value.name, venue: value.venue, address: value.address, description: value.description,
            locality_id: ref.localityBySlug.get(value.locality)?.id, starts_at: value.startsAt, ends_at: value.endsAt,
            latitude: value.latitude, longitude: value.longitude, stall_capacity: value.capacity, applications_open: value.open });
          ctx.toast('Cambios guardados', 'ok');
          ctx.navigate(`/organizador/feria/${f.id}`);
        } catch (caught) { error.textContent = caught.message; error.hidden = false; } finally { button.classList.remove('is-busy'); }
      });
    },
  };
}

