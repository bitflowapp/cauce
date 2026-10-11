// Traducción de errores del servidor a mensajes que la persona puede usar.
// Las reglas de la base responden con un texto corto en inglés y un código; acá
// se convierte en qué hacer, nunca en cómo está implementado.
import { AppError } from '../core/errors.js';

export const SERVER_MESSAGES = Object.freeze({
  'Authentication required': 'Ingresá a tu cuenta para continuar.',
  'Feature disabled': 'Esta función no está habilitada por ahora.',
  'Complete your profile first': 'Completá tu perfil antes de crear una tienda.',
  'Invalid business name': 'Elegí un nombre de 2 a 80 caracteres.',
  'Business limit reached': 'Ya tenés 3 tiendas. Escribinos si necesitás más.',
  'Locality unavailable': 'Elegí una localidad de la lista.',
  'Only the owner manages the team': 'Sólo la persona titular administra el equipo.',
  'Only the organizer owner manages the team': 'Sólo la persona titular de la organización suma personas.',
  'Invalid role': 'Elegí un rol válido.',
  'Plan limit: team': 'Tu plan no admite más personas en el equipo. Mirá «Mi plan».',
  'No account with that email': 'No hay una cuenta con ese correo. Pedile que se registre primero.',
  'Already a member': 'Esa persona ya forma parte del equipo.',
  'Member not found': 'Esa persona ya no forma parte del equipo.',
  'Ownership changes are administrative': 'La titularidad se cambia con la administración de CAUCE.',
  'Not a member of this business': 'Tu cuenta no pertenece a esa tienda.',
  'Not allowed for this business': 'Tu cuenta no tiene ese permiso en la tienda.',
  'Plan limit: products': 'Llegaste al máximo de productos de tu plan. Archivá alguno o mejorá tu plan.',
  'Plan limit: images': 'Llegaste al máximo de fotos por producto de tu plan.',
  'Up to 12 variants per product': 'Se admiten hasta 12 variantes por producto.',
  'Product not found': 'No encontramos ese producto.',
  'Invalid stock': 'El stock va de 0 a 10.000 unidades.',
  'Stock is per variant': 'Este producto tiene variantes: ajustá el stock de cada una.',
  'Only a draft or returned application can be submitted': 'Tu tienda ya fue enviada a revisión o está publicada.',
  'Administration only': 'Sección exclusiva de la administración.',
  'Invalid decision': 'Esa decisión no es válida.',
  'Business not found': 'No encontramos esa tienda.',
  'Only applications under review can be resolved': 'Sólo se resuelven tiendas en revisión.',
  'Reason required': 'Escribí un motivo (al menos 3 letras) para que la otra persona entienda qué pasó.',
  'Invalid plan': 'Elegí un plan válido.',
  'Transition not allowed': 'Ese cambio ya no es posible. Actualizamos la vista.',
  'Not allowed for this organizer': 'Tu cuenta no administra esa organización.',
  'Invalid fair': 'Revisá los datos de la feria.',
  'Too many drafts': 'Tenés muchos borradores. Publicá o borrá alguno.',
  'Invalid dates': 'Revisá fecha y horario: el cierre va después del inicio (hasta 14 días).',
  'Fair not found': 'No encontramos esa feria.',
  'Organizer plan required': 'Para publicar ferias hace falta el Plan Organizador vigente.',
  'Fair already finished': 'Esa feria ya terminó.',
  'Plan limit: fairs': 'Llegaste al máximo de ferias publicadas de tu plan.',
  'Fair has participants': 'La feria ya tiene inscripciones: no puede volver a borrador.',
  'Business must be published': 'Tu tienda tiene que estar publicada para inscribirse en ferias.',
  'Applications closed': 'Las inscripciones de esta feria están cerradas.',
  'Application rejected': 'La organización ya respondió esta solicitud.',
  'Participation not found': 'No encontramos esa inscripción.',
  'Fair already started': 'La feria ya empezó: no se puede dar de baja.',
  'Pending fair pickups': 'Tenés pedidos para retirar en esta feria: resolvelos antes de darte de baja.',
  'Invalid stall': 'El puesto admite letras, números y guiones (hasta 12).',
  'Fair is full': 'La feria ya completó sus puestos.',
  'Stall already assigned': 'Ese puesto ya está asignado a otro comercio.',
  'Invalid fulfillment': 'Elegí cómo querés recibir tu pedido.',
  'Payment method not available': 'Elegí efectivo o transferencia.',
  'Invalid contact name': 'Ingresá tu nombre (al menos 2 letras).',
  'Invalid contact phone': 'Ingresá un teléfono válido para que el vendedor te contacte.',
  'Invalid contact email': 'Revisá el correo electrónico.',
  'Address required': 'Ingresá la dirección de entrega.',
  'Choose a fair': 'Elegí la feria donde vas a retirar.',
  'Repeated attempt with different data': 'El pedido cambió mientras se enviaba. Revisalo y confirmá de nuevo.',
  'Business not available': 'Esta tienda no está disponible por el momento.',
  'Business not taking orders': 'Esta tienda no está tomando pedidos por el momento.',
  'Pickup not available': 'Esta tienda no ofrece retiro acordado.',
  'Delivery not available': 'Esta tienda no hace envíos.',
  'Fair pickup not available': 'El retiro en esa feria ya no está disponible. Elegí otra forma de entrega.',
  'Empty cart': 'Tu carrito está vacío.',
  'Invalid quantity': 'Revisá las cantidades del carrito.',
  'Product not available': 'Un producto dejó de estar disponible. Revisá tu carrito.',
  'Variant required': 'Elegí una opción del producto.',
  'Variant not available': 'Esa opción ya no está disponible.',
  'Invalid price': 'Un producto no tiene un precio válido. Avisale al vendedor.',
  'Minimum order not reached': 'No llegaste al mínimo de compra para envío.',
  'Order not found': 'No encontramos el pedido.',
  'This order belongs to another account': 'El pedido pertenece a otra cuenta.',
  'Order canceled': 'El pedido está cancelado.',
  'Invalid organizer name': 'Elegí un nombre de 2 a 80 caracteres.',
  'Organizer not found': 'No encontramos esa organización.',
  'Choose one subject': 'Elegí una tienda o una organización.',
  'Invalid status': 'Ese estado no es válido.',
  'Invalid period': 'Revisá la fecha de vencimiento.',
  'Plan does not match subject': 'Ese plan no corresponde (tiendas y organizadores tienen planes distintos).',
  'Consent required': 'Necesitamos tu consentimiento para guardar tus datos.',
  'Invalid contact': 'Dejanos un correo o un teléfono válido.',
  'Too many requests': 'Ya recibimos tus datos. Si necesitás corregir algo, escribinos.',
  'Application not found': 'Esa solicitud ya no existe.',
});

