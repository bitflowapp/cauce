import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderTimelineIndex,
  publicOrderTimelineIndex,
  renderOrderTimeline,
  renderPublicOrderTimeline,
} from '../js/core/order-timeline.js';

test('orderTimelineIndex mapea correctamente los índices operacionales de negocio y rider', () => {
  assert.equal(orderTimelineIndex('submitted'), 0);
  assert.equal(orderTimelineIndex('preparing'), 1);
  assert.equal(orderTimelineIndex('ready'), 2);
  assert.equal(orderTimelineIndex('on_the_way'), 3);
  assert.equal(orderTimelineIndex('delivered'), 4);
});

test('publicOrderTimelineIndex mapea correctamente los pasos simplificados del cliente', () => {
  assert.equal(publicOrderTimelineIndex('submitted'), 0);
  assert.equal(publicOrderTimelineIndex('accepted'), 1);
  assert.equal(publicOrderTimelineIndex('preparing'), 1);
  assert.equal(publicOrderTimelineIndex('ready'), 1);
  assert.equal(publicOrderTimelineIndex('on_the_way'), 2);
  assert.equal(publicOrderTimelineIndex('arrived'), 2);
  assert.equal(publicOrderTimelineIndex('delivered'), 3);
});

test('renderPublicOrderTimeline genera HTML accesible con aria-current', () => {
  const html = renderPublicOrderTimeline('preparing');
  assert.ok(html.includes('track-steps'));
  assert.ok(html.includes('public'));
  assert.ok(html.includes('aria-current="step"'));
  assert.ok(html.includes('role="listitem"'));
});

test('renderOrderTimeline genera los 5 pasos operacionales', () => {
  const html = renderOrderTimeline('on_the_way');
  assert.ok(html.includes('operational'));
  assert.ok(html.includes('En reparto'));
});
