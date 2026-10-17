/* Used Conex — GSAP entrance animations
   Depends on: gsap, ScrollTrigger (loaded from CDN in theme.liquid)

   Coverage is automatic: every section on every page is animated by walking
   the DOM for meaningful content, so newly built sections need no JS changes.

   Opt-out / override with data attributes:
     data-uc-anim="none"    on a section or element — never animate it
     data-uc-anim           on children — animate exactly these instead of auto
     data-uc-anim-from      "up" (default) | "down" | "left" | "right" | "fade" | "scale"
     data-uc-stagger        seconds between siblings (default 0.08)
*/
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasGsap = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';
  var inEditor = window.Shopify && window.Shopify.designMode;

  /* Never hide content unless we know we can reveal it again. */
  if (reduced || !hasGsap || inEditor) {
    document.documentElement.classList.add('uc-motion-off');
    return;
  }

  gsap.registerPlugin(ScrollTrigger);
  document.documentElement.classList.add('uc-motion-on');

  /* ---------------- Entrance animations ---------------- */

  /* Elements that must never be transformed: transforming them would break
     layout, create stacking/overflow bugs, or fight our own scroll triggers. */
  var SKIP = 'script,style,noscript,br,hr,svg,path,source,link,meta,' +
    'header,.uc-header,.announcement-bar,.shopify-section-header,' +
    '[data-uc-anim="none"]';

  /* An element is "animatable content" if it renders something a visitor
     perceives as a discrete unit. We stop descending once we hit one. */
  function isLeafContent(el) {
    var tag = el.tagName;
    if (/^(H1|H2|H3|H4|H5|H6|P|IMG|PICTURE|BUTTON|BLOCKQUOTE|TABLE|VIDEO|IFRAME|FORM|HR)$/.test(tag)) return true;
    if (tag === 'A' && el.children.length === 0) return true;
    if (tag === 'LI') return true;
    /* A card/panel: a bounded box holding several things. */
    if (el.children.length && el.children.length <= 12) {
      var cs = getComputedStyle(el);
      if (cs.borderRadius !== '0px' || cs.backgroundImage !== 'none' ||
          cs.boxShadow !== 'none' ||
          (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent')) {
        return true;
      }
    }
    return false;
  }

  /* Walk down from a section, collecting the outermost animatable units.
     Pure layout wrappers are descended through rather than animated, so the
     motion lands on real content instead of on whole page slabs. */
  function collect(root) {
    var out = [];
    /* Keep a section's stagger from becoming a slideshow. A section with lots
       of small items (the footer) can raise it with data-uc-anim-max. */
    var MAX = parseInt(root.getAttribute('data-uc-anim-max'), 10) || 40;

    (function walk(node, depth) {
      if (out.length >= MAX || depth > 6) return;
      for (var i = 0; i < node.children.length; i++) {
        var el = node.children[i];
        if (el.matches(SKIP)) continue;

        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;      /* hidden */
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.position === 'fixed') continue;
        /* Don't transform sticky elements or scroll containers. */
        if (cs.position === 'sticky') { walk(el, depth + 1); continue; }

        if (isLeafContent(el) || el.children.length === 0) {
          out.push(el);
        } else {
          var before = out.length;
          walk(el, depth + 1);
          /* Nothing usable inside — animate the wrapper itself. */
          if (out.length === before) out.push(el);
        }
        if (out.length >= MAX) return;
      }
    })(root, 0);

    return out;
  }

  function varsFor(el) {
    var dir = el.getAttribute('data-uc-anim-from') || 'up';
    switch (dir) {
      case 'down':  return { y: -28 };
      case 'left':  return { x: -36 };
      case 'right': return { x: 36 };
      case 'scale': return { scale: 0.94 };
      case 'fade':  return {};
      default:      return { y: 28 };
    }
  }

  function animate(section) {
    if (section.matches('[data-uc-anim="none"]')) return;

    var explicit = section.querySelectorAll(':scope [data-uc-anim]:not([data-uc-anim="none"])');
    var els = explicit.length ? Array.prototype.slice.call(explicit) : collect(section);

    /* Drop nested duplicates so nothing animates twice. */
    els = els.filter(function (el) {
      return !els.some(function (o) { return o !== el && o.contains(el); });
    });
    if (!els.length) return;

    var stagger = parseFloat(section.getAttribute('data-uc-stagger'));
    if (isNaN(stagger)) stagger = 0.08;
    /* Many items -> tighten stagger so the tail isn't left waiting. */
    if (els.length > 10) stagger = Math.min(stagger, 0.6 / els.length);

    els.forEach(function (el) {
      var from = varsFor(el);
      from.autoAlpha = 0;
      gsap.set(el, from);
    });

    gsap.to(els, {
      autoAlpha: 1,
      x: 0,
      y: 0,
      scale: 1,
      duration: 0.7,
      ease: 'power2.out',
      stagger: stagger,
      overwrite: 'auto',
      scrollTrigger: { trigger: section, start: 'top 85%', once: true },
      /* Clear inline transforms afterwards so they can't interfere with
         hover states, sticky behaviour or responsive layout. */
      clearProps: 'transform'
    });
  }

  function build() {
    /* Every top-level Shopify section, plus our own section wrappers.
       This covers current and future pages without an allowlist. */
    var seen = [];
    var nodes = document.querySelectorAll(
      'main .shopify-section, main > section, .uc-section, .uc-footer'
    );

    nodes.forEach(function (n) {
      /* If an ancestor is already handled, skip — avoids double animation. */
      if (seen.some(function (s) { return s !== n && s.contains(n); })) return;
      seen.push(n);
      animate(n);
    });

    var header = document.querySelector('.uc-header');
    if (header) gsap.from(header, { y: -20, autoAlpha: 0, duration: 0.6, ease: 'power2.out' });

    ScrollTrigger.refresh();
  }

  function init() {
    build();
    window.addEventListener('load', function () { ScrollTrigger.refresh(); });
    /* Fonts settling changes text height and moves trigger points. */
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { ScrollTrigger.refresh(); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
