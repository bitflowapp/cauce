import { CauceError, requireValue } from '../core/errors.js';
import { validateSignUp, validatePassword, normalizeEmail } from '../core/accounts.js';
import { slugify, validateProductInput, normalizeVariants } from '../core/catalog-rules.js';
import { quoteCart, changeQuantity, emptyCart, MAX_QUANTITY } from '../core/cart.js';
import { validateTripRequest } from '../core/taxi-dispatch.js';
import { sanitizeText, validateCustomerName, isValidArgentinePhone } from '../core/validators.js';

const MEDIA_BUCKET = 'business-media';
const LOCALITY = 'alumine';
const CART_PREFIX = 'cauce:production:cart:v1';
const GUEST_KEY = 'cauce:production:guest:v1';
const IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// The SDK is injected only by the explicit Supabase build. The demo has no SDK.
export function createSupabaseRepository({ client, redirectTo, storage } = {}) {
  requireValue(client?.auth && client?.from, 'SUPABASE_CONFIG_REQUIRED', 'Falta la conexión segura de CAUCE.');
  const store = storage || globalThis.localStorage;
  // Las reglas del servidor viajan con un mensaje corto en inglés; la persona
  // lee acá qué puede hacer, no cómo está implementado.
  const SERVER_MESSAGES = {
    'Complete your profile first': 'Completá tu perfil antes de registrar un comercio.',
    'Locality unavailable': 'La localidad no está disponible.',
    'Business not available': 'El comercio no está publicado.',
    'Business closed': 'El comercio está cerrado en este momento.',
    'Pickup not available': 'Este comercio no ofrece retiro.',
    'Delivery not available': 'Este comercio no ofrece envío.',
    'Empty cart': 'Tu carrito está vacío.',
    'Invalid quantity': 'Elegí una cantidad válida.',
    'Invalid fulfillment': 'Modalidad de entrega inválida.',
    'Payment method not available': 'Esa forma de pago no está disponible.',
    'Product not available': 'Un producto dejó de estar disponible.',
    'Variant required': 'Elegí una opción del producto.',
    'Variant not available': 'Esa opción ya no está disponible.',
    'Minimum order not reached': 'No alcanzaste el pedido mínimo para envío.',
    'Choose who delivers': 'Elegí quién hace la entrega.',
    'Rider not available': 'Esa persona de reparto no está disponible en tu comercio.',
    'Transition not allowed': 'No podés realizar ese cambio de estado.',
    'Not allowed for this business': 'Tu cuenta no tiene ese permiso en el comercio.',
    'Not a member of this business': 'Tu cuenta no pertenece a ese comercio.',
    'This order belongs to another account': 'El pedido pertenece a otra cuenta.',
    'That trip belongs to another account': 'El viaje pertenece a otra cuenta.',
    'Administration only': 'Sección exclusiva de administración.',
    'Invalid decision': 'Esa decisión no es válida.',
    'Only applications under review can be resolved': 'Sólo se puede resolver una solicitud en revisión.',
    'Only a draft or returned application can be submitted':
      'Sólo se puede solicitar la publicación desde un borrador o una solicitud devuelta.',
    'Only a published business can open': 'Sólo un comercio publicado puede abrir la atención.',
    'Your driver application is not approved yet': 'Tu alta de conductor todavía no fue aprobada.',
    'Mark yourself available before accepting': 'Marcate como disponible para aceptar solicitudes.',
    'You already have a trip in progress': 'Ya tenés un viaje en curso. Finalizalo antes de aceptar otro.',
    'You already have an open request': 'Ya tenés una solicitud de viaje abierta.',
    'Authentication required': 'Ingresá a tu cuenta para continuar.',
  };
  const fail = error => {
    if (!error) return;
    const code = error.code || 'SUPABASE_UNAVAILABLE';
    const messages = {
      invalid_credentials: 'Correo o contraseña incorrectos.',
      email_address_invalid: 'Ingresá un correo válido que pueda recibir mensajes.',
      email_not_confirmed: 'Confirmá tu correo antes de ingresar.',
      weak_password: 'Esa contraseña es insegura o apareció en filtraciones conocidas. Elegí otra.',
      over_email_send_rate_limit: 'Esperá unos minutos antes de pedir otro correo.',
      email_address_not_authorized: 'El envío de correo de CAUCE todavía necesita configuración. No se confirmó la cuenta.',
      reauthentication_needed: 'Volvé a iniciar sesión antes de cambiar tu contraseña.',
      // Reglas del servidor. El mensaje explica qué hacer, no cómo está hecho.
      U0001: 'El pedido cambió mientras lo mirabas. Actualizá la vista y reintentá.',
      U0002: 'Ese intento ya se usó con otros datos. Revisá tus pedidos antes de crear otro.',
      U0003: 'El stock cambió. Revisá tu carrito.',
      U0004: 'Esa solicitud ya no está disponible.',
      P0002: 'No se encontró lo que buscabas.',
      23505: 'Ese dato ya existe. Revisalo antes de reintentar.',
      23514: error.message?.startsWith('Faltan datos')
        ? error.message : 'Los datos no cumplen una regla del servicio.',
      42501: 'Tu cuenta no tiene permiso para realizar esta operación.',
    };
    throw new CauceError(code, SERVER_MESSAGES[error.message] || messages[code]
      || 'No se pudo completar la operación en CAUCE. Revisá la conexión y reintentá.');
  };
  const read = async request => { const { data, error } = await request; fail(error); return data; };
  const publicUrl = path => (path ? client.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl : '');

  // ── identidad ──
  let cachedSession = null;
  async function currentUser() {
    const session = await client.auth.getSession(); fail(session.error);
    if (!session.data.session) return null;
    const result = await client.auth.getUser(); fail(result.error);
    return result.data.user;
  }
  async function requireUser(message = 'Ingresá a tu cuenta para continuar.') {
    const user = await currentUser();
    requireValue(user, 'SESSION_REQUIRED', message);
    return user;
  }
  async function ensureProfile(user) {
    let profile = await read(client.from('profiles').select('*').eq('user_id', user.id).maybeSingle());
    if (!profile) {
      // Metadata is used only for display/contact fields, never permissions.
      const input = validateSignUp({ email: user.email, name: user.user_metadata?.display_name,
        phone: user.user_metadata?.phone }, { requirePassword: false });
      await read(client.from('profiles').upsert({ user_id: user.id, display_name: input.name, phone: input.phone },
        { onConflict: 'user_id', ignoreDuplicates: true }));
      profile = await read(client.from('profiles').select('*').eq('user_id', user.id).single());
    }
    return profile;
  }
  async function session() {
    const user = await currentUser();
    if (!user) {
      cachedSession = { actor: { id: null, kind: 'guest', roles: [], name: 'Visitante' }, ownerId: null };
      return cachedSession;
    }
    const profile = await ensureProfile(user);
    const memberships = await read(client.from('business_memberships').select('business_id,role').eq('user_id', user.id));
    const [admin, driver] = await Promise.all([
      read(client.rpc('my_access')),
      read(client.from('drivers').select('id,status').eq('user_id', user.id).maybeSingle()),
    ]);
    cachedSession = { ownerId: user.id, actor: { id: user.id, kind: 'account', name: profile.display_name,
      email: user.email, phone: profile.phone,
      roles: ['customer', ...(memberships.length ? ['merchant'] : []), ...(driver ? ['driver'] : []), ...(admin ? ['admin'] : [])],
      businessIds: memberships.map(item => item.business_id), memberships, driverId: driver?.id || null } };
    return cachedSession;
  }

  // ── adaptadores de forma ──
  // Una visita sin cuenta no tiene permiso sobre contactos ni revisiones: la
  // proyección pública no los pide, para no fallar la consulta entera.
  const publicBusinessColumns = '*,business_categories(slug,name)';
  const memberBusinessColumns =
    '*,business_categories(slug,name),business_contacts(owner_name,phone,email,reference),business_review_events(note,to_status,created_at)';
  const mapBusiness = row => {
    const contact = Array.isArray(row.business_contacts) ? row.business_contacts[0] : row.business_contacts;
    const reviews = (row.business_review_events || []).slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return {
      id: row.id, localityId: LOCALITY, name: row.name, slug: row.slug, status: row.status,
      open: row.open === true, active: row.status === 'active',
      categoryId: row.category_id || '', category: row.business_categories?.name || '',
      categorySlug: row.business_categories?.slug || '',
      description: row.description || '', address: row.address || '', hoursLabel: row.hours_label || '',
      deliveryZone: row.delivery_zone || '',
      deliveryFee: Number(row.delivery_fee_ars || 0), minimumOrder: Number(row.minimum_order_ars || 0),
      pickupEnabled: row.pickup_enabled === true, deliveryEnabled: row.delivery_enabled === true,
      logoPath: row.logo_path || '', coverPath: row.cover_path || '',
      logo: publicUrl(row.logo_path), cover: publicUrl(row.cover_path),
      // La vitrina existente lee estos nombres: se conserva su aspecto tal cual.
      logoImage: publicUrl(row.logo_path), coverImage: publicUrl(row.cover_path),
      subtitle: row.description || '', theme: 'sage', eta: '',
      ownerName: contact?.owner_name || '', contactPhone: contact?.phone || '',
      contactEmail: contact?.email || '', reference: contact?.reference || '',
      reviewNote: reviews.find(event => event.to_status === 'returned')?.note || '',
      reviewedAt: reviews[0]?.created_at || '',
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  };
  const productColumns = '*,product_categories(name),product_variants(id,name,price_delta_ars,position,active)';
  const mapProduct = row => ({
    id: row.id, businessId: row.business_id, localityId: LOCALITY,
    name: row.name, description: row.description || '',
    categoryId: row.category_id || '', category: row.product_categories?.name || 'Otros',
    price: Number(row.price_ars), stock: row.stock, available: row.available === true,
    archived: row.archived === true, imagePath: row.image_path || '', image: publicUrl(row.image_path),
    dishType: row.dish_type || '',
    variants: (row.product_variants || []).filter(variant => variant.active)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map(variant => ({ id: variant.id, name: variant.name, priceDelta: Number(variant.price_delta_ars) })),
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
  // Dos claves foráneas apuntan al pedido: la lectura declara cuál sigue.
  const orderColumns = '*,order_items!order_items_business_scope(*)'
    + ',order_events!order_events_business_scope(from_status,to_status,actor_role,note,created_at)';
  const mapOrder = row => ({
    id: row.id, code: row.code, businessId: row.business_id, localityId: LOCALITY,
    customerId: row.customer_id, customerAccountId: row.customer_id,
    customer: { name: row.contact_name, phone: row.contact_phone, address: row.address || '', notes: row.notes || '' },
    fulfillment: row.fulfillment, paymentMethod: row.payment_method, paymentStatus: row.payment_status,
    status: row.status, version: row.version,
    lines: (row.order_items || []).sort((a, b) => a.position - b.position).map(item => ({
      productId: item.product_id, variantId: item.variant_id,
      name: item.variant_name ? `${item.product_name} · ${item.variant_name}` : item.product_name,
      image: publicUrl(item.image_path), dishType: item.dish_type || '',
      quantity: item.quantity, unitPrice: Number(item.unit_price_ars), total: Number(item.total_ars),
    })),
    subtotal: Number(row.subtotal_ars), deliveryFee: Number(row.delivery_fee_ars),
    total: Number(row.total_ars), currency: row.currency,
    riderId: row.rider_id, trackingToken: row.tracking_token,
    deliveryCode: row.delivery_code ? { code: row.delivery_code } : null,
    cancellation: row.status === 'canceled' ? { kind: 'canceled', reason: row.cancel_reason || '' } : null,
    history: (row.order_events || []).sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(event => ({ status: event.to_status, at: event.created_at, by: event.actor_role })),
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
  const mapTrip = row => ({
    id: row.id, code: row.code, localityId: LOCALITY, passengerId: row.passenger_id, driverId: row.driver_id,
    status: row.status, origin: row.origin, originNote: row.origin_note || '', destination: row.destination,
    passengers: row.passengers, passenger: { name: row.passenger_name, phone: row.passenger_phone },
    cancelReason: row.cancel_reason || '', expiresAt: row.expires_at, acceptedAt: row.accepted_at,
    createdAt: row.created_at, updatedAt: row.updated_at, paymentMethod: 'cash_on_delivery',
  });
  const mapDriver = row => row && ({
    id: row.id, accountId: row.user_id, localityId: LOCALITY, displayName: row.display_name,
    mobileNumber: row.mobile_number || '', vehicle: row.vehicle || '', plate: row.plate || '',
    phone: row.phone || '', status: row.status, available: row.available === true,
    reviewNote: row.review_note || '', createdAt: row.created_at, updatedAt: row.updated_at,
  });
  const mapRider = row => ({ id: row.id, businessId: row.business_id, localityId: LOCALITY,
    name: row.name, phone: row.phone || '', active: row.active === true, createdAt: row.created_at });

  // ── carrito: vive en el navegador de cada cuenta hasta el checkout ──
  // Una visita sin cuenta puede armar su pedido; al ingresar, el carrito pasa a
  // la cuenta en lugar de perderse. Nunca se mezcla con el de otra identidad.
  const cartKey = (ownerId, businessId) => `${CART_PREFIX}:${ownerId}:${LOCALITY}:${businessId}`;
  function guestId() {
    try {
      let id = store?.getItem(GUEST_KEY);
      if (!id) { id = `guest-${crypto.randomUUID()}`; store?.setItem(GUEST_KEY, id); }
      return id;
    } catch { return 'guest-memory'; }
  }
  async function cartOwner() {
    const user = await currentUser();
    return user?.id || guestId();
  }
  function adoptGuestCarts(userId) {
    const guest = `${CART_PREFIX}:${guestId()}:`;
    try {
      for (const key of Object.keys(store || {})) {
        if (!key.startsWith(guest)) continue;
        const target = `${CART_PREFIX}:${userId}:${key.slice(guest.length)}`;
        if (!store.getItem(target)) store.setItem(target, store.getItem(key));
        store.removeItem(key);
      }
    } catch { /* sin almacenamiento no hay carrito que adoptar */ }
  }
  function readCart(ownerId, businessId) {
    const base = { businessId, localityId: LOCALITY, version: 1, lines: [] };
    if (!ownerId) return base;
    let parsed = null;
    try { parsed = JSON.parse(store?.getItem(cartKey(ownerId, businessId)) || 'null'); } catch { parsed = null; }
    if (!parsed || !Array.isArray(parsed.lines)) return base;
    const lines = parsed.lines
      .filter(line => typeof line?.productId === 'string'
        && Number.isSafeInteger(line.quantity) && line.quantity > 0 && line.quantity <= MAX_QUANTITY)
      .slice(0, 100)
      .map(line => ({ productId: line.productId, variantId: line.variantId ?? null, quantity: line.quantity }));
    return { ...base, lines, requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined };
  }
  function writeCart(ownerId, businessId, cart) {
    if (!ownerId) return cart;
    try {
      if (!cart.lines.length) store?.removeItem(cartKey(ownerId, businessId));
      else store?.setItem(cartKey(ownerId, businessId), JSON.stringify({ ...cart, savedAt: new Date().toISOString() }));
    } catch { /* un carrito que no se puede guardar no bloquea la navegación */ }
    return cart;
  }
  async function businessAndProducts(businessId) {
    const [business, products] = await Promise.all([
      read(client.from('businesses').select(publicBusinessColumns).eq('id', businessId).maybeSingle()),
      read(client.from('products').select(productColumns).eq('business_id', businessId).order('position')),
    ]);
    requireValue(business, 'BUSINESS_NOT_FOUND', 'No se encontró el comercio.');
    return { business: mapBusiness(business), products: (products || []).map(mapProduct) };
  }

  // ── medios ──
  async function uploadMedia(businessId, folder, file) {
    requireValue(file && typeof file.size === 'number', 'INVALID_IMAGE', 'Elegí una imagen.');
    requireValue(IMAGE_TYPES.includes(file.type), 'INVALID_IMAGE_TYPE', 'Se admiten imágenes JPEG, PNG o WebP.');
    requireValue(file.size > 0 && file.size <= MAX_IMAGE_BYTES, 'IMAGE_TOO_LARGE', 'La imagen no puede superar 5 MB.');
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
    const path = `businesses/${businessId}/${folder}/${crypto.randomUUID()}.${extension}`;
    const { error } = await client.storage.from(MEDIA_BUCKET).upload(path, file,
      { contentType: file.type, cacheControl: '3600', upsert: false });
    if (error) {
      throw new CauceError(error.statusCode === '403' ? 'MEDIA_FORBIDDEN' : 'MEDIA_UPLOAD_FAILED',
        error.statusCode === '403' ? 'Tu cuenta no puede subir imágenes de este comercio.'
          : 'No se pudo subir la imagen. Reintentá.');
    }
    return path;
  }
  async function removeMedia(path) {
    if (!path) return;
    // Un archivo huérfano no debe romper la operación principal ya guardada.
    await client.storage.from(MEDIA_BUCKET).remove([path]).catch(() => {});
  }

  const QUERIES = {
    async localities() { return read(client.from('localities').select('id,slug,name,active')); },
    async businessCategories() {
      return (await read(client.from('business_categories').select('id,slug,name').eq('active', true).order('position')))
        .map(row => ({ id: row.id, slug: row.slug, name: row.name }));
    },
    async publicBusinesses() {
      const rows = await read(client.from('businesses').select(publicBusinessColumns).eq('status', 'active').order('name'));
      return rows.map(mapBusiness).sort((a, b) => Number(b.open) - Number(a.open) || a.name.localeCompare(b.name));
    },
    async business(payload) {
      const row = await read(client.from('businesses').select(publicBusinessColumns).eq('id', payload?.businessId).maybeSingle());
      requireValue(row, 'BUSINESS_NOT_FOUND', 'No se encontró el comercio.');
      return mapBusiness(row);
    },
    async products(payload) {
      const rows = await read(client.from('products').select(productColumns)
        .eq('business_id', payload?.businessId).order('position'));
      return rows.map(mapProduct);
    },
    async productCategories(payload) {
      return read(client.from('product_categories').select('id,name,position,active')
        .eq('business_id', payload?.businessId).order('position'));
    },
    async myBusinesses() {
      const user = await requireUser('Ingresá para ver tus comercios.');
      const memberships = await read(client.from('business_memberships').select('business_id,role').eq('user_id', user.id));
      if (!memberships.length) return [];
      const rows = await read(client.from('businesses').select(memberBusinessColumns)
        .in('id', memberships.map(item => item.business_id)));
      return rows.map(row => ({ ...mapBusiness(row),
        membershipRole: memberships.find(item => item.business_id === row.id).role }));
    },
    async businessRequirements(payload) {
      return read(client.rpc('business_missing_requirements', { business: payload?.businessId }));
    },
    async cart(payload) {
      return readCart(await cartOwner(), payload?.businessId);
    },
    async carts() {
      const owner = await cartOwner();
      const businesses = await QUERIES.publicBusinesses();
      return businesses
        .map(business => ({ business, cart: readCart(owner, business.id) }))
        .filter(entry => entry.cart.lines.length);
    },
    async quote(payload) {
      const owner = await cartOwner();
      const { business, products } = await businessAndProducts(payload?.businessId);
      return quoteCart(readCart(owner, business.id), business, products, payload?.fulfillment || 'pickup');
    },
    async myOrders() {
      const user = await currentUser();
      if (!user) return [];
      const rows = await read(client.from('orders').select(orderColumns)
        .eq('customer_id', user.id).order('created_at', { ascending: false }));
      return rows.map(mapOrder);
    },
    async businessOrders(payload) {
      const rows = await read(client.from('orders').select(orderColumns)
        .eq('business_id', payload?.businessId).order('created_at', { ascending: false }));
      return rows.map(mapOrder);
    },
    async order(payload) {
      const row = await read(client.from('orders').select(orderColumns).eq('id', payload?.orderId).maybeSingle());
      requireValue(row, 'ORDER_NOT_FOUND', 'No se encontró el pedido.');
      return mapOrder(row);
    },
    async riders(payload) {
      const rows = await read(client.from('business_riders').select('*')
        .eq('business_id', payload?.businessId).order('name'));
      return rows.map(mapRider);
    },
    async myTrips() {
      const user = await currentUser();
      if (!user) return [];
      const rows = await read(client.from('trips').select('*')
        .eq('passenger_id', user.id).order('created_at', { ascending: false }));
      const trips = rows.map(mapTrip);
      // Los datos del móvil los entrega una función acotada, no la tabla.
      for (const trip of trips) {
        if (!trip.driverId) { trip.driver = null; continue; }
        const driver = await read(client.rpc('trip_driver', { trip: trip.id }));
        trip.driver = driver?.id ? { id: driver.id, displayName: driver.display_name,
          mobileNumber: driver.mobile_number, vehicle: driver.vehicle, plate: driver.plate, phone: driver.phone } : null;
      }
      return trips;
    },
    async myDriver() {
      const user = await currentUser();
      if (!user) return null;
      return mapDriver(await read(client.from('drivers').select('*').eq('user_id', user.id).maybeSingle())) || null;
    },
    async driverOffers() {
      const rows = await read(client.rpc('driver_offers'));
      return (rows || []).map(row => ({ id: row.id, code: row.code, status: row.status, origin: row.origin,
        originNote: row.origin_note || '', destination: row.destination, passengers: row.passengers,
        passengerInitial: row.passenger_initial, createdAt: row.created_at, expiresAt: row.expires_at }));
    },
    async driverTrips() {
      const user = await currentUser();
      if (!user) return [];
      const driver = await read(client.from('drivers').select('id').eq('user_id', user.id).maybeSingle());
      if (!driver) return [];
      const rows = await read(client.from('trips').select('*')
        .eq('driver_id', driver.id).order('created_at', { ascending: false }));
      return rows.map(mapTrip);
    },
    async adminBusinesses() {
      // La política ya filtra, pero la sección es administrativa: se dice que
      // no en vez de devolver una lista vacía que parezca "no hay comercios".
      const access = await read(client.rpc('my_access'));
      requireValue(access, 'ROLE_REQUIRED', 'Sección exclusiva de administración.');
      const rows = await read(client.from('businesses').select(memberBusinessColumns).order('created_at'));
      return rows.map(mapBusiness);
    },
    async adminQueue() {
      const access = await read(client.rpc('my_access'));
      requireValue(access, 'ROLE_REQUIRED', 'Sección exclusiva de administración.');
      const [businesses, drivers] = await Promise.all([
        read(client.from('businesses').select(memberBusinessColumns).order('created_at')),
        read(client.rpc('admin_drivers')),
      ]);
      const allBusinesses = businesses.map(mapBusiness);
      const allDrivers = (drivers || []).map(mapDriver);
      return {
        businesses: allBusinesses.filter(item => item.status === 'pending_review'),
        drivers: allDrivers.filter(item => item.status === 'pending_review'),
        allBusinesses, allDrivers,
      };
    },
    async adminMetrics() {
      const snapshot = await read(client.rpc('admin_snapshot'));
      requireValue(snapshot, 'ROLE_REQUIRED', 'Sección exclusiva de administración.');
      return {
        generatedAt: snapshot.generated_at, source: 'Operaciones registradas en CAUCE.',
        businesses: snapshot.businesses || {}, drivers: snapshot.drivers || {},
        orders: { total: snapshot.orders?.total || 0, byStatus: snapshot.orders?.byStatus || {},
          byFulfillment: {},
          delivered: snapshot.orders?.byStatus?.delivered || 0,
          canceled: snapshot.orders?.byStatus?.canceled || 0 },
        trips: { total: snapshot.trips?.total || 0, byStatus: snapshot.trips?.byStatus || {},
          accepted: Object.entries(snapshot.trips?.byStatus || {})
            .filter(([status]) => status !== 'requested' && status !== 'searching' && status !== 'expired')
            .reduce((total, [, count]) => total + count, 0) },
      };
    },
    async snapshotCounts() {
      const [businesses, products] = await Promise.all([
        read(client.from('businesses').select('id,open').eq('status', 'active')),
        read(client.from('products').select('id').eq('archived', false)),
      ]);
      return { businesses: businesses.length, activeBusinesses: businesses.length,
        products: products.length, orders: 0, trips: 0, openTrips: 0 };
    },
  };

  const COMMANDS = {
    async 'business.create'(payload) {
      // El alta exige perfil propio: se asegura antes de abrir la transacción.
      await ensureProfile(await requireUser('Ingresá para registrar tu comercio.'));
      const name = sanitizeText(payload?.name, { fallback: '', maxLength: 120 });
      requireValue(name.length >= 2, 'INVALID_BUSINESS_NAME', 'El nombre del comercio necesita al menos 2 caracteres.');
      const id = await read(client.rpc('create_business', { business_name: name,
        business_slug: `${slugify(name, 'comercio')}-${crypto.randomUUID().slice(0, 8)}`, locality_slug: LOCALITY }));
      await read(client.from('business_contacts').insert({ business_id: id,
        owner_name: sanitizeText(payload?.ownerName, { fallback: '', maxLength: 120 }),
        phone: sanitizeText(payload?.contactPhone, { fallback: '', maxLength: 24 }) }));
      if (payload?.category) {
        const categoryId = await resolveBusinessCategory(payload.category);
        if (categoryId) await read(client.from('businesses').update({ category_id: categoryId }).eq('id', id));
      }
      cachedSession = null;
      return { id };
    },
    async 'business.rename'(payload) {
      const row = await read(client.from('businesses').update({ name: payload?.name })
        .eq('id', payload?.businessId).select().maybeSingle());
      requireValue(row, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede editar este comercio.');
      return mapBusiness(row);
    },
    async 'business.update'(payload) {
      const patch = payload?.patch || {};
      const columns = {};
      const text = (value, max) => sanitizeText(value, { fallback: '', maxLength: max });
      if ('name' in patch) columns.name = text(patch.name, 120);
      if ('categoryId' in patch) columns.category_id = patch.categoryId || null;
      // La interfaz manda el rubro elegido de la lista real; se resuelve acá.
      if ('category' in patch && !('categoryId' in patch)) {
        columns.category_id = await resolveBusinessCategory(patch.category);
      }
      if ('description' in patch) columns.description = text(patch.description, 280);
      if ('address' in patch) columns.address = text(patch.address, 200);
      if ('hoursLabel' in patch) columns.hours_label = text(patch.hoursLabel, 120);
      if ('deliveryZone' in patch) columns.delivery_zone = text(patch.deliveryZone, 160);
      if ('pickupEnabled' in patch) columns.pickup_enabled = patch.pickupEnabled === true;
      if ('deliveryEnabled' in patch) columns.delivery_enabled = patch.deliveryEnabled === true;
      if ('deliveryFee' in patch) {
        const fee = Number(patch.deliveryFee);
        requireValue(Number.isSafeInteger(fee) && fee >= 0, 'INVALID_PRICE', 'El costo de envío debe ser un entero.');
        columns.delivery_fee_ars = fee;
      }
      if ('minimumOrder' in patch) {
        const minimum = Number(patch.minimumOrder);
        requireValue(Number.isSafeInteger(minimum) && minimum >= 0, 'INVALID_PRICE', 'El pedido mínimo debe ser un entero.');
        columns.minimum_order_ars = minimum;
      }
      if (Object.keys(columns).length) {
        const row = await read(client.from('businesses').update(columns)
          .eq('id', payload?.businessId).select(memberBusinessColumns).maybeSingle());
        requireValue(row, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede editar este comercio.');
      }
      const contact = {};
      if ('ownerName' in patch) contact.owner_name = text(patch.ownerName, 120);
      if ('contactPhone' in patch) contact.phone = text(patch.contactPhone, 24);
      if ('contactEmail' in patch) contact.email = text(patch.contactEmail, 120);
      if ('reference' in patch) contact.reference = text(patch.reference, 200);
      if (Object.keys(contact).length) {
        const updated = await read(client.from('business_contacts').update(contact)
          .eq('business_id', payload?.businessId).select().maybeSingle());
        if (!updated) {
          await read(client.from('business_contacts').insert({ business_id: payload?.businessId, ...contact }));
        }
      }
      return QUERIES.business({ businessId: payload?.businessId });
    },
    async 'business.submit'(payload) {
      await read(client.rpc('submit_business_for_review', { business: payload?.businessId }));
      return QUERIES.business({ businessId: payload?.businessId });
    },
    async 'business.setOpen'(payload) {
      await read(client.rpc('set_business_presence', { business: payload?.businessId, is_open: payload?.open === true }));
      return QUERIES.business({ businessId: payload?.businessId });
    },
    async 'business.setStatus'(payload) {
      await read(client.rpc('set_business_presence', { business: payload?.businessId, next_status: payload?.status }));
      return QUERIES.business({ businessId: payload?.businessId });
    },
    async 'business.setMedia'(payload) {
      const businessId = payload?.businessId;
      const folder = payload?.slot === 'cover' ? 'cover' : 'logo';
      const column = folder === 'cover' ? 'cover_path' : 'logo_path';
      const previous = (await QUERIES.business({ businessId }))[folder === 'cover' ? 'coverPath' : 'logoPath'];
      let path = null;
      if (payload?.file) path = await uploadMedia(businessId, folder, payload.file);
      const row = await read(client.from('businesses').update({ [column]: path })
        .eq('id', businessId).select(memberBusinessColumns).maybeSingle());
      if (!row) { await removeMedia(path); requireValue(false, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede editar este comercio.'); }
      if (previous && previous !== path) await removeMedia(previous);
      return mapBusiness(row);
    },
    async 'admin.reviewBusiness'(payload) {
      await read(client.rpc('review_business', { business: payload?.businessId,
        decision: payload?.decision === 'approve' ? 'active' : 'returned', note: payload?.note || '' }));
      return QUERIES.business({ businessId: payload?.businessId });
    },
    async 'admin.reviewDriver'(payload) {
      await read(client.rpc('review_driver', { driver: payload?.driverId,
        decision: payload?.decision === 'approve' ? 'active' : 'returned', note: payload?.note || '' }));
      return true;
    },
    async 'productCategory.create'(payload) {
      const name = sanitizeText(payload?.name, { fallback: '', maxLength: 40 });
      requireValue(name.length >= 2, 'INVALID_CATEGORY', 'Elegí o escribí una categoría.');
      const row = await read(client.from('product_categories')
        .insert({ business_id: payload?.businessId, name }).select().maybeSingle());
      requireValue(row, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede editar este catálogo.');
      return row;
    },
    async 'product.create'(payload) {
      const input = validateProductInput({ ...payload?.product, available: payload?.product?.available ?? true });
      const businessId = payload?.businessId;
      const categoryId = await resolveProductCategory(businessId, payload?.product?.category);
      const row = await read(client.from('products').insert({
        business_id: businessId, category_id: categoryId, name: input.name,
        description: input.description || '', price_ars: input.price, stock: input.stock ?? 0,
        available: input.available !== false, dish_type: input.dishType || '',
      }).select(productColumns).maybeSingle());
      requireValue(row, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede cargar productos en este comercio.');
      const variants = normalizeVariants(payload?.product?.variants || []);
      if (variants.length) {
        await read(client.from('product_variants').insert(variants.map((variant, index) => ({
          product_id: row.id, business_id: businessId, name: variant.name,
          price_delta_ars: variant.priceDelta, position: index,
        }))));
      }
      if (payload?.image) await COMMANDS['product.setImage']({ businessId, productId: row.id, file: payload.image });
      return mapProduct(await read(client.from('products').select(productColumns).eq('id', row.id).single()));
    },
    async 'product.update'(payload) {
      const patch = payload?.patch || {};
      const input = validateProductInput(patch, { partial: true });
      const columns = {};
      if ('name' in input) columns.name = input.name;
      if ('description' in input) columns.description = input.description;
      if ('price' in input) columns.price_ars = input.price;
      if ('stock' in input) columns.stock = input.stock;
      if ('archived' in input) columns.archived = input.archived;
      if ('dishType' in input) columns.dish_type = input.dishType;
      if ('category' in input) columns.category_id = await resolveProductCategory(payload?.businessId, input.category);
      // Disponibilidad y stock pasan por la función que también habilita al equipo.
      if ('available' in input && Object.keys(columns).length === 0) {
        const row = await read(client.rpc('set_product_availability',
          { product: payload?.productId, is_available: input.available, next_stock: input.stock ?? null }));
        return mapProduct(await read(client.from('products').select(productColumns).eq('id', row.id).single()));
      }
      if ('available' in input) columns.available = input.available;
      const row = await read(client.from('products').update(columns)
        .eq('id', payload?.productId).select(productColumns).maybeSingle());
      requireValue(row, 'PRODUCT_FORBIDDEN', 'Tu cuenta no puede editar este producto.');
      if ('variants' in patch) {
        const variants = normalizeVariants(patch.variants);
        await read(client.from('product_variants').delete().eq('product_id', payload?.productId));
        if (variants.length) {
          await read(client.from('product_variants').insert(variants.map((variant, index) => ({
            product_id: payload?.productId, business_id: row.business_id, name: variant.name,
            price_delta_ars: variant.priceDelta, position: index,
          }))));
        }
      }
      return mapProduct(await read(client.from('products').select(productColumns).eq('id', payload?.productId).single()));
    },
    async 'product.setImage'(payload) {
      const productId = payload?.productId;
      const current = await read(client.from('products').select('id,business_id,image_path').eq('id', productId).maybeSingle());
      requireValue(current, 'PRODUCT_NOT_FOUND', 'No se encontró el producto.');
      let path = null;
      if (payload?.file) path = await uploadMedia(current.business_id, `products/${productId}`, payload.file);
      const row = await read(client.from('products').update({ image_path: path })
        .eq('id', productId).select(productColumns).maybeSingle());
      if (!row) { await removeMedia(path); requireValue(false, 'PRODUCT_FORBIDDEN', 'Tu cuenta no puede editar este producto.'); }
      if (current.image_path && current.image_path !== path) await removeMedia(current.image_path);
      return mapProduct(row);
    },
    async 'rider.create'(payload) {
      const name = sanitizeText(payload?.name, { fallback: '', maxLength: 80 });
      requireValue(name.length >= 2, 'INVALID_NAME', 'Ingresá el nombre de la persona de reparto.');
      const phone = sanitizeText(payload?.phone, { fallback: '', maxLength: 24 });
      const row = await read(client.from('business_riders')
        .insert({ business_id: payload?.businessId, name, phone }).select().maybeSingle());
      requireValue(row, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede administrar el reparto de este comercio.');
      return mapRider(row);
    },
    async 'cart.setQuantity'(payload) {
      const owner = await cartOwner();
      const { business, products } = await businessAndProducts(payload?.businessId);
      requireValue(business.status === 'active', 'BUSINESS_NOT_ACTIVE', 'El comercio no está publicado.');
      const product = products.find(candidate => candidate.id === payload?.productId);
      requireValue(product, 'PRODUCT_NOT_FOUND', 'No se encontró el producto.');
      const next = changeQuantity(readCart(owner, business.id), product, payload?.quantity, payload?.variantId ?? null);
      return writeCart(owner, business.id, next);
    },
    async 'cart.clear'(payload) {
      const owner = await cartOwner();
      return writeCart(owner, payload?.businessId, emptyCart({ businessId: payload?.businessId, localityId: LOCALITY }));
    },
    async 'cart.prepareRequest'(payload) {
      const user = await requireUser('Ingresá para confirmar tu pedido.');
      const cart = readCart(user.id, payload?.businessId);
      requireValue(cart.lines.length > 0, 'EMPTY_CART', 'Tu carrito está vacío.');
      cart.requestId ||= crypto.randomUUID();
      writeCart(user.id, payload?.businessId, cart);
      return cart.requestId;
    },
    async 'order.create'(payload) {
      const user = await requireUser('Ingresá para confirmar tu pedido.');
      const businessId = payload?.businessId;
      const fulfillment = payload?.fulfillment;
      requireValue(['pickup', 'delivery'].includes(fulfillment), 'INVALID_FULFILLMENT', 'Modalidad inválida.');
      const nameCheck = validateCustomerName(payload?.customer?.name);
      requireValue(nameCheck.ok, 'INVALID_NAME', nameCheck.message || 'Ingresá un nombre de contacto.');
      const phone = sanitizeText(payload?.customer?.phone, { fallback: '', maxLength: 24 });
      requireValue(isValidArgentinePhone(phone), 'INVALID_PHONE', 'Ingresá un teléfono de contacto válido.');
      const address = fulfillment === 'delivery'
        ? sanitizeText(payload?.customer?.address, { fallback: '', maxLength: 200 }) : '';
      requireValue(fulfillment !== 'delivery' || address.length >= 5, 'ADDRESS_REQUIRED', 'Ingresá la dirección de entrega.');
      const cart = readCart(user.id, businessId);
      requireValue(cart.lines.length > 0, 'EMPTY_CART', 'Tu carrito está vacío.');
      requireValue(cart.requestId === payload?.requestId, 'STALE_REQUEST',
        'El carrito cambió desde que abriste la confirmación. Revisalo y confirmá de nuevo.');
      // El servidor recalcula precios, envío y total: lo enviado es sólo la selección.
      const items = cart.lines
        .map(line => ({ product_id: line.productId, variant_id: line.variantId ?? null, quantity: line.quantity }))
        .sort((a, b) => `${a.product_id}|${a.variant_id}`.localeCompare(`${b.product_id}|${b.variant_id}`));
      const orderId = await read(client.rpc('create_order', {
        business: businessId, idem: payload.requestId, fulfillment,
        payment_method: fulfillment === 'delivery' ? 'cash_on_delivery' : 'cash_on_pickup',
        contact: { name: nameCheck.name, phone, address,
          notes: sanitizeText(payload?.customer?.notes, { fallback: '', maxLength: 280 }) },
        items,
      }));
      writeCart(user.id, businessId, emptyCart({ businessId, localityId: LOCALITY }));
      return QUERIES.order({ orderId });
    },
    async 'order.transition'(payload) {
      const row = await read(client.rpc('transition_order', {
        order_id: payload?.orderId,
        expected_version: Number.isSafeInteger(Number(payload?.expectedVersion)) ? Number(payload.expectedVersion) : null,
        next_status: payload?.nextStatus, rider: payload?.riderId || null,
        reason: sanitizeText(payload?.reason, { fallback: '', maxLength: 200 }),
      }));
      return QUERIES.order({ orderId: row.id });
    },
    async 'driver.apply'(payload) {
      await requireUser('Ingresá para registrarte como conductor.');
      const name = validateCustomerName(payload?.displayName || payload?.name);
      requireValue(name.ok, 'INVALID_NAME', name.message || 'Ingresá tu nombre.');
      const row = await read(client.rpc('apply_as_driver', {
        display_name: name.name,
        mobile_number: sanitizeText(payload?.mobileNumber, { fallback: '', maxLength: 40 }),
        vehicle: sanitizeText(payload?.vehicle, { fallback: '', maxLength: 80 }),
        plate: sanitizeText(payload?.plate, { fallback: '', maxLength: 16 }),
        phone: sanitizeText(payload?.phone, { fallback: '', maxLength: 24 }),
      }));
      cachedSession = null;
      return mapDriver(row);
    },
    async 'driver.setAvailability'(payload) {
      return mapDriver(await read(client.rpc('set_driver_availability', { is_available: payload?.available === true })));
    },
    async 'trip.request'(payload) {
      await requireUser('Ingresá para pedir un taxi.');
      const input = validateTripRequest(payload);
      return mapTrip(await read(client.rpc('request_trip', {
        origin: input.origin, destination: input.destination, origin_note: input.originNote,
        passengers: input.passengers, passenger_name: input.passenger.name, passenger_phone: input.passenger.phone,
      })));
    },
    async 'trip.accept'(payload) {
      return mapTrip(await read(client.rpc('accept_trip', { trip: payload?.tripId })));
    },
    async 'trip.advance'(payload) {
      return mapTrip(await read(client.rpc('transition_trip',
        { trip: payload?.tripId, next_status: payload?.nextStatus, reason: '' })));
    },
    async 'trip.cancel'(payload) {
      return mapTrip(await read(client.rpc('transition_trip', { trip: payload?.tripId, next_status: 'canceled',
        reason: sanitizeText(payload?.reason, { fallback: '', maxLength: 200 }) })));
    },
  };

  async function resolveBusinessCategory(value) {
    const wanted = sanitizeText(value, { fallback: '', maxLength: 60 });
    if (!wanted) return null;
    const rows = await read(client.from('business_categories').select('id,slug,name').eq('active', true));
    const match = rows.find(row => row.slug === wanted)
      || rows.find(row => row.name.toLowerCase() === wanted.toLowerCase());
    return match?.id || null;
  }

  async function resolveProductCategory(businessId, name) {
    const label = sanitizeText(name, { fallback: '', maxLength: 40 });
    if (label.length < 2) return null;
    const existing = await read(client.from('product_categories').select('id')
      .eq('business_id', businessId).eq('name', label).maybeSingle());
    if (existing) return existing.id;
    const created = await read(client.from('product_categories')
      .insert({ business_id: businessId, name: label }).select('id').maybeSingle());
    return created?.id || null;
  }

  return Object.freeze({
    environment: 'supabase',
    capabilities: Object.freeze({ passwordAuth: true, sharedPersistence: true, demoIdentities: false,
      reset: false, accountManagement: true, foundationOnly: false, orders: true, media: true, realtime: true }),
    session,
    async completeAuthRedirect(href, scrubUrl) {
      const url = new URL(href);
      const tokenHash = url.searchParams.get('token_hash');
      if (!tokenHash) return { handled: false, recovery: false };
      scrubUrl();
      const type = url.searchParams.get('type');
      requireValue(['signup', 'recovery', 'email'].includes(type), 'INVALID_AUTH_LINK', 'El enlace de acceso no es válido.');
      fail((await client.auth.verifyOtp({ token_hash: tokenHash, type })).error);
      return { handled: true, recovery: type === 'recovery' };
    },
    async identities() { return []; },
    async register(input) {
      const profile = validateSignUp(input);
      const { data, error } = await client.auth.signUp({ email: profile.email, password: input.password,
        options: { emailRedirectTo: redirectTo, data: { display_name: profile.name, phone: profile.phone } } });
      fail(error);
      if (data.session) { adoptGuestCarts(data.user.id); await ensureProfile(data.user); }
      return { confirmationRequired: !data.session };
    },
    async signIn({ email, password }) {
      const result = await client.auth.signInWithPassword({ email: normalizeEmail(email), password });
      fail(result.error);
      cachedSession = null;
      if (result.data.user) adoptGuestCarts(result.data.user.id);
      return session();
    },
    async signOut() { cachedSession = null; fail((await client.auth.signOut({ scope: 'local' })).error); },
    async requestPasswordReset(email) {
      fail((await client.auth.resetPasswordForEmail(normalizeEmail(email), { redirectTo })).error);
    },
    async updatePassword(password) {
      const valid = validatePassword(password); requireValue(valid.ok, 'INVALID_PASSWORD', valid.message);
      fail((await client.auth.updateUser({ password })).error);
    },
    async updateProfile(input) {
      const user = await requireUser('Ingresá para actualizar tu perfil.');
      const profile = validateSignUp({ ...input, email: user.email }, { requirePassword: false });
      cachedSession = null;
      return read(client.from('profiles').update({ display_name: profile.name, phone: profile.phone })
        .eq('user_id', user.id).select().single());
    },
    onAuthChange(callback) { return client.auth.onAuthStateChange(callback).data.subscription; },

    // Sincronización en vivo: un canal acotado por comercio o por cuenta.
    // Nunca se escucha la tabla entera: el filtro viaja en la suscripción y el
    // servidor vuelve a aplicar RLS sobre cada fila antes de entregarla.
    watch(scope, handler) {
      const filters = {
        businessOrders: { table: 'orders', filter: `business_id=eq.${scope.businessId}` },
        myOrders: { table: 'orders', filter: `customer_id=eq.${scope.customerId}` },
        order: { table: 'orders', filter: `id=eq.${scope.orderId}` },
        myTrips: { table: 'trips', filter: `passenger_id=eq.${scope.passengerId}` },
        driverTrips: { table: 'trips', filter: `driver_id=eq.${scope.driverId}` },
        // No hay canal de solicitudes abiertas a propósito: una solicitud sin
        // aceptar no es legible por ningún conductor, así que Realtime tampoco
        // se la puede entregar. El panel del conductor las consulta por RPC.
      }[scope.kind];
      if (!filters) return () => {};
      const channel = client.channel(`cauce:${scope.kind}:${scope.businessId || scope.customerId || scope.orderId || scope.passengerId || scope.driverId || 'open'}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: filters.table, filter: filters.filter },
          payload => handler(payload))
        .subscribe();
      return () => { client.removeChannel(channel); };
    },

    async query(name, payload = {}) {
      const run = QUERIES[name];
      if (!run) throw new CauceError('FEATURE_UNAVAILABLE', 'Esta consulta todavía no está habilitada en CAUCE.');
      return run(payload);
    },
    async command(name, payload = {}) {
      const run = COMMANDS[name];
      if (!run) throw new CauceError('FEATURE_UNAVAILABLE', 'Esta operación todavía no está habilitada en CAUCE.');
      return run(payload);
    },
  });
}
