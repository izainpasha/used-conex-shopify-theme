/**
 * Used Conex — quote basket, cart drawer, and submission.
 *
 * "Add to Cart" adds a container to a basket kept in the visitor's browser and
 * opens a slide-in drawer (matching the reference design) — nothing is added
 * to an actual Shopify cart. The quote page then collects four details and
 * sends the whole thing to the Used Conex CRM: a customer record, then an
 * order flagged isQuote so the sales team sees a quote request rather than an
 * unpaid order. On success the visitor is handed off to the CRM's own hosted
 * order/payment page — card details never touch this site.
 *
 * Nothing is stored on Shopify: the basket lives in localStorage and every
 * request goes straight from the browser to api.usedconex.com, the same way
 * the WordPress site works today.
 */
(function (w) {
  'use strict';

  var KEY = 'uc_quote_items';
  var cfg = {
    api: 'https://api.usedconex.com/client/v1',
    quoteUrl: '/pages/request-a-quote',
    payBase: 'https://buy.usedconex.com/order/'
  };

  /* ---------------- basket ---------------- */

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  function write(items, justAdded) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
    paintCount();
    renderDrawer();
    w.dispatchEvent(new CustomEvent('uc:quote-basket', { detail: { items: items, justAdded: justAdded || null } }));
  }
  function items() { return read(); }
  function count() {
    return read().reduce(function (n, it) { return n + (it.qty || 1); }, 0);
  }
  function add(item) {
    if (!item || !item.containerId) return;
    var list = read();
    var found = null;
    for (var i = 0; i < list.length; i++) if (list[i].containerId === item.containerId) found = list[i];
    if (found) found.qty = (found.qty || 1) + (item.qty || 1);
    else list.push({ containerId: item.containerId, title: item.title || '', handle: item.handle || '',
                     size: item.size || '', grade: item.grade || '', condition: item.condition || '',
                     image: item.image || '', qty: item.qty || 1 });
    write(list, item);
  }
  function setQty(containerId, qty) {
    var list = read().map(function (it) {
      if (it.containerId === containerId) it.qty = Math.max(1, qty);
      return it;
    });
    write(list);
  }
  function remove(containerId) {
    write(read().filter(function (it) { return it.containerId !== containerId; }));
  }
  function clear() { write([]); }

  /* ---------------- CRM ---------------- */

  var tokenPromise = null;
  function token() {
    if (!tokenPromise) {
      tokenPromise = fetch(cfg.api + '/User/login/website', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          var t = j && j.data && (j.data.Token || j.data.token);
          if (!t) throw new Error('Could not connect to the quote system.');
          return t;
        })
        .catch(function (e) { tokenPromise = null; throw e; });
    }
    return tokenPromise;
  }

  function headers(t) {
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t };
  }

  /* The ZIP gives us city, state and the state's tax rate, so the visitor
     never types them and the order summary can show real tax (or hide it). */
  function addressFor(zip, t) {
    return fetch(cfg.api + '/Address/findByZipCode/' + encodeURIComponent(zip), { headers: headers(t) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var a = j && j.data;
        if (!a) throw new Error('We could not find that ZIP code.');
        var tax = (a.stateId && a.stateId.taxId && a.stateId.taxId.isActive) ? Number(a.stateId.taxId.amount) || 0 : 0;
        return { city: a.city || '', stateId: a.stateId && a.stateId._id, zipcode: String(a.zipcode || zip), taxPct: tax };
      });
  }

  /* US states as the CRM knows them (the customer record needs the CRM's
     own state id). Fetched once per page. */
  var statesPromise = null;
  function states() {
    if (!statesPromise) {
      statesPromise = token()
        .then(function (t) { return fetch(cfg.api + '/State', { headers: headers(t) }); })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var list = (j && j.data) || [];
          return list.map(function (s) { return { id: s.id || s._id, name: s.name || '', code: s.shortName || '' }; })
            .filter(function (s) { return s.id && s.name; })
            .sort(function (a, b) { return a.name.localeCompare(b.name); });
        })
        .catch(function (e) { statesPromise = null; throw e; });
    }
    return statesPromise;
  }

  /**
   * Sends the quote. Resolves with { reference, id, payUrl }.
   * details: { firstName, lastName, email, phone, address, city, stateId, zip, isDelivery }
   * city/stateId are what the customer entered; the ZIP lookup fills any gap.
   */
  function submit(details) {
    var list = read();
    if (!list.length) return Promise.reject(new Error('Your quote list is empty.'));
    var t, addr;

    return token()
      .then(function (tok) { t = tok; return addressFor(details.zip, t); })
      .then(function (a) {
        addr = a;
        return fetch(cfg.api + '/Customer/register', {
          method: 'POST',
          headers: headers(t),
          body: JSON.stringify({
            fullName: (details.firstName + ' ' + details.lastName).trim(),
            email: details.email,
            phoneNumber: details.phone,
            addressDetail: details.address,
            city: details.city || addr.city,
            state: details.stateId || addr.stateId,
            zipcode: addr.zipcode
          })
        }).then(function (r) {
          if (!r.ok) throw new Error('We could not save your details. Please check them and try again.');
          return r.json();
        });
      })
      .then(function (j) {
        var customerId = j && j.data && (j.data.id || j.data._id);
        if (!customerId) throw new Error('We could not save your details. Please try again.');
        var priced = (w.UCPricing && UCPricing.last) || {};
        var byId = priced.byId || {};
        return fetch(cfg.api + '/Order/orderItem', {
          method: 'POST',
          headers: headers(t),
          body: JSON.stringify({
            containers: list.map(function (it) {
              var info = byId[it.containerId] || {};
              return {
                label: it.title,
                value: it.containerId,
                size: it.size,
                containerId: it.containerId,
                quantity: it.qty || 1,
                totalTransport: info.delivery || 0,
                isDelivery: !!details.isDelivery
              };
            }),
            customerId: customerId,
            addressDetail: details.address,
            zipcode: addr.zipcode,
            depotId: priced.depotId || '',
            isPair: false,
            isDelivery: !!details.isDelivery,
            isQuote: true
          })
        }).then(function (r) {
          return r.json().then(function (body) {
            if (!r.ok || !body || !body.data || body.data.hasError) {
              throw new Error((body && body.message) || 'We could not send your quote request. Please try again.');
            }
            var id = body.data._id;
            return { reference: body.data.orderNum || id, id: id, payUrl: id ? cfg.payBase + id : '' };
          });
        });
      });
  }

  /* ---------------- pricing helpers shared by drawer + order summary ---------------- */

  /* All-in per-unit price: container + delivery folded together (delivery
     mode only), matching the reference design's single "delivered" figure. */
  function unitPrice(info) {
    // The API returns a placeholder price even for out-of-stock containers
    // (the same reason the card grid hides it — see uc-pricing.js apply()).
    // Treat it the same way here: no honest price, so no phantom line total.
    if (!info || !info.price || info.outOfStock) return null;
    var isDelivery = w.UCPricing ? UCPricing.getMode() : true;
    return info.price + (isDelivery && info.delivery ? info.delivery : 0);
  }

  function pricedItems() {
    var priced = (w.UCPricing && UCPricing.last) || {};
    var byId = priced.byId || {};
    return read().map(function (it) {
      var info = byId[it.containerId];
      var price = unitPrice(info);
      return {
        item: it,
        info: info || null,
        outOfStock: !!(info && info.outOfStock),
        unit: price,
        line: price ? price * (it.qty || 1) : null
      };
    });
  }

  function totals() {
    var rows = pricedItems();
    var subtotal = 0, known = 0;
    rows.forEach(function (r) { if (r.line) { subtotal += r.line; known++; } });
    var taxPct = ((w.UCPricing && UCPricing.last) || {}).taxPct || 0;
    var tax = taxPct ? Math.round(subtotal * (taxPct / 100) * 100) / 100 : 0;
    return { rows: rows, subtotal: subtotal, tax: tax, total: subtotal + tax, allPriced: known === rows.length && rows.length > 0 };
  }

  /* ---------------- header count ---------------- */

  function paintCount() {
    var n = count();
    document.querySelectorAll('[data-uc-quote-count]').forEach(function (el) {
      el.textContent = n;
      el.hidden = n === 0;
    });
  }

  /* ---------------- cart drawer ---------------- */

  var drawerEls = null;

  function money(n) { return w.UCPricing ? UCPricing.money(n) : ('$' + n); }

  function buildDrawer() {
    if (drawerEls) return drawerEls;
    var overlay = document.createElement('div');
    overlay.className = 'uc-cartdrawer-overlay';
    overlay.hidden = true;
    overlay.setAttribute('data-uc-drawer-overlay', '');

    var aside = document.createElement('aside');
    aside.className = 'uc-cartdrawer';
    aside.setAttribute('aria-hidden', 'true');
    aside.setAttribute('data-uc-drawer', '');
    aside.innerHTML =
      '<div class="uc-cartdrawer__head">' +
        '<h2>Cart (<span data-uc-drawer-count>0</span>)</h2>' +
        '<button type="button" class="uc-cartdrawer__close" data-uc-drawer-close aria-label="Close cart">&times;</button>' +
      '</div>' +
      '<div class="uc-cartdrawer__banner" data-uc-drawer-banner hidden></div>' +
      '<div class="uc-cartdrawer__scroll">' +
        '<ul class="uc-cartdrawer__list" data-uc-drawer-list></ul>' +
        '<p class="uc-cartdrawer__empty" data-uc-drawer-empty hidden></p>' +
      '</div>' +
      '<div class="uc-cartdrawer__summary" data-uc-drawer-summary>' +
        '<div class="uc-cartdrawer__row"><span data-uc-drawer-sublabel>Subtotal</span><strong data-uc-drawer-subtotal></strong></div>' +
        '<div class="uc-cartdrawer__row"><span>Delivery</span><strong data-uc-drawer-deliverynote>Included</strong></div>' +
        '<div class="uc-cartdrawer__row" data-uc-drawer-taxrow hidden><span>Tax</span><strong data-uc-drawer-tax></strong></div>' +
        '<div class="uc-cartdrawer__row uc-cartdrawer__row--total"><span>Total (USD)</span><strong data-uc-drawer-total></strong></div>' +
        '<p class="uc-cartdrawer__note" data-uc-drawer-note hidden></p>' +
        '<a class="uc-cartdrawer__go" href="' + cfg.quoteUrl + '" data-uc-drawer-go>Go To Cart</a>' +
        '<button type="button" class="uc-cartdrawer__continue" data-uc-drawer-continue>Continue Shopping</button>' +
        '<p class="uc-cartdrawer__fee"><span aria-hidden="true">&#128666;</span> No hidden fees — the price you see is the price you pay.</p>' +
      '</div>';

    document.body.appendChild(overlay);
    document.body.appendChild(aside);

    drawerEls = {
      overlay: overlay, aside: aside,
      count: aside.querySelector('[data-uc-drawer-count]'),
      banner: aside.querySelector('[data-uc-drawer-banner]'),
      list: aside.querySelector('[data-uc-drawer-list]'),
      empty: aside.querySelector('[data-uc-drawer-empty]'),
      summary: aside.querySelector('[data-uc-drawer-summary]'),
      sublabel: aside.querySelector('[data-uc-drawer-sublabel]'),
      subtotal: aside.querySelector('[data-uc-drawer-subtotal]'),
      taxRow: aside.querySelector('[data-uc-drawer-taxrow]'),
      tax: aside.querySelector('[data-uc-drawer-tax]'),
      total: aside.querySelector('[data-uc-drawer-total]'),
      note: aside.querySelector('[data-uc-drawer-note]')
    };

    overlay.addEventListener('click', closeDrawer);
    aside.querySelector('[data-uc-drawer-close]').addEventListener('click', closeDrawer);
    aside.querySelector('[data-uc-drawer-continue]').addEventListener('click', closeDrawer);
    aside.addEventListener('click', function (e) {
      var li = e.target.closest('[data-container-id]');
      if (!li) return;
      var id = li.getAttribute('data-container-id');
      var step = e.target.closest('[data-uc-qty]');
      if (step) {
        var cur = 1;
        items().forEach(function (it) { if (it.containerId === id) cur = it.qty || 1; });
        setQty(id, cur + parseInt(step.getAttribute('data-uc-qty'), 10));
        return;
      }
      if (e.target.closest('[data-uc-remove]')) remove(id);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && aside.classList.contains('is-open')) closeDrawer();
    });
    w.addEventListener('uc:pricing', renderDrawer);

    return drawerEls;
  }

  function itemRow(row) {
    var it = row.item;
    var priceHtml = row.unit
      ? '<span class="uc-cartdrawer__price">' + money(row.line) + '</span><span class="uc-cartdrawer__delivered">delivered</span>'
      : (row.outOfStock ? '<span class="uc-cartdrawer__oos">Currently unavailable at your nearest depot</span>' : '');
    var img = it.image
      ? '<img src="' + it.image + '" alt="" loading="lazy">'
      : '<span class="uc-cartdrawer__imgfallback" aria-hidden="true">&#128230;</span>';
    return '<li class="uc-cartdrawer__item" data-container-id="' + it.containerId + '">' +
      '<div class="uc-cartdrawer__thumb">' + img + '</div>' +
      '<div class="uc-cartdrawer__info">' +
        '<p class="uc-cartdrawer__title">' + esc(it.title || 'Container') + '</p>' +
        (it.size ? '<p class="uc-cartdrawer__size">' + esc(it.size) + '</p>' : '') +
        priceHtml +
        '<div class="uc-cartdrawer__qty">' +
          '<button type="button" data-uc-qty="-1" aria-label="Decrease quantity">&minus;</button>' +
          '<span>' + (it.qty || 1) + '</span>' +
          '<button type="button" data-uc-qty="1" aria-label="Increase quantity">+</button>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="uc-cartdrawer__remove" data-uc-remove aria-label="Remove ' + esc(it.title || 'item') + '">&#128465;</button>' +
    '</li>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderDrawer(evt) {
    if (!drawerEls) return;
    var d = drawerEls;
    var t = totals();
    var n = count();

    d.count.textContent = n;
    d.empty.hidden = t.rows.length > 0;
    d.summary.hidden = t.rows.length === 0;
    if (!t.rows.length) {
      d.empty.textContent = 'Your cart is empty.';
      d.list.innerHTML = '';
    } else {
      d.list.innerHTML = t.rows.map(itemRow).join('');
    }

    d.sublabel.textContent = 'Subtotal (' + n + ' item' + (n === 1 ? '' : 's') + ')';
    d.subtotal.textContent = t.allPriced ? money(t.subtotal) : '—';
    d.taxRow.hidden = !t.tax;
    if (t.tax) d.tax.textContent = money(t.tax);
    d.total.textContent = t.allPriced ? money(t.total) : '—';

    var zip = w.UCPricing ? UCPricing.getZip() : '';
    if (zip && t.rows.length) {
      d.note.hidden = false;
      d.note.textContent = 'Pricing shown includes delivery to ' + zip + '.';
    } else {
      d.note.hidden = true;
    }

    if (evt && evt.detail && evt.detail.justAdded) {
      d.banner.hidden = false;
      d.banner.innerHTML = '<span class="uc-cartdrawer__check" aria-hidden="true">&#10003;</span> ' +
        '<span>Added to your cart<br><small>You’re one step closer to your container.</small></span>';
    }
  }

  function openDrawer(justAdded) {
    var d = buildDrawer();
    renderDrawer(justAdded ? { detail: { justAdded: justAdded } } : null);
    if (!justAdded) d.banner.hidden = true;
    d.overlay.hidden = false;
    d.aside.hidden = false;
    /* Fade the page behind the drawer, per the reference design. */
    document.documentElement.classList.add('uc-drawer-open', 'uc-cart-open');
    requestAnimationFrame(function () {
      d.overlay.classList.add('is-open');
      d.aside.classList.add('is-open');
    });
    d.aside.setAttribute('aria-hidden', 'false');
  }

  function closeDrawer() {
    if (!drawerEls) return;
    var d = drawerEls;
    d.overlay.classList.remove('is-open');
    d.aside.classList.remove('is-open');
    d.aside.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('uc-drawer-open', 'uc-cart-open');
    setTimeout(function () { d.overlay.hidden = true; d.banner.hidden = true; }, 300);
  }

  /* ---------------- "Add to Cart" buttons + header icon ---------------- */

  function bindButtons() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-uc-quote-cta]');
      if (btn) {
        e.preventDefault();
        var added = {
          containerId: btn.getAttribute('data-container-id'),
          title: btn.getAttribute('data-product-title'),
          handle: btn.getAttribute('data-product-handle'),
          size: btn.getAttribute('data-size'),
          grade: btn.getAttribute('data-grade'),
          condition: btn.getAttribute('data-condition'),
          image: btn.getAttribute('data-image')
        };
        add(added);
        openDrawer(added);
        return;
      }
      var cartLink = e.target.closest('.uc-header__cart');
      if (cartLink) {
        e.preventDefault();
        openDrawer();
      }
    });
  }

  function boot() {
    paintCount();
    bindButtons();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  w.UCQuote = {
    configure: function (o) { if (o && o.api) cfg.api = o.api; if (o && o.quoteUrl) cfg.quoteUrl = o.quoteUrl; },
    items: items, count: count, add: add, setQty: setQty, remove: remove, clear: clear, submit: submit, states: states,
    totals: totals, openDrawer: openDrawer, closeDrawer: closeDrawer
  };
})(window);
