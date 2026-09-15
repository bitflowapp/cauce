import { CONFIG } from './config.js';
import { createRepository } from './repositories/repository-factory.js';
import { DEMO_CUSTOMER_ID, DEMO_STORAGE_KEY } from './repositories/demo-repository.js';
import { scopeOf } from './core/scope.js';
import { allowedActions, STATUS_LABELS } from './core/workflow-policy.js';
import { confirmedPrice, isCommerciallyPurchasable } from './core/commercial.js';

const main = document.querySelector('#main');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const money = value => new Intl.NumberFormat(CONFIG.locale, { style:'currency', currency:'ARS', maximumFractionDigits:0 }).format(value);
const customerActor = { kind:'customer', id:DEMO_CUSTOMER_ID };
const searchState = { query:'', category:'Todos', onlyOpen:false };
const formValues = new Map();
let repository;
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer); const element = document.querySelector('#toast');
  element.textContent = message; element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, 4200);
}
const go = hash => { location.hash = hash; };
const route = () => location.hash.slice(1).split('/').filter(Boolean);
const themes = new Set(['sage','clay','sand']);
const theme = business => themes.has(business.theme) ? business.theme : 'sage';
const back = (href = '#home', label = 'Volver a los comercios') => `<a class="back" href="${esc(href)}">← ${esc(label)}</a>`;
const empty = (title, message, href='#home', label='Ver comercios') => `<section class="empty"><h2>${esc(title)}</h2><p>${esc(message)}</p><a class="button" href="${esc(href)}">${esc(label)}</a></section>`;
const demoNotice = () => `<div class="notice"><strong>Estás probando un circuito local, no un servicio en funcionamiento.</strong>Los comercios y los datos son ficticios. Los botones de comercio y reparto simulan roles; no constituyen un inicio de sesión seguro.</div>`;
const merchantActor = business => ({ kind:'merchant', ...scopeOf(business) });
const countCart = cart => cart.lines.reduce((total, line) => total + line.quantity, 0);
const availability = b => `<span class="availability ${b.open?'':'closed'}">${b.open?'Abierto en demo':'Cerrado en demo'}</span>`;
function updateNavigation() {
  const state = repository.snapshot();
  const count = state.businesses.reduce((total,b) => total + countCart(repository.cart(b.id)),0);
  document.querySelector('#cart-count').textContent = String(count);
}
function storesMarkup() {
  const needle = searchState.query.trim().toLocaleLowerCase('es-AR').normalize('NFD').replace(/\p{Diacritic}/gu,'');
  const normalize = value => value.toLocaleLowerCase('es-AR').normalize('NFD').replace(/\p{Diacritic}/gu,'');
  const stores = repository.snapshot().businesses.filter(b => b.localityId === CONFIG.defaultLocality && b.active)
    .filter(b => !searchState.onlyOpen || b.open)
    .filter(b => searchState.category === 'Todos' || b.category === searchState.category)
    .filter(b => normalize(`${b.name} ${b.category} ${b.description}`).includes(needle));
  if (!stores.length) return empty('No encontramos coincidencias', 'Probá otra búsqueda o quitá los filtros.');
  return `<div class="stores">${stores.map(b => `<a class="store-card" href="#shop/${esc(b.id)}" data-testid="store-card">
    <div class="store-art theme-${theme(b)}" aria-hidden="true"><span class="demo-tag">COMERCIO FICTICIO</span><span class="store-monogram">${esc(b.initials)}</span></div>
    <div class="store-info"><div class="store-title"><h3>${esc(b.name)}</h3>${availability(b)}</div><p class="store-category">${esc(b.category)}</p>
    <div class="store-meta"><span>${esc(b.eta)}</span><span>${b.deliveryEnabled?`Envío ${money(b.deliveryFee)}`:'Solo retiro'}</span><span>Retiro gratis</span></div></div></a>`).join('')}</div>`;
}
function home() {
  const businesses = repository.snapshot().businesses.filter(b => b.localityId === CONFIG.defaultLocality && b.active);
  const categories = ['Todos', ...new Set(businesses.map(b=>b.category))];
  return `<section class="hero"><div class="hero-text"><span class="eyebrow">COMIDA LOCAL · ALUMINÉ</span><h1>Lo rico de acá,<br><em>a un toque.</em></h1><p>Elegí tu comercio, encontrá algo rico y decidí: lo retirás o te lo llevan.</p><div class="hero-note"><span>Comercios de tu localidad</span><span>Retiro y delivery</span></div></div>
    <div class="river-art" aria-hidden="true"><span class="art-marker">c.</span><span class="art-copy">Un mismo lugar.<br>Muchos sabores.</span></div></section>
    <section aria-labelledby="stores-title"><div class="section-heading"><div><h2 id="stores-title">¿Qué se te antoja hoy?</h2><p>Explorá los comercios de esta demostración.</p></div><span class="quiet">${businesses.length} comercios demo</span></div>
    <div class="filters"><div class="search-box"><label class="sr-only" for="search">Buscar comercio o comida</label><input id="search" type="search" aria-label="Buscar comercio o comida" value="${esc(searchState.query)}" placeholder="Buscar un comercio o algo rico…"></div>
    <div class="chips" aria-label="Categorías">${categories.map(c=>`<button type="button" class="chip ${c===searchState.category?'active':''}" data-action="filter" data-category="${esc(c)}" aria-pressed="${c===searchState.category}">${esc(c)}</button>`).join('')}</div>
    <label class="check-label"><input id="only-open" type="checkbox" ${searchState.onlyOpen?'checked':''}> Solo abiertos</label></div>
    <div id="stores-results" aria-live="polite">${storesMarkup()}</div><p class="microcopy below-note">Los precios, la disponibilidad y los tiempos son ejemplos. Todavía no hay comercios adheridos en esta versión.</p></section>`;
}
function shop(businessId) {
  const b = repository.business(businessId); const products = repository.products(b.id); const cart = repository.cart(b.id);
  const categories = [...new Set(products.map(p=>p.category))];
  return `${back()}<section class="shop-hero"><div class="shop-initials theme-${theme(b)}" aria-hidden="true">${esc(b.initials)}</div><div><span class="pill-label">COMERCIO FICTICIO · ALUMINÉ</span><h1>${esc(b.name)}</h1><p>${esc(b.description)}</p><div class="shop-info">${availability(b)}<span>${esc(b.eta)}</span><span>${b.deliveryEnabled?`Envío ${money(b.deliveryFee)}`:'Solo retiro'}</span><span>Retiro gratis</span></div></div></section>
    ${!b.open?'<div class="notice">Este comercio está cerrado en la demo. Podés explorar su carta o abrirlo desde el panel de demostración.</div>':''}
    <div class="shop-layout"><div>${categories.map(category=>`<section class="product-group"><h2>${esc(category)}</h2>${products.filter(p=>p.category===category).map(p=>{
      const quantity=cart.lines.find(l=>l.productId===p.id)?.quantity||0;const price=confirmedPrice(p);
      return `<article class="product"><div><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p><span class="product-price">${price===null?'No disponible':money(price)}</span></div><div class="product-action"><button class="add" type="button" data-action="add" data-business="${esc(b.id)}" data-product="${esc(p.id)}" aria-label="Agregar ${esc(p.name)}" ${!b.open||!isCommerciallyPurchasable(p)||quantity>=p.stock||quantity>=99?'disabled':''}>+</button><span class="product-qty">${quantity?`${quantity} en tu carrito`:isCommerciallyPurchasable(p)?'':'No disponible'}</span></div></article>`;
    }).join('')}</section>`).join('')}</div>
    <aside class="sidebox"><h3>Tu pedido,<br>en este comercio.</h3><p>Un carrito por comercio. No se mezclan productos ni costos de envío.</p><p class="inline-total">${countCart(cart)} productos seleccionados</p><a class="button full" href="#cart/${esc(b.id)}">Ver mi carrito →</a><p class="microcopy below-note">${esc(b.hoursLabel)}<br>Los horarios no controlan aperturas automáticamente en esta demo.</p><a class="link-button" href="#business/${esc(b.id)}">Abrir panel demo</a></aside></div>`;
}
function carts() {
  const nonempty=repository.snapshot().businesses.filter(b=>repository.cart(b.id).lines.length);
  return `${back()}<h1 class="page-title">Tus carritos</h1><p class="quiet">Cada pedido pertenece a un solo comercio.</p>${nonempty.length?nonempty.map(b=>`<article class="card row"><div><h3>${esc(b.name)}</h3><p class="quiet">${countCart(repository.cart(b.id))} productos</p></div><a class="button" href="#cart/${esc(b.id)}">Revisar carrito</a></article>`).join(''):empty('Todavía no elegiste nada','Entrá a un comercio y agregá algo rico.')}`;
}
function cartPage(businessId) {
  const b=repository.business(businessId);const cart=repository.cart(b.id);const products=repository.products(b.id);
  if(!cart.lines.length)return `${back(`#shop/${b.id}`,b.name)}${empty('Tu carrito está vacío','Los productos de este comercio aparecerán acá.',`#shop/${b.id}`,'Ver la carta')}`;
  const values=formValues.get(b.id)||{fulfillment:b.pickupEnabled?'pickup':'delivery',name:'Cliente de prueba',phone:'0000000000',address:'Calle de prueba 123',notes:''};
  let quote=null;let quoteError='';try{quote=repository.quote(b.id,values.fulfillment);}catch(error){quoteError=error.message;}
  return `${back(`#shop/${b.id}`,`Seguir eligiendo en ${b.name}`)}<h1 class="page-title">Tu pedido en ${esc(b.name)}</h1><p class="quiet">Revisá todo antes de probar el circuito.</p><div class="cart-layout"><div><section class="card">${cart.lines.map(line=>{
    const p=products.find(p=>p.id===line.productId);const price=confirmedPrice(p);
    return `<div class="cart-line"><div><h3>${esc(p?.name||'Producto no disponible')}</h3><span class="microcopy">${price===null?'Precio no disponible':`${money(price)} cada uno`}</span></div><div class="quantity"><button type="button" data-action="quantity" data-business="${esc(b.id)}" data-product="${esc(line.productId)}" data-quantity="${line.quantity-1}" aria-label="Quitar una unidad de ${esc(p?.name)}">−</button><span>${line.quantity}</span><button type="button" data-action="quantity" data-business="${esc(b.id)}" data-product="${esc(line.productId)}" data-quantity="${line.quantity+1}" aria-label="Agregar una unidad de ${esc(p?.name)}" ${!p||line.quantity>=p.stock||line.quantity>=99?'disabled':''}>+</button></div></div>`;
  }).join('')}<button class="link-button" type="button" data-action="clear-cart" data-business="${esc(b.id)}">Vaciar este carrito</button></section>
    <form id="checkout-form" data-form="checkout" data-business="${esc(b.id)}" class="card"><h2>¿Cómo lo recibís?</h2><p class="microcopy">Usá datos ficticios. Se guardan únicamente en este navegador.</p>
    <div class="field"><label for="fulfillment">Modalidad de entrega</label><select id="fulfillment" name="fulfillment">${b.pickupEnabled?`<option value="pickup" ${values.fulfillment==='pickup'?'selected':''}>Retiro por el comercio · sin costo</option>`:''}${b.deliveryEnabled?`<option value="delivery" ${values.fulfillment==='delivery'?'selected':''}>Delivery del comercio · ${money(b.deliveryFee)}</option>`:''}</select></div>
    <div class="form-grid"><label class="field">Nombre de ejemplo<input name="name" required minlength="2" maxlength="80" value="${esc(values.name)}" autocomplete="off"></label><label class="field">Teléfono de ejemplo<input name="phone" type="tel" required minlength="8" maxlength="24" value="${esc(values.phone)}" autocomplete="off"></label>
    ${values.fulfillment==='delivery'?`<label class="field wide">Dirección de ejemplo<input name="address" required minlength="5" maxlength="200" value="${esc(values.address)}" autocomplete="off"></label>`:''}<label class="field wide">Notas para el comercio<textarea name="notes" maxlength="300">${esc(values.notes)}</textarea></label></div></form></div>
    <aside class="sidebox"><h3>Resumen</h3><div class="totals"><div class="row"><span>Productos</span><strong>${quote?money(quote.subtotal):'—'}</strong></div><div class="row"><span>${values.fulfillment==='pickup'?'Retiro':'Envío'}</span><strong>${values.fulfillment==='pickup'?'Gratis':money(b.deliveryFee)}</strong></div><div class="row total"><span>Total demo</span><strong>${quote?money(quote.total):'—'}</strong></div></div>
    ${quoteError?`<div class="notice error">${esc(quoteError)}</div>`:''}<p class="microcopy">Pago simulado contra entrega. Mercado Pago y cualquier cobro real están deshabilitados.</p><button class="button full" type="submit" form="checkout-form" ${quote?'':'disabled'}>Crear pedido de prueba</button><p class="microcopy below-note">Ningún comercio recibirá este pedido.</p></aside></div>`;
}
function orderCard(order,actor) {
  const b=repository.business(order.businessId);const actions=allowedActions(order,actor);
  const actionLabels={accepted:'Confirmar',preparing:'Preparar',ready:'Marcar listo',assigned:'Asignar repartidor demo',picked_up:'Confirmar retiro',on_the_way:'Salir a reparto',arrived:'Llegué al destino',delivered:'Confirmar entrega',canceled:'Cancelar pedido'};
  return `<article class="card order-card"><div class="row"><div><span class="order-code">${esc(order.code)} · PEDIDO DE PRUEBA</span><h3>${esc(b.name)}</h3><span class="microcopy">${order.fulfillment==='pickup'?'Retiro por el local':'Delivery del comercio'}</span></div><span class="status">${esc(STATUS_LABELS[order.status])}</span></div>
    <p class="order-items">${order.lines.map(l=>`${l.quantity} × ${esc(l.name)}`).join(' · ')}</p><div class="row"><strong>${money(order.total)}</strong><a class="link-button" href="#order/${esc(order.id)}">Ver seguimiento</a></div>
    ${actor.kind!=='customer'?`<p class="microcopy below-note">${esc(order.customer.name)} · ${esc(order.customer.phone)}${order.customer.address?`<br>${esc(order.customer.address)}`:''}${order.customer.notes?`<br>Nota: ${esc(order.customer.notes)}`:''}</p>`:''}
    <div class="order-actions">${actions.map(status=>`<button type="button" class="button ${status==='canceled'?'danger':''}" data-action="transition" data-order="${esc(order.id)}" data-version="${order.version}" data-status="${esc(status)}" data-business="${esc(order.businessId)}" data-actor="${esc(actor.kind)}" data-rider="${esc(actor.kind==='rider'?actor.id:'')}">${esc(actionLabels[status]||status)}</button>`).join('')}</div></article>`;
}
function orders() {const all=repository.orders(customerActor);return `${back()}<h1 class="page-title">Mis pedidos de prueba</h1><p class="quiet">Historial local de este navegador. No son pedidos reales.</p>${all.length?all.map(o=>orderCard(o,customerActor)).join(''):empty('Todavía no hay pedidos','Probá el circuito completo: catálogo, carrito, pedido y seguimiento.')}`;}
function tracking(orderId) {
  const order=repository.orders(customerActor).find(o=>o.id===orderId);
  if(!order)return empty('Pedido no encontrado','Este pedido no está guardado en el navegador.','#orders','Ver mis pedidos');
  const b=repository.business(order.businessId);
  return `${back('#orders','Volver a mis pedidos')}<div class="narrow"><span class="eyebrow">SEGUIMIENTO DE DEMOSTRACIÓN</span><h1 class="page-title">${esc(STATUS_LABELS[order.status])}</h1><p class="quiet">${esc(order.code)} · ${esc(b.name)}</p>${orderCard(order,customerActor)}<section class="card"><h2>Así va tu pedido</h2><ol class="timeline">${order.history.map(event=>`<li>${esc(STATUS_LABELS[event.status])}<small>${esc(new Date(event.at).toLocaleString('es-AR'))}</small></li>`).join('')}</ol><p class="microcopy">Los estados cambian desde los paneles demo. No hay GPS ni seguimiento de repartidores reales.</p></section>
    <div class="notice"><strong>Probá el otro lado del mostrador.</strong>Abrí el panel demo para confirmar y preparar este pedido.</div><div class="order-actions"><a class="button" href="#business/${esc(b.id)}">Abrir panel demo de ${esc(b.name)}</a>${order.fulfillment==='delivery'?`<a class="button secondary" href="#rider/${esc(b.id)}">Abrir reparto demo</a>`:''}</div></div>`;
}
function manage() {
  return `${back()}<h1 class="page-title">Paneles de demostración</h1>${demoNotice()}<div class="stores">${repository.snapshot().businesses.map(b=>`<section class="card"><span class="eyebrow">COMERCIO FICTICIO</span><h2>${esc(b.name)}</h2><p class="quiet">Probá la bandeja, los productos y la apertura del local.</p><div class="stack"><a class="button" href="#business/${esc(b.id)}">Panel del comercio</a>${b.deliveryEnabled?`<a class="button secondary" href="#rider/${esc(b.id)}">Panel de reparto</a>`:''}</div></section>`).join('')}</div>`;
}
function businessPanel(businessId) {
  const b=repository.business(businessId);const actor=merchantActor(b);const all=repository.orders(actor);
  return `${back('#manage','Todos los paneles demo')}<div class="manage-header"><div><span class="eyebrow">PANEL DE COMERCIO · DEMO</span><h1 class="page-title">${esc(b.name)}</h1>${availability(b)}</div><div class="manage-controls"><a class="button secondary" href="#shop/${esc(b.id)}">Ver mi carta</a><button class="button" type="button" data-action="toggle-open" data-business="${esc(b.id)}">${b.open?'Cerrar':'Abrir'} comercio demo</button></div></div>${demoNotice()}
    <div class="section-heading"><div><h2>Pedidos del comercio</h2><p>${all.length} pedidos de prueba. No se muestran los de otros comercios en esta vista.</p></div>${b.deliveryEnabled?`<a class="link-button" href="#rider/${esc(b.id)}">Ir a reparto demo →</a>`:''}</div>
    ${all.length?all.map(o=>orderCard(o,actor)).join(''):empty('La bandeja está vacía','Creá un pedido de prueba desde la carta de este comercio.',`#shop/${b.id}`,'Abrir la carta')}
    <section class="product-group"><h2>Productos</h2><p class="quiet">Modificá precios, stock y disponibilidad de esta demostración.</p><div class="edit-products">${repository.products(b.id).map(p=>`<form class="card edit-product" data-form="product" data-business="${esc(b.id)}" data-product="${esc(p.id)}"><h3>${esc(p.name)}</h3><div class="edit-fields"><label class="field">Precio de ejemplo<input name="price" type="number" min="1" max="10000000" step="1" required value="${p.price}"></label><label class="field">Stock de ejemplo<input name="stock" type="number" min="0" max="10000" step="1" required value="${p.stock}"></label></div><label class="check-label"><input name="available" type="checkbox" ${p.available?'checked':''}> Disponible</label><button class="button secondary full" type="submit">Guardar cambios demo</button></form>`).join('')}</div></section>`;
}
function riderPanel(businessId) {
  const b=repository.business(businessId);const rider=repository.snapshot().riders.find(r=>r.businessId===b.id&&r.localityId===b.localityId);
  if(!rider)return `${back('#manage','Paneles demo')}${empty('Este comercio no tiene delivery','En esta demostración trabaja únicamente con retiro.')}`;
  const actor={...rider,kind:'rider'};const all=repository.orders(actor);
  return `${back(`#business/${b.id}`,'Volver al panel del comercio')}<span class="eyebrow">REPARTO DEL COMERCIO · DEMO</span><h1 class="page-title">${esc(b.name)}</h1>${demoNotice()}<p class="quiet">Solo aparecen los pedidos asignados a ${esc(rider.name)}. No se comparte una flota entre comercios.</p>${all.length?all.map(o=>orderCard(o,actor)).join(''):empty('Todavía no hay pedidos asignados','Prepará un pedido con delivery y asignalo desde el panel de este comercio.',`#business/${b.id}`,'Ir al panel del comercio')}`;
}
function render({focus=false}={}) {
  if(!repository)return;
  try {
    const [page='home',id]=route();
    const pages={home:()=>home(),shop:()=>shop(id),cart:()=>cartPage(id),carts,orders,order:()=>tracking(id),manage,business:()=>businessPanel(id),rider:()=>riderPanel(id)};
    main.innerHTML=Object.hasOwn(pages,page)?pages[page]():empty('Página no encontrada','Volvé al inicio para seguir explorando.');
    updateNavigation();
  } catch(error){ main.innerHTML=`<section class="notice error"><h2>No pudimos abrir esta vista</h2><p>${esc(error.message)}</p><a href="#home" class="button secondary">Volver al inicio</a></section>`; }
  if(focus){main.focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
}
function rememberForm(form) { if(form?.dataset.form==='checkout')formValues.set(form.dataset.business,{...formValues.get(form.dataset.business),...Object.fromEntries(new FormData(form))}); }
async function doAction(button) {
  const {action,business:businessId,product:productId}=button.dataset;
  if(action==='filter'){searchState.category=button.dataset.category;render();return;}
  if(action==='add'){
    const current=repository.cart(businessId).lines.find(l=>l.productId===productId)?.quantity||0;
    await repository.setQuantity(businessId,productId,current+1);toast('Agregado al carrito de este comercio.');
  }else if(action==='quantity')await repository.setQuantity(businessId,productId,Number(button.dataset.quantity));
  else if(action==='clear-cart')await repository.clearCart(businessId);
  else if(action==='toggle-open'){
    const b=repository.business(businessId);await repository.setBusinessOpen(b.id,!b.open,merchantActor(b));
  }else if(action==='transition'){
    const b=repository.business(businessId);let actor;
    if(button.dataset.actor==='customer')actor=customerActor;
    else if(button.dataset.actor==='merchant')actor=merchantActor(b);
    else actor={kind:'rider',...scopeOf(b),id:button.dataset.rider};
    const rider=repository.snapshot().riders.find(r=>r.businessId===b.id&&r.localityId===b.localityId);
    await repository.transition({orderId:button.dataset.order,expectedVersion:Number(button.dataset.version),nextStatus:button.dataset.status,actor,riderId:rider?.id});
    toast('Estado del pedido demo actualizado.');
  }
}
main.addEventListener('click',async event=>{
  const button=event.target.closest('button[data-action]');if(!button||button.disabled)return;
  const currentHash=location.hash;button.disabled=true;
  try{await doAction(button);if(location.hash===currentHash)render();}catch(error){toast(error.message);button.disabled=false;}
});
main.addEventListener('input',event=>{
  if(event.target.id==='search'){searchState.query=event.target.value;document.querySelector('#stores-results').innerHTML=storesMarkup();}
  rememberForm(event.target.closest('form'));
});
main.addEventListener('change',event=>{
  if(event.target.id==='only-open'){searchState.onlyOpen=event.target.checked;document.querySelector('#stores-results').innerHTML=storesMarkup();}
  if(event.target.id==='fulfillment'){rememberForm(event.target.closest('form'));render();document.querySelector('#fulfillment')?.focus();}
});
main.addEventListener('submit',async event=>{
  const form=event.target;if(!form.dataset.form)return;event.preventDefault();
  const buttons=[...document.querySelectorAll('button[type="submit"]')];buttons.forEach(b=>b.disabled=true);
  const values=Object.fromEntries(new FormData(form));
  try{
    if(form.dataset.form==='checkout'){
      rememberForm(form);const businessId=form.dataset.business;
      const requestId=await repository.prepareRequest(businessId);const lines=repository.cart(businessId).lines;
      const order=await repository.createOrder({businessId,requestId,lines,fulfillment:values.fulfillment,customer:values});
      formValues.delete(businessId);go(`order/${order.id}`);toast('Pedido de prueba creado. No se envió a ningún comercio.');
    }else if(form.dataset.form==='product'){
      const b=repository.business(form.dataset.business);
      await repository.updateProduct(b.id,form.dataset.product,{price:Number(values.price),stock:Number(values.stock),available:values.available==='on'},merchantActor(b));render();toast('Producto de demostración actualizado.');
    }
  }catch(error){toast(error.message);buttons.forEach(b=>b.disabled=false);}
});
document.querySelector('#reset-demo').addEventListener('click',async()=>{
  if(!confirm('¿Borrar todos los pedidos, carritos y cambios de esta demostración?'))return;
  try{
    if(repository){try{await repository.reset();}catch(error){if(error.code!=='CORRUPT_STORAGE')throw error;localStorage.removeItem(DEMO_STORAGE_KEY);}}
    else localStorage.removeItem(DEMO_STORAGE_KEY);
    formValues.clear();if(!repository)repository=createRepository(CONFIG,{storage:localStorage});go('home');render();toast('Demostración reiniciada.');
  }catch(error){toast(error.message);}
});
window.addEventListener('hashchange',()=>render({focus:true}));
window.addEventListener('storage',event=>{if(event.key===DEMO_STORAGE_KEY){render();toast('Se actualizaron los datos de otra pestaña.');}});
try{repository=createRepository(CONFIG,{storage:localStorage});render();}
catch(error){main.innerHTML=`<div class="notice error"><h1 class="page-title">No se pudo iniciar</h1><p>${esc(error.message)}</p></div>`;}
