/**
 * Used Conex — storefront wiring for live depot pricing.
 *
 * Sections render markup and configuration as data-* attributes only; all
 * behaviour lives here. Loaded once from <head> with defer, so nothing is
 * inlined into the page and the logic is cached across navigations.
 *
 * Handles three surfaces:
 *   [data-uc-zip-results] — the shop page (ZIP gate + grouped catalogue)
 *   [data-uc-zipbar]      — compact ZIP bar on product and collection pages
 *   [data-uc-pricing-target] — anything that just listens and paints prices
 */
(function () {
  'use strict';

  function ready(fn) {
    if (window.UCPricing) return fn();
    var tries = 0;
    var t = setInterval(function () {
      if (window.UCPricing || ++tries > 100) {
        clearInterval(t);
        if (window.UCPricing) fn();
      }
    }, 50);
  }

  function cfgFrom(el) {
    return {
      api: el.getAttribute('data-api-base') || undefined,
      email: el.getAttribute('data-api-email') || undefined,
      live: el.getAttribute('data-live') !== 'false'
    };
  }

  // Reads the ZIP off the URL, accepting the older zip/delivery spelling that
  // existing links and the WordPress site still use.
  function readZipParams() {
    var q = new URLSearchParams(window.location.search);
    var zip = (q.get('zipcode') || q.get('zip') || '').trim();
    var d = q.get('isDelivery');
    if (d === null) {
      var legacy = q.get('delivery');
      d = legacy === null ? null : (legacy === 'pickup' || legacy === 'false' ? 'false' : 'true');
    }
    return { zip: zip, isDelivery: d === null ? null : d !== 'false' };
  }

  // Carries the resolved ZIP and mode across every internal hop, so a visitor
  // who lands on a product page from a card sees prices without re-entering it.
  // Uses the stored ZIP rather than the input: that is what the prices on
  // screen actually reflect, even if someone has since typed something else.
  function decorateLinks() {
    document.addEventListener('click', function (e) {
      var link = e.target.closest('[data-uc-product-link]');
      if (!link) return;
      var href = link.getAttribute('href');
      if (!href || href === '#') { e.preventDefault(); return; }

      var zip = UCPricing.getZip();
      var url = new URL(href, window.location.origin);
      if (zip) {
        url.searchParams.set('zipcode', zip);
        url.searchParams.set('isDelivery', String(UCPricing.getMode()));
      }
      link.setAttribute('href', url.toString());
    });
  }

  function paintOpts(el) {
    return {
      pricePrefix: el.getAttribute('data-price-prefix') || 'From',
      deliveryLabel: el.getAttribute('data-delivery-label') || '+ delivery'
    };
  }

  // ---------------------------------------------------------------
  // Shop page: ZIP gate + live pricing
  // ---------------------------------------------------------------
  function initZipResults(root) {
    var form = root.querySelector('[data-uc-zip-form]');
    var input = root.querySelector('#uc-zip-input');
    var mode = root.querySelector('#uc-zip-delivery');
    var error = root.querySelector('[data-uc-zip-error]');
    var prompt = root.querySelector('[data-uc-zip-prompt]');
    var panel = root.querySelector('[data-uc-zip-panel]');
    var meta = root.querySelector('[data-uc-zip-meta]');
    var loading = root.querySelector('[data-uc-zip-loading]');
    if (!form || !input) return;

    UCPricing.configure(cfgFrom(root));
    var opts = paintOpts(root);

    function render(zip, isDelivery, result) {
      // real === false is a ZIP the API rejects. real === null means the API
      // was unreachable, so a well-formed ZIP still shows the catalogue.
      var ok = UCPricing.isValidZip(zip) && result.real !== false;
      error.hidden = ok || zip === '';
      panel.hidden = !ok;
      prompt.hidden = ok;
      if (!ok) return false;

      UCPricing.setZip(zip);
      UCPricing.setMode(isDelivery);
      UCPricing.apply(root, result, opts);
      if (meta) meta.textContent = UCPricing.describe(result, zip, isDelivery);
      return true;
    }

    function show(zip, isDelivery) {
      if (!UCPricing.isValidZip(zip)) {
        return Promise.resolve(render(zip, isDelivery, { real: false }));
      }
      form.classList.add('is-checking');
      if (loading) loading.hidden = false;
      if (prompt) prompt.hidden = true;
      return UCPricing.lookup(zip, isDelivery).then(function (res) {
        form.classList.remove('is-checking');
        if (loading) loading.hidden = true;
        return render(zip, isDelivery, res);
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var zip = input.value.trim();
      var isDelivery = mode.value === 'true';
      show(zip, isDelivery).then(function (ok) {
        if (!ok) return;
        var url = new URL(window.location.href);
        url.searchParams.set('zipcode', zip);
        url.searchParams.set('isDelivery', String(isDelivery));
        window.history.replaceState({}, '', url);
      });
    });

    input.addEventListener('input', function () {
      if (!input.value.trim()) error.hidden = true;
    });

    // Prefer the URL, then a remembered ZIP from an earlier search.
    var initial = readZipParams();
    var zip = initial.zip || UCPricing.getZip();
    var isDelivery = initial.isDelivery === null ? UCPricing.getMode() : initial.isDelivery;
    if (zip) {
      input.value = zip;
      mode.value = String(isDelivery);
      show(zip, isDelivery);
    } else {
      render('', isDelivery, { real: null });
    }
  }

  // ---------------------------------------------------------------
  // Compact ZIP bar (product + collection pages)
  // ---------------------------------------------------------------
  function initZipBar(root) {
    var form = root.querySelector('[data-uc-zipbar-form]');
    var input = root.querySelector('[data-uc-zipbar-input]');
    var mode = root.querySelector('[data-uc-zipbar-mode]');
    var status = root.querySelector('[data-uc-zipbar-status]');
    if (!form || !input) return;

    UCPricing.configure(cfgFrom(root));
    var MSG_INVALID = root.getAttribute('data-msg-invalid') || 'Please enter a valid US ZIP code.';
    var MSG_LOADING = root.getAttribute('data-msg-loading') || 'Checking availability…';

    function run(zip, isDelivery) {
      if (!UCPricing.isValidZip(zip)) {
        status.hidden = false;
        status.textContent = MSG_INVALID;
        status.classList.add('is-error');
        return;
      }
      status.classList.remove('is-error');
      status.hidden = false;
      status.textContent = MSG_LOADING;
      root.classList.add('is-loading');
      UCPricing.setZip(zip);
      UCPricing.setMode(isDelivery);

      UCPricing.lookup(zip, isDelivery).then(function (res) {
        root.classList.remove('is-loading');
        if (res.real === false) {
          status.textContent = MSG_INVALID;
          status.classList.add('is-error');
          return;
        }
        status.textContent = UCPricing.describe(res, zip, isDelivery);
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      run(input.value.trim(), mode.value === 'true');
    });

    // A link from a card carries the ZIP in the URL; otherwise fall back to
    // whatever the visitor searched earlier in the session.
    var fromUrl = readZipParams();
    var zip = fromUrl.zip || UCPricing.getZip();
    var isDelivery = fromUrl.isDelivery === null ? UCPricing.getMode() : fromUrl.isDelivery;
    if (zip) {
      input.value = zip;
      mode.value = String(isDelivery);
      run(zip, isDelivery);
    }
  }

  // ---------------------------------------------------------------
  // Passive targets: paint prices whenever a lookup completes
  // ---------------------------------------------------------------
  function initTarget(root) {
    var opts = paintOpts(root);
    function paint(result) {
      UCPricing.apply(root, result, opts);
      var depotEl = root.querySelector('[data-uc-depot]');
      if (depotEl) {
        var txt = result && result.depot
          ? 'Delivered from our ' + result.depot + ' depot' +
            (result.timeframe ? ' · ' + result.timeframe + ' business days' : '')
          : '';
        depotEl.textContent = txt;
        depotEl.hidden = !txt;
      }
    }
    window.addEventListener('uc:pricing', function (e) {
      paint((e.detail || {}).result);
    });
    // A lookup may already have resolved before this ran.
    if (UCPricing.last) paint(UCPricing.last);
  }

  // Tidy up imported WordPress article markup.
  function tidyArticle() {
    var content = document.querySelector('.uc-article__content');
    if (!content) return;

    // Tables are wider than the reading column. Wrapping each one lets it
    // scroll on its own instead of dragging the whole page sideways.
    var tables = content.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      if (t.parentElement && t.parentElement.classList.contains('uc-article__table-wrap')) continue;
      var wrap = document.createElement('div');
      wrap.className = 'uc-article__table-wrap';
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    }

    // The import left two kinds of text-less block behind. Ones holding only
    // an image are real content, but a heading wrapping an image still draws
    // the heading's yellow rule under it — so those get stripped of heading
    // treatment instead. Genuinely empty ones are hidden outright.
    var blocks = content.querySelectorAll('h1, h2, h3, h4, h5, h6, p');
    for (var j = 0; j < blocks.length; j++) {
      var el = blocks[j];
      if (el.textContent.trim()) continue;
      if (el.querySelector('img, iframe, video')) {
        if (el.tagName !== 'P') el.classList.add('uc-article__media-heading');
      } else {
        el.hidden = true;
      }
    }

    // Some posts repeat their own title as the first heading, which now shows
    // twice: once in the hero, once again immediately below it.
    var titleEl = document.querySelector('.uc-article__title');
    if (!titleEl) return;
    var norm = function (v) { return v.replace(/s+/g, ' ').trim().toLowerCase(); };
    var first = content.querySelector('h1, h2, h3');
    if (first && !first.hidden && norm(first.textContent) === norm(titleEl.textContent)) {
      first.hidden = true;
    }
  }

  // Click-to-play video posters (review cards, the testimonial row and the
  // media row). One delegated handler for all, so no section needs an inline script.
  function initVideoPosters() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.uc-reviews__video, .uc-reviews-playlist__item, .uc-media__video');
      if (!btn) return;
      var id = btn.getAttribute('data-yt');
      if (!id) return;
      var frame = document.createElement('iframe');
      if (btn.classList.contains('uc-reviews__video')) frame.className = 'uc-reviews__iframe';
      else if (btn.classList.contains('uc-reviews-playlist__item')) frame.className = 'uc-reviews-playlist__iframe';
      frame.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1&rel=0&playsinline=1';
      frame.title = btn.getAttribute('aria-label') || 'Customer review video';
      frame.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture';
      frame.allowFullscreen = true;
      frame.setAttribute('loading', 'lazy');
      btn.replaceWith(frame);
    });
  }

  // Testimonial row: arrows plus gentle auto-rotation.
  // Rotation stops for good once someone plays a video, and pauses while
  // the pointer is over the row, the tab is hidden, or motion is reduced.
  function initPlaylistSliders() {
    document.querySelectorAll('[data-uc-playlist-track]').forEach(function (track) {
      if (track.dataset.ucPlaylistBound) return;
      track.dataset.ucPlaylistBound = '1';
      var root = track.closest('.uc-reviews-playlist__viewport');
      var prev = root && root.querySelector('[data-uc-playlist-prev]');
      var next = root && root.querySelector('[data-uc-playlist-next]');

      function maxScroll() { return track.scrollWidth - track.clientWidth - 2; }
      function step(dir) {
        var target = track.scrollLeft + dir * track.clientWidth;
        if (dir > 0 && track.scrollLeft >= maxScroll()) target = 0;
        if (dir < 0 && track.scrollLeft <= 2) target = maxScroll();
        track.scrollTo({ left: target, behavior: 'smooth' });
      }
      if (prev) prev.addEventListener('click', function () { stop(); step(-1); });
      if (next) next.addEventListener('click', function () { stop(); step(1); });

      var timer = null;
      var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var wanted = track.getAttribute('data-uc-playlist-autoplay') !== 'false' && !reduced;
      var seconds = parseInt(track.getAttribute('data-uc-playlist-interval'), 10) || 6;
      function tick() { if (!document.hidden) step(1); }
      function play() { if (wanted && !timer) timer = setInterval(tick, seconds * 1000); }
      function pause() { if (timer) { clearInterval(timer); timer = null; } }
      function stop() { wanted = false; pause(); }

      track.addEventListener('mouseenter', pause);
      track.addEventListener('mouseleave', play);
      track.addEventListener('focusin', pause);
      track.addEventListener('touchstart', stop, { passive: true });
      document.addEventListener('visibilitychange', function () { document.hidden ? pause() : play(); });
      // A playing video must never be scrolled away mid-sentence.
      track.addEventListener('click', function (e) { if (e.target.closest('.uc-reviews-playlist__item')) stop(); });
      play();
    });
  }

  // Checkout page: contact + delivery form on the left, order summary on the
  // right. The ZIP field reprices the order; city/state are prefilled from it.
  function initQuotePage(root) {
    var listEl = root.querySelector('[data-uc-quote-list]');
    var emptyEl = root.querySelector('[data-uc-quote-empty]');
    var form = root.querySelector('[data-uc-quote-form]');
    var status = root.querySelector('[data-uc-quote-status]');
    var main = root.querySelector('[data-uc-quote-main]');
    var done = root.querySelector('[data-uc-quote-done]');
    var refEl = root.querySelector('[data-uc-quote-ref]');
    var payLink = root.querySelector('[data-uc-quote-paylink]');
    var countEl = root.querySelector('[data-uc-quote-itemcount]');
    var subtotalEl = root.querySelector('[data-uc-quote-subtotal]');
    var taxRowEl = root.querySelector('[data-uc-quote-taxrow]');
    var taxEl = root.querySelector('[data-uc-quote-tax]');
    var totalEl = root.querySelector('[data-uc-quote-total]');
    var zipNoteEl = root.querySelector('[data-uc-quote-zipnote]');
    var zipInput = root.querySelector('[data-uc-quote-zip]');
    var stateSel = root.querySelector('[data-uc-quote-state]');
    var saveBtn = root.querySelector('[data-uc-quote-save]');
    if (!listEl || !form) return;

    UCQuote.configure({ api: root.getAttribute('data-api-base') });
    var zipNoteEmpty = zipNoteEl ? zipNoteEl.textContent : '';
    var itemNote = root.getAttribute('data-item-note') || '';
    var msg = {
      zip: root.getAttribute('data-msg-invalid-zip'),
      required: root.getAttribute('data-msg-required'),
      email: root.getAttribute('data-msg-email'),
      sending: root.getAttribute('data-msg-sending'),
      redirecting: root.getAttribute('data-msg-redirecting'),
      empty: root.getAttribute('data-msg-empty')
    };
    var GRADES = { 'CW': 'Cargo worthy • Wind & watertight', 'WWT': 'Wind & watertight', 'IICL': 'IICL certified', 'AS IS': 'Sold as is' };

    function describeItem(it) {
      var parts = [];
      var cond = (it.condition || '').toLowerCase();
      if (cond) parts.push(cond === 'new' ? 'Brand new container' : 'Quality ' + cond + ' container');
      var g = (it.grade || '').toUpperCase();
      if (g) parts.push(GRADES[g] || it.grade);
      return parts.join(' • ');
    }

    function row(item) {
      var li = document.createElement('li');
      li.className = 'uc-checkout__item';
      li.setAttribute('data-container-id', item.containerId);
      var thumb = document.createElement('div');
      thumb.className = 'uc-checkout__thumb';
      if (item.image) {
        var img = document.createElement('img');
        img.src = item.image; img.alt = ''; img.loading = 'lazy';
        thumb.appendChild(img);
      }
      li.appendChild(thumb);
      var body = document.createElement('div');
      body.className = 'uc-checkout__itembody';
      var t = document.createElement('p');
      t.className = 'uc-checkout__itemtitle';
      t.textContent = (item.title || item.containerId) + ' × ' + (item.qty || 1);
      body.appendChild(t);
      var d = describeItem(item);
      if (d || itemNote) {
        var p = document.createElement('p');
        p.className = 'uc-checkout__itemdesc';
        p.textContent = d;
        if (d && itemNote) p.appendChild(document.createElement('br'));
        if (itemNote) p.appendChild(document.createTextNode(itemNote));
        body.appendChild(p);
      }
      var info = (UCPricing.last && UCPricing.last.byId || {})[item.containerId];
      if (info && info.outOfStock) {
        var oos = document.createElement('p');
        oos.className = 'uc-checkout__itemoos';
        oos.textContent = 'Currently unavailable at your nearest depot';
        body.appendChild(oos);
      }
      li.appendChild(body);
      return li;
    }

    function render() {
      var items = UCQuote.items();
      var n = items.reduce(function (s, it) { return s + (it.qty || 1); }, 0);
      countEl.textContent = n + ' Item' + (n === 1 ? '' : 's');
      emptyEl.hidden = items.length > 0;
      listEl.innerHTML = '';
      items.forEach(function (it) { listEl.appendChild(row(it)); });
      var t = UCQuote.totals();
      subtotalEl.textContent = t.allPriced ? UCPricing.money(t.subtotal) : '—';
      taxRowEl.hidden = !t.tax;
      taxEl.textContent = t.tax ? UCPricing.money(t.tax) : '';
      totalEl.textContent = t.allPriced ? UCPricing.money(t.total) : '—';
      var zip = UCPricing.getZip();
      if (zipNoteEl) {
        zipNoteEl.textContent = zip && UCPricing.last && UCPricing.last.real !== false
          ? (UCPricing.getMode() ? 'Price includes delivery to ZIP code ' + zip : 'Price is for pickup from the ' + (UCPricing.last.depot || 'nearest') + ' depot')
          : zipNoteEmpty;
      }
    }

    // City/state follow the ZIP unless the visitor has typed their own.
    var cityTouched = false, stateTouched = false;
    form.city.addEventListener('input', function () { cityTouched = true; });
    stateSel.addEventListener('change', function () { stateTouched = true; });

    function prefill(res) {
      if (!res || res.real === false) return;
      if (res.city && (!cityTouched || !form.city.value.trim())) form.city.value = res.city;
      if (res.stateId && (!stateTouched || !stateSel.value)) stateSel.value = res.stateId;
    }

    function look(zip) {
      return UCPricing.lookup(zip, UCPricing.getMode()).then(function (res) {
        prefill(res);
        render();
        return res;
      });
    }

    var lastZip = '';
    function zipChanged() {
      var zip = zipInput.value.trim();
      if (zip === lastZip || !UCPricing.isValidZip(zip)) return;
      lastZip = zip;
      UCPricing.setZip(zip);
      look(zip);
    }
    zipInput.addEventListener('change', zipChanged);
    zipInput.addEventListener('input', function () { if (/^\d{5}$/.test(zipInput.value.trim())) zipChanged(); });

    UCQuote.states().then(function (list) {
      list.forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.id; o.textContent = s.name;
        stateSel.appendChild(o);
      });
      prefill(UCPricing.last);
    }).catch(function () {});

    window.addEventListener('uc:quote-basket', render);
    window.addEventListener('uc:pricing', function () { setTimeout(render, 0); });

    function fail(text) {
      status.hidden = false;
      status.classList.add('is-error');
      status.textContent = text;
    }

    function send(pay) {
      status.classList.remove('is-error');
      var data = {
        firstName: form.firstName.value.trim(),
        lastName: form.lastName.value.trim(),
        email: form.email.value.trim(),
        phone: form.phone.value.trim(),
        address: form.address.value.trim(),
        city: form.city.value.trim(),
        stateId: stateSel.value,
        zip: zipInput.value.trim(),
        isDelivery: UCPricing.getMode()
      };
      if (!data.firstName || !data.lastName || !data.email || !data.phone || !data.address || !data.city || !data.stateId || !data.zip) return fail(msg.required);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) return fail(msg.email);
      if (!UCPricing.isValidZip(data.zip)) return fail(msg.zip);
      if (!UCQuote.items().length) return fail(msg.empty);

      var btns = [form.querySelector('[data-uc-quote-submit]'), saveBtn];
      btns.forEach(function (b) { if (b) b.disabled = true; });
      status.hidden = false;
      status.textContent = msg.sending;
      UCPricing.setZip(data.zip);
      var ready = (UCPricing.last && UCPricing.last.zip === data.zip) ? Promise.resolve() : look(data.zip);
      ready.then(function () { return UCQuote.submit(data); }).then(function (res) {
        UCQuote.clear();
        if (pay && res.payUrl) {
          status.textContent = msg.redirecting;
          window.location.href = res.payUrl;
          return;
        }
        main.hidden = true;
        done.hidden = false;
        refEl.textContent = res.reference || '';
        if (payLink && res.payUrl) { payLink.href = res.payUrl; payLink.hidden = false; }
        root.scrollIntoView({ block: 'start' });
      }).catch(function (err) {
        btns.forEach(function (b) { if (b) b.disabled = false; });
        fail((err && err.message) || 'Something went wrong. Please try again.');
      });
    }

    form.addEventListener('submit', function (e) { e.preventDefault(); send(true); });
    if (saveBtn) saveBtn.addEventListener('click', function () { send(false); });

    var zip = UCPricing.getZip();
    if (zip) {
      zipInput.value = zip;
      lastZip = zip;
      look(zip);
    }
    render();
  }

  // ---------------------------------------------------------------
  // Shop page filter sidebar (size / condition / grade / price)
  // ---------------------------------------------------------------
  function initShopFilters(root) {
    if (root.dataset.ucFiltersBound) return;
    root.dataset.ucFiltersBound = '1';

    var cards = Array.prototype.slice.call(root.querySelectorAll('[data-uc-filter-grid] [data-uc-card]'));
    var groups = Array.prototype.slice.call(root.querySelectorAll('[data-uc-filter-group]'));
    var countEl = root.parentElement.querySelector('[data-uc-filter-count]');
    var emptyEl = root.querySelector('[data-uc-filter-empty]');
    var gridEl = root.querySelector('[data-uc-filter-grid]');
    var clearBtn = root.querySelector('[data-uc-filter-clear]');
    var selected = { size: {}, condition: {}, grade: {}, price: null };
    var priceBuilt = false;

    function facetValues(key) {
      var seen = {};
      cards.forEach(function (c) {
        var v = c.getAttribute('data-' + key);
        if (v) seen[v] = (seen[v] || 0) + 1;
      });
      return seen;
    }

    function buildCheckboxGroup(key, container) {
      var values = facetValues(key);
      var names = Object.keys(values).sort();
      container.innerHTML = names.map(function (name) {
        var id = 'uc-filter-' + key + '-' + name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        return '<label class="uc-shopfilters__opt" for="' + id + '">' +
          '<input type="checkbox" id="' + id + '" data-uc-filter-key="' + key + '" value="' + name.replace(/"/g, '&quot;') + '">' +
          '<span>' + name + '</span><em data-uc-filter-count-for="' + key + ':' + name + '">(' + values[name] + ')</em>' +
        '</label>';
      }).join('');
    }

    function buildPriceGroup(container) {
      var hint = container.querySelector('[data-uc-filter-price-hint]');
      var prices = [];
      cards.forEach(function (c) {
        var el = c.querySelector('[data-uc-price]');
        var wrap = c.querySelector('[data-uc-pricing]');
        if (el && wrap && !wrap.hidden) {
          var n = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
          if (n) prices.push(n);
        }
      });
      if (!prices.length) { priceBuilt = false; return; }
      priceBuilt = true;
      var max = Math.max.apply(null, prices);
      var step = max > 6000 ? 1000 : max > 3000 ? 500 : 250;
      var top = Math.ceil(max / step) * step;
      var buckets = [];
      for (var v = step; v <= top; v += step) buckets.push(v);
      container.innerHTML = buckets.map(function (v) {
        var id = 'uc-filter-price-' + v;
        return '<label class="uc-shopfilters__opt uc-shopfilters__opt--radio" for="' + id + '">' +
          '<input type="radio" name="uc-filter-price" id="' + id + '" data-uc-filter-price="' + v + '">' +
          '<span>Up to ' + UCPricing.money(v) + '</span>' +
        '</label>';
      }).join('');
    }

    function cardPrice(card) {
      var el = card.querySelector('[data-uc-price]');
      var wrap = card.querySelector('[data-uc-pricing]');
      if (!el || !wrap || wrap.hidden) return null;
      var n = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
      return n || null;
    }

    function applyFilters() {
      var shown = 0;
      cards.forEach(function (card) {
        var ok = true;
        ['size', 'condition', 'grade'].forEach(function (key) {
          var chosen = Object.keys(selected[key]);
          if (chosen.length && ok) {
            var v = card.getAttribute('data-' + key);
            ok = v && chosen.indexOf(v) !== -1;
          }
        });
        if (ok && selected.price) {
          var p = cardPrice(card);
          ok = p !== null && p <= selected.price;
        }
        card.hidden = !ok;
        if (ok) shown++;
      });
      emptyEl.hidden = shown > 0;
      gridEl.hidden = shown === 0;
      if (countEl) {
        var tpl = countEl.getAttribute(UCPricing.getZip() ? 'data-template' : 'data-template-nozip') || countEl.getAttribute('data-template');
        countEl.textContent = tpl ? tpl.replace('{shown}', shown) : shown + ' of ' + cards.length + ' containers shown';
      }
    }

    root.addEventListener('change', function (e) {
      var cb = e.target.closest('[data-uc-filter-key]');
      if (cb) {
        var key = cb.getAttribute('data-uc-filter-key');
        if (cb.checked) selected[key][cb.value] = true; else delete selected[key][cb.value];
        applyFilters();
        return;
      }
      var radio = e.target.closest('[data-uc-filter-price]');
      if (radio) {
        selected.price = parseFloat(radio.getAttribute('data-uc-filter-price'));
        applyFilters();
      }
    });

    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-uc-filter-toggle]')) {
        var btn = e.target.closest('[data-uc-filter-toggle]');
        var group = btn.closest('[data-uc-filter-group]');
        var open = btn.getAttribute('aria-expanded') !== 'false';
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
        group.classList.toggle('is-collapsed', open);
      }
    });

    if (clearBtn) clearBtn.addEventListener('click', function () {
      selected = { size: {}, condition: {}, grade: {}, price: null };
      root.querySelectorAll('input[type="checkbox"][data-uc-filter-key], input[type="radio"][data-uc-filter-price]').forEach(function (i) { i.checked = false; });
      applyFilters();
    });

    // Sort: recommended keeps the theme order; price sorts put unpriced rows last.
    var sortSel = root.parentElement.querySelector('[data-uc-sort]');
    function applySort() {
      if (!sortSel) return;
      var mode = sortSel.value;
      var list = cards.slice().sort(function (x, y) {
        if (mode === 'recommended') return x.getAttribute('data-index') - y.getAttribute('data-index');
        var px = cardPrice(x), py = cardPrice(y);
        if (px === null && py === null) return x.getAttribute('data-index') - y.getAttribute('data-index');
        if (px === null) return 1;
        if (py === null) return -1;
        return mode === 'price-asc' ? px - py : py - px;
      });
      list.forEach(function (c) { gridEl.appendChild(c); });
    }
    if (sortSel) sortSel.addEventListener('change', applySort);

    groups.forEach(function (group) {
      var key = group.getAttribute('data-uc-filter-group');
      var box = group.querySelector('[data-uc-filter-options]');
      if (key === 'price') buildPriceGroup(box); else buildCheckboxGroup(key, box);
    });
    // On phones, start with every filter group closed so the list shows first.
    if (root.closest('[data-uc-listview]') && window.matchMedia('(max-width: 900px)').matches) {
      groups.forEach(function (g) {
        g.classList.add('is-collapsed');
        var t = g.querySelector('[data-uc-filter-toggle]');
        if (t) t.setAttribute('aria-expanded', 'false');
      });
    }
    applyFilters();

    window.addEventListener('uc:pricing', function () {
      // uc-pricing.js fires this event from inside its own lookup() promise,
      // one microtask before the caller's .then() runs UCPricing.apply() to
      // actually unhide each card's price. Defer to a macrotask so the DOM
      // reflects real prices before we read them off the cards.
      setTimeout(function () {
        if (!priceBuilt) {
          var priceGroup = root.querySelector('[data-uc-filter-group="price"] [data-uc-filter-options]');
          if (priceGroup) buildPriceGroup(priceGroup);
        }
        applyFilters();
        applySort();
      }, 0);
    });
  }

  // ---------------------------------------------------------------
  // List view (collection pages + ZIP search page): ZIP bar, prices,
  // depot line. Filters and sort are handled by initShopFilters.
  // ---------------------------------------------------------------
  function initListView(root) {
    if (root.dataset.ucLvBound) return;
    root.dataset.ucLvBound = '1';
    var form = root.querySelector('[data-uc-lv-zipform]');
    var input = root.querySelector('[data-uc-lv-zip]');
    var status = root.querySelector('[data-uc-lv-status]');
    var panel = root.querySelector('[data-uc-lv-panel]');
    var prompt = root.querySelector('[data-uc-lv-prompt]');
    var gate = root.hasAttribute('data-gate');
    if (!form || !input) return;

    UCPricing.configure(cfgFrom(root));
    var opts = { pricePrefix: '', deliveryLabel: '' };
    var MSG_INVALID = root.getAttribute('data-msg-invalid') || 'Please enter a valid US ZIP code.';
    var MSG_LOADING = root.getAttribute('data-msg-loading') || 'Checking availability…';

    function say(text, isError) {
      status.hidden = !text;
      status.textContent = text || '';
      status.classList.toggle('is-error', !!isError);
    }

    function showRows(show) {
      if (!gate) return;
      panel.hidden = !show;
      if (prompt) prompt.hidden = show;
    }

    function paint(res) {
      if (!res) return;
      UCPricing.apply(root, res, opts);
      var ok = res.real !== false && !!res.byId;
      var label = root.getAttribute(UCPricing.getMode() ? 'data-label-delivery' : 'data-label-pickup');
      var depot = res.depot ? 'Depot: ' + res.depot + (res.distance ? ' (' + res.distance + ' miles away)' : '') : '';
      root.querySelectorAll('[data-uc-card]').forEach(function (row) {
        var d = row.querySelector('[data-uc-lv-depot]');
        if (d) { d.querySelector('span').textContent = depot; d.hidden = !depot; }
        var l = row.querySelector('[data-uc-lv-pricelabel]');
        if (l && label) l.textContent = label;
        var wrap = row.querySelector('[data-uc-pricing]');
        var oos = row.querySelector('[data-uc-oos]');
        var np = row.querySelector('[data-uc-lv-noprice]');
        if (np) {
          if (!np.dataset.hint) np.dataset.hint = np.textContent;
          np.textContent = ok ? 'Price available on request' : np.dataset.hint;
          np.hidden = (wrap && !wrap.hidden) || (oos && !oos.hidden);
        }
      });
    }

    function run(zip, fromUser) {
      if (!UCPricing.isValidZip(zip)) {
        if (zip || fromUser) say(MSG_INVALID, true);
        showRows(false);
        return;
      }
      say(MSG_LOADING);
      root.classList.add('is-loading');
      UCPricing.lookup(zip, UCPricing.getMode()).then(function (res) {
        root.classList.remove('is-loading');
        if (res.real === false) { say(MSG_INVALID, true); showRows(false); return; }
        say('');
        UCPricing.setZip(zip);
        showRows(true);
        paint(res);
        if (fromUser) {
          var url = new URL(window.location.href);
          url.searchParams.set('zipcode', zip);
          url.searchParams.set('isDelivery', String(UCPricing.getMode()));
          window.history.replaceState({}, '', url);
        }
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      run(input.value.trim(), true);
    });

    window.addEventListener('uc:pricing', function (e) {
      setTimeout(function () { paint((e.detail || {}).result); }, 0);
    });

    var initial = readZipParams();
    if (initial.isDelivery !== null) UCPricing.setMode(initial.isDelivery);
    var zip = initial.zip || UCPricing.getZip();
    if (zip) {
      input.value = zip;
      run(zip, false);
    } else {
      showRows(false);
    }
  }

  // ---------------------------------------------------------------
  // Review sliders inside page content ([data-uc-quotes]): one card at
  // a time, arrows, dots, autoplay (as on the WordPress site).
  // ---------------------------------------------------------------
  // Lucide chevron-left / chevron-right (ISC).
  var CHEV = {
    prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>'
  };

  function initQuoteSliders() {
    document.querySelectorAll('[data-uc-quotes]').forEach(function (root) {
      if (root.dataset.ucSliderBound) return;
      var slides = Array.prototype.slice.call(root.children);
      if (slides.length < 2) return;
      root.dataset.ucSliderBound = '1';
      root.classList.add('is-slider');
      root.setAttribute('role', 'region');
      root.setAttribute('aria-roledescription', 'carousel');
      root.setAttribute('aria-label', 'Customer reviews');

      var viewport = document.createElement('div');
      viewport.className = 'uc-quotes__viewport';
      var track = document.createElement('div');
      track.className = 'uc-quotes__track';
      slides.forEach(function (s, i) {
        s.setAttribute('role', 'group');
        s.setAttribute('aria-roledescription', 'slide');
        s.setAttribute('aria-label', (i + 1) + ' / ' + slides.length);
        track.appendChild(s);
      });
      viewport.appendChild(track);
      root.appendChild(viewport);

      function arrow(dir) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'uc-quotes__arrow uc-quotes__arrow--' + dir;
        b.setAttribute('aria-label', dir === 'prev' ? 'Previous review' : 'Next review');
        b.innerHTML = CHEV[dir];
        return b;
      }
      var prev = arrow('prev'), next = arrow('next');
      root.appendChild(prev);
      root.appendChild(next);
      var dots = document.createElement('div');
      dots.className = 'uc-quotes__dots';
      slides.forEach(function (_, i) {
        var d = document.createElement('button');
        d.type = 'button';
        d.setAttribute('aria-label', 'Go to review ' + (i + 1));
        d.addEventListener('click', function () { go(i); stop(); });
        dots.appendChild(d);
      });
      root.appendChild(dots);

      var index = 0, timer = null, paused = false;
      function go(i) {
        index = (i + slides.length) % slides.length;
        track.style.transform = 'translateX(' + (-100 * index) + '%)';
        slides.forEach(function (s, n) { s.setAttribute('aria-hidden', n === index ? 'false' : 'true'); });
        Array.prototype.forEach.call(dots.children, function (d, n) { d.classList.toggle('is-active', n === index); });
      }
      function play() {
        if (timer || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        timer = setInterval(function () { if (!paused && !document.hidden) go(index + 1); }, 5000);
      }
      function stop() { clearInterval(timer); timer = null; }

      prev.addEventListener('click', function () { go(index - 1); stop(); });
      next.addEventListener('click', function () { go(index + 1); stop(); });
      root.addEventListener('mouseenter', function () { paused = true; });
      root.addEventListener('mouseleave', function () { paused = false; });

      // Swipe on touch screens.
      var startX = null;
      viewport.addEventListener('touchstart', function (e) { startX = e.touches[0].clientX; stop(); }, { passive: true });
      viewport.addEventListener('touchend', function (e) {
        if (startX === null) return;
        var dx = e.changedTouches[0].clientX - startX;
        if (Math.abs(dx) > 40) go(index + (dx < 0 ? 1 : -1));
        startX = null;
      });

      go(0);
      play();
    });
  }

  var linksBound = false;

  function boot() {
    ready(function () {
      if (!linksBound) { decorateLinks(); initVideoPosters(); linksBound = true; }
      initPlaylistSliders();
      initQuoteSliders();
      tidyArticle();
      document.querySelectorAll('[data-uc-zip-results]').forEach(initZipResults);
      document.querySelectorAll('[data-uc-pricing-target]').forEach(initTarget);
      document.querySelectorAll('[data-uc-zipbar]').forEach(initZipBar);
      document.querySelectorAll('[data-uc-listview]').forEach(initListView);
      document.querySelectorAll('[data-uc-quote-page]').forEach(initQuotePage);
      document.querySelectorAll('[data-uc-shop-filters]').forEach(initShopFilters);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Re-initialise when a section is edited in the theme customiser.
  document.addEventListener('shopify:section:load', function () { boot(); });
})();
