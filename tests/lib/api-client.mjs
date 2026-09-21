// Cliente de pruebas del backend local. Cada instancia mantiene su propio
// tarro de cookies, así que dos clientes son dos sesiones independientes de
// verdad, no dos pestañas compartiendo la misma identidad.
import { createDevServer, openDatabase } from '../../scripts/dev-server.mjs';

export async function startTestServer() {
  const database = openDatabase(':memory:');
  const server = createDevServer({ database });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    database,
    server,
    client(label = 'anónimo') { return createClient(base, label); },
    // Concede el rol de administración fuera de la API pública, como hace `--seed`.
    grantAdmin(email) {
      const row = database.prepare('SELECT doc FROM domain_state WHERE id = 1').get();
      const state = JSON.parse(row.doc);
      const account = state.accounts.find(candidate => candidate.email === email);
      if (!account) throw new Error(`No existe la cuenta ${email}`);
      if (!account.roles.includes('admin')) account.roles.push('admin');
      database.prepare('UPDATE domain_state SET doc = ? WHERE id = 1').run(JSON.stringify(state));
      return account;
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
      database.close();
    },
  };
}

export function createClient(base, label = 'anónimo') {
  let cookie = '';
  const post = async (path, body) => {
    const response = await fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    for (const entry of response.headers.getSetCookie?.() || []) cookie = entry.split(';')[0];
    const payload = await response.json();
    return { status: response.status, ...payload };
  };
  return {
    label,
    get cookie() { return cookie; },
    post,
    register(profile) { return post('/register', profile); },
    signIn(credentials) { return post('/sign-in', credentials); },
    signOut() { return post('/sign-out'); },
    session() { return post('/session'); },
    query(name, payload) { return post('/query', { name, payload }); },
    command(name, payload) { return post('/command', { name, payload }); },
  };
}

export function expectOk(result, context = '') {
  if (!result.ok) {
    throw new Error(`${context || 'La operación'} falló: ${result.code} — ${result.message}`);
  }
  return result.data;
}

export function expectFail(result, code, context = '') {
  if (result.ok) throw new Error(`${context || 'La operación'} debió fallar con ${code} y fue exitosa.`);
  if (result.code !== code) {
    throw new Error(`${context || 'La operación'} falló con ${result.code} (${result.message}), se esperaba ${code}.`);
  }
  return result;
}

// Alta completa de un comercio publicado, usada por varias pruebas.
export async function publishBusiness(harness, { merchant, admin, name = 'Almacén de prueba', delivery = true }) {
  const business = expectOk(await merchant.command('business.create', { name, category: 'Almacén' }), 'crear comercio');
  expectOk(await merchant.command('business.update', {
    businessId: business.id,
    patch: {
      ownerName: 'Responsable de prueba',
      contactPhone: '2942111111',
      address: 'Calle de prueba 100',
      hoursLabel: 'Lunes a sábado de 9 a 13',
      pickupEnabled: true,
      deliveryEnabled: delivery,
      deliveryZone: delivery ? 'Casco urbano de Aluminé' : '',
      deliveryFee: delivery ? 1200 : 0,
      minimumOrder: 0,
    },
  }), 'completar comercio');
  const product = expectOk(await merchant.command('product.create', {
    businessId: business.id,
    product: { name: 'Pan casero', price: 3000, category: 'Panadería', available: true, stock: 10, description: 'Hogaza de campo' },
  }), 'crear producto');
  expectOk(await merchant.command('business.submit', { businessId: business.id }), 'solicitar publicación');
  expectOk(await admin.command('admin.reviewBusiness', { businessId: business.id, decision: 'approve' }), 'aprobar comercio');
  return { business, product };
}

export async function registerAccount(harness, label, profile) {
  const client = harness.client(label);
  expectOk(await client.register(profile), `registrar ${label}`);
  return client;
}
