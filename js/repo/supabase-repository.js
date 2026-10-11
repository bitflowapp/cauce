// Repositorio de CAUCE · Ferias sobre Supabase. El navegador lee lo que RLS le
// deja leer y las operaciones críticas (pedidos, estados, inscripciones,
// suscripciones) pasan por funciones del servidor. Nunca se usa una clave
// privilegiada: sólo la publishable key y el JWT de la sesión.
import { AppError, requireValue } from '../core/errors.js';
import { toAppError } from './messages.js';
import { optimizeImage, IMAGE_SIDES } from './image-prep.js';
import { clean, isUuid } from '../core/validators.js';

export const MEDIA_BUCKET = 'ferias-media';
const IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20000;
const SESSION_TTL_MS = 15000;
export const PAGE_SIZE = 24;

const PRODUCT_LIST = 'id,name,price_ars,stock,track_stock,made_to_order,available,featured,created_at,category_id,business_id,'
  + 'businesses!inner(id,name,slug,status,locality_id,logo_path),product_images(path,position)';
const PRODUCT_FULL = '*,product_images(id,path,alt,position),product_variants(id,name,price_delta_ars,stock,active,position)';
const BUSINESS_PUBLIC = '*,taking_orders,featured,offers_fair_pickup,categories(slug,name,icon),localities(slug,name)';

/**
 * @param {{ client: any, siteUrl: string, redirectTo: string, onError?: (error: AppError) => void }} options
 */
