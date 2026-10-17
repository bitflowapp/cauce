const APP = Object.freeze({
  VERSION: '2026-10-14-v1',
  RESPONSE_SHEET: 'Responses',
  START_SHEET: 'Starts',
  DASHBOARD_SHEET: 'Dashboard',
  SETTINGS_SHEET: 'Assumptions',
  PROPERTY_SHEET_ID: 'CAUCE_SURVEY_SPREADSHEET_ID',
  HEADERS: [
    'response_id', 'received_at', 'survey_version', 'activity', 'customer_channels',
    'sales_challenges', 'usefulness', 'interested_features', 'joining_priorities',
    'payment_model', 'monthly_price', 'pilot_interest', 'send_status', 'receipt',
    'payload_sha256', 'estimated_monthly_ars'
  ],
  QUESTIONS: {
    activity: { kind: 'single', options: ['commerce', 'venture', 'food', 'lodging_tourism', 'services', 'fair_crafts', 'transport_delivery', 'other'] },
    customer_channels: { kind: 'multiple', options: ['whatsapp', 'social_media', 'physical_store', 'word_of_mouth', 'google', 'fairs', 'website_shop', 'other'] },
    sales_challenges: { kind: 'multiple', options: ['awareness', 'show_products', 'organize_orders', 'coordinate_delivery', 'get_paid', 'new_customers', 'social_media_management', 'no_major_difficulty', 'other'] },
    usefulness: { kind: 'single', options: ['not_useful', 'slightly_useful', 'could_help', 'useful', 'very_useful'] },
    interested_features: { kind: 'multiple', options: ['show_business', 'publish_offerings', 'receive_orders', 'reservations_inquiries', 'local_pickup', 'offer_delivery', 'reach_tourists', 'promotions', 'statistics', 'local_directory', 'other'] },
    joining_priorities: { kind: 'multiple', options: ['easy_to_use', 'affordable', 'generate_customers', 'low_commission', 'setup_help', 'local_platform', 'try_before_pay', 'other'] },
    payment_model: { kind: 'single', options: ['free_plus_extras', 'fixed_monthly', 'commission_only', 'low_fee_commission', 'one_time', 'try_first', 'not_willing'] },
    monthly_price: { kind: 'single', options: ['up_to_10000', '10000_to_20000', '20000_to_30000', 'over_30000', 'depends_on_results', 'rather_not_monthly'] },
    pilot_interest: { kind: 'single', options: ['yes', 'maybe', 'not_now'] }
  },
  PRICE_ESTIMATES: { up_to_10000: 5000, '10000_to_20000': 15000, '20000_to_30000': 25000, over_30000: 40000 }
});

/** Run once from the editor. Creates a private spreadsheet, tabs, formulas and charts. */
function setupSurvey() {
  const existing = PropertiesService.getScriptProperties().getProperty(APP.PROPERTY_SHEET_ID);
  if (existing) throw new Error('Ya hay una hoja configurada. Use getSurveySheetUrl() para abrirla.');
  const book = SpreadsheetApp.create('CAUCE Aluminé · Encuesta comercial');
  book.setSpreadsheetTimeZone('America/Argentina/Buenos_Aires');
  const first = book.getSheets()[0];
  first.setName(APP.RESPONSE_SHEET);
  first.getRange(1, 1, 1, APP.HEADERS.length).setValues([APP.HEADERS]);
  const starts = book.insertSheet(APP.START_SHEET);
  starts.getRange(1, 1, 1, 4).setValues([['response_id', 'started_at', 'completed_at', 'status']]);
  const dashboard = book.insertSheet(APP.DASHBOARD_SHEET);
  const assumptions = book.insertSheet(APP.SETTINGS_SHEET);
  initializeAssumptions_(assumptions);
  initializeDashboard_(book, dashboard);
  [first, starts, dashboard].forEach(protectSheet_);
  PropertiesService.getScriptProperties().setProperty(APP.PROPERTY_SHEET_ID, book.getId());
  return book.getUrl();
}

function getSurveySheetUrl() {
  const id = PropertiesService.getScriptProperties().getProperty(APP.PROPERTY_SHEET_ID);
  if (!id) throw new Error('Run setupSurvey() first.');
  return SpreadsheetApp.openById(id).getUrl();
}

