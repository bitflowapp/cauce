// Driver mínimo de Chrome DevTools Protocol, sin dependencias externas.
// Usa el WebSocket incorporado de Node 22+ y un Chrome/Edge ya instalado en la máquina.
// No descarga navegadores ni contacta servicios externos.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const CANDIDATES = [
  process.env.CAUCE_CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);

export function findChrome() {
  for (const candidate of CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch { /* el navegador todavía no abrió el puerto de depuración */ }
    await sleep(250);
  }
  throw new Error(`No respondió el endpoint de depuración: ${url}`);
}

export async function launchBrowser({ port = 9300 + Math.floor(Math.random() * 400), headless = true } = {}) {
  const binary = findChrome();
  if (!binary) throw new Error('No se encontró Chrome ni Edge. Definí CAUCE_CHROME_PATH.');
  const profile = await mkdtemp(join(tmpdir(), 'cauce-cdp-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-gpu',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  const child = spawn(binary, args, { stdio: 'ignore' });
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  return {
    port,
    binary,
    product: version.Browser,
    async newPage(options) { return openPage(port, options); },
    async close() {
      await fetch(`http://127.0.0.1:${port}/json/close`).catch(() => {});
      child.kill();
      await sleep(400);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function openPage(port, { width = 390, height = 844, mobile = true } = {}) {
  const target = await fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`).catch(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    if (!response.ok) throw new Error('No se pudo abrir una pestaña nueva.');
    return response.json();
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = new Set();
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('No se pudo abrir el canal CDP')), { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    for (const listener of [...listeners]) listener(message);
  });
  let nextId = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout CDP en ${method}`)); }
    }, 30000);
  });

  const consoleErrors = [];
  listeners.add(message => {
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails?.exception?.description
        || message.params.exceptionDetails?.text || 'excepción sin descripción');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map(arg => arg.description || arg.value).join(' '));
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(`${message.params.entry.source}: ${message.params.entry.text}`);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await setViewport(send, { width, height, mobile });

  const page = {
    targetId: target.id,
    send,
    consoleErrors,
    async setViewport(size) { return setViewport(send, { mobile, width, height, ...size }); },
    async goto(url) {
      const loaded = waitForEvent(listeners, message => message.method === 'Page.loadEventFired', 25000);
      await send('Page.navigate', { url });
      await loaded.catch(() => {});
      await page.waitForFunction('document.readyState === "complete"');
      await sleep(150);
    },
    async reload() {
      const loaded = waitForEvent(listeners, message => message.method === 'Page.loadEventFired', 25000);
      await send('Page.reload', { ignoreCache: false });
      await loaded.catch(() => {});
      await page.waitForFunction('document.readyState === "complete"');
      await sleep(150);
    },
    async evaluate(expression) {
      const body = expression.trim();
      const wrapped = /^(return|const|let|var|if|for|while|try|await)\b/.test(body) || body.includes(';\n')
        ? `(async () => { ${body} })()`
        : `(async () => (${body}))()`;
      const result = await send('Runtime.evaluate', {
        expression: wrapped, awaitPromise: true, returnByValue: true, userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(`Error al evaluar: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      }
      return result.result.value;
    },
    async waitForFunction(expression, { timeout = 12000, interval = 100 } = {}) {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        try { last = await page.evaluate(expression); if (last) return last; }
        catch (error) { last = error.message; }
        await sleep(interval);
      }
      throw new Error(`Timeout esperando: ${expression} · último valor: ${JSON.stringify(last)}`);
    },
    async click(selector) {
      await page.waitForFunction(`!!document.querySelector(${JSON.stringify(selector)})`);
      const box = await page.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      await sleep(150);
    },
    async fill(selector, value) {
      await page.waitForFunction(`!!document.querySelector(${JSON.stringify(selector)})`);
      await page.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
          : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
        setter.call(element, ${JSON.stringify(String(value))});
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
    },
    async text(selector = 'body') {
      return page.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText || '')`);
    },
    async screenshot(path, { fullPage = false } = {}) {
      const params = { format: 'png', captureBeyondViewport: fullPage };
      if (fullPage) {
        const metrics = await send('Page.getLayoutMetrics');
        params.clip = {
          x: 0, y: 0,
          width: metrics.cssContentSize.width,
          height: Math.min(metrics.cssContentSize.height, 6000),
          scale: 1,
        };
      }
      const shot = await send('Page.captureScreenshot', params);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(shot.data, 'base64'));
      return path;
    },
    async setOffline(offline) {
      await send('Network.emulateNetworkConditions', {
        offline, latency: 0,
        downloadThroughput: offline ? 0 : -1,
        uploadThroughput: offline ? 0 : -1,
      });
    },
    async close() {
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
      socket.close();
    },
  };
  return page;
}

async function setViewport(send, { width, height, mobile }) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile,
    screenWidth: width, screenHeight: height,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: Boolean(mobile), maxTouchPoints: mobile ? 5 : 0 });
}

function waitForEvent(listeners, predicate, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('Timeout de evento CDP')); }, timeout);
    const listener = message => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(message);
    };
    listeners.add(listener);
  });
}
