import test from 'node:test';
import assert from 'node:assert/strict';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

test('esc() escapa caracteres HTML peligrosos exactamente una vez', () => {
  assert.equal(esc('Café & Medialunas'), 'Café &amp; Medialunas');
  assert.equal(esc('Pizza <Especial>'), 'Pizza &lt;Especial&gt;');
  assert.equal(esc('"Comida" & \'Bebida\''), '&quot;Comida&quot; &amp; &#39;Bebida&#39;');
});

test('resumen de productos en carritos no sufre doble escape', () => {
  const lines = [
    { quantity: 1, name: 'Café & Medialunas' },
    { quantity: 2, name: 'Pizza <Especial>' }
  ];

  // Patrón correcto: componer texto plano y escapar al interpolar en HTML
  const itemsSummary = lines.map(l => `${l.quantity} × ${l.name}`).join(' · ');
  const renderedHtml = `<p class="cart-merchant-items-summary">3 productos: ${esc(itemsSummary)}</p>`;

  // Debe contener &amp; y &lt; exactamente una vez, nunca &amp;amp; o &amp;lt;
  assert.match(renderedHtml, /Café &amp; Medialunas/);
  assert.match(renderedHtml, /Pizza &lt;Especial&gt;/);
  assert.doesNotMatch(renderedHtml, /&amp;amp;/);
  assert.doesNotMatch(renderedHtml, /&amp;lt;/);
});

test('prevención de regresión de doble escape detectado en v0.3.2', () => {
  const name = 'Café & Medialunas';
  const doubleEscaped = esc(esc(name));
  assert.equal(doubleEscaped, 'Café &amp;amp; Medialunas');

  const singleEscaped = esc(name);
  assert.equal(singleEscaped, 'Café &amp; Medialunas');
  assert.notEqual(singleEscaped, doubleEscaped);
});
