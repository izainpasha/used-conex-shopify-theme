/**
 * Used Conex — shared live depot pricing.
 *
 * One place that knows how to talk to the pricing API, used by the shop page,
 * collection pages and product pages. Sections never fetch directly; they call
 * UCPricing.lookup() or listen for the 'uc:pricing' event.
 *
 * NOTE ON CREDENTIALS: the API issues a token in exchange for an email, so that
 * email is visible in page source — the same trade-off the WordPress site makes
 * today. This was a deliberate decision, not an oversight. To close it, stand up
 * a server-side proxy and point `api` at it; nothing else here changes. Note a
 * Cloudflare Worker will not work: the API sits behind Cloudflare and rejects
 * Cloudflare-to-Cloudflare traffic with a 403, so host any proxy elsewhere.
 */
(function (w) {
  'use strict';

  var cfg = {
    api: 'https://api.usedconex.com/client/v1',
    email: 'mg@usedconex.com',
    live: true
  };

  var ZIP_KEY = 'uc_zipcode';
  var MODE_KEY = 'uc_isDelivery';
  var US_ZIP = /^\d{5}(-\d{4})?$/;

  var cache = {};
  var tokenPromise = null;
  var lastResult = null;

  function configure(opts) {
    if (!opts) return;
    if (opts.api) cfg.api = opts.api;
    if (opts.email) cfg.email = opts.email;
    if (typeof opts.live === 'boolean') cfg.live = opts.live;
  }

  function isValidZip(zip) {
    return US_ZIP.test(String(zip || '').trim());
  }

  function getZip() {
    try { return localStorage.getItem(ZIP_KEY) || ''; } catch (e) { return ''; }
  }

  function setZip(zip) {
    try { localStorage.setItem(ZIP_KEY, zip); } catch (e) {}
  }

  function getMode() {
    try {
      var v = localStorage.getItem(MODE_KEY);
      return v === null ? true : v !== 'false';
    } catch (e) { return true; }
  }

  function setMode(isDelivery) {
    try { localStorage.setItem(MODE_KEY, String(!!isDelivery)); } catch (e) {}
  }

  function money(n) {
    if (n === null || n === undefined || isNaN(n)) return '';
    return '$' + Number(n).toLocaleString('en-US');
  }

  function getToken() {
    if (!tokenPromise) {
      tokenPromise = fetch(cfg.api + '/User/login/website', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cfg.email })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          var t = j && j.data && (j.data.Token || j.data.token);
          if (!t) throw new Error('no token');
          return t;
        })
        .catch(function (e) { tokenPromise = null; throw e; });
    }
    return tokenPromise;
  }

  /**
   * Resolves { real, place, depot, timeframe, byId }.
   * real === false  → the API does not recognise this ZIP.
   * real === null   → the API was unreachable; callers should degrade to
   *                   showing the catalogue without prices rather than block.
   */
  function lookup(zip, isDelivery) {
    zip = String(zip || '').trim();
    isDelivery = !!isDelivery;
    var key = zip + '|' + isDelivery;
    if (cache[key]) return Promise.resolve(cache[key]);

    var result = { real: null, place: '', depot: '', depotId: '', timeframe: '', distance: null,
                   city: '', stateId: '', stateName: '', taxPct: 0, zip: zip, byId: null };
    if (!cfg.live || !cfg.api || !isValidZip(zip)) return Promise.resolve(result);

    return getToken()
      .then(function (token) {
        var auth = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
        return fetch(cfg.api + '/Address/findByZipCode/' + encodeURIComponent(zip), { headers: auth })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (addr) {
            if (!addr || !addr.data) { result.real = false; return result; }
            result.real = true;
            var a = addr.data;
            result.place = [a.city, a.stateId && a.stateId.shortName].filter(Boolean).join(', ');
            result.city = a.city || '';
            result.stateId = (a.stateId && a.stateId._id) || '';
            result.stateName = (a.stateId && a.stateId.name) || '';
            // State sales tax as a percentage; 0 when the state has none or it is inactive.
            var tx = a.stateId && a.stateId.taxId;
            result.taxPct = (tx && tx.isActive && tx.type === '%') ? (Number(tx.amount) || 0) : 0;
            result.zip = String(a.zipcode || zip);

            return fetch(cfg.api + '/Order/depotWithZipcode', {
              method: 'POST',
              headers: auth,
              body: JSON.stringify({ zipcode: zip, isDelivery: isDelivery })
            })
              .then(function (r) { return r.json().catch(function () { return null; }); })
              .then(function (dep) {
                var depots = (dep && dep.data) || [];
                if (!depots.length) return result;
                var d = depots[0];
                result.depot = d.name || '';
                result.depotId = d._id || '';
                result.timeframe = d.deliveryTimeFrame || '';
                var miles = Number(d.distanceDrive) || Number(d.distance) || 0;
                result.distance = miles ? Math.round(miles) : null;
                var byId = {};
                (d.Containers && d.Containers.sizeCategory ? d.Containers.sizeCategory : []).forEach(function (group) {
                  Object.keys(group).forEach(function (size) {
                    group[size].forEach(function (it) {
                      var id = it.containerId && it.containerId._id;
                      if (!id) return;
                      byId[id] = {
                        name: (it.containerId && it.containerId.name) || '',
                        size: size,
                        price: isDelivery ? it.price : it.pricePickup,
                        delivery: it.estimated_Delivery_Cost,
                        outOfStock: !!it.outOfStuck
                      };
                    });
                  });
                });
                result.byId = byId;
                return result;
              });
          });
      })
      .catch(function () { return result; })
      .then(function (res) {
        cache[key] = res;
        lastResult = res;
        try {
          w.dispatchEvent(new CustomEvent('uc:pricing', { detail: { zip: zip, isDelivery: isDelivery, result: res } }));
        } catch (e) {}
        return res;
      });
  }

  /**
   * Paints prices onto any element carrying data-container-id. Containers that
   * are out of stock show no price at all: the API returns a placeholder price
   * in delivery mode and none in pickup mode, so the badge is the honest signal.
   */
  function apply(root, result, opts) {
    if (!root) return;
    opts = opts || {};
    var prefix = opts.pricePrefix != null ? opts.pricePrefix : 'From';
    var delLabel = opts.deliveryLabel || '+ delivery';
    var cards = root.querySelectorAll('[data-container-id]');

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var wrap = card.querySelector('[data-uc-pricing]');
      var priceEl = card.querySelector('[data-uc-price]');
      var delEl = card.querySelector('[data-uc-delivery]');
      var oosEl = card.querySelector('[data-uc-oos]');
      if (!wrap && !priceEl && !oosEl) continue;

      var info = result && result.byId ? result.byId[card.getAttribute('data-container-id')] : null;
      card.classList.remove('is-unavailable');

      if (!info) {
        if (wrap) wrap.hidden = true;
        if (oosEl) oosEl.hidden = true;
        continue;
      }

      // Shown all-in (container + delivery folded together), matching the
      // client's reference design: one definite delivered price per card, not
      // a base price plus a separate delivery add-on.
      var isDelivery = getMode();
      var allIn = info.price + (isDelivery && info.delivery ? info.delivery : 0);
      var showPrice = !!info.price && !info.outOfStock;
      if (priceEl) priceEl.textContent = showPrice ? (prefix ? prefix + ' ' : '') + money(allIn) : '';
      if (delEl) delEl.textContent = showPrice ? (isDelivery ? delLabel : '') : '';
      if (wrap) wrap.hidden = !showPrice;
      if (oosEl) oosEl.hidden = !info.outOfStock;
      if (info.outOfStock) card.classList.add('is-unavailable');
    }
  }

  function describe(result, zip, isDelivery) {
    if (!result) return '';
    var where = result.place ? result.place + ' (' + zip + ')' : zip;
    var bits = ['Showing availability for ' + where, isDelivery ? 'Delivery' : 'Pick Up'];
    if (result.depot) bits.push('from our ' + result.depot + ' depot');
    if (result.timeframe) bits.push(result.timeframe + ' business days');
    return bits.join(' · ');
  }

  w.UCPricing = {
    configure: configure,
    isValidZip: isValidZip,
    getZip: getZip,
    setZip: setZip,
    getMode: getMode,
    setMode: setMode,
    lookup: lookup,
    apply: apply,
    describe: describe,
    money: money,
    get last() { return lastResult; }
  };
})(window);
