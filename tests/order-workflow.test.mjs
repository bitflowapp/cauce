import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canTransitionWorkflowStatus,
  getNextWorkflowStatus,
  normalizeWorkflowStatus,
  toDemoOrderStatus,
} from '../js/core/order-workflow.js';

test('workflow maps legacy demo statuses to production statuses', () => {
  assert.equal(normalizeWorkflowStatus('received'), 'submitted');
  assert.equal(normalizeWorkflowStatus('arriving'), 'arrived');
  assert.equal(normalizeWorkflowStatus('cancelled'), 'canceled');
  assert.equal(toDemoOrderStatus('accepted'), 'preparing');
  assert.equal(toDemoOrderStatus('picked_up'), 'on_the_way');
});

test('workflow validates production transitions without breaking pickup flow', () => {
  assert.equal(canTransitionWorkflowStatus('draft', 'submitted'), true);
  assert.equal(canTransitionWorkflowStatus('submitted', 'accepted'), true);
  assert.equal(canTransitionWorkflowStatus('submitted', 'delivered'), false);
  assert.equal(canTransitionWorkflowStatus('delivered', 'canceled'), false);

  assert.equal(getNextWorkflowStatus('ready', 'delivery'), 'assigned');
  assert.equal(getNextWorkflowStatus('ready', 'pickup'), 'delivered');
});
