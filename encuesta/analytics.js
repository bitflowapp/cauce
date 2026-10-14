(() => {
  "use strict";

  const GA4_MEASUREMENT_ID = ""; // Configurá aquí tu ID, por ejemplo: G-ABC1234567
  const validId = /^G-[A-Z0-9]+$/i.test(GA4_MEASUREMENT_ID);

  if (!validId) {
    window.CauceAnalytics = { track: () => false, enabled: false };
    return;
  }

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("config", GA4_MEASUREMENT_ID, { anonymize_ip: true });

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA4_MEASUREMENT_ID)}`;
  document.head.append(script);

  window.CauceAnalytics = {
    enabled: true,
    track(eventName, parameters = {}) {
      window.gtag("event", eventName, parameters);
      return true;
    }
  };
})();
