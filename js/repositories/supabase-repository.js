import { CauceError, requireValue } from '../core/errors.js';
import { validateSignUp, validatePassword, normalizeEmail, isValidEmail } from '../core/accounts.js';
import { slugify, validateProductInput, normalizeVariants } from '../core/catalog-rules.js';
import { quoteCart, changeQuantity, emptyCart, MAX_QUANTITY } from '../core/cart.js';
import { validateTripRequest } from '../core/taxi-dispatch.js';
import { sanitizeText, validateCustomerName, isValidArgentinePhone } from '../core/validators.js';
import { validateHours, DEFAULT_TIMEZONE } from '../core/business-hours.js';
import { mapPilotMetrics } from '../core/pilot-metrics.js';

const MEDIA_BUCKET = 'business-media';
const LOCALITY = 'alumine';
const CART_PREFIX = 'cauce:production:cart:v1';
const GUEST_KEY = 'cauce:production:guest:v1';
const IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20000;
const SESSION_TTL_MS = 15000;
const AUTH_LINK_TYPES = Object.freeze(['signup', 'email', 'recovery', 'invite', 'magiclink', 'email_change']);

// Las reglas del servidor viajan con un mensaje corto en inglés; la persona lee
// acá qué puede hacer, nunca cómo está implementado.
const SERVER_MESSAGES = Object.freeze({
  'Complete your profile first': 'Completá tu perfil antes de registrar un comercio.',
  'Locality unavailable': 'La localidad no está disponible.',
  'Business not available': 'Este comercio no está recibiendo pedidos por el momento.',
  'Business not found': 'No se encontró el comercio.',
  'Business closed': 'El comercio está cerrado en este momento.',
  'Pickup not available': 'Este comercio no ofrece retiro.',
  'Delivery not available': 'Este comercio no ofrece envío.',
  'Empty cart': 'Tu carrito está vacío.',
  'Invalid quantity': 'Revisá las cantidades del carrito.',
  'Invalid fulfillment': 'Elegí retiro o envío.',
  'Payment method not available': 'Esa forma de pago no está disponible.',
  'Product not available': 'Un producto dejó de estar disponible. Revisá tu carrito.',
  'Variant required': 'Elegí una opción del producto.',
  'Variant not available': 'Esa opción ya no está disponible.',
  'Minimum order not reached': 'No alcanzaste el pedido mínimo para envío.',
  'Invalid contact name': 'Ingresá tu nombre y apellido.',
  'Invalid contact phone': 'Ingresá un teléfono de contacto válido.',
  'Address required': 'Ingresá la dirección de entrega.',
  'Choose who delivers': 'Elegí quién hace la entrega.',
  'Rider not available': 'Esa persona de reparto no está disponible en tu comercio.',
  'Reason required': 'Escribí el motivo para que la persona sepa qué pasó.',
  'Transition not allowed': 'Ese cambio de estado ya no es posible. Actualizá la vista.',
  'Not allowed for this business': 'Tu cuenta no tiene ese permiso en el comercio.',
  'Not a member of this business': 'Tu cuenta no pertenece a ese comercio.',
  'This order belongs to another account': 'El pedido pertenece a otra cuenta.',
  'Order not found': 'No se encontró el pedido.',
  'That trip belongs to another account': 'El viaje pertenece a otra cuenta.',
  'Administration only': 'Sección exclusiva de administración.',
  'Invalid decision': 'Esa decisión no es válida.',
  'Only applications under review can be resolved': 'Sólo se puede resolver una solicitud en revisión.',
  'Only a draft or returned application can be submitted':
    'Sólo se puede solicitar la publicación desde un borrador o una solicitud devuelta.',
  'Only a published business can open': 'Sólo un comercio publicado puede abrir la atención.',
  'Only the owner manages the team': 'Sólo la persona titular administra el equipo.',
  'No account with that email': 'No hay una cuenta de CAUCE con ese correo. Pedile que se registre primero.',
  'Already a member': 'Esa persona ya forma parte del equipo.',
  'Invalid role': 'Elegí un rol válido.',
  'Member not found': 'Esa persona ya no forma parte del equipo.',
  'Ownership changes are administrative': 'La titularidad del comercio se cambia con administración de CAUCE.',
  'Invalid hours': 'Revisá los horarios cargados.',
  'Se admiten hasta 3 horarios por día': 'Se admiten hasta 3 horarios por día.',
  'Feature disabled': 'Esta sección no está habilitada en CAUCE por ahora.',
  'Your driver application is not approved yet': 'Tu alta de conductor todavía no fue aprobada.',
  'Mark yourself available before accepting': 'Marcate como disponible para aceptar solicitudes.',
  'You already have a trip in progress': 'Ya tenés un viaje en curso. Finalizalo antes de aceptar otro.',
  'You already have an open request': 'Ya tenés una solicitud de viaje abierta.',
  'Authentication required': 'Ingresá a tu cuenta para continuar.',
  'Delivery code required': 'Para entregar, ingresá el código que te dicta el cliente.',
  'Account already linked to another rider': 'Esa cuenta ya está vinculada a otra persona de reparto de este comercio.',
  'Payment not approved': 'El pago online de este pedido todavía no está aprobado.',
  'Payments disabled': 'Los pagos online no están habilitados en CAUCE.',
  'Order already paid': 'Este pedido ya está pagado.',
  'Payment not required': 'Este pedido se paga en efectivo al comercio.',
  'Order canceled': 'El pedido está cancelado.',
});

const CODE_MESSAGES = Object.freeze({
  invalid_credentials: 'Correo o contraseña incorrectos.',
  email_address_invalid: 'Ingresá un correo válido que pueda recibir mensajes.',
  email_not_confirmed: 'Confirmá tu correo antes de ingresar. Revisá tu casilla (y la carpeta de spam).',
  weak_password: 'Esa contraseña es insegura o apareció en filtraciones conocidas. Elegí otra.',
  same_password: 'La nueva contraseña tiene que ser distinta de la actual.',
  over_email_send_rate_limit: 'Esperá unos minutos antes de pedir otro correo.',
  over_request_rate_limit: 'Hubo demasiados intentos. Esperá unos minutos y volvé a probar.',
  email_address_not_authorized: 'El envío de correo de CAUCE todavía necesita configuración. Escribinos para completar el alta.',
  email_exists: 'Ya existe una cuenta con ese correo. Ingresá o recuperá tu contraseña.',
  user_already_exists: 'Ya existe una cuenta con ese correo. Ingresá o recuperá tu contraseña.',
  signup_disabled: 'El registro de cuentas no está habilitado en este momento.',
  anonymous_provider_disabled: 'La compra sin cuenta no está habilitada. Ingresá con tu cuenta para confirmar.',
  reauthentication_needed: 'Por seguridad, volvé a ingresar antes de cambiar tu contraseña.',
  otp_expired: 'El enlace venció o ya se usó. Pedí uno nuevo.',
  flow_state_expired: 'El enlace venció o ya se usó. Pedí uno nuevo.',
  flow_state_not_found: 'El enlace venció o ya se usó. Pedí uno nuevo.',
  bad_code_verifier: 'El enlace venció o ya se usó. Pedí uno nuevo.',
  user_banned: 'La cuenta está deshabilitada. Escribí a CAUCE para revisarlo.',
  session_not_found: 'Tu sesión venció. Ingresá de nuevo.',
  refresh_token_not_found: 'Tu sesión venció. Ingresá de nuevo.',
  refresh_token_already_used: 'Tu sesión venció. Ingresá de nuevo.',
  PGRST301: 'Tu sesión venció. Ingresá de nuevo.',
  PGRST303: 'Tu sesión venció. Ingresá de nuevo.',
  U0001: 'El pedido cambió mientras lo mirabas. Ya actualizamos la vista: revisalo y reintentá.',
  U0003: 'No queda stock suficiente de un producto. Revisá tu carrito.',
  U0004: 'Esa solicitud ya no está disponible.',
  U0006: 'Tenés varios pedidos esperando respuesta. Esperá a que el comercio los atienda antes de enviar otro.',
  P0002: 'No se encontró lo que buscabas.',
  23505: 'Ese dato ya existe. Revisalo antes de reintentar.',
  23514: 'Los datos no cumplen una regla del servicio.',
  42501: 'Tu cuenta no tiene permiso para realizar esta operación.',
});

