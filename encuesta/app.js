(() => {
  "use strict";

  const CONFIG = Object.freeze({
    storageKey: "cauceEncuestaStateV1",
    whatsappNumber: "5492942597276", // 2942597276 con prefijo móvil de Argentina para wa.me
    priceRanges: [
      { id: "up_to_10000", label: "Hasta $10.000" },
      { id: "10000_to_20000", label: "Entre $10.000 y $20.000" },
      { id: "20000_to_30000", label: "Entre $20.000 y $30.000" },
      { id: "over_30000", label: "Más de $30.000" },
      { id: "depends_on_results", label: "Dependería de los resultados" },
      { id: "rather_not_monthly", label: "Preferiría no pagar una cuota mensual" }
    ]
  });

  const PAYMENT_MODELS_WITH_MONTHLY_PRICE = new Set([
    "free_plus_extras",
    "fixed_monthly",
    "low_fee_commission",
    "try_first"
  ]);
  const PILOT_INTEREST = new Set(["yes", "maybe"]);
  const DEFAULT_STATE = {
    answers: {},
    currentQuestionId: "activity",
    surveyStarted: false,
    surveyCompleted: false
  };

  if (new URLSearchParams(window.location.search).get("restart") === "1") {
    try {
      window.localStorage.removeItem(CONFIG.storageKey);
    } catch {
      // El reinicio visual sigue funcionando aunque el navegador bloquee localStorage.
    }
    const cleanedUrl = new URL(window.location.href);
    cleanedUrl.searchParams.delete("restart");
    window.history.replaceState(null, "", `${cleanedUrl.pathname}${cleanedUrl.search}${cleanedUrl.hash}`);
  }

  const QUESTIONS = [
    {
      id: "activity",
      kind: "single",
      title: "¿Qué tipo de actividad tenés?",
      options: [
        ["commerce", "Comercio"],
        ["venture", "Emprendimiento"],
        ["food", "Gastronomía"],
        ["lodging_tourism", "Alojamiento / turismo"],
        ["services", "Servicios"],
        ["fair_crafts", "Feria / producción artesanal"],
        ["transport_delivery", "Transporte / delivery"],
        ["other", "Otro"]
      ]
    },
    {
      id: "customer_channels",
      kind: "multiple",
      title: "¿Cómo llegan hoy tus clientes?",
      options: [
        ["whatsapp", "WhatsApp"],
        ["social_media", "Instagram / Facebook"],
        ["physical_store", "Local físico"],
        ["word_of_mouth", "Recomendaciones"],
        ["google", "Google"],
        ["fairs", "Ferias"],
        ["website_shop", "Página web / tienda online"],
        ["other", "Otro"]
      ]
    },
    {
      id: "sales_challenges",
      kind: "multiple",
      title: "¿Qué es lo que más te cuesta hoy para vender más?",
      options: [
        ["awareness", "Que más gente conozca mi negocio"],
        ["show_products", "Mostrar mis productos o servicios"],
        ["organize_orders", "Recibir y ordenar pedidos"],
        ["coordinate_delivery", "Coordinar entregas"],
        ["get_paid", "Cobrar"],
        ["new_customers", "Conseguir nuevos clientes"],
        ["social_media_management", "Manejar redes sociales"],
        ["no_major_difficulty", "No tengo grandes dificultades"],
        ["other", "Otro"]
      ]
    },
    {
      id: "usefulness",
      kind: "scale",
      title: "¿Qué tan útil sería para tu actividad?",
      description: "Imaginá una plataforma exclusivamente de Aluminé donde vecinos y turistas puedan encontrar comercios, emprendimientos, productos y servicios locales.",
      options: [
        ["not_useful", "No me serviría"],
        ["slightly_useful", "Poco"],
        ["could_help", "Puede servirme"],
        ["useful", "Me serviría"],
        ["very_useful", "Me serviría mucho"]
      ]
    },
    {
      id: "interested_features",
      kind: "multiple",
      title: "¿Qué te interesaría poder hacer desde CAUCE?",
      options: [
        ["show_business", "Mostrar mi negocio"],
        ["publish_offerings", "Publicar productos o servicios"],
        ["receive_orders", "Recibir pedidos"],
        ["reservations_inquiries", "Recibir reservas o consultas"],
        ["local_pickup", "Coordinar retiro en el local"],
        ["offer_delivery", "Ofrecer delivery"],
        ["reach_tourists", "Aparecer para turistas"],
        ["promotions", "Publicar promociones"],
        ["statistics", "Ver estadísticas"],
        ["local_directory", "Solo aparecer en el directorio local"],
        ["other", "Otro"]
      ]
    },
    {
      id: "joining_priorities",
      kind: "multiple",
      title: "¿Qué sería lo más importante para que te sumes?",
      options: [
        ["easy_to_use", "Que sea fácil de usar"],
        ["affordable", "Que tenga un costo accesible"],
        ["generate_customers", "Que realmente genere clientes"],
        ["low_commission", "Que no cobre una comisión alta"],
        ["setup_help", "Tener ayuda para configurarlo"],
        ["local_platform", "Que sea una plataforma de Aluminé"],
        ["try_before_pay", "Poder probarlo antes de pagar"],
        ["other", "Otro"]
      ]
    },
    {
      id: "payment_model",
      kind: "single",
      title: "Si CAUCE realmente te ayudara a conseguir clientes y gestionar mejor tu actividad, ¿qué modalidad te resultaría más cómoda?",
      options: [
        ["free_plus_extras", "Usarlo gratis con funciones básicas y pagar por extras"],
        ["fixed_monthly", "Pagar un monto fijo mensual y tener todas las funciones"],
        ["commission_only", "No pagar cuota y pagar una pequeña comisión cuando vendo"],
        ["low_fee_commission", "Cuota baja + comisión baja"],
        ["one_time", "Pagar una sola vez"],
        ["try_first", "Tendría que probarlo antes"],
        ["not_willing", "No estaría dispuesto/a a pagar"]
      ]
    },
    {
      id: "monthly_price",
      kind: "single",
      title: "Si CAUCE realmente te genera clientes o te facilita el trabajo, ¿qué monto mensual te parecería razonable?",
      options: CONFIG.priceRanges
    },
    {
      id: "pilot_interest",
      kind: "single",
      title: "Si CAUCE se lanzara en Aluminé, ¿te interesaría participar de una prueba inicial?",
      options: [
        ["yes", "Sí, me interesa"],
        ["maybe", "Quizás, quiero conocer más"],
        ["not_now", "Por ahora no"]
      ]
    }
  ];

  const elements = {
    hero: document.querySelector(".hero"),
    survey: document.getElementById("encuesta"),
    final: document.getElementById("final"),
    start: document.getElementById("start-survey"),
    form: document.getElementById("survey-form"),
    content: document.getElementById("question-content"),
    step: document.getElementById("step-label"),
    progress: document.getElementById("progress-track"),
    progressFill: document.getElementById("progress-fill"),
    error: document.getElementById("form-error"),
    back: document.getElementById("back-button"),
    next: document.getElementById("next-button"),
    share: document.getElementById("share-button"),
    shareStatus: document.getElementById("share-status"),
    pilot: document.getElementById("pilot-button")
  };

  let state = readState();
  let lastVisibleQuestions = [];

  function readState() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(CONFIG.storageKey));
      if (!saved || typeof saved !== "object" || !saved.answers || typeof saved.answers !== "object") {
        return { ...DEFAULT_STATE, answers: {} };
      }
      return {
        ...DEFAULT_STATE,
        ...saved,
        answers: saved.answers,
        surveyStarted: Boolean(saved.surveyStarted),
        surveyCompleted: Boolean(saved.surveyCompleted)
      };
    } catch {
      return { ...DEFAULT_STATE, answers: {} };
    }
  }

  function saveState() {
    try {
      window.localStorage.setItem(CONFIG.storageKey, JSON.stringify(state));
    } catch {
      // La encuesta sigue funcionando en memoria si el navegador bloquea localStorage.
    }
  }

  function track(eventName, parameters) {
    if (window.CauceAnalytics && typeof window.CauceAnalytics.track === "function") {
      window.CauceAnalytics.track(eventName, parameters);
    }
  }

  function shouldAskMonthlyPrice() {
    return PAYMENT_MODELS_WITH_MONTHLY_PRICE.has(state.answers.payment_model);
  }

  function getVisibleQuestions() {
    const paymentModelChosen = Object.prototype.hasOwnProperty.call(state.answers, "payment_model");
    return QUESTIONS.filter((question) => question.id !== "monthly_price" || !paymentModelChosen || shouldAskMonthlyPrice());
  }

  function getQuestionIndex(questionId, questions = getVisibleQuestions()) {
    return questions.findIndex((question) => question.id === questionId);
  }

  function getCurrentQuestion(questions = getVisibleQuestions()) {
    let index = getQuestionIndex(state.currentQuestionId, questions);
    if (index < 0) {
      index = Math.min(questions.length - 1, 0);
      state.currentQuestionId = questions[index].id;
      saveState();
    }
    return { question: questions[index], index };
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function renderChoice(question, option, questionNumber) {
    const [optionId, label] = Array.isArray(option) ? option : [option.id, option.label];
    const inputType = question.kind === "multiple" ? "checkbox" : "radio";
    const saved = state.answers[question.id];
    const selected = inputType === "checkbox" ? Array.isArray(saved) && saved.includes(optionId) : saved === optionId;
    const inputId = `${question.id}-${optionId}`;
    const optionMarkup = question.kind === "scale"
      ? `<span class="scale-number">${question.options.indexOf(option) + 1}</span><span class="scale-copy">${escapeHtml(label)}</span>`
      : `<span class="choice-copy">${escapeHtml(label)}</span>`;

    return `<label class="choice-card" for="${inputId}">
      <input class="choice-control" id="${inputId}" name="${question.id}" type="${inputType}" value="${escapeHtml(optionId)}"${selected ? " checked" : ""} aria-describedby="form-error" data-question="${question.id}" data-question-number="${questionNumber}">
      ${optionMarkup}
    </label>`;
  }

  function renderQuestion() {
    const questions = getVisibleQuestions();
    lastVisibleQuestions = questions;
    const { question, index } = getCurrentQuestion(questions);
    const number = index + 1;
    const total = questions.length;
    const description = question.description
      ? `<p class="question-description" id="question-description">${escapeHtml(question.description)}</p>`
      : "";
    const options = question.options.map((option) => renderChoice(question, option, number)).join("");
    const listClass = question.kind === "scale" ? "choice-list scale-list" : "choice-list";

    elements.content.innerHTML = `<div class="question-enter">
      <h2 class="question-heading" id="survey-heading" tabindex="-1">${escapeHtml(question.title)}</h2>
      ${description}
      <fieldset class="${listClass}" aria-labelledby="survey-heading"${question.description ? ' aria-describedby="question-description"' : ""}>
        <legend class="visually-hidden">${escapeHtml(question.title)}</legend>
        ${options}
      </fieldset>
    </div>`;
    elements.step.textContent = `Pregunta ${number} de ${total}`;
    elements.progress.setAttribute("aria-valuemax", String(total));
    elements.progress.setAttribute("aria-valuenow", String(number));
    elements.progress.setAttribute("aria-valuetext", `Pregunta ${number} de ${total}`);
    elements.progressFill.style.width = `${(number / total) * 100}%`;
    elements.back.hidden = index === 0;
    elements.next.querySelector("span").textContent = index === total - 1 ? "Finalizar" : "Continuar";
    elements.error.hidden = true;
    elements.error.textContent = "Elegí al menos una opción para continuar.";
    track("survey_question_view", { question_id: question.id, question_number: number });
    requestAnimationFrame(() => document.getElementById("survey-heading")?.focus({ preventScroll: true }));
  }

  function showHero() {
    elements.hero.hidden = false;
    elements.survey.hidden = true;
    elements.final.hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showSurvey() {
    elements.hero.hidden = true;
    elements.survey.hidden = false;
    elements.final.hidden = true;
    renderQuestion();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setQuestionAnswer(question, changedInput) {
    if (question.kind === "multiple") {
      const selected = new Set(Array.isArray(state.answers[question.id]) ? state.answers[question.id] : []);
      if (changedInput.checked) selected.add(changedInput.value);
      else selected.delete(changedInput.value);
      state.answers[question.id] = [...selected];
    } else {
      state.answers[question.id] = changedInput.value;
    }

    if (question.id === "payment_model" && !shouldAskMonthlyPrice()) {
      delete state.answers.monthly_price;
    }
    saveState();
    elements.error.hidden = true;
  }

  function getSelectedOptionIds(question) {
    const answer = state.answers[question.id];
    return Array.isArray(answer) ? answer : answer ? [answer] : [];
  }

  function startSurvey() {
    if (!state.surveyStarted) {
      state.surveyStarted = true;
      state.surveyCompleted = false;
      state.currentQuestionId = "activity";
      track("survey_start");
    }
    saveState();
    showSurvey();
  }

  function advanceSurvey(event) {
    event.preventDefault();
    const { question, index } = getCurrentQuestion(lastVisibleQuestions);
    const selected = getSelectedOptionIds(question);
    if (selected.length === 0) {
      elements.error.hidden = false;
      elements.error.textContent = "Elegí al menos una opción para continuar.";
      elements.content.querySelector("input")?.focus({ preventScroll: true });
      return;
    }

    for (const optionId of selected) {
      track("survey_answer", {
        question_id: question.id,
        option_id: optionId,
        question_number: index + 1
      });
    }

    const currentQuestions = getVisibleQuestions();
    const currentIndex = getQuestionIndex(question.id, currentQuestions);
    const nextQuestion = currentQuestions[currentIndex + 1];
    if (!nextQuestion) {
      state.surveyCompleted = true;
      state.currentQuestionId = question.id;
      saveState();
      track("survey_complete");
      showCompletion();
      return;
    }

    state.currentQuestionId = nextQuestion.id;
    saveState();
    renderQuestion();
  }

  function goBack() {
    const questions = getVisibleQuestions();
    const { question, index } = getCurrentQuestion(questions);
    if (index <= 0) return;
    track("survey_back", { question_id: question.id, question_number: index + 1 });
    state.currentQuestionId = questions[index - 1].id;
    saveState();
    renderQuestion();
  }

  function configurePilotLink() {
    const message = "Hola, vi la encuesta de CAUCE · Aluminé y me interesa conocer más sobre la prueba inicial.";
    const encodedMessage = encodeURIComponent(message);
    const number = CONFIG.whatsappNumber.replace(/\D/g, "");
    elements.pilot.href = number
      ? `https://wa.me/${number}?text=${encodedMessage}`
      : `https://wa.me/?text=${encodedMessage}`;
  }

  function showCompletion() {
    elements.hero.hidden = true;
    elements.survey.hidden = true;
    elements.final.hidden = false;
    elements.pilot.hidden = !PILOT_INTEREST.has(state.answers.pilot_interest);
    configurePilotLink();
    elements.shareStatus.textContent = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
    requestAnimationFrame(() => document.getElementById("completion-title")?.focus({ preventScroll: true }));
  }

  async function copySurveyLink() {
    const url = window.location.href.split("#")[0];
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      let temporaryInput;
      try {
        temporaryInput = document.createElement("textarea");
        temporaryInput.value = url;
        temporaryInput.setAttribute("readonly", "");
        temporaryInput.style.position = "fixed";
        temporaryInput.style.opacity = "0";
        document.body.append(temporaryInput);
        temporaryInput.select();
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        temporaryInput?.remove();
      }
    }
    if (copied) {
      elements.shareStatus.textContent = "Enlace copiado.";
    } else {
      elements.shareStatus.textContent = "No pudimos copiarlo. Podés copiar la dirección desde el navegador.";
    }
  }

  async function shareSurvey() {
    track("survey_share");
    const shareData = {
      title: "CAUCE · Aluminé | Encuesta para emprendedores",
      text: "Estamos construyendo algo para Aluminé y queremos escuchar a quienes trabajan acá.",
      url: window.location.href.split("#")[0]
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        elements.shareStatus.textContent = "Gracias por compartir.";
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }
    await copySurveyLink();
  }

  function handleChoiceChange(event) {
    const input = event.target.closest(".choice-control");
    if (!input) return;
    const question = QUESTIONS.find((item) => item.id === input.dataset.question);
    if (question) setQuestionAnswer(question, input);
  }

  function handlePilotClick() {
    track("pilot_whatsapp_click");
  }

  elements.start.addEventListener("click", startSurvey);
  elements.form.addEventListener("submit", advanceSurvey);
  elements.form.addEventListener("change", handleChoiceChange);
  elements.back.addEventListener("click", goBack);
  elements.share.addEventListener("click", shareSurvey);
  elements.pilot.addEventListener("click", handlePilotClick);

  track("survey_view");
  if (state.surveyCompleted) showCompletion();
  else if (state.surveyStarted) showSurvey();
  else showHero();
})();

