// Storage real (API de Supabase Storage + políticas en storage.objects).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env, account, guest, anonClient, makeAdmin, publishedBusiness, ok, closeAll } from './harness.mjs';

const BUCKET = 'business-media';
const people = {};
let A, B;
// PNG 1×1 válido.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const png = () => new Blob([PNG], { type: 'image/png' });
const upload = (who, path, body = png(), contentType = 'image/png') =>
  who.client.storage.from(BUCKET).upload(path, body, { contentType, upsert: false });
const publicUrl = path => `${env.url}/storage/v1/object/public/${BUCKET}/${path}`;

before(async () => {
  for (const name of ['ownerA', 'managerA', 'staffA', 'ownerB', 'admin', 'customer']) people[name] = await account(name);
  people.guest = await guest('guest');
  people.anon = { client: anonClient() };
  await makeAdmin(people.admin);
  A = await publishedBusiness(people.ownerA, people.admin, { name: 'Imagenes' });
  B = await publishedBusiness(people.ownerB, people.admin, { name: 'Ajeno' });
  ok(await people.ownerA.client.rpc('add_business_member', { business: A.id, member_email: people.managerA.email, member_role: 'manager' }));
  ok(await people.ownerA.client.rpc('add_business_member', { business: A.id, member_email: people.staffA.email, member_role: 'staff' }));
});
after(async () => { await closeAll(Object.values(people)); });

test('owner y manager suben imágenes de su comercio y se sirven públicamente', async () => {
  const logo = `businesses/${A.id}/logo/${randomUUID()}.png`;
  const cover = `businesses/${A.id}/cover/${randomUUID()}.png`;
  ok(await upload(people.ownerA, logo));
  ok(await upload(people.managerA, cover));
  const response = await fetch(publicUrl(logo));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  ok(await people.ownerA.client.from('businesses').update({ logo_path: logo, cover_path: cover }).eq('id', A.id));
  // La ruta guardada en el comercio debe ser de su propia carpeta.
  const foreign = await people.ownerA.client.from('businesses').update({ logo_path: `businesses/${B.id}/logo/x.png` }).eq('id', A.id);
  assert.equal(foreign.error?.code, '23514');
});

test('staff, otro comercio, clientes y visitas no suben nada', async () => {
  const path = `businesses/${A.id}/products/${A.products.untracked.id}/${randomUUID()}.png`;
  for (const who of ['staffA', 'ownerB', 'customer', 'guest', 'anon']) {
    const result = await upload(people[who], path);
    assert.ok(result.error, `${who} no debe subir a la carpeta de A`);
  }
  assert.equal((await fetch(publicUrl(path))).status >= 400, true);
});

test('sólo imágenes JPEG, PNG o WebP de hasta 5 MB', async () => {
  const base = `businesses/${A.id}/products/${A.products.untracked.id}`;
  const html = await upload(people.ownerA, `${base}/${randomUUID()}.html`,
    new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'text/html');
  assert.ok(html.error, 'HTML rechazado');
  const svg = await upload(people.ownerA, `${base}/${randomUUID()}.svg`,
    new Blob(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'], { type: 'image/svg+xml' }), 'image/svg+xml');
  assert.ok(svg.error, 'SVG rechazado: puede ejecutar scripts');
  const huge = await upload(people.ownerA, `${base}/${randomUUID()}.png`,
    new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: 'image/png' }));
  assert.ok(huge.error, 'más de 5 MB rechazado');
  ok(await upload(people.ownerA, `${base}/${randomUUID()}.webp`, new Blob([PNG], { type: 'image/webp' }), 'image/webp'));
});

test('rutas fuera del formato esperado no resuelven a ningún comercio', async () => {
  for (const path of [
    `businesses/${A.id}/privado/${randomUUID()}.png`,
    `businesses/${A.id}/../${B.id}/logo/${randomUUID()}.png`,
    `${randomUUID()}.png`,
    `businesses/${A.id.toUpperCase()}/logo/${randomUUID()}.png`,
  ]) {
    assert.ok((await upload(people.ownerA, path)).error, path);
  }
});

test('otro comercio no lista, pisa ni borra los archivos de A', async () => {
  const path = `businesses/${A.id}/logo/${randomUUID()}.png`;
  ok(await upload(people.ownerA, path));
  const listed = await people.ownerB.client.storage.from(BUCKET).list(`businesses/${A.id}/logo`);
  assert.deepEqual(listed.data || [], []);
  assert.deepEqual((await people.anon.client.storage.from(BUCKET).list(`businesses/${A.id}/logo`)).data || [], []);
  const overwrite = await people.ownerB.client.storage.from(BUCKET).upload(path, png(), { contentType: 'image/png', upsert: true });
  assert.ok(overwrite.error);
  await people.ownerB.client.storage.from(BUCKET).remove([path]);
  assert.equal((await fetch(publicUrl(path))).status, 200, 'sigue en su lugar');
  ok(await people.ownerA.client.storage.from(BUCKET).remove([path]));
  assert.ok((await fetch(publicUrl(path))).status >= 400, 'el dueño sí lo borra');
});
