// Genera los íconos PNG de la PWA a partir de la marca de CAUCE.
// Sin dependencias: rasteriza el fondo y las dos ondas, y comprime con zlib.
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const FOREST = [20, 61, 52];
const WHITE = [255, 255, 255];

// Una onda por muestreo: para cada píxel se mide la distancia vertical a la
// curva y se suaviza el borde, que es lo que evita el efecto de escalera.
function wavePixel(x, y, size, offsetY, amplitude, thickness) {
  const t = (x / size) * Math.PI * 2;
  const curve = offsetY + Math.sin(t) * amplitude;
  const distance = Math.abs(y - curve);
  if (distance > thickness) return 0;
  return Math.min(1, (thickness - distance) / 1.6);
}

function renderIcon(size, { padding = 0 } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = padding > 0 ? 0 : size * 0.22;
  const inner = size - padding * 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      let alpha = 1;

      if (radius > 0) {
        // Esquinas redondeadas con antialias en el borde.
        const dx = Math.max(radius - x, x - (size - radius), 0);
        const dy = Math.max(radius - y, y - (size - radius), 0);
        if (dx > 0 && dy > 0) {
          const distance = Math.hypot(dx, dy);
          alpha = Math.min(1, Math.max(0, radius - distance + 0.5));
        }
      }

      pixels[index] = FOREST[0];
      pixels[index + 1] = FOREST[1];
      pixels[index + 2] = FOREST[2];
      pixels[index + 3] = Math.round(alpha * 255);

      const localX = x - padding;
      const localY = y - padding;
      if (localX < 0 || localY < 0 || localX >= inner || localY >= inner) continue;

      const amplitude = inner * 0.085;
      const thickness = Math.max(2, inner * 0.055);
      const coverage = Math.max(
        wavePixel(localX, localY, inner, inner * 0.38, amplitude, thickness),
        wavePixel(localX, localY, inner, inner * 0.64, amplitude, thickness),
      );
      if (coverage <= 0) continue;
      const blend = coverage * alpha;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[index + channel] = Math.round(
          pixels[index + channel] * (1 - blend) + WHITE[channel] * blend,
        );
      }
    }
  }
  return pixels;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // profundidad de bits
  header[9] = 6;   // color RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filtro "none"
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  { file: 'icon-192.png', size: 192, padding: 0 },
  { file: 'icon-512.png', size: 512, padding: 0 },
  // El ícono "maskable" deja margen para que el recorte del sistema no corte la marca.
  { file: 'icon-maskable-512.png', size: 512, padding: 96 },
];

const output = resolve(ROOT, 'assets/images');
await mkdir(output, { recursive: true });
const written = [];
for (const target of targets) {
  const png = encodePng(target.size, renderIcon(target.size, { padding: target.padding }));
  await writeFile(resolve(output, target.file), png);
  written.push(`${target.file} (${png.length} bytes, sha256 ${createHash('sha256').update(png).digest('hex').slice(0, 12)})`);
}
console.log(`ICONOS PWA · ${written.join(' · ')}`);
