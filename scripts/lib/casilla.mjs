// Casillas de correo para comprobar entregas reales sin depender de nadie:
// Mailpit en el stack local y una casilla desechable (mail.tm) contra el
// proyecto real. Sólo reciben correos de prueba de cuentas cauce-qa-….
import { randomBytes } from 'node:crypto';
import { hide } from './proyecto.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function tokenLink(html) {
  const match = /href="([^"]*token_hash=[^"]+)"/.exec(String(html || ''));
  if (!match) throw new Error('El correo no trae un enlace con token_hash.');
  return new URL(match[1].replace(/&amp;/g, '&'));
}

// Mailpit del stack local: cualquier dirección sirve.
export function mailpitInbox(baseUrl, address) {
  return {
    address,
    async waitFor(subject, { after = 0, timeout = 30000 } = {}) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const response = await fetch(`${baseUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
        const found = ((await response.json()).messages || [])
          .filter(message => message.Subject === subject && new Date(message.Created).getTime() >= after)
          .sort((a, b) => new Date(b.Created) - new Date(a.Created))[0];
        if (found) return (await (await fetch(`${baseUrl}/api/v1/message/${found.ID}`)).json()).HTML;
        await sleep(400);
      }
      throw new Error(`No llegó "${subject}" a la casilla de prueba.`);
    },
    async close() {},
  };
}

// mail.tm: casilla pública desechable, con API. Se crea para esta prueba y se
// borra al final.
export async function disposableInbox(prefix) {
  const api = 'https://api.mail.tm';
  const domains = await (await fetch(`${api}/domains`)).json();
  const domain = (domains['hydra:member'] || []).find(item => item.isActive && !item.isPrivate)?.domain;
  if (!domain) throw new Error('mail.tm no ofrece dominios activos ahora.');
  const address = `${prefix}@${domain}`.toLowerCase();
  const password = randomBytes(18).toString('base64url');
  hide(password);
  const created = await fetch(`${api}/accounts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, password }),
  });
  if (!created.ok) throw new Error(`mail.tm no creó la casilla (HTTP ${created.status}).`);
  const account = await created.json();
  const { token } = await (await fetch(`${api}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, password }),
  })).json();
  hide(token);
  const auth = { Authorization: `Bearer ${token}` };
  return {
    address,
    async waitFor(subject, { after = 0, timeout = 180000 } = {}) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const list = await (await fetch(`${api}/messages`, { headers: auth })).json();
        const found = (list['hydra:member'] || [])
          .filter(message => message.subject === subject && new Date(message.createdAt).getTime() >= after - 5000)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
        if (found) {
          const message = await (await fetch(`${api}/messages/${found.id}`, { headers: auth })).json();
          return Array.isArray(message.html) ? message.html.join('') : String(message.html || '');
        }
        await sleep(3000);
      }
      throw new Error(`No llegó "${subject}" a ${address} en ${Math.round(timeout / 1000)} s.`);
    },
    async close() {
      await fetch(`${api}/accounts/${account.id}`, { method: 'DELETE', headers: auth }).catch(() => {});
    },
  };
}
