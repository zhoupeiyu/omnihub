(function () {
  'use strict';
  var FLAG = 'data-omnihub-ready';
  function anchor(href, text) {
    var a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    return a;
  }
  function init() {
    var nav = document.querySelector('.nav-in');
    var head = document.querySelector('.doc-head');
    if (!nav || !head) return false;
    if (document.documentElement.getAttribute(FLAG) === '1') return true;
    document.documentElement.setAttribute(FLAG, '1');
    nav.insertBefore(anchor('/', '返回 OmniHub'), nav.firstChild);
    var title = nav.querySelector('a.title');
    if (title) title.textContent = '生活指南';
    var q = document.getElementById('q');
    if (q) q.setAttribute('placeholder', '搜索条目、成本、收益与备注');
    var fold = [];
    var first = null;
    var kids = head.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].tagName !== 'P') continue;
      if (first) fold.push(kids[i]); else first = kids[i];
    }
    var links = document.querySelectorAll('.doc-links');
    for (var j = 0; j < links.length; j++) fold.push(links[j]);
    var gloss = document.querySelector('#gloss');
    if (gloss) fold.push(gloss);
    if (fold.length) {
      var details = document.createElement('details');
      var summary = document.createElement('summary');
      summary.textContent = '阅读说明与配套长文';
      details.appendChild(summary);
      fold.forEach(function (el) { details.appendChild(el); });
      head.appendChild(details);
    }
    var meta = window.__CORPUS_META__ || {};
    var snap = meta.snapshot || meta.snapshotDate || meta.date || '';
    var sha = String(meta.commit || meta.sha || meta.revision || '').slice(0, 7);
    var src = document.createElement('p');
    src.className = 'doc-source';
    src.appendChild(document.createTextNode('原文作者：'));
    src.appendChild(anchor('https://github.com/eternity4719/HowToLiveBetter', 'eternity4719/HowToLiveBetter'));
    src.appendChild(document.createTextNode('，许可协议：'));
    src.appendChild(anchor('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0'));
    src.appendChild(document.createTextNode('，快照日期：' + snap + (sha ? '，提交：' + sha : '') + '。'));
    src.appendChild(document.createTextNode('原文完整保留，页面适配 OmniHub。'));
    head.appendChild(src);
    return true;
  }
  if (!init()) document.addEventListener('DOMContentLoaded', init, { once: true });
})();