export const CODE_MESSAGES = Object.freeze({
  invalid_credentials: 'Correo o contraseña incorrectos.',
  email_address_invalid: 'Ingresá un correo válido que pueda recibir mensajes.',
  email_not_confirmed: 'Confirmá tu correo antes de ingresar. Revisá tu casilla (y la carpeta de spam).',
  weak_password: 'Esa contraseña es insegura. Elegí otra con letras y números (10 o más).',
  same_password: 'La nueva contraseña tiene que ser distinta de la actual.',
  over_email_send_rate_limit: 'Esperá unos minutos antes de pedir otro correo.',
  over_request_rate_limit: 'Hubo demasiados intentos. Esperá unos minutos y volvé a probar.',
  email_exists: 'Ya existe una cuenta con ese correo. Ingresá o recuperá tu contraseña.',
  user_already_exists: 'Ya existe una cuenta con ese correo. Ingresá o recuperá tu contraseña.',
  signup_disabled: 'El registro de cuentas no está habilitado en este momento.',
  anonymous_provider_disabled: 'Para confirmar el pedido, ingresá con tu cuenta.',
  otp_expired: 'El enlace venció o ya se usó. Pedí uno nuevo.',
  flow_state_expired: 'El enlace venció o ya se usó. Pedí uno nuevo.',
  flow_state_not_found: 'El enlace venció o ya se usó. Pedí uno nuevo.',
  user_banned: 'La cuenta está deshabilitada. Escribinos para revisarlo.',
  session_not_found: 'Tu sesión venció. Ingresá de nuevo.',
  refresh_token_not_found: 'Tu sesión venció. Ingresá de nuevo.',
  refresh_token_already_used: 'Tu sesión venció. Ingresá de nuevo.',
  PGRST301: 'Tu sesión venció. Ingresá de nuevo.',
  PGRST303: 'Tu sesión venció. Ingresá de nuevo.',
  U0001: 'El pedido cambió mientras lo mirabas. Ya actualizamos la vista: revisalo y reintentá.',
  U0003: 'No queda stock suficiente de un producto. Revisá tu carrito.',
  U0005: 'Los precios cambiaron mientras confirmabas. Revisá el nuevo total y confirmá de nuevo.',
  U0006: 'Tenés varios pedidos esperando respuesta. Esperá a que los atiendan antes de enviar otro.',
  U0010: 'Llegaste a un límite de tu plan.',
  P0002: 'No encontramos lo que buscabas.',
  23505: 'Ese dato ya existe. Revisalo antes de reintentar.',
  23514: 'Los datos no cumplen una regla del servicio. Revisalos.',
  42501: 'Tu cuenta no tiene permiso para hacer esto.',
});

const NETWORK = /Failed to fetch|NetworkError|Load failed|fetch failed|Network request failed|ERR_INTERNET/i;

/** Convierte un error de Supabase en uno que se puede mostrar. */
export function toAppError(error) {
  if (error instanceof AppError) return error;
  const rawCode = String(error?.code || error?.error_code || '');
  const rawMessage = String(error?.message || '');
  let code = rawCode || 'SERVICE_ERROR';
  let message;
  if (NETWORK.test(rawMessage) || error?.name === 'AuthRetryableFetchError' || error?.status === 0) {
    code = 'NETWORK_ERROR';
    message = 'No hay conexión. Revisá tu internet y reintentá: no se envió nada.';
  } else if (rawMessage.startsWith('Faltan datos')) {
    message = rawMessage;
  } else {
    message = SERVER_MESSAGES[rawMessage] || CODE_MESSAGES[rawCode]
      || 'No se pudo completar la operación. Reintentá en unos segundos.';
  }
  const wrapped = new AppError(code, message);
  wrapped.technical = { code: rawCode, message: rawMessage.slice(0, 200), status: error?.status ?? null };
  if (rawCode === 'U0005') {
    wrapped.code = 'PRICES_CHANGED';
    wrapped.message = 'Los precios cambiaron mientras confirmabas. Revisá el nuevo total y confirmá de nuevo.';
    /** @type {any} */ (wrapped).newTotal = Number(error?.details);
  }
  return wrapped;
}