const NETWORK = /Failed to fetch|NetworkError|Load failed|fetch failed|Network request failed|ERR_INTERNET/i;

export function isConnectionError(error) {
  return error?.code === 'NETWORK_ERROR';
}

// Convierte cualquier error de Supabase en uno que la interfaz puede mostrar.
// El detalle técnico queda en `technical` para el registro, nunca en pantalla.
export function toCauceError(error) {
  const rawCode = String(error?.code || error?.error_code || '');
  const rawMessage = String(error?.message || '');
  let code = rawCode || 'SUPABASE_UNAVAILABLE';
  let message;
  if (NETWORK.test(rawMessage) || error?.name === 'AuthRetryableFetchError' || error?.status === 0) {
    code = 'NETWORK_ERROR';
    message = 'No hay conexión con CAUCE. Revisá tu conexión y reintentá: no se envió nada.';
  } else if (rawMessage.startsWith('Faltan datos')) {
    message = rawMessage;
  } else {
    message = SERVER_MESSAGES[rawMessage] || CODE_MESSAGES[rawCode]
      || 'No se pudo completar la operación. Reintentá en unos segundos.';
  }
  const wrapped = new CauceError(code, message);
  wrapped.technical = { code: rawCode, message: rawMessage.slice(0, 200), status: error?.status ?? null };
  if (rawCode === 'U0005') {
    wrapped.code = 'PRICES_CHANGED';
    wrapped.newTotal = Number(error?.details);
    wrapped.message = 'Los precios cambiaron mientras confirmabas. Revisá el nuevo total y confirmá de nuevo.';
  }
  return wrapped;
}

// El SDK se inyecta sólo en el build conectado. La demo no incluye ningún SDK.
/**
 * @param {{ client: any, redirectTo?: string, storage?: Storage, onError?: ((error: CauceError) => void)|null,
 *   requestTimeoutMs?: number }} options
 */
