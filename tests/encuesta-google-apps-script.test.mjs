import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class MockRange {
  constructor(sheet, row, column, rows = 1, columns = 1) { Object.assign(this, { sheet, row, column, rows, columns }); }
  setNumberFormat() { return this; }
  setValues(values) {
    values.forEach((line, y) => line.forEach((value, x) => {
      const targetRow = this.row + y - 1;
      const targetColumn = this.column + x - 1;
      this.sheet.rows[targetRow] ||= [];
      this.sheet.rows[targetRow][targetColumn] = value;
    }));
    return this;
  }
  setValue(value) { return this.setValues([[value]]); }
  getValue() { return this.sheet.rows[this.row - 1]?.[this.column - 1] ?? ''; }
  getDisplayValue() { const value = this.getValue(); return value instanceof Date ? value.toISOString() : String(value); }
  createTextFinder(needle) {
    let exact = false;
    return {
      matchEntireCell(value) { exact = value; return this; },
      findNext: () => {
        for (let row = 1; row < this.sheet.rows.length; row++) {
          const value = String(this.sheet.rows[row]?.[this.column - 1] ?? '');
          if (exact ? value === String(needle) : value.includes(String(needle))) return { getRow: () => row + 1 };
        }
        return null;
      }
    };
  }
}

class MockSheet {
  constructor(headers) { this.rows = [headers]; }
  getLastRow() { return this.rows.length; }
  getRange(row, column, rows = 1, columns = 1) { return new MockRange(this, row, column, rows, columns); }
}

test('server-side validation, conditional questions, formula escaping and stable hashing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'encuesta', 'google-apps-script', 'Code.gs'), 'utf8');
  const context = vm.createContext({ console });
  vm.runInContext(source, context, { filename: 'Code.gs' });
  assert.equal(vm.runInContext('runValidationTests()', context), 'All Apps Script validation tests passed.');

  const changedOrderA = vm.runInContext('canonicalJson_({b: 2, a: 1})', context);
  const changedOrderB = vm.runInContext('canonicalJson_({a: 1, b: 2})', context);
  assert.equal(changedOrderA, changedOrderB);
  assert.match(vm.runInContext('safeCell_("  =1+1")', context), /^'/);
});

test('mock Apps Script endpoint confirms writes and safely deduplicates retries', () => {
  const id = '6c7b3c6f-8303-46b8-951d-17c50aa27e15';
  const headers = ['response_id', 'received_at', 'survey_version', 'activity', 'customer_channels', 'sales_challenges', 'usefulness', 'interested_features', 'joining_priorities', 'payment_model', 'monthly_price', 'pilot_interest', 'send_status', 'receipt', 'payload_sha256', 'estimated_monthly_ars'];
  const responses = new MockSheet(headers);
  const starts = new MockSheet(['response_id', 'started_at', 'completed_at', 'status']);
  const book = { getSheetByName: name => name === 'Responses' ? responses : starts };
  const props = { getProperty: () => 'mock-sheet-id' };
  const context = vm.createContext({
    console,
    SpreadsheetApp: { openById: () => book, flush() {} },
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(value).digest()],
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'),
      getUuid: randomUUID
    },
    ContentService: {
      MimeType: { TEXT: 'text/plain', JAVASCRIPT: 'application/javascript' },
      createTextOutput: value => ({ value, setMimeType() { return this; } })
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'encuesta', 'google-apps-script', 'Code.gs'), 'utf8'), context, { filename: 'Code.gs' });

  const answers = {
    activity: 'commerce', customer_channels: ['whatsapp', 'fairs'], sales_challenges: ['awareness'],
    usefulness: 'useful', interested_features: ['show_business'], joining_priorities: ['affordable'],
    payment_model: 'fixed_monthly', monthly_price: '10000_to_20000', pilot_interest: 'yes'
  };
  const request = { parameter: { action: 'submit', responseId: id, surveyVersion: '2026-10-14-v1', answers: JSON.stringify(answers) } };
  assert.equal(vm.runInContext('doPost', context)(request).value, 'ok');
  assert.equal(responses.rows.length, 2);
  assert.equal(responses.rows[1][0], id);
  assert.equal(responses.rows[1][12], 'received');
  assert.equal(starts.rows[1][3], 'completed');

  for (let i = 0; i < 8; i++) vm.runInContext('doPost', context)(request);
  assert.equal(responses.rows.length, 2, 'same response ID does not append duplicate rows');

  const confirmation = vm.runInContext('doGet', context)({ parameter: {
    action: 'confirm', responseId: id, nonce: '109d68e6-ff0f-4acb-bef3-239b8b26bc17', callback: 'cauceSurveyReceive_109d68e6ff0f4acbbef3239b8b26bc17'
  } });
  assert.match(confirmation.value, /"ok":true/);
  assert.match(confirmation.value, /"verified":true/);
  assert.match(confirmation.value, new RegExp(id));

  const invalid = { ...request, parameter: { ...request.parameter, responseId: '6c7b3c6f-8303-46b8-951d-17c50aa27e15', answers: JSON.stringify({ ...answers, activity: '=1+1' }) } };
  vm.runInContext('doPost', context)(invalid);
  assert.equal(responses.rows.length, 2, 'manipulated answers are rejected before writing');
});

test('frontend and Apps Script question IDs and options stay in sync', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'encuesta', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'encuesta', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'encuesta', 'google-apps-script', 'Code.gs'), 'utf8');
  const questionSource = app.slice(app.indexOf('const QUESTIONS = ['), app.indexOf('const elements ='));
  const serverContext = vm.createContext({ console });
  vm.runInContext(server, serverContext);
  const serverQuestionIds = Object.keys(vm.runInContext('APP.QUESTIONS', serverContext)).sort();
  const frontendQuestionIds = [...questionSource.matchAll(/id: "([a-z_]+)",\s*kind:/g)].map(match => match[1]).sort();
  assert.deepEqual(frontendQuestionIds, serverQuestionIds);

  const blocks = [...questionSource.matchAll(/id: "([a-z_]+)",\s*kind: "[a-z]+",[\s\S]*?(?=\n    \},?\n    \{|\n  \];)/g)];
  const frontendOptions = new Map();
  for (const block of blocks) {
    frontendOptions.set(block[1], [...block[0].matchAll(/\["([a-z0-9_]+)",\s*"[^"]+"\]/g)].map(match => match[1]).sort());
  }
  frontendOptions.set('monthly_price', [...app.slice(app.indexOf('priceRanges: ['), app.indexOf('\n    ]', app.indexOf('priceRanges: ['))).matchAll(/id: "([a-z0-9_]+)"/g)].map(match => match[1]).sort());
  for (const [questionId, question] of Object.entries(vm.runInContext('APP.QUESTIONS', serverContext))) {
    assert.deepEqual(frontendOptions.get(questionId), [...question.options].sort(), `options match for ${questionId}`);
  }

  for (const [, elementId] of app.matchAll(/getElementById\("([a-z0-9-]+)"\)/g)) {
    if (elementId === 'survey-heading') continue; // Rendered from the active question at runtime.
    assert.match(html, new RegExp(`id="${elementId}"`), `markup includes #${elementId}`);
  }
});