function doPost(e) {
  try {
    const p = (e && e.parameter) || {};
    const id = String(p.responseId || '');
    if (!validId_(id)) throw new Error('Invalid request.');
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const book = openSurveyBook_();
      if (p.action === 'start') {
        validateVersion_(p.surveyVersion);
        recordStart_(book, id, false);
      } else if (p.action === 'submit') {
        saveResponse_(book, p);
      } else {
        throw new Error('Unsupported action.');
      }
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    // The client treats a missing confirmation as pending and safely retries by ID.
  }
  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

/** Read-only JSONP confirmation. It exposes no answers or personal data. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const callback = /^cauceSurveyReceive_[0-9a-f]{32}$/i.test(String(p.callback || '')) ? p.callback : '';
  if (!callback) return ContentService.createTextOutput('');
  const id = String(p.responseId || '');
  const nonce = validId_(p.nonce) ? p.nonce : '';
  let result = { ok: false, responseId: validId_(id) ? id : '', nonce: nonce };
  if (callback && nonce && validId_(id)) {
    try {
      const book = openSurveyBook_();
      if (p.action === 'confirm_start') {
        const row = findRow_(book.getSheetByName(APP.START_SHEET), 1, id);
        result.ok = Boolean(row);
      } else if (p.action === 'confirm') {
        const sheet = book.getSheetByName(APP.RESPONSE_SHEET);
        const row = findRow_(sheet, 1, id);
        if (row && sheet.getRange(row, 13).getDisplayValue() === 'received') {
          result.ok = true;
          result.verified = true;
          result.receipt = sheet.getRange(row, 14).getDisplayValue();
        }
      }
    } catch (error) {
      result.ok = false;
    }
  }
  const json = JSON.stringify(result).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return ContentService.createTextOutput(callback + '(' + json + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function saveResponse_(book, p) {
  validateVersion_(p.surveyVersion);
  if (typeof p.answers !== 'string' || p.answers.length > 12000) throw new Error('Invalid answer payload.');
  const answers = JSON.parse(p.answers);
  validateAnswers_(answers);
  const canonical = canonicalJson_({ responseId: p.responseId, surveyVersion: p.surveyVersion, answers: answers });
  const digest = digest_(canonical);
  const sheet = book.getSheetByName(APP.RESPONSE_SHEET);
  const existingRow = findRow_(sheet, 1, p.responseId);
  if (existingRow) {
    const existingHash = sheet.getRange(existingRow, 15).getDisplayValue();
    if (existingHash !== digest) throw new Error('Response id conflict.');
    const receipt = sheet.getRange(existingRow, 14).getDisplayValue();
    const verified = verifyRow_(sheet, p.responseId, digest);
    if (verified) recordStart_(book, p.responseId, true);
    return { verified: verified, receipt: receipt };
  }

  recordStart_(book, p.responseId, false);
  const receipt = Utilities.getUuid();
  const values = APP.HEADERS.map(function (header) {
    if (header === 'response_id') return p.responseId;
    if (header === 'received_at') return new Date();
    if (header === 'survey_version') return p.surveyVersion;
    if (header === 'send_status') return 'received';
    if (header === 'receipt') return receipt;
    if (header === 'payload_sha256') return digest;
    if (header === 'estimated_monthly_ars') return APP.PRICE_ESTIMATES[answers.monthly_price] || '';
    const answer = answers[header];
    return Array.isArray(answer) ? JSON.stringify(answer) : answer;
  });
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, values.length).setNumberFormat('@');
  sheet.getRange(row, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange(row, 1, 1, values.length).setValues([values.map(safeCell_)]);
  SpreadsheetApp.flush();
  const verified = verifyRow_(sheet, p.responseId, digest);
  if (verified) recordStart_(book, p.responseId, true);
  return { verified: verified, receipt: receipt };
}

function verifyRow_(sheet, id, digest) {
  const row = findRow_(sheet, 1, id);
  return Boolean(row && sheet.getRange(row, 15).getDisplayValue() === digest && sheet.getRange(row, 13).getDisplayValue() === 'received' && sheet.getRange(row, 14).getDisplayValue());
}

function validateAnswers_(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Answers must be an object.');
  const model = answers.payment_model;
  const asksMonthlyPrice = ['free_plus_extras', 'fixed_monthly', 'low_fee_commission', 'try_first'].indexOf(model) >= 0;
  const required = Object.keys(APP.QUESTIONS).filter(function (key) { return key !== 'monthly_price' || asksMonthlyPrice; });
  const keys = Object.keys(answers);
  if (keys.some(function (key) { return !APP.QUESTIONS[key] || required.indexOf(key) < 0; })) throw new Error('Unexpected question.');
  if (required.some(function (key) { return !Object.prototype.hasOwnProperty.call(answers, key); })) throw new Error('Missing answer.');
  required.forEach(function (key) {
    const question = APP.QUESTIONS[key];
    const answer = answers[key];
    if (question.kind === 'multiple') {
      if (!Array.isArray(answer) || answer.length < 1 || answer.length > question.options.length) throw new Error('Invalid multiple choice.');
      if (new Set(answer).size !== answer.length || answer.some(function (item) { return typeof item !== 'string' || question.options.indexOf(item) < 0; })) throw new Error('Invalid option.');
    } else if (typeof answer !== 'string' || question.options.indexOf(answer) < 0) {
      throw new Error('Invalid single choice.');
    }
  });
}

function validateVersion_(version) {
  if (version !== APP.VERSION) throw new Error('Unsupported survey version.');
}

function validId_(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function recordStart_(book, id, completed) {
  const sheet = book.getSheetByName(APP.START_SHEET);
  let row = findRow_(sheet, 1, id);
  if (!row) {
    row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1).setNumberFormat('@');
    sheet.getRange(row, 1, 1, 4).setValues([[id, new Date(), '', 'started']]);
    sheet.getRange(row, 2, 1, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange(row, 4).setNumberFormat('@');
  }
  if (completed) {
    sheet.getRange(row, 3).setValue(new Date()).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange(row, 4).setValue('completed');
  }
}

function findRow_(sheet, column, exactValue) {
  if (sheet.getLastRow() < 2) return 0;
  const found = sheet.getRange(2, column, sheet.getLastRow() - 1, 1).createTextFinder(String(exactValue)).matchEntireCell(true).findNext();
  return found ? found.getRow() : 0;
}

function openSurveyBook_() {
  const id = PropertiesService.getScriptProperties().getProperty(APP.PROPERTY_SHEET_ID);
  if (!id) throw new Error('Spreadsheet not configured.');
  return SpreadsheetApp.openById(id);
}

function safeCell_(value) {
  if (typeof value !== 'string') return value;
  return /^[\s]*[=+\-@]/.test(value) ? "'" + value : value;
}

function canonicalJson_(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson_).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + canonicalJson_(value[key]); }).join(',') + '}';
  return JSON.stringify(value);
}

function digest_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8));
}

function initializeAssumptions_(sheet) {
  sheet.getRange('A1:B4').setValues([
    ['Parámetro editable', 'Valor'],
    ['Precio mensual fijo para escenarios', ''],
    ['Precio mensual de extras para escenarios', ''],
    ['Cuota mensual del modelo mixto para escenarios', '']
  ]);
  sheet.getRange('A6:B7').setValues([
    ['Nota', 'Las celdas de valores quedan vacías para no inventar precios. Completar solo con hipótesis propias; no son ingresos ni respuestas observadas.'],
    ['Comisiones', 'No se proyectan: la encuesta no pregunta ventas ni volumen transaccionado.']
  ]);
  sheet.setColumnWidth(1, 300);
  sheet.setColumnWidth(2, 620);
}

function initializeDashboard_(book, sheet) {
  sheet.getCharts().forEach(function (chart) { sheet.removeChart(chart); });
  sheet.clear();
  sheet.getRange('A1').setValue('CAUCE · Aluminé | Panel de investigación comercial');
  sheet.getRange('A2:B6').setValues([
    ['Indicador', 'Resultado'],
    ['Encuestas completadas (confirmadas)', '=COUNTA(Responses!A2:A)'],
    ['Inicios registrados', '=COUNTA(Starts!A2:A)'],
    ['Inicios sin completar hace más de 24 h', '=COUNTIFS(Starts!D2:D,"started",Starts!B2:B,"<"&NOW()-1)'],
    ['Abandono entre inicios con más de 24 h', '=IFERROR(B5/COUNTIF(Starts!B2:B,"<"&NOW()-1),0)']
  ]);
  sheet.getRange('B6').setNumberFormat('0.0%');
  sheet.getRange('A8:B9').setValues([
    ['Interés en el piloto (sí o quizás)', '=COUNTIF(Responses!L2:L,"yes")+COUNTIF(Responses!L2:L,"maybe")'],
    ['Porcentaje con interés en el piloto', '=IFERROR(B8/B3,0)']
  ]);
  sheet.getRange('B9').setNumberFormat('0.0%');
  sheet.getRange('A11:B12').setValues([
    ['Eligieron un modelo con pago mensual', '=COUNTIF(Responses!J2:J,"free_plus_extras")+COUNTIF(Responses!J2:J,"fixed_monthly")+COUNTIF(Responses!J2:J,"low_fee_commission")+COUNTIF(Responses!J2:J,"try_first")'],
    ['Porcentaje con intención de pago mensual', '=IFERROR(B11/B3,0)']
  ]);
  sheet.getRange('B12').setNumberFormat('0.0%');
  sheet.getRange('D2:E2').setValues([['Fecha', 'Encuestas']]);
  sheet.getRange('D3').setFormula('=QUERY({INT(Responses!B2:B),Responses!A2:A},"select Col1,count(Col2) where Col2 is not null group by Col1 order by Col1 label Col1 \'Fecha\', count(Col2) \'Encuestas\'",0)');
  sheet.getRange('G2:H3').setValues([['Evolución semanal', 'Completadas'], ['', '']]);
  sheet.getRange('G3').setFormula('=QUERY({YEAR(Responses!B2:B),WEEKNUM(Responses!B2:B),Responses!A2:A},"select Col1,Col2,count(Col3) where Col3 is not null group by Col1,Col2 order by Col1,Col2 label count(Col3) \'Completadas\'",0)');

  const profileRows = [
    ['Rubro', 'Respuestas', 'Comercios', ...APP.QUESTIONS.activity.options],
    ['Modelo de cobro', 'Respuestas', 'Modelos', ...APP.QUESTIONS.payment_model.options],
    ['Monto mensual elegido', 'Respuestas', 'Rangos', ...APP.QUESTIONS.monthly_price.options],
    ['Canales utilizados', 'Selecciones', 'Canales', ...APP.QUESTIONS.customer_channels.options],
    ['Dificultades', 'Selecciones', 'Dificultades', ...APP.QUESTIONS.sales_challenges.options],
    ['Funciones solicitadas', 'Selecciones', 'Funciones', ...APP.QUESTIONS.interested_features.options],
    ['Utilidad percibida', 'Respuestas', 'Utilidad', ...APP.QUESTIONS.usefulness.options]
  ];
  let row = 15;
  let paymentModelRow = 0;
  profileRows.forEach(function (entry) {
    if (entry[0] === 'Modelo de cobro') paymentModelRow = row;
    sheet.getRange(row, 1, 1, 2).setValues([[entry[0], entry[1]]]);
    entry.slice(3).forEach(function (option, index) {
      const target = row + index + 1;
      sheet.getRange(target, 1).setValue(option);
      const sourceColumn = entry[0] === 'Rubro' ? 'D' : entry[0] === 'Modelo de cobro' ? 'J' : entry[0] === 'Monto mensual elegido' ? 'K' : entry[0] === 'Canales utilizados' ? 'E' : entry[0] === 'Dificultades' ? 'F' : entry[0] === 'Funciones solicitadas' ? 'H' : 'G';
      const countFormula = ['Canales utilizados', 'Dificultades', 'Funciones solicitadas'].indexOf(entry[0]) >= 0
        ? `=COUNTIF(Responses!${sourceColumn}2:${sourceColumn},"*"&A${target}&"*")`
        : `=COUNTIF(Responses!${sourceColumn}2:${sourceColumn},A${target})`;
      sheet.getRange(target, 2).setFormula(countFormula);
    });
    row += entry.length - 2 + 2;
  });
  const scenarioStart = row + 1;
  sheet.getRange(scenarioStart, 1, 1, 6).setValues([['Escenarios mensuales (ARS, intención declarada)', '10 comercios', '20 comercios', '50 comercios', '100 comercios', 'Qué incluye']]);
  const scenarios = [
    ['Cuota fija', 'Assumptions!B2', 'fixed_monthly', 'La extrapolación usa la participación declarada; precio supuesto editable. No son ingresos reales.'],
    ['Gratis + extras', 'Assumptions!B3', 'free_plus_extras', 'Solo extras hipotéticos; no representa cobros observados.'],
    ['Mixto · solo cuota', 'Assumptions!B4', 'low_fee_commission', 'No incluye comisiones. Precio supuesto editable.'],
    ['Prueba y luego cuota', '0', 'try_first', 'No se estima conversión posterior a la prueba.'],
    ['Solo comisión · cuota', '0', 'commission_only', 'No estima comisiones: faltan datos de ventas.'],
    ['Pago único · mensual recurrente', '0', 'one_time', 'No estima pago único: falta monto aceptable.'],
    ['No pagaría · mensual', '0', 'not_willing', 'Ingreso mensual supuesto: ARS 0.']
  ];
  scenarios.forEach(function (scenario, index) {
    const r = scenarioStart + index + 1;
    sheet.getRange(r, 1).setValue(scenario[0]);
    [10, 20, 50, 100].forEach(function (count, colIndex) {
      const price = scenario[1];
      const share = `COUNTIF(Responses!J2:J,"${scenario[2]}")/MAX(1,$B$3)`;
      sheet.getRange(r, colIndex + 2).setFormula(price === '0' ? `=${count}*${share}*0` : `=IF(${price}=\"\",\"\",${count}*${share}*${price})`);
      sheet.getRange(r, colIndex + 2).setNumberFormat('"$"#,##0');
    });
    sheet.getRange(r, 6).setValue(scenario[3]);
  });
  sheet.setFrozenRows(2);
  sheet.setColumnWidth(1, 300);
  sheet.setColumnWidth(2, 170);
  sheet.setColumnWidth(6, 430);
  sheet.getRange(1, 1, 1, 8).setFontWeight('bold').setBackground('#123e37').setFontColor('#fffefa');
  sheet.getRange(2, 1, 1, 8).setFontWeight('bold').setBackground('#dce9e5');
  addChart_(sheet, sheet.getRange('D2:E40'), Charts.ChartType.LINE, 'Encuestas completadas por día', 1, 10);
  addChart_(sheet, sheet.getRange('A15:B23'), Charts.ChartType.BAR, 'Perfil de actividad', 7, 10);
  addChart_(sheet, sheet.getRange(paymentModelRow, 1, APP.QUESTIONS.payment_model.options.length + 1, 2), Charts.ChartType.PIE, 'Preferencia de modelo de cobro', 7, 28);
}

function addChart_(sheet, range, type, title, column, row) {
  const chart = sheet.newChart().setChartType(type).addRange(range).setOption('title', title).setPosition(row, column, 0, 0).build();
  sheet.insertChart(chart);
}

function refreshDashboard() {
  const book = openSurveyBook_();
  initializeDashboard_(book, book.getSheetByName(APP.DASHBOARD_SHEET));
}

function runValidationTests() {
  const valid = {
    activity: 'commerce', customer_channels: ['whatsapp', 'fairs'], sales_challenges: ['awareness'],
    usefulness: 'useful', interested_features: ['show_business'], joining_priorities: ['affordable'],
    payment_model: 'fixed_monthly', monthly_price: '10000_to_20000', pilot_interest: 'yes'
  };
  validateAnswers_(valid);
  assertTestThrows_(function () { validateAnswers_(Object.assign({}, valid, { monthly_price: '1+1' })); }, 'reject unknown option');
  assertTestThrows_(function () { const x = Object.assign({}, valid); delete x.sales_challenges; validateAnswers_(x); }, 'reject missing answer');
  assertTestThrows_(function () { const x = Object.assign({}, valid, { payment_model: 'commission_only' }); validateAnswers_(x); }, 'reject hidden conditional answer');
  assertTestThrows_(function () { validateAnswers_(Object.assign({}, valid, { customer_channels: ['whatsapp', 'whatsapp'] })); }, 'reject duplicate selection');
  const noMonthly = Object.assign({}, valid, { payment_model: 'commission_only' });
  delete noMonthly.monthly_price;
  validateAnswers_(noMonthly);
  if (validId_('not-a-uuid')) throw new Error('Test failed: invalid response id accepted.');
  if (!/^'[=+\-@]/.test(safeCell_('=IMPORTXML("https://example.invalid","//x")'))) throw new Error('Test failed: formula input not escaped.');
  if (canonicalJson_({ b: 2, a: 1 }) !== '{"a":1,"b":2}') throw new Error('Test failed: canonical JSON order.');
  return 'All Apps Script validation tests passed.';
}

function assertTestThrows_(fn, label) {
  let threw = false;
  try { fn(); } catch (error) { threw = true; }
  if (!threw) throw new Error('Test failed: ' + label);
}

function protectSheet_(sheet) {
  const protection = sheet.protect().setDescription('CAUCE survey · owner only');
  protection.setWarningOnly(false);
  protection.setDomainEdit(false);
  const owner = Session.getEffectiveUser().getEmail();
  protection.getEditors().forEach(function (editor) {
    if (editor.getEmail() !== owner) protection.removeEditor(editor);
  });
}
