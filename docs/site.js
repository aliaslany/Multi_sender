// Shared by the content pages. One request to /plans gives every page the live
// trial/referral/pricing numbers, so static copy never drifts from the Worker's vars.
(function () {
  const { API_BASE } = window.MULTISENDER;
  const fa = new Intl.NumberFormat('fa-IR');

  window.MULTISENDER.plans = fetch(`${API_BASE}/plans`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);

  // <span data-cfg="trial.days">۳</span>: the HTML holds the default (what a
  // crawler sees); this swaps in the live value when the Worker answers.
  window.MULTISENDER.plans.then((config) => {
    if (!config) return;
    document.querySelectorAll('[data-cfg]').forEach((el) => {
      const value = el.dataset.cfg.split('.').reduce((obj, key) => (obj == null ? obj : obj[key]), config);
      if (typeof value === 'number') el.textContent = fa.format(value);
    });
  });
})();
