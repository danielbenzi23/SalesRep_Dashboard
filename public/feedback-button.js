/* Feedback panel for the sales dashboards.
 *
 * Opens the SAME form the sales intake pages use (/feedback on the intake app)
 * in a side panel, exactly like the widget on the intake deal pages. One form,
 * one SalesRep Feedback sheet, one Slack ping, one board, one Triage Agent. A
 * second form here would have split triage in two.
 *
 * REQUIRES a header change on the intake app. It serves /feedback with
 * `frame-ancestors 'self'`, which blocks framing from any other origin. These
 * dashboards are a different origin, so without that change the panel renders
 * empty. See the vercel.json delivered alongside this file.
 *
 * The panel always carries an "open in a new tab" link in its header, so if the
 * frame is ever blocked again — a new preview domain, a reverted header — the
 * person still has a way through instead of staring at a blank box.
 *
 * Drop-in: add one line before </body> on any dashboard page.
 *     <script src="/feedback-button.js"></script>
 * Self-contained, mounts itself, safe to include twice.
 */
(function () {
  if (window.__dsFeedbackButton) return;
  window.__dsFeedbackButton = true;

  // CONFIRM THIS: the intake app's production domain. The only line to change
  // if that domain is different.
  var FEEDBACK_BASE = 'https://ds-sales-intake.vercel.app';

  // Which page the person is on, in words a human would use in a bug report.
  function pageName() {
    var p = (location.pathname || '').toLowerCase();
    if (p.indexOf('call-performance') >= 0) return 'Call performance';
    if (p.indexOf('sales') >= 0 || p === '/' || p === '') return 'Sales rep workspace';
    return document.title || 'Dashboard';
  }

  // The tab open right now. Read at open time, not at page load, or every
  // report would name whichever tab happened to be open when the page rendered.
  function tabName() {
    var el = document.querySelector('.tab.active, .tab.on, [data-tab].active');
    return el ? (el.textContent || '').trim() : '';
  }

  // Which rep is being viewed, when an admin has someone else selected.
  // "The pipeline looks wrong" means something different depending on whose
  // pipeline was on screen.
  function repName() {
    var sel = document.getElementById('rep-select');
    if (sel && sel.style.display !== 'none' && sel.selectedIndex >= 0) {
      var o = sel.options[sel.selectedIndex];
      if (o && o.text) return o.text.trim();
    }
    return '';
  }

  function context() {
    var where = pageName();
    var t = tabName();
    if (t) where += ' — ' + t + ' tab';
    var r = repName();
    if (r) where += ' (viewing ' + r + ')';
    return where;
  }

  function feedbackUrl(embed) {
    // The form has no dashboard category, so the context goes in the links
    // field, which is free text and always shown to whoever triages.
    var params = { links: context() + '\n' + location.origin + location.pathname };
    if (embed) {
      params.embed = '1';
      // Fresh URL per open: a cached copy of the form keeps whatever embed
      // permission (frame-ancestors) it was first served with, so a fix to
      // that header on the intake app would otherwise never reach the panel.
      params.t = String(Date.now());
    }
    return FEEDBACK_BASE + '/feedback?' + new URLSearchParams(params).toString();
  }

  function mount() {
    if (document.getElementById('ds-fb-btn')) return;

    var st = document.createElement('style');
    st.textContent =
      '#ds-fb-btn{position:fixed;right:18px;bottom:18px;z-index:9998;border:0;border-radius:999px;' +
      'padding:10px 16px;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'background:#1565C0;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.18);cursor:pointer}' +
      '#ds-fb-btn:hover{background:#0F4C9A}' +
      '#ds-fb-p{position:fixed;right:18px;bottom:66px;z-index:9999;width:620px;' +
      'max-width:calc(100vw - 32px);height:min(820px,calc(100vh - 100px));background:#fff;' +
      'border:1px solid #dfe3ea;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.2);' +
      'display:none;overflow:hidden}' +
      '#ds-fb-p.on{display:flex;flex-direction:column}' +
      '#ds-fb-h{display:flex;justify-content:space-between;align-items:center;gap:10px;' +
      'padding:8px 12px;border-bottom:1px solid #e3e6ea;' +
      'font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1d2433}' +
      '#ds-fb-h .r{display:flex;align-items:center;gap:10px;font-weight:400}' +
      '#ds-fb-h a{font-size:11.5px;color:#1565C0;text-decoration:none}' +
      '#ds-fb-h a:hover{text-decoration:underline}' +
      '#ds-fb-h button{border:0;background:none;font-size:20px;line-height:1;color:#5b6373;cursor:pointer}' +
      '#ds-fb-f{flex:1;border:0;width:100%}' +
      '@media print{#ds-fb-btn,#ds-fb-p{display:none!important}}';
    document.head.appendChild(st);

    var btn = document.createElement('button');
    btn.id = 'ds-fb-btn';
    btn.type = 'button';
    btn.textContent = 'Feedback';
    btn.title = 'Report something wrong, or ask for something that is missing.';

    var panel = document.createElement('div');
    panel.id = 'ds-fb-p';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Send feedback');

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    function close() { panel.classList.remove('on'); }

    btn.addEventListener('click', function () {
      if (panel.classList.contains('on')) { close(); return; }
      // Rebuilt every time it opens, so the tab and rep are the current ones.
      panel.innerHTML =
        '<div id="ds-fb-h"><span>Feedback</span>' +
        '<span class="r"><a id="ds-fb-tab" target="_blank" rel="noopener">Open in a new tab</a>' +
        '<button type="button" id="ds-fb-x" aria-label="Close">&times;</button></span></div>';
      panel.querySelector('#ds-fb-tab').href = feedbackUrl(false);
      var f = document.createElement('iframe');
      f.id = 'ds-fb-f';
      f.title = 'Feedback form';
      f.src = feedbackUrl(true);
      panel.appendChild(f);
      panel.classList.add('on');
    });

    panel.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'ds-fb-x') close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