export function createSupabaseRepository({ client, redirectTo, storage, onError = null, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
  requireValue(client?.auth && client?.from, 'SUPABASE_CONFIG_REQUIRED', 'Falta la conexión segura de CAUCE.');
  const store = storage || globalThis.localStorage;
  const fail = error => {
    if (!error) return;
    const wrapped = toCauceError(error);
    onError?.(wrapped);
    throw wrapped;
  };
  // Una red móvil que se traba no da error: la consulta queda colgada y el
  // botón, ocupado para siempre. Pasado el tiempo se corta y se avisa; como
  // la operación pudo haber llegado, no se dice "no se envió nada". Las
  // subidas de imágenes (Storage) no pasan por acá: pueden tardar más.
  const failTimeout = () => {
    const wrapped = new CauceError('NETWORK_TIMEOUT',
      'La conexión está muy lenta y no pudimos confirmar. Revisá cómo quedó y reintentá si hace falta.');
    onError?.(wrapped);
    throw wrapped;
  };
  const read = async request => {
    let result;
    const controller = typeof request?.abortSignal === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), requestTimeoutMs) : null;
    try { result = await (controller ? request.abortSignal(controller.signal) : request); }
    catch (error) { if (controller?.signal.aborted) failTimeout(); fail(error); }
    finally { if (timer) clearTimeout(timer); }
    if (controller?.signal.aborted && result?.error) failTimeout();
    fail(result.error);
    return result.data;
  };
  // Edge Functions de pagos. Un 503 quiere decir apagado o sin configurar: se
  // explica sin detalles técnicos.
  const invoke = async (name, body) => {
    requireValue(typeof client.functions?.invoke === 'function', 'PAYMENT_UNAVAILABLE', 'Los pagos online no están disponibles.');
    let result;
    try { result = await client.functions.invoke(name, { body }); }
    catch (error) { fail(error); }
    if (result?.error) {
      const status = result.error.context?.status ?? result.error.status ?? null;
      const wrapped = new CauceError(status === 503 ? 'PAYMENTS_DISABLED' : 'PAYMENT_UNAVAILABLE', status === 503
        ? 'Los pagos online no están habilitados en este momento.'
        : 'No pudimos completar la operación con el proveedor de pagos. Reintentá en unos minutos.');
      wrapped.technical = { code: `FUNCTION_${status ?? 'ERROR'}`, message: String(result.error.message || '').slice(0, 200), status };
      onError?.(wrapped);
      throw wrapped;
    }
    return result?.data;
  };
  const publicUrl = path => (path ? client.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl : '');

  // ── identidad ──
  let cachedSession = null;
  let cachedAt = 0;
  const invalidate = () => { cachedSession = null; cachedAt = 0; };

  // `verify` consulta a Auth por red (al arrancar y ante eventos de sesión); el
  // resto de las veces alcanza la sesión local: cada request vuelve a validar
  // el JWT en el servidor igual.
  async function currentUser({ verify = false } = {}) {
    const session = await client.auth.getSession();
    fail(session.error);
    if (!session.data.session) return null;
    if (!verify) return session.data.session.user;
    const result = await client.auth.getUser();
    if (result.error) {
      // Una sesión revocada o vencida se descarta en vez de dejar la interfaz
      // en un estado a medias.
      if (['session_not_found', 'refresh_token_not_found', 'user_not_found', 'bad_jwt'].includes(result.error.code)
        || result.error.status === 401 || result.error.status === 403) {
        await client.auth.signOut({ scope: 'local' }).catch(() => {});
        return null;
      }
      fail(result.error);
    }
    return result.data.user;
  }
  const isPermanent = user => Boolean(user) && user.is_anonymous !== true;

  async function requireAccount(message = 'Ingresá a tu cuenta para continuar.') {
    const user = await currentUser();
    requireValue(isPermanent(user), 'SESSION_REQUIRED', message);
    return user;
  }
  async function ensureProfile(user) {
    let profile = await read(client.from('profiles').select('*').eq('user_id', user.id).maybeSingle());
    if (!profile) {
      // Metadata sólo inicializa nombre y teléfono, nunca permisos.
      const input = validateSignUp({ email: user.email, name: user.user_metadata?.display_name || user.email.split('@')[0],
        phone: user.user_metadata?.phone }, { requirePassword: false });
      await read(client.from('profiles').upsert({ user_id: user.id, display_name: input.name, phone: input.phone },
        { onConflict: 'user_id', ignoreDuplicates: true }));
      profile = await read(client.from('profiles').select('*').eq('user_id', user.id).single());
    }
    return profile;
  }
  async function session({ verify = false, fresh = false } = {}) {
    if (!verify && !fresh && cachedSession && Date.now() - cachedAt < SESSION_TTL_MS) return cachedSession;
    const user = await currentUser({ verify });
    if (!user) {
      cachedSession = { actor: { id: null, kind: 'guest', roles: [], name: 'Visitante' }, ownerId: null };
    } else if (!isPermanent(user)) {
      // Sesión anónima de compra: puede tener pedidos propios, nada más.
      cachedSession = { ownerId: user.id, actor: { id: user.id, kind: 'guest', anonymous: true,
        roles: ['customer'], name: 'Compra sin cuenta', businessIds: [], memberships: [] } };
    } else {
      const profile = await ensureProfile(user);
      const [memberships, admin, driver, riderRows] = await Promise.all([
        read(client.from('business_memberships').select('business_id,role').eq('user_id', user.id)),
        read(client.rpc('my_access')),
        read(client.from('drivers').select('id,status').eq('user_id', user.id).maybeSingle()),
        // Reparto propio: las filas que un comercio vinculó a esta cuenta (RLS: sólo las propias).
        read(client.from('business_riders').select('id,business_id,name,active').eq('user_id', user.id)),
      ]);
      const riders = riderRows.filter(row => row.active);
      cachedSession = { ownerId: user.id, actor: { id: user.id, kind: 'account', name: profile.display_name,
        email: user.email, phone: profile.phone,
        roles: ['customer', ...(memberships.length ? ['merchant'] : []), ...(riders.length ? ['rider'] : []),
          ...(driver ? ['driver'] : []), ...(admin ? ['admin'] : [])],
        businessIds: memberships.map(item => item.business_id), memberships, driverId: driver?.id || null,
        riderIds: riders.map(row => row.id) } };
    }
    cachedAt = Date.now();
    return cachedSession;
  }

  // Compra sin cuenta: si no hay sesión, se abre una anónima real de Supabase.
  async function ensureCustomerSession() {
    const user = await currentUser();
    if (user) return user;
    const { data, error } = await client.auth.signInAnonymously();
    if (error) {
      const wrapped = toCauceError(error);
      if (error.code === 'anonymous_provider_disabled' || error.status === 422) {
        wrapped.code = 'GUEST_CHECKOUT_UNAVAILABLE';
        wrapped.message = 'Para confirmar el pedido, ingresá con tu cuenta.';
      }
      onError?.(wrapped);
      throw wrapped;
    }
    invalidate();
    return data.user;
  }

  // ── adaptadores de forma ──
  const publicBusinessColumns = '*,open_now,business_categories(slug,name),business_hours(weekday,opens,closes)';
  const memberBusinessColumns = `${publicBusinessColumns},business_contacts(owner_name,phone,email,reference),`
    + 'business_review_events(note,to_status,created_at)';
  const mapBusiness = row => {
    const contact = Array.isArray(row.business_contacts) ? row.business_contacts[0] : row.business_contacts;
    const reviews = (row.business_review_events || []).slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const openNow = typeof row.open_now === 'boolean' ? row.open_now : row.status === 'active' && row.open === true;
    return {
      id: row.id, localityId: LOCALITY, name: row.name, slug: row.slug, status: row.status,
      // `open`: recibe pedidos ahora (interruptor, estado y horario).
      // `acceptingOrders`: el interruptor manual del comercio.
      open: openNow, acceptingOrders: row.open === true, active: row.status === 'active',
      categoryId: row.category_id || '', category: row.business_categories?.name || '',
      categorySlug: row.business_categories?.slug || '',
      description: row.description || '', address: row.address || '', hoursLabel: row.hours_label || '',
      hours: (row.business_hours || []).map(item => ({ weekday: item.weekday, opens: item.opens, closes: item.closes })),
      timezone: DEFAULT_TIMEZONE,
      deliveryZone: row.delivery_zone || '',
      deliveryFee: Number(row.delivery_fee_ars || 0), minimumOrder: Number(row.minimum_order_ars || 0),
      pickupEnabled: row.pickup_enabled === true, deliveryEnabled: row.delivery_enabled === true,
      publicPhone: row.public_phone || '', whatsapp: row.whatsapp || '',
      prepMinutes: row.prep_minutes ?? null, deliveryMinutes: row.delivery_minutes ?? null,
      logoPath: row.logo_path || '', coverPath: row.cover_path || '',
      logo: publicUrl(row.logo_path), cover: publicUrl(row.cover_path),
      logoImage: publicUrl(row.logo_path), coverImage: publicUrl(row.cover_path),
      subtitle: row.description || '', theme: 'sage', eta: '',
      ownerName: contact?.owner_name || '', contactPhone: contact?.phone || '',
      contactEmail: contact?.email || '', reference: contact?.reference || '',
      reviewNote: reviews.find(event => ['returned', 'suspended'].includes(event.to_status))?.note || '',
      reviewedAt: reviews[0]?.created_at || '',
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  };
  const productColumns = '*,product_categories(name,position),product_variants(id,name,price_delta_ars,position,active)';
  const mapProduct = row => ({
    id: row.id, businessId: row.business_id, localityId: LOCALITY,
    name: row.name, description: row.description || '',
    categoryId: row.category_id || '', category: row.product_categories?.name || 'Otros',
    // Orden de la categoría que definió el comercio (null: sin categoría visible).
    categoryPosition: row.product_categories?.position ?? null,
    price: Number(row.price_ars), stock: row.stock, trackStock: row.track_stock === true,
    available: row.available === true,
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
    cancellation: row.status === 'canceled'
      ? { kind: (row.order_events || []).some(event => event.to_status === 'canceled' && event.actor_role === 'merchant')
        ? 'rejected' : 'canceled', reason: row.cancel_reason || '' }
      : null,
    history: (row.order_events || []).sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(event => ({ status: event.to_status, from: event.from_status, at: event.created_at, by: event.actor_role })),
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
    name: row.name, phone: row.phone || '', active: row.active === true, linked: Boolean(row.user_id),
    createdAt: row.created_at });
  // Lo que devuelve rider_orders: lo necesario para entregar, nunca el código
  // de entrega ni la cuenta del cliente (la base no los manda).
  const mapRiderOrder = row => ({
    id: row.id, code: row.code, status: row.status, version: row.version, fulfillment: 'delivery',
    business: { id: row.business?.id, name: row.business?.name || '', address: row.business?.address || '',
      phone: row.business?.phone || '' },
    locality: row.locality || '', riderId: row.rider?.id || null, riderName: row.rider?.name || '',
    customer: { name: row.contact_name || '', phone: row.contact_phone || '', address: row.address || '',
      notes: row.notes || '' },
    paymentMethod: row.payment_method, paymentStatus: row.payment_status,
    subtotal: Number(row.subtotal_ars), deliveryFee: Number(row.delivery_fee_ars), total: Number(row.total_ars),
    cancelReason: row.cancel_reason || '', codeAttemptsLeft: Number(row.code_attempts_left ?? 0),
    lines: (row.items || []).map(item => ({ name: item.variant ? `${item.name} · ${item.variant}` : item.name,
      quantity: Number(item.quantity) || 0 })),
    history: (row.history || []).map(step => ({ status: step.status, at: step.at })),
    createdAt: row.created_at, updatedAt: row.updated_at,
  });

  // ── carrito: vive en el navegador hasta el checkout ──
  // Sin cuenta (o con la sesión anónima de compra) el carrito es del
  // dispositivo; al ingresar con una cuenta pasa a esa cuenta. Nunca se mezcla
  // con el de otra identidad.
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
    return isPermanent(user) ? user.id : guestId();
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
  /** @typedef {{ businessId: string, localityId: string, version: number, lines: Array<{ productId: string, variantId: string|null, quantity: number }>, requestId?: string }} Cart */
  /** @returns {Cart} */
  function readCart(ownerId, businessId) {
    /** @type {Cart} */
    const base = { businessId, localityId: LOCALITY, version: 1, lines: [] };
    if (!ownerId) return base;
    let parsed;
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
      read(client.from('products').select(productColumns).eq('business_id', businessId).order('position').order('name')),
    ]);
    requireValue(business, 'BUSINESS_NOT_FOUND', 'Este comercio no está disponible por el momento.');
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
      { contentType: file.type, cacheControl: '31536000', upsert: false });
    if (error) {
      const forbidden = String(error.statusCode) === '403' || /row-level security|Unauthorized/i.test(error.message || '');
      const wrapped = new CauceError(forbidden ? 'MEDIA_FORBIDDEN' : 'MEDIA_UPLOAD_FAILED',
        forbidden ? 'Tu cuenta no puede subir imágenes de este comercio.' : 'No se pudo subir la imagen. Reintentá.');
      wrapped.technical = { code: String(error.statusCode || ''), message: String(error.message || '').slice(0, 200) };
      onError?.(wrapped);
      throw wrapped;
    }
    return path;
  }
  async function removeMedia(path) {
    if (!path) return;
    // Un archivo que no se pudo borrar no deshace la operación ya guardada.
    const { error } = await client.storage.from(MEDIA_BUCKET).remove([path]).catch(caught => ({ error: caught }));
    if (error) onError?.(Object.assign(new CauceError('MEDIA_ORPHAN', 'Quedó un archivo sin uso.'),
      { technical: { code: 'MEDIA_ORPHAN', message: String(error.message || '').slice(0, 120) } }));
  }

  const likeTerm = value => sanitizeText(value, { fallback: '', maxLength: 40 }).replace(/[%_,()*\\]/g, ' ').trim();

  const QUERIES = {
    async appStatus() { return read(client.rpc('app_status')); },
    async localities() { return read(client.from('localities').select('id,slug,name,active,timezone')); },
    async businessCategories() {
      return (await read(client.from('business_categories').select('id,slug,name').eq('active', true).order('position')))
        .map(row => ({ id: row.id, slug: row.slug, name: row.name }));
    },
    async publicBusinesses() {
      const rows = await read(client.from('businesses').select(publicBusinessColumns).eq('status', 'active').order('name'));
      return rows.map(mapBusiness).sort((a, b) => Number(b.open) - Number(a.open) || a.name.localeCompare(b.name));
    },
    // Una sola consulta para buscar en todos los catálogos publicados.
    async searchCatalog(payload) {
      const term = likeTerm(payload?.query);
      if (term.length < 2) return {};
      const rows = await read(client.from('products').select('business_id,name')
        .eq('archived', false).ilike('name', `%${term}%`).limit(300));
      const byBusiness = {};
      for (const row of rows) byBusiness[row.business_id] = `${byBusiness[row.business_id] || ''} ${row.name}`;
      return byBusiness;
    },
    async business(payload) {
      const row = await read(client.from('businesses').select(publicBusinessColumns).eq('id', payload?.businessId).maybeSingle());
      requireValue(row, 'BUSINESS_NOT_FOUND', 'Este comercio no está disponible por el momento.');
      return mapBusiness(row);
    },
    async products(payload) {
      const rows = await read(client.from('products').select(productColumns)
        .eq('business_id', payload?.businessId).order('position').order('name'));
      return rows.map(mapProduct);
    },
    async productCategories(payload) {
      return read(client.from('product_categories').select('id,name,position,active')
        .eq('business_id', payload?.businessId).order('position').order('name'));
    },
    async myBusinesses() {
      const user = await requireAccount('Ingresá para ver tus comercios.');
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
    async team(payload) {
      const rows = await read(client.rpc('business_team', { business: payload?.businessId }));
      return (rows || []).map(row => ({ userId: row.user_id, name: row.display_name, email: row.email,
        role: row.role, since: row.created_at, isSelf: row.is_self }));
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
    async cartCount() {
      const owner = await cartOwner();
      let total = 0;
      try {
        for (const key of Object.keys(store || {})) {
          if (!key.startsWith(`${CART_PREFIX}:${owner}:`)) continue;
          const parsed = JSON.parse(store.getItem(key) || 'null');
          for (const line of parsed?.lines || []) total += Number.isSafeInteger(line.quantity) ? line.quantity : 0;
        }
      } catch { return 0; }
      return total;
    },
    async quote(payload) {
      const owner = await cartOwner();
      const { business, products } = await businessAndProducts(payload?.businessId);
      return quoteCart(readCart(owner, business.id), business, products, payload?.fulfillment || 'pickup');
    },
    // Formas de pago que ofrece este comercio ahora (efectivo según modalidad;
    // online sólo con el interruptor encendido y la cuenta conectada).
    async paymentMethods(payload) {
      return read(client.rpc('payment_methods', { business: payload?.businessId }));
    },
    // Estado real de un pago, por pedido o por intento. Sólo quien compró o el
    // comercio lo ven; para cualquier otra sesión es null.
    async paymentStatus(payload) {
      const reference = String(payload?.reference || '');
      if (!/^[0-9a-f-]{36}$/i.test(reference)) return null;
      const row = await read(client.rpc('payment_status', { reference }));
      return row && { orderId: row.order_id, code: row.code, orderStatus: row.order_status,
        paymentMethod: row.payment_method, paymentStatus: row.payment_status, amount: Number(row.total || 0),
        attemptId: row.attempt?.id || null, checkoutUrl: row.attempt?.checkout_url || '',
        updatedAt: row.attempt?.updated_at || null };
    },
    async businessPaymentOverview(payload) {
      return read(client.rpc('business_payment_overview', { business: payload?.businessId }));
    },
    async myOrders() {
      const user = await currentUser();
      if (!user) return [];
      const rows = await read(client.from('orders').select(orderColumns)
        .eq('customer_id', user.id).order('created_at', { ascending: false }).limit(50));
      return rows.map(mapOrder);
    },
    // Lo que el comercio necesita en el día: todo lo abierto y lo cerrado
    // recientemente, nunca el historial completo en cada refresco.
    async businessOrders(payload) {
      const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
      const rows = await read(client.from('orders').select(orderColumns)
        .eq('business_id', payload?.businessId)
        .or(`status.not.in.(delivered,canceled),updated_at.gte.${since}`)
        .order('created_at', { ascending: false }).limit(150));
      return rows.map(mapOrder);
    },
    async order(payload) {
      const row = await read(client.from('orders').select(orderColumns).eq('id', payload?.orderId).maybeSingle());
      requireValue(row, 'ORDER_NOT_FOUND', 'No encontramos ese pedido en esta sesión. Si lo hiciste en otro dispositivo, usá el enlace de seguimiento.');
      return mapOrder(row);
    },
    async trackOrder(payload) {
      const token = String(payload?.token || '');
      requireValue(/^[0-9a-f-]{36}$/i.test(token), 'ORDER_NOT_FOUND', 'El enlace de seguimiento no es válido.');
      const row = await read(client.rpc('track_order', { token }));
      requireValue(row, 'ORDER_NOT_FOUND', 'No encontramos un pedido con ese enlace de seguimiento.');
      return {
        id: row.id, code: row.code, status: row.status, fulfillment: row.fulfillment, paymentMethod: row.payment_method,
        paymentStatus: row.payment_status || '', customer: { address: row.address || '' }, deliveryCode: row.delivery_code ? { code: row.delivery_code } : null,
        subtotal: Number(row.subtotal_ars), deliveryFee: Number(row.delivery_fee_ars), total: Number(row.total_ars),
        cancellation: row.status === 'canceled' ? { kind: 'canceled', reason: row.cancel_reason || '' } : null,
        createdAt: row.created_at, updatedAt: row.updated_at, trackingToken: token,
        business: { id: row.business.id, name: row.business.name, address: row.business.address || '',
          publicPhone: row.business.public_phone || '', whatsapp: row.business.whatsapp || '',
          prepMinutes: row.business.prep_minutes ?? null, deliveryMinutes: row.business.delivery_minutes ?? null },
        lines: (row.items || []).map(item => ({ name: item.variant_name ? `${item.product_name} · ${item.variant_name}` : item.product_name,
          image: publicUrl(item.image_path), quantity: item.quantity, unitPrice: Number(item.unit_price_ars), total: Number(item.total_ars) })),
        history: (row.history || []).map(step => ({ status: step.status, at: step.at })),
      };
    },
    async riders(payload) {
      const rows = await read(client.from('business_riders').select('*')
        .eq('business_id', payload?.businessId).order('name'));
      return rows.map(mapRider);
    },
    // Titular y encargado/a: qué cuenta tiene vinculada cada persona de reparto.
    async riderAccounts(payload) {
      const rows = await read(client.rpc('business_rider_accounts', { business: payload?.businessId }));
      return Object.fromEntries(rows.map(row => [row.rider_id, row.email]));
    },
    // Quien reparte: sus entregas en curso y las cerradas en los últimos 7 días.
    async riderOrders() {
      const user = await currentUser();
      if (!isPermanent(user)) return [];
      const rows = await read(client.rpc('rider_orders'));
      return (Array.isArray(rows) ? rows : []).map(mapRiderOrder);
    },
    async myRiderProfiles() {
      const user = await currentUser();
      if (!isPermanent(user)) return [];
      const rows = await read(client.from('business_riders').select('id,business_id,name,active,businesses(name)')
        .eq('user_id', user.id));
      return rows.map(row => ({ ...mapRider(row), businessName: row.businesses?.name || '' }));
    },
    async myTrips() {
      const user = await currentUser();
      if (!user) return [];
      const rows = await read(client.from('trips').select('*')
        .eq('passenger_id', user.id).order('created_at', { ascending: false }).limit(20));
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
      if (!isPermanent(user)) return null;
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
      if (!isPermanent(user)) return [];
      const driver = await read(client.from('drivers').select('id').eq('user_id', user.id).maybeSingle());
      if (!driver) return [];
      const rows = await read(client.from('trips').select('*')
        .eq('driver_id', driver.id).order('created_at', { ascending: false }).limit(30));
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
    // El día del piloto (hora de la localidad): comercios, pedidos, volumen,
    // pedidos que necesitan atención y errores. Sin datos de clientes.
    async adminPilotMetrics() {
      const row = await read(client.rpc('admin_pilot_metrics'));
      requireValue(row, 'ROLE_REQUIRED', 'Sección exclusiva de administración.');
      return mapPilotMetrics(row);
    },
    async adminClientEvents() {
      return (await read(client.rpc('admin_client_events', { max_rows: 30 }))) || [];
    },
    async snapshotCounts() {
      const [businesses, products] = await Promise.all([
        client.from('businesses').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        client.from('products').select('id', { count: 'exact', head: true }).eq('archived', false),
      ]);
      fail(businesses.error); fail(products.error);
      return { businesses: businesses.count || 0, activeBusinesses: businesses.count || 0,
        products: products.count || 0, orders: 0, trips: 0, openTrips: 0 };
    },
  };

  const text = (value, max) => sanitizeText(value, { fallback: '', maxLength: max });
  const optionalMinutes = (value, label) => {
    if (value === '' || value == null) return null;
    const minutes = Number(value);
    requireValue(Number.isSafeInteger(minutes) && minutes >= 5 && minutes <= 240, 'INVALID_MINUTES',
      `${label}: entre 5 y 240 minutos, o dejalo vacío.`);
    return minutes;
  };
  const optionalPhone = (value, label) => {
    const phone = text(value, 24);
    requireValue(!phone || isValidArgentinePhone(phone), 'INVALID_PHONE', `${label}: ingresá un número válido o dejalo vacío.`);
    return phone;
  };

  const COMMANDS = {
    async 'business.create'(payload) {
      // El alta exige cuenta permanente y perfil propio.
      await ensureProfile(await requireAccount('Ingresá con tu cuenta para registrar tu comercio.'));
      const name = text(payload?.name, 120);
      requireValue(name.length >= 2, 'INVALID_BUSINESS_NAME', 'El nombre del comercio necesita al menos 2 caracteres.');
      const id = await read(client.rpc('create_business', { business_name: name,
        business_slug: `${slugify(name, 'comercio')}-${crypto.randomUUID().slice(0, 8)}`, locality_slug: LOCALITY }));
      await read(client.from('business_contacts').insert({ business_id: id,
        owner_name: text(payload?.ownerName, 120), phone: text(payload?.contactPhone, 24) }));
      if (payload?.category) {
        const categoryId = await resolveBusinessCategory(payload.category);
        if (categoryId) await read(client.from('businesses').update({ category_id: categoryId }).eq('id', id));
      }
      invalidate();
      return { id };
    },
    async 'business.rename'(payload) {
      const row = await read(client.from('businesses').update({ name: text(payload?.name, 120) })
        .eq('id', payload?.businessId).select().maybeSingle());
      requireValue(row, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede editar este comercio.');
      return mapBusiness(row);
    },
    async 'business.update'(payload) {
      const patch = payload?.patch || {};
      const columns = {};
      if ('name' in patch) {
        columns.name = text(patch.name, 120);
        requireValue(columns.name.length >= 2, 'INVALID_BUSINESS_NAME', 'El nombre del comercio necesita al menos 2 caracteres.');
      }
      if ('categoryId' in patch) columns.category_id = patch.categoryId || null;
      if ('category' in patch && !('categoryId' in patch)) columns.category_id = await resolveBusinessCategory(patch.category);
      if ('description' in patch) columns.description = text(patch.description, 280);
      if ('address' in patch) columns.address = text(patch.address, 200);
      if ('hoursLabel' in patch) columns.hours_label = text(patch.hoursLabel, 120);
      if ('deliveryZone' in patch) columns.delivery_zone = text(patch.deliveryZone, 160);
      if ('pickupEnabled' in patch) columns.pickup_enabled = patch.pickupEnabled === true;
      if ('deliveryEnabled' in patch) columns.delivery_enabled = patch.deliveryEnabled === true;
      if ('publicPhone' in patch) columns.public_phone = optionalPhone(patch.publicPhone, 'Teléfono para clientes');
      if ('whatsapp' in patch) columns.whatsapp = optionalPhone(patch.whatsapp, 'WhatsApp');
      if ('prepMinutes' in patch) columns.prep_minutes = optionalMinutes(patch.prepMinutes, 'Tiempo de preparación');
      if ('deliveryMinutes' in patch) columns.delivery_minutes = optionalMinutes(patch.deliveryMinutes, 'Tiempo de envío');
      for (const [key, column, label] of [['deliveryFee', 'delivery_fee_ars', 'El costo de envío'],
        ['minimumOrder', 'minimum_order_ars', 'El pedido mínimo']]) {
        if (!(key in patch)) continue;
        const amount = Number(patch[key]);
        requireValue(Number.isSafeInteger(amount) && amount >= 0 && amount <= 10000000, 'INVALID_PRICE',
          `${label} debe ser un número entero de pesos, sin centavos.`);
        columns[column] = amount;
      }
      if (Object.keys(columns).length) {
        const row = await read(client.from('businesses').update(columns)
          .eq('id', payload?.businessId).select('id').maybeSingle());
        requireValue(row, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede editar este comercio.');
      }
      const contact = {};
      if ('ownerName' in patch) contact.owner_name = text(patch.ownerName, 120);
      if ('contactPhone' in patch) contact.phone = optionalPhone(patch.contactPhone, 'Teléfono de contacto');
      if ('contactEmail' in patch) contact.email = text(patch.contactEmail, 120);
      if ('reference' in patch) contact.reference = text(patch.reference, 200);
      if (Object.keys(contact).length) {
        const updated = await read(client.from('business_contacts').update(contact)
          .eq('business_id', payload?.businessId).select('business_id').maybeSingle());
        if (!updated) {
          await read(client.from('business_contacts').insert({ business_id: payload?.businessId, ...contact }));
        }
      }
      return QUERIES.business({ businessId: payload?.businessId }).catch(() => null);
    },
    async 'business.setHours'(payload) {
      const hours = validateHours(payload?.hours || []);
      return read(client.rpc('set_business_hours', { business: payload?.businessId, hours }));
    },
    async 'business.submit'(payload) {
      await read(client.rpc('submit_business_for_review', { business: payload?.businessId }));
      return true;
    },
    async 'business.setOpen'(payload) {
      await read(client.rpc('set_business_presence', { business: payload?.businessId, is_open: payload?.open === true }));
      return true;
    },
    async 'business.setStatus'(payload) {
      await read(client.rpc('set_business_presence', { business: payload?.businessId, next_status: payload?.status }));
      return true;
    },
    async 'business.setMedia'(payload) {
      const businessId = payload?.businessId;
      const folder = payload?.slot === 'cover' ? 'cover' : 'logo';
      const column = folder === 'cover' ? 'cover_path' : 'logo_path';
      const current = await read(client.from('businesses').select('id,logo_path,cover_path').eq('id', businessId).maybeSingle());
      requireValue(current, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede editar este comercio.');
      const previous = current[column];
      let path = null;
      if (payload?.file) path = await uploadMedia(businessId, folder, payload.file);
      const row = await read(client.from('businesses').update({ [column]: path })
        .eq('id', businessId).select('id').maybeSingle());
      if (!row) { await removeMedia(path); requireValue(false, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede editar este comercio.'); }
      if (previous && previous !== path) await removeMedia(previous);
      return true;
    },
    async 'team.add'(payload) {
      const email = normalizeEmail(payload?.email);
      requireValue(isValidEmail(email), 'INVALID_EMAIL', 'Ingresá el correo de la cuenta de esa persona.');
      return read(client.rpc('add_business_member', { business: payload?.businessId, member_email: email,
        member_role: payload?.role === 'manager' ? 'manager' : 'staff' }));
    },
    async 'team.setRole'(payload) {
      return read(client.rpc('set_business_member_role', { business: payload?.businessId, member: payload?.userId,
        member_role: payload?.role === 'manager' ? 'manager' : 'staff' }));
    },
    async 'team.remove'(payload) {
      const result = await read(client.rpc('remove_business_member', { business: payload?.businessId, member: payload?.userId }));
      invalidate();
      return result;
    },
    async 'admin.reviewBusiness'(payload) {
      await read(client.rpc('review_business', { business: payload?.businessId,
        decision: payload?.decision === 'approve' ? 'active' : 'returned', note: text(payload?.note, 400) }));
      return true;
    },
    async 'admin.setBusinessStatus'(payload) {
      return read(client.rpc('admin_set_business_status', { business: payload?.businessId,
        next_status: payload?.status === 'suspended' ? 'suspended' : 'active', note: text(payload?.note, 400) }));
    },
    async 'admin.reviewDriver'(payload) {
      await read(client.rpc('review_driver', { driver: payload?.driverId,
        decision: payload?.decision === 'approve' ? 'active' : 'returned', note: text(payload?.note, 400) }));
      return true;
    },
    async 'productCategory.create'(payload) {
      const name = text(payload?.name, 40);
      requireValue(name.length >= 2, 'INVALID_CATEGORY', 'Elegí o escribí una categoría.');
      const row = await read(client.from('product_categories')
        .insert({ business_id: payload?.businessId, name }).select().maybeSingle());
      requireValue(row, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede editar este catálogo.');
      return row;
    },
    // Categorías del catálogo: nombre, visibilidad y orden. RLS limita todo a
    // titular y encargado/a del propio comercio; el filtro por comercio acá
    // sólo evita tocar una fila ajena por un id equivocado.
    async 'productCategory.update'(payload) {
      const patch = payload?.patch || {};
      const columns = {};
      if ('name' in patch) {
        columns.name = text(patch.name, 40);
        requireValue(columns.name.length >= 2, 'INVALID_CATEGORY', 'El nombre de la categoría necesita al menos 2 caracteres.');
      }
      if ('active' in patch) columns.active = patch.active === true;
      requireValue(Object.keys(columns).length > 0, 'EMPTY_PATCH', 'No hay cambios para guardar.');
      const row = await read(client.from('product_categories').update(columns)
        .eq('id', payload?.categoryId).eq('business_id', payload?.businessId).select().maybeSingle());
      requireValue(row, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede editar este catálogo.');
      return row;
    },
    async 'productCategory.reorder'(payload) {
      const ids = (Array.isArray(payload?.order) ? payload.order : []).slice(0, 100);
      for (const [index, id] of ids.entries()) {
        const row = await read(client.from('product_categories').update({ position: (index + 1) * 10 })
          .eq('id', id).eq('business_id', payload?.businessId).select('id').maybeSingle());
        requireValue(row, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede editar este catálogo.');
      }
      return true;
    },
    async 'product.create'(payload) {
      const trackStock = payload?.product?.trackStock === true;
      const input = validateProductInput({ ...payload?.product, stock: trackStock ? payload?.product?.stock : 0,
        available: payload?.product?.available ?? true });
      const businessId = payload?.businessId;
      const categoryId = await resolveProductCategory(businessId, payload?.product?.category);
      const row = await read(client.from('products').insert({
        business_id: businessId, category_id: categoryId, name: input.name,
        description: input.description || '', price_ars: input.price, track_stock: trackStock,
        stock: trackStock ? (input.stock ?? 0) : 0,
        available: input.available !== false, dish_type: input.dishType || '',
      }).select('id').maybeSingle());
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
      if ('trackStock' in patch) columns.track_stock = patch.trackStock === true;
      if ('archived' in input) columns.archived = input.archived;
      if ('dishType' in input) columns.dish_type = input.dishType;
      if ('category' in input) columns.category_id = await resolveProductCategory(payload?.businessId, input.category);
      // Disponibilidad y stock pasan por la función que también habilita al equipo.
      if (('available' in input || 'stock' in input) && Object.keys(columns).every(key => key === 'stock')) {
        const row = await read(client.rpc('set_product_availability', { product: payload?.productId,
          is_available: 'available' in input ? input.available : patch.currentAvailable !== false,
          next_stock: input.stock ?? null }));
        return mapProduct(await read(client.from('products').select(productColumns).eq('id', row.id).single()));
      }
      if ('available' in input) columns.available = input.available;
      const row = await read(client.from('products').update(columns)
        .eq('id', payload?.productId).select('id,business_id').maybeSingle());
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
      const name = text(payload?.name, 80);
      requireValue(name.length >= 2, 'INVALID_NAME', 'Ingresá el nombre de la persona de reparto.');
      const phone = optionalPhone(payload?.phone, 'Teléfono');
      const row = await read(client.from('business_riders')
        .insert({ business_id: payload?.businessId, name, phone }).select().maybeSingle());
      requireValue(row, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede administrar el reparto de este comercio.');
      return mapRider(row);
    },
    async 'rider.linkAccount'(payload) {
      const email = normalizeEmail(payload?.email);
      requireValue(isValidEmail(email), 'INVALID_EMAIL', 'Ingresá el correo de la cuenta de CAUCE de esa persona.');
      await read(client.rpc('link_rider_account', { rider: payload?.riderId, account_email: email }));
      return { riderId: payload?.riderId, email };
    },
    async 'rider.unlinkAccount'(payload) {
      await read(client.rpc('unlink_rider_account', { rider: payload?.riderId }));
      return { riderId: payload?.riderId };
    },
    async 'rider.setActive'(payload) {
      const row = await read(client.from('business_riders').update({ active: payload?.active === true })
        .eq('id', payload?.riderId).select().maybeSingle());
      requireValue(row, 'BUSINESS_FORBIDDEN', 'Tu cuenta no puede administrar el reparto de este comercio.');
      return mapRider(row);
    },
    async 'cart.setQuantity'(payload) {
      const owner = await cartOwner();
      const businessId = payload?.businessId;
      const quantity = Number(payload?.quantity);
      // Quitar una línea nunca depende del catálogo: un producto que se dio de
      // baja o cambió también se tiene que poder sacar del carrito.
      if (quantity === 0) {
        const cart = readCart(owner, businessId);
        const next = { ...cart, lines: cart.lines.filter(line => !(line.productId === payload?.productId
          && (line.variantId ?? null) === (payload?.variantId ?? null))) };
        delete next.requestId;
        return writeCart(owner, businessId, next);
      }
      const { business, products } = await businessAndProducts(businessId);
      requireValue(business.status === 'active', 'BUSINESS_NOT_ACTIVE', 'Este comercio no está recibiendo pedidos por el momento.');
      const product = products.find(candidate => candidate.id === payload?.productId);
      requireValue(product && !product.archived, 'PRODUCT_NOT_FOUND', 'Ese producto ya no está en el catálogo.');
      const next = changeQuantity(readCart(owner, business.id), product, quantity, payload?.variantId ?? null);
      return writeCart(owner, business.id, next);
    },
    async 'cart.clear'(payload) {
      const owner = await cartOwner();
      return writeCart(owner, payload?.businessId, emptyCart({ businessId: payload?.businessId, localityId: LOCALITY }));
    },
    async 'cart.removeUnavailable'(payload) {
      const owner = await cartOwner();
      const { business, products } = await businessAndProducts(payload?.businessId);
      const cart = readCart(owner, business.id);
      const kept = cart.lines.filter(line => {
        const product = products.find(candidate => candidate.id === line.productId);
        if (!product || product.archived || !product.available) return false;
        if (line.variantId && !product.variants.some(variant => variant.id === line.variantId)) return false;
        return !(product.variants.length && !line.variantId);
      });
      const next = { ...cart, lines: kept };
      delete next.requestId;
      return writeCart(owner, business.id, next);
    },
    async 'cart.prepareRequest'(payload) {
      const owner = await cartOwner();
      const cart = readCart(owner, payload?.businessId);
      requireValue(cart.lines.length > 0, 'EMPTY_CART', 'Tu carrito está vacío.');
      cart.requestId ||= crypto.randomUUID();
      writeCart(owner, payload?.businessId, cart);
      return cart.requestId;
    },
    async 'order.create'(payload) {
      const businessId = payload?.businessId;
      const fulfillment = payload?.fulfillment;
      requireValue(['pickup', 'delivery'].includes(fulfillment), 'INVALID_FULFILLMENT', 'Elegí retiro o envío.');
      const nameCheck = validateCustomerName(payload?.customer?.name);
      requireValue(nameCheck.ok, 'INVALID_NAME', nameCheck.message || 'Ingresá tu nombre y apellido.');
      const phone = text(payload?.customer?.phone, 24);
      requireValue(isValidArgentinePhone(phone), 'INVALID_PHONE', 'Ingresá un teléfono de contacto válido, con característica.');
      const address = fulfillment === 'delivery' ? text(payload?.customer?.address, 200) : '';
      requireValue(fulfillment !== 'delivery' || address.length >= 5, 'ADDRESS_REQUIRED', 'Ingresá la dirección de entrega.');
      const owner = await cartOwner();
      const cart = readCart(owner, businessId);
      requireValue(cart.lines.length > 0, 'EMPTY_CART', 'Tu carrito está vacío.');
      requireValue(cart.requestId === payload?.requestId, 'STALE_REQUEST',
        'El carrito cambió desde que abriste la confirmación. Revisalo y confirmá de nuevo.');
      // El total que la persona vio: si el catálogo cambió, el servidor no crea el pedido.
      const expectedTotal = Number.isSafeInteger(payload?.expectedTotal) ? payload.expectedTotal : null;
      const user = await ensureCustomerSession();
      const items = cart.lines
        .map(line => ({ product_id: line.productId, variant_id: line.variantId ?? null, quantity: line.quantity }))
        .sort((a, b) => `${a.product_id}|${a.variant_id}`.localeCompare(`${b.product_id}|${b.variant_id}`));
      const contact = { name: nameCheck.name, phone, address, notes: text(payload?.customer?.notes, 280) };
      let orderId;
      try {
        orderId = await read(client.rpc('create_order', {
          business: businessId, idem: payload.requestId, fulfillment,
          payment_method: payload?.paymentMethod === 'online' ? 'online'
            : fulfillment === 'delivery' ? 'cash_on_delivery' : 'cash_on_pickup',
          contact, items, expected_total: expectedTotal,
        }));
      } catch (error) {
        if (error.technical?.code === 'U0002') {
          // El mismo intento ya creó un pedido (la respuesta se perdió y se
          // cambiaron datos al reintentar): se muestra ese pedido.
          const existing = await read(client.from('orders').select('id').eq('customer_id', user.id)
            .eq('business_id', businessId).eq('idempotency_key', payload.requestId).maybeSingle());
          if (existing) {
            writeCart(owner, businessId, emptyCart({ businessId, localityId: LOCALITY }));
            const order = await QUERIES.order({ orderId: existing.id });
            return { ...order, alreadyExisted: true };
          }
          delete cart.requestId;
          writeCart(owner, businessId, cart);
        }
        // Compra sin cuenta apagada desde la base (interruptor de emergencia):
        // la persona ingresa con su cuenta y el carrito se conserva.
        if (user.is_anonymous && error.technical?.code === '42501') {
          error.code = 'GUEST_CHECKOUT_UNAVAILABLE';
          error.message = 'Para confirmar el pedido, ingresá con tu cuenta.';
        }
        throw error;
      }
      writeCart(owner, businessId, emptyCart({ businessId, localityId: LOCALITY }));
      invalidate();
      return QUERIES.order({ orderId });
    },
    // Pago online: la Edge Function crea (o devuelve) el intento del pedido y
    // el checkout del proveedor. El importe sale del pedido en la base; el
    // navegador sólo recibe la dirección a la que tiene que ir.
    async 'payment.start'(payload) {
      const data = await invoke('payments-checkout', { order_id: payload?.orderId, flow: 'checkout_pro' });
      requireValue(typeof data?.checkout_url === 'string' && /^https:\/\//.test(data.checkout_url), 'PAYMENT_UNAVAILABLE',
        'No pudimos abrir el pago online. Reintentá en unos minutos o elegí efectivo en tu próximo pedido.');
      return { checkoutUrl: data.checkout_url };
    },
    async 'payment.connect'(payload) {
      await requireAccount('Ingresá con la cuenta titular del comercio.');
      const data = await invoke('payments-oauth', { business: payload?.businessId, provider: payload?.provider });
      requireValue(typeof data?.authorization_url === 'string' && /^https:\/\//.test(data.authorization_url),
        'PAYMENT_UNAVAILABLE', 'No pudimos iniciar la conexión con el proveedor de pagos. Reintentá en unos minutos.');
      return { authorizationUrl: data.authorization_url };
    },
    async 'payment.disconnect'(payload) {
      await read(client.rpc('disconnect_payment_account', { business: payload?.businessId,
        provider: String(payload?.provider || '') }));
      return true;
    },
    async 'order.transition'(payload) {
      const row = await read(client.rpc('transition_order', {
        order_id: payload?.orderId,
        expected_version: Number.isSafeInteger(Number(payload?.expectedVersion)) ? Number(payload.expectedVersion) : null,
        next_status: payload?.nextStatus, rider: payload?.riderId || null,
        reason: text(payload?.reason, 200),
      }));
      return mapOrder({ ...row, order_items: [], order_events: [] });
    },
    // Entregar con el código del cliente. Un código equivocado no es un error de
    // la base (el intento queda registrado): vuelve como { ok: false, reason }.
    async 'order.confirmDelivery'(payload) {
      const code = String(payload?.code || '').replace(/\D/g, '');
      const result = await read(client.rpc('confirm_delivery', {
        order_id: payload?.orderId,
        expected_version: Number.isSafeInteger(Number(payload?.expectedVersion)) ? Number(payload.expectedVersion) : null,
        code,
      }));
      return { ok: result?.ok === true, reason: result?.reason || '', remaining: Number(result?.remaining ?? 0),
        status: result?.status || '', version: result?.version ?? null };
    },
    async 'driver.apply'(payload) {
      await requireAccount('Ingresá con tu cuenta para registrarte como conductor.');
      const name = validateCustomerName(payload?.displayName || payload?.name);
      requireValue(name.ok, 'INVALID_NAME', name.message || 'Ingresá tu nombre.');
      const row = await read(client.rpc('apply_as_driver', {
        display_name: name.name,
        mobile_number: text(payload?.mobileNumber, 40),
        vehicle: text(payload?.vehicle, 80),
        plate: text(payload?.plate, 16),
        phone: text(payload?.phone, 24),
      }));
      invalidate();
      return mapDriver(row);
    },
    async 'driver.setAvailability'(payload) {
      return mapDriver(await read(client.rpc('set_driver_availability', { is_available: payload?.available === true })));
    },
    async 'trip.request'(payload) {
      await ensureCustomerSession();
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
        reason: text(payload?.reason, 200) })));
    },
  };

  async function resolveBusinessCategory(value) {
    const wanted = text(value, 60);
    if (!wanted) return null;
    const rows = await read(client.from('business_categories').select('id,slug,name').eq('active', true));
    const match = rows.find(row => row.slug === wanted)
      || rows.find(row => row.name.toLowerCase() === wanted.toLowerCase());
    return match?.id || null;
  }

  async function resolveProductCategory(businessId, name) {
    const label = text(name, 40);
    if (label.length < 2) return null;
    const existing = await read(client.from('product_categories').select('id')
      .eq('business_id', businessId).eq('name', label).maybeSingle());
    if (existing) return existing.id;
    const created = await read(client.from('product_categories')
      .insert({ business_id: businessId, name: label }).select('id').maybeSingle());
    return created?.id || null;
  }

  // Parámetros que Auth deja en la URL al volver de un correo: se leen y se
  // borran antes de cualquier otra cosa, para que no queden en el historial.
  function authParams(href) {
    const url = new URL(href);
    const params = new URLSearchParams(url.search);
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : '';
    if (/(^|&)(error|error_code|error_description|access_token|code)=/.test(hash)) {
      for (const [key, value] of new URLSearchParams(hash)) if (!params.has(key)) params.set(key, value);
    }
    return params;
  }

  return Object.freeze({
    environment: 'supabase',
    capabilities: Object.freeze({ passwordAuth: true, sharedPersistence: true, demoIdentities: false,
      reset: false, accountManagement: true, foundationOnly: false, orders: true, media: true, realtime: true,
      guestCheckout: true, team: true, hours: true, tracking: true }),
    session,
    invalidateSession: invalidate,
    async completeAuthRedirect(href, scrubUrl) {
      const params = authParams(href);
      const tokenHash = params.get('token_hash');
      const errorCode = params.get('error_code') || params.get('error');
      const code = params.get('code');
      if (!tokenHash && !errorCode && !code) return { handled: false, recovery: false };
      scrubUrl();
      if (errorCode) {
        const wrapped = toCauceError({ code: params.get('error_code') || 'otp_expired', message: params.get('error_description') || '' });
        return { handled: true, recovery: false, error: wrapped };
      }
      if (tokenHash) {
        const type = params.get('type');
        if (!AUTH_LINK_TYPES.includes(type)) {
          return { handled: true, recovery: false, error: new CauceError('INVALID_AUTH_LINK', 'El enlace no es válido. Pedí uno nuevo.') };
        }
        const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
        invalidate();
        if (error) return { handled: true, recovery: false, error: toCauceError(error) };
        // Una invitación deja la sesión abierta pero sin contraseña: igual que
        // una recuperación, lo siguiente es elegirla.
        return { handled: true, recovery: ['recovery', 'invite'].includes(type), invited: type === 'invite',
          confirmed: ['signup', 'email'].includes(type) };
      }
      // Enlace con código PKCE: sólo funciona en el navegador que lo pidió.
      const { error } = await client.auth.exchangeCodeForSession(code);
      invalidate();
      if (error) return { handled: true, recovery: false, error: toCauceError({ code: 'flow_state_not_found' }) };
      return { handled: true, recovery: false };
    },
    async identities() { return []; },
    async register(input) {
      const profile = validateSignUp(input);
      const { data, error } = await client.auth.signUp({ email: profile.email, password: input.password,
        options: { emailRedirectTo: redirectTo, data: { display_name: profile.name, phone: profile.phone } } });
      fail(error);
      invalidate();
      // Con confirmación obligatoria, GoTrue no revela si el correo ya existía.
      if (data.session) { adoptGuestCarts(data.user.id); await ensureProfile(data.user); }
      return { confirmationRequired: !data.session };
    },
    async signIn({ email, password }) {
      requireValue(isValidEmail(email), 'INVALID_EMAIL', 'Ingresá un correo válido.');
      requireValue(typeof password === 'string' && password.length > 0, 'INVALID_PASSWORD', 'Ingresá tu contraseña.');
      const result = await client.auth.signInWithPassword({ email: normalizeEmail(email), password });
      fail(result.error);
      invalidate();
      if (result.data.user) adoptGuestCarts(result.data.user.id);
      return session({ fresh: true });
    },
    async signOut() {
      invalidate();
      const { error } = await client.auth.signOut({ scope: 'local' });
      // Sin red, la sesión local igual se borra: la persona queda afuera.
      if (error && !isConnectionError(toCauceError(error))) fail(error);
    },
    async requestPasswordReset(email) {
      requireValue(isValidEmail(email), 'INVALID_EMAIL', 'Ingresá el correo de tu cuenta.');
      fail((await client.auth.resetPasswordForEmail(normalizeEmail(email), { redirectTo })).error);
    },
    async resendConfirmation(email) {
      requireValue(isValidEmail(email), 'INVALID_EMAIL', 'Ingresá el correo de tu cuenta.');
      fail((await client.auth.resend({ type: 'signup', email: normalizeEmail(email), options: { emailRedirectTo: redirectTo } })).error);
    },
    async updatePassword(password, { currentPassword = null } = {}) {
      const valid = validatePassword(password);
      requireValue(valid.ok, 'INVALID_PASSWORD', valid.message);
      if (currentPassword != null) {
        // Cambiar la clave con la sesión abierta exige conocer la actual.
        const user = await requireAccount('Ingresá para cambiar tu contraseña.');
        const check = await client.auth.signInWithPassword({ email: user.email, password: String(currentPassword) });
        if (check.error?.code === 'invalid_credentials') {
          throw new CauceError('INVALID_CURRENT_PASSWORD', 'La contraseña actual no es correcta.');
        }
        fail(check.error);
      }
      fail((await client.auth.updateUser({ password })).error);
      invalidate();
    },
    async updateProfile(input) {
      const user = await requireAccount('Ingresá para actualizar tu perfil.');
      const profile = validateSignUp({ ...input, email: user.email }, { requirePassword: false });
      invalidate();
      return read(client.from('profiles').update({ display_name: profile.name, phone: profile.phone })
        .eq('user_id', user.id).select().single());
    },
    onAuthChange(callback) { return client.auth.onAuthStateChange(callback).data.subscription; },
    async reportEvent(event) {
      // El registro de errores nunca debe provocar otro error visible.
      try {
        await client.rpc('report_client_event', { kind: event.kind, code: event.code, message: event.message,
          route: event.route, release: event.release, context: event.context || {} });
      } catch { /* sin red no hay registro remoto: queda la consola */ }
    },

    // Sincronización en vivo: un canal acotado por comercio o por cuenta.
    // Nunca se escucha la tabla entera: el filtro viaja en la suscripción y el
    // servidor vuelve a aplicar RLS sobre cada fila antes de entregarla.
    /** @param {any} scope @param {(payload: any) => void} handler @param {(status: string) => void} [onStatus] */
    watch(scope, handler, onStatus = () => {}) {
      const filters = {
        businessOrders: { table: 'orders', filter: `business_id=eq.${scope.businessId}` },
        myOrders: { table: 'orders', filter: `customer_id=eq.${scope.customerId}` },
        order: { table: 'orders', filter: `id=eq.${scope.orderId}` },
        myTrips: { table: 'trips', filter: `passenger_id=eq.${scope.passengerId}` },
        driverTrips: { table: 'trips', filter: `driver_id=eq.${scope.driverId}` },
      }[scope.kind];
      if (!filters) return () => {};
      const channel = client.channel(`cauce:${scope.kind}:${scope.businessId || scope.customerId || scope.orderId || scope.passengerId || scope.driverId || 'open'}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: filters.table, filter: filters.filter },
          payload => handler(payload))
        // SUBSCRIBED llega enseguida, pero los cambios de Postgres empiezan a
        // fluir recién cuando Realtime lo confirma (segundos después, y otra vez
        // tras cada reconexión). Lo que pase en ese hueco no genera evento: al
        // confirmarse se vuelve a consultar, así ningún pedido queda afuera.
        .on('system', {}, payload => {
          if (payload?.extension !== 'postgres_changes') return;
          if (payload.status === 'ok') {
            onStatus('SUBSCRIBED');
            handler({ eventType: 'READY' });
          } else onStatus('CHANNEL_ERROR');
        })
        .subscribe(status => onStatus(status));
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
      const result = await run(payload);
      if (/^(business|team|admin|driver)\./.test(name) || name === 'rider.unlinkAccount') invalidate();
      return result;
    },
  });
}