export function createRepository({ client, siteUrl, redirectTo, onError = null }) {
  requireValue(client?.auth && client?.from, 'CONFIG', 'Falta la conexión con el servicio.');

  const report = error => { try { onError?.(error); } catch { /* el registro nunca rompe la interfaz */ } };
  const fail = error => {
    if (!error) return;
    const wrapped = toAppError(error);
    report(wrapped);
    throw wrapped;
  };
  // Una red móvil trabada no da error: se corta a los 20 s y se avisa.
  async function read(request) {
    let result;
    const controller = typeof request?.abortSignal === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try { result = await (controller ? request.abortSignal(controller.signal) : request); }
    catch (error) { if (controller?.signal.aborted) timeout(); fail(error); }
    finally { if (timer) clearTimeout(timer); }
    if (controller?.signal.aborted && result?.error) timeout();
    fail(result?.error);
    return result?.data;
  }
  function timeout() {
    const error = new AppError('NETWORK_TIMEOUT', 'La conexión está muy lenta y no pudimos confirmar. Revisá cómo quedó y reintentá si hace falta.');
    report(error);
    throw error;
  }
  const rpc = (name, args = {}) => read(client.rpc(name, args));
  const publicUrl = path => (path ? client.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl : '');

  // ── catálogos de referencia (cache en memoria) ──
  let reference = null;
  async function referenceData() {
    if (reference) return reference;
    const [localities, categories, plans] = await Promise.all([
      read(client.from('localities').select('id,slug,name,province,position').order('position')),
      read(client.from('categories').select('id,slug,name,icon,position').order('position')),
      read(client.from('plans').select('*').order('position')),
    ]);
    reference = { localities, categories, plans,
      localityById: new Map(localities.map(l => [l.id, l])), localityBySlug: new Map(localities.map(l => [l.slug, l])),
      categoryById: new Map(categories.map(c => [c.id, c])), categoryBySlug: new Map(categories.map(c => [c.slug, c])) };
    return reference;
  }

  // ── adaptadores ──
  const firstImage = images => (images || []).slice().sort((a, b) => a.position - b.position)[0]?.path || '';
  function mapProductCard(row, ref) {
    const business = row.businesses || {};
    return {
      id: row.id, name: row.name, price: Number(row.price_ars), stock: row.stock, trackStock: row.track_stock,
      madeToOrder: row.made_to_order, available: row.available, featured: row.featured, createdAt: row.created_at,
      categoryId: row.category_id, image: publicUrl(firstImage(row.product_images)),
      business: { id: business.id, name: business.name, slug: business.slug, logo: publicUrl(business.logo_path),
        locality: ref?.localityById.get(business.locality_id)?.name || '' },
    };
  }
  function mapProduct(row) {
    const images = (row.product_images || []).slice().sort((a, b) => a.position - b.position || String(a.id).localeCompare(String(b.id)));
    return {
      id: row.id, businessId: row.business_id, name: row.name, description: row.description || '', materials: row.materials || '',
      price: Number(row.price_ars), stock: row.stock, trackStock: row.track_stock, madeToOrder: row.made_to_order,
      productionMin: row.production_days_min, productionMax: row.production_days_max, handmade: row.handmade,
      available: row.available, archived: row.archived, featured: row.featured, position: row.position,
      categoryId: row.category_id, createdAt: row.created_at, updatedAt: row.updated_at,
      images: images.map(image => ({ id: image.id, path: image.path, url: publicUrl(image.path), alt: image.alt || '', position: image.position })),
      image: publicUrl(images[0]?.path),
      allVariants: (row.product_variants || []).slice().sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        .map(v => ({ id: v.id, name: v.name, priceDelta: Number(v.price_delta_ars), stock: v.stock, active: v.active, position: v.position })),
      get variants() { return this.allVariants.filter(v => v.active); },
    };
  }
  function mapBusiness(row) {
    if (!row) return null;
    const contact = Array.isArray(row.business_contacts) ? row.business_contacts[0] : row.business_contacts;
    return {
      id: row.id, name: row.name, slug: row.slug, status: row.status, tagline: row.tagline || '', description: row.description || '',
      localityId: row.locality_id, locality: row.localities?.name || '', localitySlug: row.localities?.slug || '',
      categoryId: row.category_id, category: row.categories?.name || '', categorySlug: row.categories?.slug || '',
      categoryIcon: row.categories?.icon || 'otros',
      logoPath: row.logo_path || '', coverPath: row.cover_path || '', logo: publicUrl(row.logo_path), cover: publicUrl(row.cover_path),
      publicPhone: row.public_phone || '', whatsapp: row.whatsapp || '', instagram: row.instagram || '',
      pickupEnabled: row.pickup_enabled, pickupArea: row.pickup_area || '', fairPickupEnabled: row.fair_pickup_enabled,
      deliveryEnabled: row.delivery_enabled, deliveryZone: row.delivery_zone || '',
      deliveryFee: row.delivery_fee_ars === null || row.delivery_fee_ars === undefined ? null : Number(row.delivery_fee_ars),
      minimumOrder: Number(row.minimum_order_ars || 0), acceptingOrders: row.accepting_orders,
      takingOrders: row.taking_orders === true, featured: row.featured === true, offersFairPickup: row.offers_fair_pickup === true,
      contact: contact ? { ownerName: contact.owner_name || '', phone: contact.phone || '', email: contact.email || '' } : null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
  function mapFair(row, ref) {
    return {
      id: row.id, slug: row.slug, name: row.name, venue: row.venue, address: row.address || '', description: row.description || '',
      latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
      longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
      startsAt: row.starts_at, endsAt: row.ends_at, status: row.status, applicationsOpen: row.applications_open,
      stallCapacity: row.stall_capacity, cancelReason: row.cancel_reason || '', cover: publicUrl(row.cover_path), coverPath: row.cover_path || '',
      locality: row.locality_name || row.localities?.name || ref?.localityById.get(row.locality_id)?.name || '',
      localitySlug: row.locality_slug || row.localities?.slug || ref?.localityById.get(row.locality_id)?.slug || '',
      localityId: row.locality_id,
      organizer: row.organizer_name || row.organizers?.name || '', organizerId: row.organizer_id,
      organizerContact: row.organizers ? { whatsapp: row.organizers.whatsapp || '', phone: row.organizers.public_phone || '',
        instagram: row.organizers.instagram || '' } : null,
      participants: Number(row.participants || 0), participantLogos: (row.participant_logos || []).map(publicUrl),
    };
  }
  function mapOrder(row) {
    const items = row.order_items_business || row.order_items_customer || row.order_items || [];
    const events = row.order_events_business || row.order_events_customer || row.order_events || [];
    return {
      id: row.id, code: row.code, businessId: row.business_id, status: row.status, version: row.version,
      fulfillment: row.fulfillment, fairId: row.fair_id, paymentMethod: row.payment_method, paymentStatus: row.payment_status,
      paidAt: row.paid_at, trackingToken: row.tracking_token,
      pickup: { fairName: row.pickup_fair_name || '', venue: row.pickup_venue || '', stall: row.pickup_stall || '', startsAt: row.pickup_starts_at },
      contact: { name: row.contact_name, phone: row.contact_phone, email: row.contact_email || '', address: row.address || '', notes: row.notes || '' },
      subtotal: Number(row.subtotal_ars), deliveryFee: Number(row.delivery_fee_ars), deliveryFeePending: row.delivery_fee_pending,
      total: Number(row.total_ars), cancelReason: row.cancel_reason || '', createdAt: row.created_at, updatedAt: row.updated_at,
      business: row.businesses ? { name: row.businesses.name, slug: row.businesses.slug, logo: publicUrl(row.businesses.logo_path),
        whatsapp: row.businesses.whatsapp || '', phone: row.businesses.public_phone || '' } : null,
      lines: items.slice().sort((a, b) => a.position - b.position).map(item => ({
        name: item.variant_name ? `${item.product_name} · ${item.variant_name}` : item.product_name,
        image: publicUrl(item.image_path), quantity: item.quantity, unitPrice: Number(item.unit_price_ars),
        total: Number(item.total_ars), madeToOrder: item.made_to_order })),
      history: events.slice().sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(e => ({ from: e.from_status, status: e.to_status, by: e.actor_role, note: e.note || '', at: e.created_at })),
    };
  }

  // ── sesión ──
  let cached = null;
  let cachedAt = 0;
  const invalidate = () => { cached = null; cachedAt = 0; };

  async function currentUser({ verify = false } = {}) {
    const { data, error } = await client.auth.getSession();
    fail(error);
    if (!data.session) return null;
    if (!verify) return data.session.user;
    const result = await client.auth.getUser();
    if (result.error) {
      if ([401, 403].includes(result.error.status) || ['session_not_found', 'user_not_found', 'bad_jwt'].includes(result.error.code)) {
        await client.auth.signOut({ scope: 'local' }).catch(() => {});
        return null;
      }
      fail(result.error);
    }
    return result.data.user;
  }
  const isPermanent = user => Boolean(user) && user.is_anonymous !== true;

  async function ensureProfile(user) {
    let profile = await read(client.from('profiles').select('*').eq('user_id', user.id).maybeSingle());
    if (!profile) {
      // La metadata del registro sólo inicializa nombre y teléfono, nunca permisos.
      const name = clean(user.user_metadata?.display_name || (user.email || '').split('@')[0] || 'Persona', 80).padEnd(2, '.');
      const phone = clean(user.user_metadata?.phone || '', 24);
      await read(client.from('profiles').upsert({ user_id: user.id, display_name: name, phone },
        { onConflict: 'user_id', ignoreDuplicates: true }));
      profile = await read(client.from('profiles').select('*').eq('user_id', user.id).single());
    }
    return profile;
  }

  async function session({ verify = false, fresh = false } = {}) {
    if (!verify && !fresh && cached && Date.now() - cachedAt < SESSION_TTL_MS) return cached;
    const user = await currentUser({ verify });
    if (!user) {
      cached = { kind: 'visitor', user: null, memberships: [], organizers: [], admin: false };
    } else if (!isPermanent(user)) {
      cached = { kind: 'guest', user: { id: user.id }, memberships: [], organizers: [], admin: false };
    } else {
      const profile = await ensureProfile(user);
      const [memberships, organizers, admin] = await Promise.all([
        read(client.from('business_memberships').select('business_id,role,businesses(id,name,slug,status,logo_path)').eq('user_id', user.id)),
        read(client.from('organizer_members').select('organizer_id,role,organizers(id,name,slug,status)').eq('user_id', user.id)),
        rpc('my_access'),
      ]);
      cached = { kind: 'account', user: { id: user.id, email: user.email, name: profile.display_name, phone: profile.phone },
        memberships: memberships.map(m => ({ businessId: m.business_id, role: m.role, name: m.businesses?.name || '',
          slug: m.businesses?.slug || '', status: m.businesses?.status || '', logo: publicUrl(m.businesses?.logo_path) })),
        organizers: organizers.map(o => ({ organizerId: o.organizer_id, role: o.role, name: o.organizers?.name || '',
          slug: o.organizers?.slug || '', status: o.organizers?.status || '' })),
        admin: admin === true };
    }
    cachedAt = Date.now();
    return cached;
  }

  // Compra o preinscripción sin cuenta: una sesión anónima real de Supabase.
  async function ensureSession() {
    const user = await currentUser();
    if (user) return user;
    const { data, error } = await client.auth.signInAnonymously();
    if (error) {
      const wrapped = toAppError(error);
      if (error.code === 'anonymous_provider_disabled' || error.status === 422) {
        wrapped.code = 'GUEST_UNAVAILABLE';
        wrapped.message = 'Para continuar, ingresá con tu cuenta.';
      }
      report(wrapped);
      throw wrapped;
    }
    invalidate();
    return data.user;
  }

  // ── medios ──
  async function uploadMedia(prefix, folder, original) {
    requireValue(original && typeof original.size === 'number', 'INVALID_IMAGE', 'Elegí una imagen.');
    requireValue(IMAGE_TYPES.includes(original.type), 'INVALID_IMAGE_TYPE', 'Se admiten fotos JPG, PNG o WebP.');
    const file = await optimizeImage(original, { maxSide: IMAGE_SIDES[folder] || IMAGE_SIDES.product });
    requireValue(file.size > 0 && file.size <= MAX_IMAGE_BYTES, 'IMAGE_TOO_LARGE', 'La foto no puede superar 5 MB.');
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
    const path = `${prefix}/${folder}/${crypto.randomUUID()}.${extension}`;
    const { error } = await client.storage.from(MEDIA_BUCKET).upload(path, file,
      { contentType: file.type, cacheControl: '31536000', upsert: false });
    if (error) {
      const forbidden = String(error.statusCode) === '403' || /row-level security|Unauthorized/i.test(error.message || '');
      const wrapped = new AppError(forbidden ? 'MEDIA_FORBIDDEN' : 'MEDIA_UPLOAD_FAILED',
        forbidden ? 'No se pudo subir la foto: revisá tu plan o tus permisos.' : 'No se pudo subir la foto. Reintentá.');
      wrapped.technical = { code: String(error.statusCode || ''), message: String(error.message || '').slice(0, 200) };
      report(wrapped);
      throw wrapped;
    }
    return path;
  }
  async function removeMedia(paths) {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
    if (!list.length) return;
    const { error } = await client.storage.from(MEDIA_BUCKET).remove(list).catch(caught => ({ error: caught }));
    if (error) report(Object.assign(new AppError('MEDIA_ORPHAN', 'Quedó un archivo sin uso.'), { technical: { code: 'MEDIA_ORPHAN', message: String(error.message || '').slice(0, 120) } }));
  }

  const likeTerm = value => clean(value, 40).replace(/[%_,()*\\:."']/g, ' ').trim();

  // ═════════════ API pública del repositorio ═════════════
  return {
    client, publicUrl, invalidate,
    referenceData,
    appStatus: () => rpc('app_status'),

    // ── catálogo público ──
    async homeData({ locality = '' } = {}) {
      const ref = await referenceData();
      const localityId = ref.localityBySlug.get(locality)?.id || null;
      const featured = client.from('products').select(PRODUCT_LIST).eq('archived', false).eq('businesses.status', 'active')
        .eq('featured', true).order('updated_at', { ascending: false }).limit(12)
        .order('position', { referencedTable: 'product_images' }).limit(1, { referencedTable: 'product_images' });
      const newest = client.from('products').select(PRODUCT_LIST).eq('archived', false).eq('businesses.status', 'active')
        .order('created_at', { ascending: false }).limit(12)
        .order('position', { referencedTable: 'product_images' }).limit(1, { referencedTable: 'product_images' });
      const stores = client.from('businesses').select(BUSINESS_PUBLIC).eq('status', 'active').order('created_at', { ascending: false }).limit(24);
      if (localityId) { featured.eq('businesses.locality_id', localityId); newest.eq('businesses.locality_id', localityId); }
      const [featuredRows, newestRows, storeRows, fairs] = await Promise.all([read(featured), read(newest), read(stores),
        rpc('public_fairs', { locality: locality || null, max_rows: 6 })]);
      const seen = new Set();
      const highlight = [...featuredRows, ...newestRows].filter(row => (seen.has(row.id) ? false : seen.add(row.id))).slice(0, 8);
      const allStores = storeRows.map(mapBusiness);
      const local = localityId ? allStores.filter(s => s.localityId === localityId) : allStores;
      return {
        featured: highlight.map(row => mapProductCard(row, ref)),
        recommended: [...local.filter(s => s.featured), ...local.filter(s => !s.featured)].slice(0, 6),
        newStores: local.slice(0, 6),
        fairs: fairs.map(row => mapFair(row, ref)),
      };
    },

    async searchProducts({ q = '', category = '', locality = '', availability = '', min = null, max = null, sort = 'recientes', page = 0 } = {}) {
      const ref = await referenceData();
      let query = client.from('products').select(PRODUCT_LIST, { count: 'exact' }).eq('archived', false).eq('businesses.status', 'active');
      const term = likeTerm(q);
      if (term.length >= 2) query = query.or(`name.ilike.*${term}*,description.ilike.*${term}*,materials.ilike.*${term}*`);
      const categoryId = ref.categoryBySlug.get(category)?.id;
      if (categoryId) query = query.eq('category_id', categoryId);
      const localityId = ref.localityBySlug.get(locality)?.id;
      if (localityId) query = query.eq('businesses.locality_id', localityId);
      if (availability === 'stock') query = query.eq('available', true).or('track_stock.eq.false,stock.gt.0');
      if (availability === 'pedido') query = query.eq('made_to_order', true);
      if (Number.isFinite(min) && min > 0) query = query.gte('price_ars', min);
      if (Number.isFinite(max) && max > 0) query = query.lte('price_ars', max);
      if (sort === 'precio-asc') query = query.order('price_ars', { ascending: true });
      else if (sort === 'precio-desc') query = query.order('price_ars', { ascending: false });
      else query = query.order('created_at', { ascending: false });
      query = query.order('id').order('position', { referencedTable: 'product_images' }).limit(1, { referencedTable: 'product_images' })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      const result = await (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try { return await query.abortSignal(controller.signal); } finally { clearTimeout(timer); }
      })();
      fail(result.error);
      return { items: (result.data || []).map(row => mapProductCard(row, ref)), total: result.count ?? 0, page, pageSize: PAGE_SIZE };
    },

    async searchStores({ q = '', locality = '' } = {}) {
      const ref = await referenceData();
      let query = client.from('businesses').select(BUSINESS_PUBLIC).eq('status', 'active').order('name').limit(30);
      const term = likeTerm(q);
      if (term.length >= 2) query = query.or(`name.ilike.*${term}*,tagline.ilike.*${term}*`);
      const localityId = ref.localityBySlug.get(locality)?.id;
      if (localityId) query = query.eq('locality_id', localityId);
      return (await read(query)).map(mapBusiness);
    },

    async storeBySlug(slug) {
      const row = await read(client.from('businesses').select(BUSINESS_PUBLIC).eq('slug', String(slug || '').toLowerCase()).maybeSingle());
      requireValue(row, 'STORE_NOT_FOUND', 'Esta tienda no está disponible.');
      const business = mapBusiness(row);
      const [products, fairs] = await Promise.all([
        read(client.from('products').select(PRODUCT_FULL).eq('business_id', business.id).eq('archived', false)
          .order('featured', { ascending: false }).order('position').order('created_at', { ascending: false }).limit(200)),
        rpc('business_fairs', { business: business.id }),
      ]);
      return { business, products: products.map(mapProduct), fairs: fairs.map(f => ({ ...mapFair({ ...f, id: f.fair_id }), stall: f.stall_code || '' })) };
    },

    async product(id) {
      requireValue(isUuid(id), 'PRODUCT_NOT_FOUND', 'No encontramos ese producto.');
      const ref = await referenceData();
      const row = await read(client.from('products').select(`${PRODUCT_FULL},businesses!inner(${BUSINESS_PUBLIC.replace('*', 'id,name,slug,status,tagline,logo_path,locality_id,category_id,whatsapp,public_phone,instagram,pickup_enabled,pickup_area,fair_pickup_enabled,delivery_enabled,delivery_zone,delivery_fee_ars,minimum_order_ars,accepting_orders')})`)
        .eq('id', id).eq('archived', false).maybeSingle());
      requireValue(row, 'PRODUCT_NOT_FOUND', 'Este producto ya no está disponible.');
      const product = mapProduct(row);
      const business = mapBusiness(row.businesses);
      const relatedQuery = client.from('products').select(PRODUCT_LIST).eq('archived', false).eq('businesses.status', 'active')
        .neq('id', id).order('created_at', { ascending: false }).limit(8)
        .order('position', { referencedTable: 'product_images' }).limit(1, { referencedTable: 'product_images' });
      if (product.categoryId) relatedQuery.eq('category_id', product.categoryId); else relatedQuery.eq('business_id', business.id);
      const [related, fairs] = await Promise.all([read(relatedQuery), rpc('business_fairs', { business: business.id })]);
      return { product, business, related: related.map(r => mapProductCard(r, ref)),
        fairs: fairs.map(f => ({ ...mapFair({ ...f, id: f.fair_id }), stall: f.stall_code || '' })) };
    },

    async productsByIds(ids) {
      const valid = ids.filter(isUuid).slice(0, 100);
      if (!valid.length) return [];
      const ref = await referenceData();
      const rows = await read(client.from('products').select(PRODUCT_LIST).in('id', valid).eq('archived', false)
        .order('position', { referencedTable: 'product_images' }).limit(1, { referencedTable: 'product_images' }));
      return rows.map(row => mapProductCard(row, ref));
    },

    async cartCatalog(businessId, productIds) {
      requireValue(isUuid(businessId), 'STORE_NOT_FOUND', 'Esta tienda no está disponible.');
      const [businessRow, rows, fairs] = await Promise.all([
        read(client.from('businesses').select(BUSINESS_PUBLIC).eq('id', businessId).maybeSingle()),
        productIds.length ? read(client.from('products').select(PRODUCT_FULL).in('id', productIds.filter(isUuid)).eq('business_id', businessId)) : [],
        rpc('business_fairs', { business: businessId }),
      ]);
      return { business: mapBusiness(businessRow), products: rows.filter(r => !r.archived).map(mapProduct),
        fairs: fairs.map(f => ({ ...mapFair({ ...f, id: f.fair_id }), stall: f.stall_code || '' })) };
    },

    async fairs({ locality = '', from = null, to = null, q = '' } = {}) {
      const ref = await referenceData();
      const rows = await rpc('public_fairs', { locality: locality || null, from_date: from, to_date: to,
        search: likeTerm(q) || null, max_rows: 60 });
      return rows.map(row => mapFair(row, ref));
    },

    async fairBySlug(slug) {
      const ref = await referenceData();
      const row = await read(client.from('fairs').select('*,localities(name,slug),organizers(name,slug,whatsapp,public_phone,instagram)')
        .eq('slug', String(slug || '').toLowerCase()).maybeSingle());
      requireValue(row, 'FAIR_NOT_FOUND', 'No encontramos esa feria.');
      const fair = mapFair(row, ref);
      const participants = await read(client.from('fair_participations')
        .select('id,stall_code,business_id,businesses!inner(id,name,slug,tagline,logo_path,status,locality_id,categories(name))')
        .eq('fair_id', fair.id).eq('status', 'confirmed').eq('businesses.status', 'active').order('stall_code'));
      return { fair, participants: participants.map(p => ({ stall: p.stall_code || '', business: { ...mapBusiness(p.businesses),
        locality: ref.localityById.get(p.businesses.locality_id)?.name || '' } })) };
    },

    trackOrder: async token => {
      requireValue(isUuid(token), 'ORDER_NOT_FOUND', 'El enlace del pedido no es válido.');
      const data = await rpc('track_order', { token });
      requireValue(data, 'ORDER_NOT_FOUND', 'No encontramos ese pedido. Revisá el enlace.');
      return { ...data, items: (data.items || []).map(item => ({ ...item, image: publicUrl(item.image_path) })),
        business: { ...data.business, logo: publicUrl(data.business?.logo_path) } };
    },

    // ── identidad ──
    session, isPermanent,
    onAuthChange(callback) {
      const { data } = client.auth.onAuthStateChange((event, session) => { invalidate(); callback(event, session); });
      return () => data.subscription.unsubscribe();
    },
    async signUp({ name, email, phone, password }) {
      const { data, error } = await client.auth.signUp({ email: email.trim().toLowerCase(), password,
        options: { emailRedirectTo: redirectTo, data: { display_name: clean(name, 80), phone: clean(phone, 24) } } });
      fail(error);
      invalidate();
      // Con confirmación obligatoria no hay sesión hasta que se confirma el correo.
      return { needsConfirmation: !data.session, user: data.user };
    },
    async signIn({ email, password }) {
      const { error } = await client.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
      fail(error);
      invalidate();
      return session({ fresh: true });
    },
    async signOut() {
      await client.auth.signOut({ scope: 'local' }).catch(() => {});
      invalidate();
    },
    async requestPasswordReset(email) {
      const { error } = await client.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo });
      fail(error);
    },
    async resendConfirmation(email) {
      const { error } = await client.auth.resend({ type: 'signup', email: email.trim().toLowerCase(), options: { emailRedirectTo: redirectTo } });
      fail(error);
    },
    async verifyLink(tokenHash, type) {
      requireValue(['signup', 'email', 'recovery', 'invite', 'magiclink', 'email_change'].includes(type), 'INVALID_LINK', 'El enlace no es válido.');
      const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
      fail(error);
      invalidate();
      return type;
    },
    async updatePassword(password) {
      const { error } = await client.auth.updateUser({ password });
      fail(error);
    },
    async updateProfile({ name, phone }) {
      const current = await session({ fresh: true });
      requireValue(current.kind === 'account', 'SESSION_REQUIRED', 'Ingresá a tu cuenta.');
      await read(client.from('profiles').update({ display_name: clean(name, 80), phone: clean(phone, 24) }).eq('user_id', current.user.id));
      invalidate();
    },

    // ── pedidos (quien compra) ──
    async createOrder({ businessId, idem, fulfillment, paymentMethod, fairId = null, contact, items, expectedTotal }) {
      await ensureSession();
      const id = await rpc('create_order', { business: businessId, idem, fulfillment, payment_method: paymentMethod,
        fair: fulfillment === 'fair_pickup' ? fairId : null, contact, items, expected_total: expectedTotal });
      const row = await read(client.from('orders').select('id,code,tracking_token').eq('id', id).single());
      return { id: row.id, code: row.code, trackingToken: row.tracking_token };
    },
    async myOrders() {
      const user = await currentUser();
      if (!user) return [];
      const rows = await read(client.from('orders')
        .select('*,order_items_customer:order_items!order_items_customer_scope(*),order_events_customer:order_events!order_events_customer_scope(from_status,to_status,actor_role,note,created_at),businesses(name,slug,logo_path,whatsapp,public_phone)')
        .eq('customer_id', user.id).order('created_at', { ascending: false }).limit(50));
      return rows.map(mapOrder);
    },
    async cancelMyOrder(order) {
      return read(client.rpc('transition_order', { order_id: order.id, expected_version: order.version, next_status: 'canceled', reason: '' }));
    },
    subscribeOrders(filter, onChange) {
      const channel = client.channel(`orders-${filter.replace(/[^a-z0-9]/gi, '')}-${Math.random().toString(36).slice(2, 8)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter }, () => onChange())
        // SUBSCRIBED llega enseguida, pero los cambios de Postgres empiezan a
        // fluir cuando Realtime lo confirma (segundos después, y otra vez tras
        // cada reconexión). Al confirmarse se vuelve a consultar: un pedido que
        // entró en ese hueco no queda afuera.
        .on('system', {}, payload => { if (payload?.extension === 'postgres_changes' && payload.status === 'ok') onChange(); })
        .subscribe(status => { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') onChange({ degraded: true }); });
      return () => { client.removeChannel(channel); };
    },

    // ── comunidad fundadora ──
    async applyFounding(payload) {
      await ensureSession();
      return rpc('apply_founding', { payload });
    },

    // ── panel del comercio ──
    async createBusiness({ name, locality, category }) {
      const result = await rpc('create_business', { business_name: clean(name, 80), locality_slug: locality, category_slug: category || null });
      invalidate();
      return result;
    },
    async panelBusiness(businessId) {
      const [row, rights, missing, reviews] = await Promise.all([
        read(client.from('businesses').select(`${BUSINESS_PUBLIC},business_contacts(owner_name,phone,email)`).eq('id', businessId).maybeSingle()),
        rpc('my_entitlements', { business: businessId }),
        rpc('business_missing_requirements', { business: businessId }),
        read(client.from('business_review_events').select('from_status,to_status,actor_role,note,created_at').eq('business_id', businessId)
          .order('created_at', { ascending: false }).limit(10)),
      ]);
      requireValue(row, 'STORE_NOT_FOUND', 'No encontramos tu tienda.');
      return { business: mapBusiness(row), rights, missing: missing || [], reviews };
    },
    async updateBusiness(businessId, patch) {
      await read(client.from('businesses').update(patch).eq('id', businessId));
    },
    async updateContact(businessId, patch) {
      await read(client.from('business_contacts').upsert({ business_id: businessId, ...patch }, { onConflict: 'business_id' }));
    },
    async setBusinessImage(business, kind, file) {
      const path = await uploadMedia(`businesses/${business.id}`, kind, file);
      const column = kind === 'logo' ? 'logo_path' : 'cover_path';
      try { await read(client.from('businesses').update({ [column]: path }).eq('id', business.id)); }
      catch (error) { await removeMedia(path); throw error; }
      await removeMedia(kind === 'logo' ? business.logoPath : business.coverPath);
      return path;
    },
    submitForReview: businessId => rpc('submit_business_for_review', { business: businessId }),
    setPresence: (businessId, status) => rpc('set_business_presence', { business: businessId, next_status: status }),
    async panelProducts(businessId, { archived = false } = {}) {
      const rows = await read(client.from('products').select(PRODUCT_FULL).eq('business_id', businessId).eq('archived', archived)
        .order('position').order('created_at', { ascending: false }).limit(500));
      return rows.map(mapProduct);
    },
    async panelProduct(productId) {
      const row = await read(client.from('products').select(PRODUCT_FULL).eq('id', productId).maybeSingle());
      requireValue(row, 'PRODUCT_NOT_FOUND', 'No encontramos ese producto.');
      return mapProduct(row);
    },
    /**
     * Guarda producto, variantes y fotos. Las fotos nuevas se suben primero; si
     * algo falla, los archivos subidos en este intento se borran.
     */
    async saveProduct(businessId, input, { variants = [], newImages = [], removedImages = [], imageOrder = [] } = {}) {
      const fields = {
        name: clean(input.name, 80), description: String(input.description || '').trim().slice(0, 1000), materials: clean(input.materials, 160),
        price_ars: input.price, category_id: input.categoryId || null, made_to_order: input.madeToOrder === true,
        track_stock: input.madeToOrder ? false : input.trackStock !== false, handmade: input.handmade !== false,
        available: input.available !== false, featured: input.featured === true,
        production_days_min: input.productionMin || null, production_days_max: input.productionMax || null,
      };
      const activeVariants = variants.filter(v => v.name && !v.remove);
      if (!activeVariants.length && fields.track_stock) fields.stock = Math.max(0, Math.min(10000, Number(input.stock) || 0));
      let id = input.id;
      if (id) await read(client.from('products').update(fields).eq('id', id));
      else id = (await read(client.from('products').insert({ business_id: businessId, ...fields }).select('id').single())).id;
      // Variantes: alta, cambio y baja.
      for (const variant of variants) {
        const row = { name: clean(variant.name, 40), price_delta_ars: Number(variant.priceDelta) || 0,
          stock: Math.max(0, Math.min(10000, Number(variant.stock) || 0)), position: Number(variant.position) || 0, active: true };
        if (variant.id && variant.remove) await read(client.from('product_variants').delete().eq('id', variant.id));
        else if (variant.id) await read(client.from('product_variants').update(row).eq('id', variant.id));
        else if (row.name && !variant.remove) await read(client.from('product_variants').insert({ ...row, product_id: id, business_id: businessId }));
      }
      // Fotos: primero las bajas (liberan lugar del plan), después las altas.
      for (const image of removedImages) {
        await read(client.from('product_images').delete().eq('id', image.id));
        await removeMedia(image.path);
      }
      const uploaded = [];
      try {
        for (const [index, file] of newImages.entries()) {
          const path = await uploadMedia(`businesses/${businessId}`, 'products', file);
          uploaded.push(path);
          await read(client.from('product_images').insert({ product_id: id, business_id: businessId, path,
            alt: clean(input.name, 140), position: 100 + index }));
        }
      } catch (error) {
        const pending = uploaded.slice(-1);
        await removeMedia(pending);
        throw error;
      }
      // Orden final de las fotos (la primera es la portada).
      if (imageOrder.length) {
        const rows = await read(client.from('product_images').select('id,path').eq('product_id', id));
        const order = [...imageOrder, ...uploaded];
        for (const row of rows) {
          const position = order.indexOf(row.id) >= 0 ? order.indexOf(row.id) : order.indexOf(row.path);
          if (position >= 0) await read(client.from('product_images').update({ position }).eq('id', row.id));
        }
      }
      return id;
    },
    archiveProduct: (productId, archived = true) => read(client.from('products').update({ archived }).eq('id', productId)),
    setStock: ({ productId, variantId = null, stock = null, available = null }) =>
      rpc('set_stock', { product: productId, variant: variantId, next_stock: stock, is_available: available }),
    async panelOrders(businessId, { open = null } = {}) {
      let query = client.from('orders')
        .select('*,order_items_business:order_items!order_items_business_scope(*),order_events_business:order_events!order_events_business_scope(from_status,to_status,actor_role,note,created_at)')
        .eq('business_id', businessId).order('created_at', { ascending: false }).limit(100);
      if (open === true) query = query.not('status', 'in', '(delivered,canceled)');
      if (open === false) query = query.in('status', ['delivered', 'canceled']);
      return (await read(query)).map(mapOrder);
    },
    transitionOrder: (order, next, reason = '') =>
      read(client.rpc('transition_order', { order_id: order.id, expected_version: order.version, next_status: next, reason })),
    setOrderPayment: (order, paid) => read(client.rpc('set_order_payment', { order_id: order.id, expected_version: order.version, paid })),
    stats: (businessId, days = 30) => rpc('business_stats', { business: businessId, days }),
    team: businessId => rpc('business_team', { business: businessId }),
    addMember: (businessId, email, role) => rpc('add_business_member', { business: businessId, member_email: email.trim(), member_role: role }),
    removeMember: (businessId, userId) => rpc('remove_business_member', { business: businessId, member: userId }),
    async myParticipations(businessId) {
      const ref = await referenceData();
      const rows = await read(client.from('fair_participations')
        .select('id,status,stall_code,decision_note,requested_at,decided_at,fairs(*,organizers(name,whatsapp,public_phone,instagram))')
        .eq('business_id', businessId).order('requested_at', { ascending: false }).limit(60));
      const confirmedIds = rows.filter(r => r.status === 'confirmed').map(r => r.fairs.id);
      const announcements = confirmedIds.length ? await read(client.from('fair_announcements').select('id,fair_id,body,created_at')
        .in('fair_id', confirmedIds).order('created_at', { ascending: false }).limit(50)) : [];
      return rows.map(r => ({ id: r.id, status: r.status, stall: r.stall_code || '', note: r.decision_note || '',
        requestedAt: r.requested_at, decidedAt: r.decided_at, fair: mapFair(r.fairs, ref),
        announcements: announcements.filter(a => a.fair_id === r.fairs.id) }));
    },
    applyToFair: (fairId, businessId) => rpc('apply_to_fair', { fair: fairId, business: businessId }),
    withdrawParticipation: id => rpc('withdraw_participation', { participation: id }),

    // ── organizador ──
    organizerOverview: id => rpc('organizer_overview', { organizer: id }),
    async organizer(id) {
      return read(client.from('organizers').select('*').eq('id', id).maybeSingle());
    },
    updateOrganizer: (id, patch) => read(client.from('organizers').update(patch).eq('id', id)),
    async organizerFairs(id) {
      const ref = await referenceData();
      const rows = await read(client.from('fairs').select('*').eq('organizer_id', id).order('starts_at', { ascending: false }).limit(100));
      return rows.map(row => mapFair(row, ref));
    },
    async organizerFair(fairId) {
      const ref = await referenceData();
      const row = await read(client.from('fairs').select('*').eq('id', fairId).maybeSingle());
      requireValue(row, 'FAIR_NOT_FOUND', 'No encontramos esa feria.');
      return mapFair(row, ref);
    },
    createFair: (organizerId, payload) => rpc('create_fair', { organizer: organizerId, payload }),
    updateFair: (fairId, patch) => read(client.from('fairs').update(patch).eq('id', fairId)),
    setFairStatus: (fairId, status, reason = '') => rpc('set_fair_status', { fair: fairId, next_status: status, reason }),
    async setFairCover(fair, file) {
      const path = await uploadMedia(`fairs/${fair.id}`, 'cover', file);
      try { await read(client.from('fairs').update({ cover_path: path }).eq('id', fair.id)); }
      catch (error) { await removeMedia(path); throw error; }
      await removeMedia(fair.coverPath);
      return path;
    },
    async fairApplications(fairId) {
      const rows = await rpc('fair_applications', { fair: fairId });
      return rows.map(r => ({ ...r, business: { ...r.business, logo: publicUrl(r.business.logo_path) } }));
    },
    decideParticipation: (id, decision, stall = null, note = '') => rpc('decide_participation', { participation: id, decision, stall, note }),
    addFairParticipant: (fairId, slug, stall = null) => rpc('add_fair_participant', { fair: fairId, business_slug: slug, stall }),
    fairStats: fairId => rpc('fair_stats', { fair: fairId }),
    announcements: fairId => read(client.from('fair_announcements').select('id,body,created_at').eq('fair_id', fairId).order('created_at', { ascending: false })),
    postAnnouncement: (fairId, body) => read(client.from('fair_announcements').insert({ fair_id: fairId, body: String(body || '').trim().slice(0, 600) })),
    deleteAnnouncement: id => read(client.from('fair_announcements').delete().eq('id', id)),
    addOrganizerMember: (id, email) => rpc('add_organizer_member', { organizer: id, member_email: email.trim() }),

    // ── administración ──
    adminOverview: () => rpc('admin_overview'),
    async adminBusinesses() {
      const rows = await rpc('admin_businesses');
      return rows.map(r => ({ ...r, logo: publicUrl(r.logo_path) }));
    },
    reviewBusiness: (id, decision, note = '', plan = 'entrada', trialDays = 30) =>
      rpc('review_business', { business: id, decision, note, plan, trial_days: trialDays }),
    adminSetBusinessStatus: (id, status, note = '') => rpc('admin_set_business_status', { business: id, next_status: status, note }),
    adminSetSubscription: ({ businessId = null, organizerId = null, plan, status, periodEnd, graceDays = 10, note = '' }) =>
      rpc('admin_set_subscription', { business: businessId, organizer: organizerId, plan, plan_status: status, period_end: periodEnd, grace_days: graceDays, note }),
    adminOrganizers: () => rpc('admin_organizers'),
    adminCreateOrganizer: (name, email) => rpc('admin_create_organizer', { organizer_name: name, owner_email: email.trim() }),
    adminSetOrganizerStatus: (id, status) => rpc('admin_set_organizer_status', { organizer: id, next_status: status }),
    adminFounding: () => rpc('admin_founding_applications'),
    adminSurveySummary: () => rpc('admin_survey_summary'),
    adminUpdateFounding: (id, status) => rpc('admin_update_founding', { application: id, next_status: status }),
    adminAudit: (limit = 80) => rpc('admin_audit_log', { max_rows: limit }),
    adminErrors: (limit = 80) => rpc('admin_client_events', { max_rows: limit }),

    // ── registro de errores (sin datos personales; la base además los limpia) ──
    async reportEvent(kind, { code = '', message = '', route = '', release = '', context = {} } = {}) {
      try { await client.rpc('report_client_event', { kind, code, message, route, release, context }); } catch { /* nunca bloquea */ }
    },
    siteUrl,
  };
}
