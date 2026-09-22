import { CauceError, requireValue } from '../core/errors.js';
import { validateSignUp, validatePassword, normalizeEmail } from '../core/accounts.js';
import { slugify } from '../core/catalog-rules.js';

// The SDK is injected only by the explicit Supabase build. The demo has no SDK.
export function createSupabaseRepository({ client, redirectTo } = {}) {
  requireValue(client?.auth && client?.from, 'SUPABASE_CONFIG_REQUIRED', 'Falta la conexión segura de CAUCE.');
  const fail = error => {
    if (!error) return;
    const code = error.code || 'SUPABASE_UNAVAILABLE';
    const messages = {
      invalid_credentials: 'Correo o contraseña incorrectos.',
      email_address_invalid: 'Ingresá un correo válido que pueda recibir mensajes.',
      email_not_confirmed: 'Confirmá tu correo antes de ingresar.',
      over_email_send_rate_limit: 'Esperá unos minutos antes de pedir otro correo.',
      email_address_not_authorized: 'El envío de correo de CAUCE todavía necesita configuración. No se confirmó la cuenta.',
      reauthentication_needed: 'Volvé a iniciar sesión antes de cambiar tu contraseña.',
      '23505': 'Ese dato ya existe. Revisalo antes de reintentar.',
      '42501': 'Tu cuenta no tiene permiso para realizar esta operación.',
    };
    throw new CauceError(code, messages[code] || 'No se pudo completar la operación en CAUCE. Revisá la conexión y reintentá.');
  };
  const read = async request => { const { data, error } = await request; fail(error); return data; };
  const businessFields = '*,localities(slug)';
  const mapBusiness = row => ({ ...row, localityId: row.localities?.slug, createdAt: row.created_at });
  async function currentUser() {
    const session = await client.auth.getSession(); fail(session.error);
    if (!session.data.session) return null;
    const result = await client.auth.getUser(); fail(result.error);
    return result.data.user;
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
    if (!user) return { actor: { id: null, kind: 'guest', roles: [], name: 'Visitante' }, ownerId: null };
    const profile = await ensureProfile(user);
    const memberships = await read(client.from('business_memberships').select('business_id,role').eq('user_id', user.id));
    const admin = await read(client.rpc('my_access'));
    return { ownerId: user.id, actor: { id: user.id, kind: 'account', name: profile.display_name,
      email: user.email, phone: profile.phone, roles: ['customer', ...(memberships.length ? ['merchant'] : []), ...(admin ? ['admin'] : [])],
      businessIds: memberships.map(item => item.business_id), memberships } };
  }
  return Object.freeze({
    environment: 'supabase',
    capabilities: Object.freeze({ passwordAuth: true, sharedPersistence: true, demoIdentities: false,
      reset: false, accountManagement: true, foundationOnly: true, orders: false }),
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
      if (data.session) await ensureProfile(data.user);
      return { confirmationRequired: !data.session };
    },
    async signIn({ email, password }) {
      fail((await client.auth.signInWithPassword({ email: normalizeEmail(email), password })).error);
      return session();
    },
    async signOut() { fail((await client.auth.signOut({ scope: 'local' })).error); },
    async requestPasswordReset(email) {
      fail((await client.auth.resetPasswordForEmail(normalizeEmail(email), { redirectTo })).error);
    },
    async updatePassword(password) {
      const valid = validatePassword(password); requireValue(valid.ok, 'INVALID_PASSWORD', valid.message);
      fail((await client.auth.updateUser({ password })).error);
    },
    async updateProfile(input) {
      const user = await currentUser(); requireValue(user, 'SESSION_REQUIRED', 'Ingresá para actualizar tu perfil.');
      const profile = validateSignUp({ ...input, email: user.email }, { requirePassword: false });
      return read(client.from('profiles').update({ display_name: profile.name, phone: profile.phone }).eq('user_id', user.id).select().single());
    },
    onAuthChange(callback) { return client.auth.onAuthStateChange(callback).data.subscription; },
    async query(name, payload = {}) {
      if (name === 'localities') return read(client.from('localities').select('id,slug,name,active'));
      if (name === 'adminBusinesses') {
        const access = await read(client.rpc('my_access'));
        requireValue(access, 'ROLE_REQUIRED', 'Sección exclusiva de administración.');
        return (await read(client.from('businesses').select(businessFields))).map(mapBusiness);
      }
      if (name === 'publicBusinesses') return (await read(client.from('businesses').select(businessFields).eq('status', 'active'))).map(mapBusiness);
      if (name === 'myBusinesses') {
        const user = await currentUser(); requireValue(user, 'SESSION_REQUIRED', 'Ingresá para ver tus comercios.');
        const memberships = await read(client.from('business_memberships').select('business_id,role').eq('user_id', user.id));
        if (!memberships.length) return [];
        const rows = await read(client.from('businesses').select(businessFields).in('id', memberships.map(m => m.business_id)));
        return rows.map(row => ({ ...mapBusiness(row), membershipRole: memberships.find(m => m.business_id === row.id).role }));
      }
      throw new CauceError('FEATURE_UNAVAILABLE', 'Esta función todavía no está habilitada en el entorno conectado.');
    },
    async command(name, payload) {
      if (name === 'business.create') {
        await session();
        const id = await read(client.rpc('create_business', { business_name: payload.name,
          business_slug: `${slugify(payload.name)}-${crypto.randomUUID().slice(0, 8)}`, locality_slug: 'alumine' }));
        return { id };
      }
      if (name === 'business.rename') {
        return read(client.from('businesses').update({ name: payload.name }).eq('id', payload.businessId).select().single());
      }
      throw new CauceError('FEATURE_UNAVAILABLE', 'Esta operación todavía no está habilitada.');
    },
  });
}
