'use strict';
/* 抖音商家线索工作台 · 前端
   数据全在服务端，这里只做渲染与交互。 */

(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var S = {
    state: null,
    view: 'queue',
    leadId: null,
    tone: 'consult',
    draftId: null,
    keyword: null,
    busy: false,
    filter: { q: '', status: '', industry: '' },
  };

  var TONE_LABEL = { consult: '首次咨询', follow: '跟进', reply: '接话', sample: '要报价' };
  var STATUS_LABEL = { new: '待联系', contacted: '已联系', replied: '已回复', won: '已成交', excluded: '已排除', invalid: '无效' };
  var STATUS_CLASS = { new: 'info', contacted: '', replied: 'ok', won: 'ok', excluded: 'bad', invalid: 'bad' };

  /* ------------------------------------------------------------ 基础 */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtFans(n) {
    n = Number(n);
    if (!isFinite(n)) return '未知';
    if (n >= 1e4) return (n / 1e4).toFixed(n % 1e4 === 0 ? 0 : 1) + '万';
    return String(n);
  }

  function fmtAgo(ts) {
    if (!ts) return '—';
    var d = Date.now() - ts;
    if (d < 0) {
      var f = -d;
      if (f < 36e5) return Math.round(f / 6e4) + ' 分钟后';
      if (f < 864e5) return Math.round(f / 36e5) + ' 小时后';
      return Math.round(f / 864e5) + ' 天后';
    }
    if (d < 6e4) return '刚刚';
    if (d < 36e5) return Math.round(d / 6e4) + ' 分钟前';
    if (d < 864e5) return Math.round(d / 36e5) + ' 小时前';
    if (d < 30 * 864e5) return Math.round(d / 864e5) + ' 天前';
    return new Date(ts).toLocaleDateString('zh-CN');
  }

  function fmtClock(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function sync(txt, cls) {
    var el = $('#saveState');
    if (!el) return;
    el.textContent = txt || '已同步';
    el.className = 'tag ' + (cls || 'info');
  }

  function toast(msg, cls) {
    var host = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (cls || '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .2s, transform .2s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(10px)';
      setTimeout(function () { el.remove(); }, 220);
    }, cls === 'err' ? 4200 : 2400);
  }

  /* ------------------------------------------------------------ API */

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      if (res.status === 401) {
        showLogin();
        throw new Error('需要登录');
      }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
        return data;
      });
    });
  }

  /* ------------------------------------------------------------ 登录 */

  function showLogin() {
    $('#login').hidden = false;
    $('#app').hidden = true;
    setTimeout(function () { var p = $('#pw'); if (p) p.focus(); }, 60);
  }

  function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
  }

  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('#loginBtn');
    var pw = $('#pw').value;
    if (!pw) return;
    btn.disabled = true;
    $('#loginErr').textContent = '';
    api('/api/login', { method: 'POST', body: { password: pw } })
      .then(function () {
        $('#pw').value = '';
        return loadState().then(function () { showApp(); renderAll(); });
      })
      .catch(function (err) {
        $('#loginErr').textContent = err.message === '需要登录' ? '口令不对' : err.message;
      })
      .then(function () { btn.disabled = false; });
  });

  $('#logoutBtn').addEventListener('click', function () {
    api('/api/logout', { method: 'POST', body: {} }).then(function () {
      S.state = null; S.leadId = null; showLogin();
    });
  });

  /* ------------------------------------------------------------ 状态加载 */

  function loadState() {
    sync('同步中…', 'warn');
    return api('/api/state').then(function (st) {
      S.state = st;
      var q = st.queue || { ids: [], cursor: 0 };
      if (!S.leadId || !st.leads.some(function (l) { return l.id === S.leadId; })) {
        S.leadId = q.ids[q.cursor] || null;
      }
      if (!st.settings.aiToneDefault) S.tone = 'consult'; else S.tone = S.tone || st.settings.aiToneDefault;
      sync('已同步', 'info');
      return st;
    }).catch(function (e) {
      sync('离线', 'bad');
      throw e;
    });
  }

  function refresh() {
    return loadState().then(renderAll).catch(function (e) { toast(e.message, 'err'); });
  }

  /* ------------------------------------------------------------ 视图切换 */

  var TITLES = {
    queue: ['今日队列', '一家一家来，发完自动跳下一条'],
    leads: ['线索库', '所有商家档案与筛选结果'],
    keywords: ['关键词库', '进同一个词 7 天内不重复抽'],
    follow: ['跟进', '到期的先处理'],
    drafts: ['草稿箱', '发过 / 没发过的都在这里'],
    stats: ['统计', '挡掉了多少、回了多少'],
    settings: ['设置', 'AI 接口、我方信息、数据'],
  };

  function go(view) {
    S.view = view;
    $$('.nav-item').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-view') === view); });
    $$('.content > section').forEach(function (s) { s.hidden = s.id !== 'view-' + view; });
    var t = TITLES[view] || ['', ''];
    $('#viewTitle').textContent = t[0];
    $('#viewSub').textContent = t[1];
    if (view === 'stats') renderStats();
    if (view === 'follow') renderFollow();
    if (view === 'drafts') renderDrafts();
    window.scrollTo({ top: 0 });
  }

  $$('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () { go(b.getAttribute('data-view')); });
  });

  /* ------------------------------------------------------------ 渲染总入口 */

  function renderAll() {
    if (!S.state) return;
    var st = S.state;
    var q = st.queue || { ids: [], cursor: 0 };
    $('#badgeQueue').textContent = Math.max(0, q.ids.length - q.cursor);
    $('#badgeLeads').textContent = st.leads.length;
    $('#badgeKw').textContent = st.keywords.filter(function (k) { return k.active; }).length;
    $('#badgeDrafts').textContent = st.drafts.length;
    var due = st.leads.filter(function (l) { return l.followUpAt && l.followUpAt <= Date.now(); }).length;
    $('#badgeFollow').textContent = due;
    renderQueue();
    renderLeads();
    renderKeywords();
    renderFollow();
    renderDrafts();
    renderSettings();
    if (S.view === 'stats') renderStats();
  }

  /* ------------------------------------------------------------ 队列 */

  function leadById(id) {
    if (!S.state) return null;
    for (var i = 0; i < S.state.leads.length; i++) if (S.state.leads[i].id === id) return S.state.leads[i];
    return null;
  }

  function curLead() {
    if (!S.state) return null;
    var q = S.state.queue || { ids: [], cursor: 0 };
    return leadById(S.leadId) || leadById(q.ids[q.cursor]) || null;
  }

  function renderQueue() {
    var st = S.state, q = st.queue || { ids: [], cursor: 0, paused: false };
    var remain = Math.max(0, q.ids.length - q.cursor);
    $('#qRemain').textContent = remain;
    $('#btnPause').textContent = q.paused ? '继续' : '暂停';
    $('#btnPause').classList.toggle('primary', q.paused);
    $('#kwTag').textContent = '关键词：' + (S.keyword ? S.keyword.text + (S.keyword.city ? ' · ' + S.keyword.city : '') : '—');

    var lead = curLead();
    var emptyBox = $('#queueEmpty');
    var body = $('#queueBody');

    if (!lead) {
      body.hidden = true;
      emptyBox.hidden = false;
      emptyBox.innerHTML = st.leads.length
        ? '<strong>队列跑完了</strong>剩下 ' + st.leads.length + ' 条线索，可能都在冷却里或者不合规。<br>' +
          '去线索库补新商家，或者点上面的「重建队列」。<div style="margin-top:12px"><button class="btn sm" id="emptyLeads">去线索库</button></div>'
        : '<strong>还没有线索</strong>先在线索库录入或导入商家（可以粘贴抖音主页文字自动解析），也可以载入示例数据看看流程。<div style="margin-top:12px"><button class="btn sm" id="emptyDemo">载入示例数据</button></div>';
      var eb = $('#emptyLeads');
      if (eb) eb.addEventListener('click', function () { go('leads'); });
      var ed = $('#emptyDemo');
      if (ed) ed.addEventListener('click', loadDemo);
      return;
    }

    emptyBox.hidden = true;
    body.hidden = false;

    $('#leadAvatar').textContent = (lead.name || '?').slice(0, 1);
    $('#leadName').innerHTML = esc(lead.name) +
      (lead.verified ? ' <span class="tag ok">企业认证</span>' : ' <span class="tag warn">未认证</span>') +
      (lead.cooldownLeft > 0 ? ' <span class="tag bad">冷却中</span>' : '');

    var meta = [];
    meta.push('<span>粉丝 <b>' + fmtFans(lead.fans) + '</b></span>');
    if (lead.region) meta.push('<span>' + esc(lead.region) + '</span>');
    if (lead.industry) meta.push('<span>' + esc(lead.industry) + '</span>');
    if (lead.works) meta.push('<span>作品 <b>' + lead.works + '</b></span>');
    if (lead.lastTouchAt) meta.push('<span>上次联系 <b>' + fmtAgo(lead.lastTouchAt) + '</b></span>');
    if (lead.dyId) meta.push('<span class="mono">' + esc(lead.dyId) + '</span>');
    $('#leadMeta').innerHTML = meta.join('');

    var bio = $('#leadBio');
    if (lead.bio) { bio.hidden = false; bio.textContent = lead.bio; } else { bio.hidden = true; }

    $('#leadScore').textContent = lead.score || 0;

    // tone chips
    var tc = $('#toneChips');
    tc.innerHTML = Object.keys(TONE_LABEL).map(function (k) {
      return '<button class="chip' + (S.tone === k ? ' on' : '') + '" data-tone="' + k + '">' + TONE_LABEL[k] + '</button>';
    }).join('');

    // 队列预览
    var preview = q.ids.slice(q.cursor, q.cursor + 12);
    var host = $('#queueList');
    if (!preview.length) {
      host.innerHTML = '<div class="hint">队列里没有更多了。</div>';
    } else {
      host.innerHTML = preview.map(function (id) {
        var l = leadById(id);
        if (!l) return '';
        return '<div class="qitem' + (l.id === lead.id ? ' on' : '') + '" data-lead="' + l.id + '">' +
          '<span class="tag ' + (STATUS_CLASS[l.status] || '') + '">' + (STATUS_LABEL[l.status] || l.status) + '</span>' +
          '<span class="nm">' + esc(l.name) + '</span>' +
          '<span class="sc">' + fmtFans(l.fans) + '</span>' +
          '<span class="sc">' + (l.score || 0) + '</span></div>';
      }).join('');
    }
  }

  function nextLead() {
    sync('同步中…', 'warn');
    return api('/api/queue/next', { method: 'POST', body: {} }).then(function (r) {
      S.leadId = r.lead ? r.lead.id : null;
      if (r.keyword) S.keyword = r.keyword;
      return loadState().then(renderAll);
    }).then(function () {
      var l = curLead();
      if (!l) toast('队列空了，去线索库补商家');
    });
  }

  $('#btnNext').addEventListener('click', function () {
    // 手动点「下一家」= 跳过当前这条（不改状态，冷却期后还会回来）
    var step = curLead() ? api('/api/queue/advance', { method: 'POST', body: {} }) : Promise.resolve();
    step.then(function () { S.leadId = null; setDraft(''); return nextLead(); })
      .catch(function (e) { toast(e.message, 'err'); });
  });

  $('#btnRebuild').addEventListener('click', function () {
    api('/api/queue/build', { method: 'POST', body: {} })
      .then(function () { S.leadId = null; return refresh(); })
      .then(function () { toast('队列已重建', 'ok'); })
      .catch(function (e) { toast(e.message, 'err'); });
  });

  $('#btnPause').addEventListener('click', function () {
    var paused = !(S.state.queue || {}).paused;
    api('/api/queue/pause', { method: 'POST', body: { paused: paused } })
      .then(refresh)
      .then(function () { toast(paused ? '已暂停，进度留在服务端' : '继续', 'ok'); })
      .catch(function (e) { toast(e.message, 'err'); });
  });

  $('#btnKw').addEventListener('click', function () {
    api('/api/keywords/next', { method: 'POST', body: {} }).then(function (r) {
      if (!r.keyword) { toast(r.message || '没有可用关键词', 'err'); return; }
      S.keyword = r.keyword;
      return loadState().then(renderAll).then(function () {
        toast('关键词：' + r.keyword.text + (r.keyword.city ? ' · ' + r.keyword.city : ''), 'ok');
      });
    }).catch(function (e) { toast(e.message, 'err'); });
  });

  // 队列预览点击 → 切换当前
  $('#queueList').addEventListener('click', function (e) {
    var item = e.target.closest('[data-lead]');
    if (!item) return;
    S.leadId = item.getAttribute('data-lead');
    S.draftId = null;
    $('#draftText').value = '';
    $('#lintBox').innerHTML = '';
    renderQueue();
  });

  // 语气切换（委托）
  $('#toneChips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tone]');
    if (!b) return;
    S.tone = b.getAttribute('data-tone');
    renderQueue();
  });

  /* ------------------------------------------------------------ 起草 */

  function lintHtml(hits) {
    if (!hits.length) return '<div class="lint ok">没发现明显风险点。发之前自己再读一遍，别群发感太重。</div>';
    var parts = [];
    var types = {};
    hits.forEach(function (h) { (types[h.type] = types[h.type] || []).push(h.word); });
    if (types.offsite) {
      parts.push('<b>站外导流：</b>「' + types.offsite.join('、') + '」。平台禁止在私信里要微信/手机号、绕到站外交易，这条发出去有被限流甚至封号的风险，建议改成站内沟通。工具不会帮你换字规避——换字不改变行为性质。');
    }
    if (types.falseid) {
      parts.push('<b>虚构身份：</b>「' + types.falseid.join('、') + '」。别说自己是老客户/回头客，正常以潜在客户身份咨询就行。');
    }
    if (types.promise) {
      parts.push('<b>效果承诺：</b>「' + types.promise.join('、') + '」。绝对化用语有广告法风险。');
    }
    if (types.length) {
      parts.push('<b>偏长：</b>' + types.length[0] + '，私信里可能只显示前两行。');
    }
    return '<div class="lint ' + (types.offsite || types.falseid ? 'bad' : 'warn') + '">' + parts.join('<br>') + '</div>';
  }

  function setDraft(text, hits) {
    $('#draftText').value = text || '';
    $('#lintBox').innerHTML = text ? lintHtml(hits || []) : '';
  }

  $('#btnDraft').addEventListener('click', function () {
    var l = curLead();
    if (!l) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = '生成中…';
    sync('AI 起草中…', 'warn');
    api('/api/draft', { method: 'POST', body: { leadId: l.id, tone: S.tone } })
      .then(function (r) {
        S.draftId = r.draft.id;
        setDraft(r.draft.text, r.lint);
        if (r.draft.warn) toast(r.draft.warn + '，已用模板话术兜底', 'err');
        else toast(r.draft.source === 'ai' ? '已生成' : '已用模板话术', 'ok');
        return loadState().then(renderAll);
      })
      .catch(function (e) { toast(e.message, 'err'); sync('已同步', 'info'); })
      .then(function () { btn.disabled = false; btn.textContent = '✦ 生成'; });
  });

  // 输入时实时 lint（本地简版，规则与服务端一致）
  var lintTimer = null;
  $('#draftText').addEventListener('input', function () {
    var v = this.value;
    clearTimeout(lintTimer);
    lintTimer = setTimeout(function () {
      if (!v.trim()) { $('#lintBox').innerHTML = ''; return; }
      $('#lintBox').innerHTML = lintHtml(localLint(v));
    }, 220);
  });

  function localLint(text) {
    var hits = [];
    var lower = text.toLowerCase();
    ['微信', '威信', '薇信', 'vx', 'v信', 'wx', '加我', '私聊', '转账', '支付宝', '手机号', '电话'].forEach(function (w) {
      if (lower.indexOf(w.toLowerCase()) >= 0) hits.push({ type: 'offsite', word: w });
    });
    ['老客户', '回头客', '之前来过', '上次在', '老朋友'].forEach(function (w) {
      if (text.indexOf(w) >= 0) hits.push({ type: 'falseid', word: w });
    });
    ['保证', '包治', '100%', '百分百', '最便宜', '全网最低'].forEach(function (w) {
      if (text.indexOf(w) >= 0) hits.push({ type: 'promise', word: w });
    });
    if (text.length > 160) hits.push({ type: 'length', word: '正文 ' + text.length + ' 字' });
    return hits;
  }

  $('#btnCopy').addEventListener('click', function () {
    var v = $('#draftText').value.trim();
    if (!v) { toast('还没有内容', 'err'); return; }
    copyText(v).then(function () { toast('已复制，去抖音私信里粘贴', 'ok'); })
      .catch(function () { toast('复制失败，手动选中吧', 'err'); });
  });

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('fail')); }
      catch (e) { reject(e); }
      finally { ta.remove(); }
    });
  }

  $('#btnOpenProfile').addEventListener('click', function () {
    var l = curLead();
    if (!l) return;
    var url = l.profileUrl;
    if (!url) {
      var kw = (S.keyword && S.keyword.text) || l.industry || l.name;
      url = 'https://www.douyin.com/search/' + encodeURIComponent(kw + ' ' + (l.region || ''));
    }
    window.open(url, '_blank', 'noopener');
  });

  $('#btnSkip').addEventListener('click', function () {
    api('/api/queue/advance', { method: 'POST', body: {} })
      .then(function () { S.leadId = null; S.draftId = null; setDraft(''); return nextLead(); })
      .catch(function (e) { toast(e.message, 'err'); });
  });

  $('#btnExclude').addEventListener('click', function () {
    var l = curLead();
    if (!l) return;
    modal({
      title: '排除「' + l.name + '」',
      desc: '排除后不再进队列，档案保留，随时可以恢复。',
      fields: [{ key: 'reason', label: '原因（可不填）', type: 'text', value: '' }],
      okText: '排除',
      danger: true,
      onOk: function (v) {
        return api('/api/leads/' + l.id, { method: 'PATCH', body: { status: 'excluded', reason: v.reason || '手动排除' } })
          .then(function () { S.leadId = null; return nextLead(); });
      },
    });
  });

  $('#btnSent').addEventListener('click', function () {
    var l = curLead();
    if (!l) return;
    var text = $('#draftText').value.trim();
    if (!text) { toast('先写点内容，点「生成」也行', 'err'); return; }
    api('/api/leads/' + l.id + '/touch', {
      method: 'POST',
      body: { text: text, draftId: S.draftId, nextFollowUpDays: 3 },
    }).then(function () {
      toast('已记录，3 天后提醒跟进', 'ok');
      S.draftId = null;
      setDraft('');
      return nextLead();
    }).catch(function (e) { toast(e.message, 'err'); });
  });

  /* ------------------------------------------------------------ 线索库 */

  function filteredLeads() {
    var f = S.filter;
    return (S.state.leads || []).filter(function (l) {
      if (f.status && l.status !== f.status) return false;
      if (f.industry && l.industry !== f.industry) return false;
      if (f.q) {
        var q = f.q.toLowerCase();
        var hay = [l.name, l.dyId, l.region, l.industry, l.bio, l.note].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) {
      if (a.status === 'new' && b.status !== 'new') return -1;
      if (b.status === 'new' && a.status !== 'new') return 1;
      return (b.score || 0) - (a.score || 0);
    });
  }

  function renderLeads() {
    var list = filteredLeads();
    var rows = list.map(function (l) {
      var cd = l.cooldownLeft > 0 ? Math.ceil(l.cooldownLeft / 864e5) + ' 天' : '可联系';
      return '<tr data-id="' + l.id + '">' +
        '<td><div class="nm">' + esc(l.name) + '</div><div class="sub">' + (l.dyId ? esc(l.dyId) : '未填抖音号') + '</div></td>' +
        '<td><div>' + esc(l.region || '—') + '</div><div class="sub">' + esc(l.industry || '—') + '</div></td>' +
        '<td class="num">' + fmtFans(l.fans) + '</td>' +
        '<td>' + (l.verified ? '<span class="tag ok">企业</span>' : '<span class="tag warn">未认证</span>') +
          (l.private ? ' <span class="tag bad">私密</span>' : '') + '</td>' +
        '<td><span class="tag ' + (STATUS_CLASS[l.status] || '') + '" title="' + esc(l.excludeReason || '') + '">' + (STATUS_LABEL[l.status] || l.status) + '</span></td>' +
        '<td class="num">' + (l.score || 0) + '</td>' +
        '<td>' + (l.status === 'excluded' ? '<span class="hint">—</span>' : cd) + '</td>' +
        '<td style="white-space:nowrap">' +
          '<button class="btn sm ghost" data-act="edit">改</button> ' +
          (l.status === 'excluded'
            ? '<button class="btn sm ghost" data-act="restore">恢复</button>'
            : '<button class="btn sm ghost" data-act="queue">加入队列</button>') +
        '</td></tr>';
    }).join('');

    $('#leadRows').innerHTML = rows || '<tr><td colspan="8"><div class="empty" style="border:0;background:none"><strong>没有匹配的线索</strong>换个筛选，或者录入 / 导入商家</div></td></tr>';
    $('#leadCount').textContent = '共 ' + (S.state.leads || []).length + ' 条，当前显示 ' + list.length + ' 条';

    var inds = {};
    (S.state.leads || []).forEach(function (l) { if (l.industry) inds[l.industry] = 1; });
    var sel = $('#leadIndustry');
    var cur = sel.value;
    sel.innerHTML = '<option value="">全部行业</option>' + Object.keys(inds).sort().map(function (i) {
      return '<option value="' + esc(i) + '">' + esc(i) + '</option>';
    }).join('');
    sel.value = cur && inds[cur] ? cur : '';
  }

  var searchTimer = null;
  $('#leadSearch').addEventListener('input', function (e) {
    if (e.isComposing) return;
    var v = this.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { S.filter.q = v.trim(); renderLeads(); }, 180);
  });
  $('#leadSearch').addEventListener('compositionend', function () {
    S.filter.q = this.value.trim();
    renderLeads();
  });
  $('#leadStatus').addEventListener('change', function () { S.filter.status = this.value; renderLeads(); });
  $('#leadIndustry').addEventListener('change', function () { S.filter.industry = this.value; renderLeads(); });

  $('#leadRows').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    var tr = e.target.closest('[data-id]');
    if (!tr) return;
    var l = leadById(tr.getAttribute('data-id'));
    if (!l) return;
    var act = btn ? btn.getAttribute('data-act') : '';
    if (act === 'edit') return leadForm(l);
    if (act === 'queue') {
      if (l.status === 'excluded') { toast('先「恢复」它，再进队列', 'err'); return; }
      S.leadId = l.id;
      go('queue');
      renderQueue();
      return;
    }
    if (act === 'restore') {
      api('/api/leads/' + l.id, { method: 'PATCH', body: { status: 'new' } })
        .then(refresh).then(function () { toast('已恢复', 'ok'); })
        .catch(function (err) { toast(err.message, 'err'); });
      return;
    }
    if (!act) leadDetail(l);
  });

  function leadDetail(l) {
    modal({
      title: l.name,
      desc: '匹配分 ' + (l.score || 0) + ' · ' + (STATUS_LABEL[l.status] || l.status) + (l.excludeReason ? ' · ' + l.excludeReason : ''),
      html:
        '<div class="lead-meta">' +
        '<span>粉丝 <b>' + fmtFans(l.fans) + '</b></span>' +
        '<span>' + esc(l.region || '地区未知') + '</span>' +
        '<span>' + esc(l.industry || '行业未知') + '</span>' +
        '<span>作品 <b>' + (l.works || 0) + '</b></span>' +
        (l.dyId ? '<span class="mono">' + esc(l.dyId) + '</span>' : '') +
        '</div>' +
        (l.bio ? '<div class="lead-bio" style="margin-top:10px">' + esc(l.bio) + '</div>' : '') +
        '<div class="hint" style="margin-top:12px">最后联系：' + fmtClock(l.lastTouchAt) + ' · 创建：' + fmtClock(l.createdAt) + '</div>' +
        (l.profileUrl ? '<div style="margin-top:8px"><a href="' + esc(l.profileUrl) + '" target="_blank" rel="noopener">打开主页</a></div>' : ''),
      okText: '编辑',
      onOk: function () { setTimeout(function () { leadForm(l); }, 0); },
    });
  }

  function leadForm(l) {
    var isNew = !l;
    l = l || {};
    modal({
      title: isNew ? '录入商家' : '编辑「' + l.name + '」',
      desc: isNew ? '嫌手填麻烦？把抖音主页文字整个粘到下面，点「解析」，能自动填的都会填上。' : '',
      fields: [
        { key: 'paste', label: '粘贴主页原文（可选）', type: 'textarea', rows: 3, value: '', only: isNew },
        { key: 'name', label: '商家名称 *', type: 'text', value: l.name || '' },
        { key: 'dyId', label: '抖音号 / 主页链接', type: 'text', value: l.dyId || '' },
        { key: 'fans', label: '粉丝数（50–10000）', type: 'number', value: isFinite(Number(l.fans)) ? l.fans : '' },
        { key: 'region', label: '地区', type: 'text', value: l.region || '' },
        { key: 'industry', label: '主营 / 行业', type: 'text', value: l.industry || '' },
        { key: 'works', label: '作品数', type: 'number', value: isFinite(Number(l.works)) ? l.works : '' },
        { key: 'verified', label: '企业认证', type: 'checkbox', value: !!l.verified },
        { key: 'private', label: '私密账号', type: 'checkbox', value: !!l.private },
        { key: 'bio', label: '简介', type: 'textarea', rows: 2, value: l.bio || '' },
        { key: 'note', label: '我的备注', type: 'textarea', rows: 2, value: l.note || '' },
      ],
      parseFrom: 'paste',
      okText: isNew ? '保存' : '保存修改',
      onOk: function (v) {
        delete v.paste;
        var req = isNew
          ? api('/api/leads', { method: 'POST', body: v })
          : api('/api/leads/' + l.id, { method: 'PATCH', body: v });
        return req.then(function (r) {
          if (isNew && r.result && r.result.merged && r.result.merged.length) toast('这个商家已在库里，已合并补齐字段', 'ok');
          else toast(isNew ? '已录入' : '已保存', 'ok');
          return refresh();
        });
      },
    });
  }

  $('#btnAddLead').addEventListener('click', function () { leadForm(null); });

  $('#btnDemo').addEventListener('click', loadDemo);

  function loadDemo() {
    api('/api/demo', { method: 'POST', body: {} }).then(function (r) {
      toast('已载入 ' + r.added + ' 条示例（含 3 条会被硬筛选挡掉的）', 'ok');
      return refresh();
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  $('#btnExportCsv').addEventListener('click', function () { window.location.href = '/api/export?fmt=csv'; });
  $('#btnExportJson').addEventListener('click', function () { window.location.href = '/api/export?fmt=json'; });
  $('#btnExportJson2').addEventListener('click', function () { window.location.href = '/api/export?fmt=json'; });

  /* ------------------------------------------------------------ 导入 */

  $('#btnImport').addEventListener('click', function () {
    modal({
      title: '导入商家',
      desc: '支持 JSON 备份，或 CSV（表头：name,dyId,fans,verified,private,region,industry,works,bio）。按抖音号/名称去重，已存在只补空字段，不覆盖你的备注和冷却时间。',
      fields: [
        { key: 'text', label: '粘贴 JSON 或 CSV', type: 'textarea', rows: 8, value: '' },
      ],
      okText: '导入',
      onOk: function (v) {
        var items = parseImport(v.text);
        if (!items.length) throw new Error('没解析出内容，检查下格式');
        return api('/api/import', { method: 'POST', body: { leads: items } }).then(function (r) {
          toast('新增 ' + r.added + '，合并 ' + r.merged + '，跳过 ' + r.skipped, 'ok');
          return loadState().then(renderAll);
        });
      },
    });
  });

  function parseImport(text) {
    text = String(text || '').trim();
    if (!text) return [];
    if (text[0] === '{' || text[0] === '[') {
      try {
        var j = JSON.parse(text);
        if (Array.isArray(j)) return j;
        if (Array.isArray(j.leads)) return j.leads;
        return [j];
      } catch (e) { throw new Error('JSON 解析失败：' + e.message); }
    }
    return parseCsv(text);
  }

  function parseCsv(text) {
    var lines = text.replace(/\r\n?/g, '\n').split('\n').filter(function (x) { return x.trim(); });
    if (!lines.length) return [];
    function split(line) {
      var out = [], cur = '', q = false;
      for (var i = 0; i < line.length; i++) {
        var c = line[i];
        if (q) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') q = false;
          else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out.map(function (s) { return s.trim(); });
    }
    var head = split(lines[0]).map(function (h) { return h.toLowerCase(); });
    var hasHead = head.indexOf('name') >= 0 || head.indexOf('名称') >= 0;
    var rows = hasHead ? lines.slice(1) : lines;
    if (!hasHead) head = ['name', 'dyId', 'fans', 'region', 'industry', 'bio'];
    return rows.map(function (line) {
      var cells = split(line);
      var o = {};
      head.forEach(function (h, i) { o[h] = cells[i]; });
      if (o['名称'] !== undefined) o.name = o['名称'];
      if (o['粉丝'] !== undefined) o.fans = o['粉丝'];
      if (o['地区'] !== undefined) o.region = o['地区'];
      ['verified', 'private'].forEach(function (k) {
        if (o[k] !== undefined) o[k] = /^(1|true|是|y|yes)$/i.test(String(o[k]));
      });
      return o;
    }).filter(function (o) { return o.name || o.dyId; });
  }

  /* ------------------------------------------------------------ 关键词 */

  function renderKeywords() {
    var kws = S.state.keywords || [];
    var kwMs = (S.state.rules && S.state.rules.KW_COOLDOWN_MS) || 7 * 864e5;
    $('#kwRows').innerHTML = kws.map(function (k) {
      var cd = '';
      if (k.lastUsedAt && Date.now() - k.lastUsedAt < kwMs) {
        cd = Math.ceil((kwMs - (Date.now() - k.lastUsedAt)) / 864e5) + ' 天后可用';
      } else {
        cd = '<span class="tag ok">可用</span>';
      }
      return '<tr data-id="' + k.id + '">' +
        '<td><span class="nm">' + esc(k.text) + '</span></td>' +
        '<td><span class="tag">' + esc(k.cat || '—') + '</span></td>' +
        '<td>' + esc([k.province, k.city].filter(Boolean).join('·') || '不限') + '</td>' +
        '<td class="num">' + (k.useCount || 0) + '</td>' +
        '<td>' + cd + '</td>' +
        '<td>' + (k.active ? '<span class="tag ok">启用</span>' : '<span class="tag">停用</span>') + '</td>' +
        '<td style="white-space:nowrap">' +
          '<button class="btn sm ghost" data-act="toggle">' + (k.active ? '停用' : '启用') + '</button> ' +
          '<button class="btn sm ghost danger" data-act="del">删</button>' +
        '</td></tr>';
    }).join('') || '<tr><td colspan="7"><div class="hint" style="padding:16px 0">还没有关键词。上面批量加几个，比如「餐饮 | 厦门」「烤鱼 | 厦门」。</div></td></tr>';
  }

  $('#btnKwAdd').addEventListener('click', function () {
    var raw = $('#kwBulk').value.trim();
    if (!raw) { toast('先写点东西', 'err'); return; }
    var items = raw.split('\n').filter(function (x) { return x.trim(); }).map(function (line) {
      var p = line.split(/[|｜\t]/).map(function (s) { return s.trim(); });
      return { text: p[0], city: p[1] || '', cat: p[2] || '行业' };
    });
    api('/api/keywords', { method: 'POST', body: { items: items } }).then(function (r) {
      var msg = '新增 ' + r.added.length + ' 个';
      if (r.dup.length) msg += '，' + r.dup.length + ' 个重复被挡住';
      $('#kwAddResult').textContent = msg;
      toast(msg, r.added.length ? 'ok' : 'err');
      if (r.added.length) $('#kwBulk').value = '';
      return loadState().then(renderAll);
    }).catch(function (e) { toast(e.message, 'err'); });
  });

  $('#kwRows').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    var tr = e.target.closest('[data-id]');
    if (!btn || !tr) return;
    var id = tr.getAttribute('data-id');
    var k = (S.state.keywords || []).filter(function (x) { return x.id === id; })[0];
    if (!k) return;
    if (btn.getAttribute('data-act') === 'toggle') {
      api('/api/keywords/' + id, { method: 'PATCH', body: { active: !k.active } }).then(refresh);
    } else {
      api('/api/keywords/' + id, { method: 'DELETE' }).then(function () {
        toast('已删除', 'ok');
        return refresh();
      });
    }
  });

  /* ------------------------------------------------------------ 跟进 / 消息 */

  function renderFollow() {
    var st = S.state;
    var due = (st.leads || []).filter(function (l) {
      return l.followUpAt && l.followUpAt <= Date.now() && l.status !== 'won' && l.status !== 'invalid';
    }).sort(function (a, b) { return a.followUpAt - b.followUpAt; });

    var contacted = (st.leads || []).filter(function (l) {
      return l.status === 'contacted' && !l.replyAt;
    }).sort(function (a, b) { return (b.lastTouchAt || 0) - (a.lastTouchAt || 0); });

    var html = '';
    if (due.length) {
      html += '<div class="hint" style="margin-bottom:8px">到期 ' + due.length + ' 家</div>';
      html += due.map(function (l) { return followRow(l, '到期 ' + fmtAgo(l.followUpAt)); }).join('');
    }
    if (contacted.length) {
      html += '<div class="hint" style="margin:14px 0 8px">发过还没回的 ' + contacted.length + ' 家</div>';
      html += contacted.slice(0, 20).map(function (l) { return followRow(l, '最后联系 ' + fmtAgo(l.lastTouchAt)); }).join('');
    }
    $('#followList').innerHTML = html || '<div class="empty"><strong>没有待跟进</strong>标记过「已发送」的商家会在这里按时间冒出来</div>';

    var msgs = (st.messages || []).slice(0, 40);
    $('#msgList').innerHTML = msgs.length ? msgs.map(function (m) {
      var l = leadById(m.leadId);
      return '<div class="qitem" style="cursor:default">' +
        '<span class="tag ' + (m.direction === 'in' ? 'ok' : 'info') + '">' + (m.direction === 'in' ? '对方' : '我方') + '</span>' +
        '<span class="nm" style="white-space:normal">' + esc(m.text.slice(0, 90)) + (m.text.length > 90 ? '…' : '') + '</span>' +
        '<span class="sc">' + esc((l && l.name) || '已删除') + '</span>' +
        '<span class="sc">' + fmtAgo(m.at) + '</span></div>';
    }).join('') : '<div class="hint">还没有消息记录。标记「已发送」或录入对方回复后会出现。</div>';
  }

  function followRow(l, sub) {
    return '<div class="qitem" data-follow="' + l.id + '">' +
      '<span class="nm">' + esc(l.name) + '</span>' +
      '<span class="sc">' + fmtFans(l.fans) + '</span>' +
      '<span class="sc">' + esc(sub) + '</span>' +
      '<button class="btn sm ghost" data-act="reply">记回复</button>' +
      '<button class="btn sm ghost" data-act="again">再提醒</button>' +
      '<button class="btn sm ghost" data-act="done">结束</button></div>';
  }

  $('#followList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    var row = e.target.closest('[data-follow]');
    if (!btn || !row) return;
    var l = leadById(row.getAttribute('data-follow'));
    if (!l) return;
    var act = btn.getAttribute('data-act');
    if (act === 'reply') {
      modal({
        title: '记录「' + l.name + '」的回复',
        desc: '把对方回的原文粘进来，方便下次接话时看上下文。',
        fields: [{ key: 'text', label: '对方回复内容', type: 'textarea', rows: 4, value: '' }],
        okText: '保存',
        onOk: function (v) {
          return api('/api/leads/' + l.id + '/reply', { method: 'POST', body: { text: v.text } })
            .then(function () { toast('已记录', 'ok'); return refresh(); });
        },
      });
    } else if (act === 'again') {
      api('/api/leads/' + l.id, { method: 'PATCH', body: { followUpAt: Date.now() + 3 * 864e5 } })
        .then(function () { toast('3 天后再提醒', 'ok'); return refresh(); });
    } else if (act === 'done') {
      api('/api/leads/' + l.id, { method: 'PATCH', body: { followUpAt: 0 } })
        .then(function () { S.leadId = l.id; go('queue'); renderQueue(); });
    }
  });

  /* ------------------------------------------------------------ 草稿箱 */

  function renderDrafts() {
    var ds = (S.state.drafts || []).slice(0, 40);
    $('#draftList').innerHTML = ds.length ? ds.map(function (d) {
      return '<div class="card" style="margin-top:8px;background:var(--panel2)">' +
        '<div class="row" style="margin-bottom:6px">' +
        '<span class="tag">' + esc(d.leadName || '—') + '</span>' +
        '<span class="tag info">' + (TONE_LABEL[d.tone] || d.tone) + '</span>' +
        '<span class="tag ' + (d.source === 'ai' ? 'ok' : '') + '">' + (d.source === 'ai' ? 'AI · ' + esc(d.model || '') : '模板') + '</span>' +
        (d.sentAt ? '<span class="tag ok">已发送</span>' : '') +
        '<span class="spacer"></span><span class="hint">' + fmtAgo(d.createdAt) + '</span>' +
        '</div>' +
        '<div style="font-size:12.5px;color:var(--txt2);white-space:pre-wrap">' + esc(d.text) + '</div>' +
        '<div class="row" style="margin-top:8px"><button class="btn sm ghost" data-draft-copy="' + d.id + '">复制</button>' +
        '<button class="btn sm ghost danger" data-draft-del="' + d.id + '">删除</button></div>' +
        '</div>';
    }).join('') : '<div class="hint">还没生成过草稿。</div>';
  }

  $('#draftList').addEventListener('click', function (e) {
    var c = e.target.closest('[data-draft-copy]');
    var d = e.target.closest('[data-draft-del]');
    if (c) {
      var dr = (S.state.drafts || []).filter(function (x) { return x.id === c.getAttribute('data-draft-copy'); })[0];
      if (dr) copyText(dr.text).then(function () { toast('已复制', 'ok'); });
    } else if (d) {
      api('/api/drafts/' + d.getAttribute('data-draft-del'), { method: 'DELETE' })
        .then(function () { toast('已删除', 'ok'); return refresh(); });
    }
  });

  /* ------------------------------------------------------------ 统计 */

  function renderStats() {
    if (!S.state) return;
    api('/api/stats').then(function (s) {
      var kpis = [
        { k: '线索总数', v: s.total, cls: '' },
        { k: '待联系', v: (s.byStatus.new || 0) + (s.byStatus.contacted || 0), cls: 'acc2' },
        { k: '已联系', v: s.contacted, cls: '' },
        { k: '已回复', v: s.replied, cls: 'acc' },
        { k: '回复率', v: s.replyRate, cls: 'acc', unit: '%' },
        { k: '被硬筛掉', v: (s.byStatus.excluded || 0), cls: 'warn' },
        { k: '到期跟进', v: s.dueFollowUps, cls: 'warn' },
        { k: '冷却中关键词', v: s.coolingKeywords, cls: '' },
      ];
      $('#kpiGrid').innerHTML = kpis.map(function (x) {
        return '<div class="kpi"><div class="k">' + x.k + '</div><div class="v ' + x.cls + '">' + x.v +
          (x.unit ? '<small>' + x.unit + '</small>' : '') + '</div></div>';
      }).join('');

      $('#barStatus').innerHTML = bars(s.byStatus, STATUS_LABEL);
      $('#barIndustry').innerHTML = bars(s.byIndustry) || '<div class="hint">还没有行业数据</div>';
      $('#barReason').innerHTML = bars(s.excludeReasons) || '<div class="hint">还没挡掉任何线索</div>';
    }).catch(function () {});
  }

  function bars(obj, labels) {
    var keys = Object.keys(obj || {});
    if (!keys.length) return '';
    var max = Math.max.apply(null, keys.map(function (k) { return obj[k]; }));
    return keys.sort(function (a, b) { return obj[b] - obj[a]; }).map(function (k) {
      var pct = max ? Math.round((obj[k] / max) * 100) : 0;
      var label = (labels && labels[k]) || k;
      return '<div class="bar-row"><span class="lb" title="' + esc(label) + '">' + esc(label) + '</span>' +
        '<span class="tr"><span class="fl" style="width:' + pct + '%"></span></span>' +
        '<span class="vl">' + obj[k] + '</span></div>';
    }).join('');
  }

  /* ------------------------------------------------------------ 设置 */

  function renderSettings() {
    var s = S.state.settings;
    $('#setBase').value = s.aiBaseUrl || '';
    $('#setModel').value = s.aiModel || '';
    $('#setKey').value = '';
    $('#setKey').placeholder = s.aiKeySet ? '已设置 ' + s.aiKey + '（留空表示不修改）' : '还没设置，填一个 OpenAI 兼容的 Key';
    $('#setBrand').value = s.brandName || '';
    $('#setIndustry').value = s.industry || '';
    $('#setCity').value = s.city || '';
    $('#setCap').value = s.dailyCap || 30;
    $('#setNote').value = s.stationNote || '';
  }

  $('#btnSaveAi').addEventListener('click', function () {
    var body = { aiBaseUrl: $('#setBase').value.trim(), aiModel: $('#setModel').value.trim() };
    var k = $('#setKey').value.trim();
    if (k) body.aiKey = k;
    api('/api/settings', { method: 'POST', body: body }).then(function () {
      toast('AI 配置已保存', 'ok');
      return refresh();
    }).catch(function (e) { toast(e.message, 'err'); });
  });

  $('#btnSaveBiz').addEventListener('click', function () {
    api('/api/settings', {
      method: 'POST',
      body: {
        brandName: $('#setBrand').value.trim(),
        industry: $('#setIndustry').value.trim(),
        city: $('#setCity').value.trim(),
        dailyCap: Number($('#setCap').value) || 30,
        stationNote: $('#setNote').value,
      },
    }).then(function () {
      toast('已保存', 'ok');
      return refresh();
    }).catch(function (e) { toast(e.message, 'err'); });
  });

  $('#btnTestAi').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    $('#aiTestResult').textContent = '测试中…';
    api('/api/settings/test', { method: 'POST', body: {} }).then(function (r) {
      if (r.ok) {
        $('#aiTestResult').innerHTML = '<span class="tag ok">通 · ' + r.ms + 'ms · ' + esc(r.model || '') + '</span>';
        toast('AI 接口正常', 'ok');
      } else {
        $('#aiTestResult').innerHTML = '<span class="tag bad">失败</span> ' + esc(r.error);
      }
    }).catch(function (e) {
      $('#aiTestResult').textContent = e.message;
    }).then(function () { btn.disabled = false; });
  });

  $('#btnPresetDeepseek').addEventListener('click', function () {
    $('#setBase').value = 'https://api.deepseek.com';
    $('#setModel').value = 'deepseek-chat';
  });

  $('#btnPresetArk').addEventListener('click', function () {
    $('#setBase').value = 'https://ark.cn-beijing.volces.com/api/v3';
    $('#setModel').value = 'doubao-pro-32k';
    toast('模型要填你方舟里的 endpoint id，形如 ep-xxxx', 'ok');
  });

  $('#btnImportFile').addEventListener('click', function () { $('#fileInput').click(); });

  $('#fileInput').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var items = parseImport(String(reader.result));
        if (!items.length) { toast('文件里没解析出商家', 'err'); return; }
        api('/api/import', { method: 'POST', body: { leads: items } }).then(function (r) {
          toast('新增 ' + r.added + '，合并 ' + r.merged, 'ok');
          return loadState().then(renderAll);
        });
      } catch (e) { toast(e.message, 'err'); }
    };
    reader.readAsText(f);
    this.value = '';
  });

  /* ------------------------------------------------------------ 模态 */

  var modalState = { onOk: null, parser: null };

  function modal(cfg) {
    var host = $('#modalHost');
    var fieldsHtml = (cfg.fields || []).map(function (f) {
      var id = 'mf_' + f.key;
      if (f.type === 'checkbox') {
        return '<div class="field"><label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--txt)">' +
          '<input type="checkbox" id="' + id + '" data-f="' + f.key + '"' + (f.value ? ' checked' : '') + ' style="width:auto"> ' + esc(f.label) + '</label></div>';
      }
      if (f.type === 'textarea') {
        return '<div class="field"><label for="' + id + '">' + esc(f.label) + '</label>' +
          '<textarea id="' + id + '" data-f="' + f.key + '" rows="' + (f.rows || 3) + '">' + esc(f.value || '') + '</textarea></div>';
      }
      return '<div class="field"><label for="' + id + '">' + esc(f.label) + '</label>' +
        '<input type="' + (f.type || 'text') + '" id="' + id + '" data-f="' + f.key + '" value="' + esc(f.value == null ? '' : f.value) + '"></div>';
    }).join('');

    host.innerHTML =
      '<div class="modal-mask"><div class="modal" role="dialog" aria-modal="true">' +
      '<div class="modal-h"><h3>' + esc(cfg.title) + '</h3>' + (cfg.desc ? '<p>' + esc(cfg.desc) + '</p>' : '') + '</div>' +
      '<div class="modal-b">' + (cfg.html || '') + fieldsHtml +
        (cfg.parseFrom ? '<div class="row"><button class="btn sm" data-parse="' + cfg.parseFrom + '">解析粘贴的主页文字</button><span class="hint" data-parse-result></span></div>' : '') +
      '</div>' +
      '<div class="modal-f">' +
        (cfg.okText ? '<button class="btn ghost" data-close>取消</button>' : '<button class="btn" data-close>关闭</button>') +
        (cfg.okText ? '<button class="btn ' + (cfg.danger ? 'danger' : 'primary') + '" data-ok>' + esc(cfg.okText) + '</button>' : '') +
      '</div></div></div>';

    modalState.onOk = cfg.onOk || null;

    host.querySelector('[data-close]').addEventListener('click', closeModal);
    host.querySelector('.modal-mask').addEventListener('mousedown', function (e) {
      if (e.target === host.querySelector('.modal-mask')) closeModal();
    });

    var ok = host.querySelector('[data-ok]');
    if (ok) {
      ok.addEventListener('click', function () {
        var vals = collect();
        if (!modalState.onOk) return closeModal();
        ok.disabled = true;
        Promise.resolve()
          .then(function () { return modalState.onOk(vals); })
          .then(function () { closeModal(); })
          .catch(function (e) { toast(e.message || '保存失败', 'err'); })
          .then(function () { ok.disabled = false; });
      });
    }

    var parseBtn = host.querySelector('[data-parse]');
    if (parseBtn) {
      parseBtn.addEventListener('click', function () {
        var src = host.querySelector('[data-f="' + cfg.parseFrom + '"]');
        var parsed = parseProfile(src ? src.value : '');
        var filled = [];
        Object.keys(parsed).forEach(function (k) {
          var el = host.querySelector('[data-f="' + k + '"]');
          if (!el) return;
          if (el.type === 'checkbox') el.checked = !!parsed[k];
          else el.value = parsed[k];
          filled.push(k);
        });
        var r = host.querySelector('[data-parse-result]');
        if (r) r.textContent = filled.length ? '填了：' + filled.join('、') : '没认出字段，手动填吧';
      });
    }

    function collect() {
      var out = {};
      $$('[data-f]', host).forEach(function (el) {
        var k = el.getAttribute('data-f');
        if (el.type === 'checkbox') out[k] = el.checked;
        else out[k] = el.value.trim();
      });
      return out;
    }

    document.addEventListener('keydown', escClose);
    setTimeout(function () {
      var first = host.querySelector('input,textarea');
      if (first) first.focus();
    }, 50);
  }

  function escClose(e) {
    if (e.key === 'Escape') closeModal();
  }

  function closeModal() {
    document.removeEventListener('keydown', escClose);
    $('#modalHost').innerHTML = '';
    modalState.onOk = null;
  }

  /* ------------------------------------------------------------ 主页文本解析 */

  /** 从抖音主页复制的文字里抽字段。纯本地启发式，不上传任何东西。 */
  function parseProfile(text) {
    var out = {};
    text = String(text || '');
    if (!text.trim()) return out;
    var lines = text.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);

    // 粉丝：1.2万粉丝 / 粉丝 2380 / 2380粉丝
    var fm = text.match(/([\d.]+)\s*(万|w)?\s*粉\s*丝/i) || text.match(/粉\s*丝[：:\s]*([\d.]+)\s*(万|w)?/i);
    if (fm) {
      var n = parseFloat(fm[1]);
      if (fm[2]) n = n * 10000;
      out.fans = Math.round(n);
    }
    // 「作品 146」优先，避免把「粉丝 2380 作品 146」里的 2380 当成作品数
    var wm = text.match(/作\s*品[：:\s]*([\d.]+)\s*(万)?/) || text.match(/([\d.]+)\s*(万)?\s*作\s*品/);
    if (wm) {
      var w = parseFloat(wm[1]);
      if (wm[2]) w = w * 10000;
      out.works = Math.round(w);
    }
    if (/企业认证|蓝V|蓝v|官方认证|企业号/.test(text)) out.verified = true;
    if (/私密账号|该账号为私密/.test(text)) out.private = true;

    var rm = text.match(/IP\s*属地[：:\s]*([^\s|·]+)/i);
    if (rm) out.region = rm[1];
    if (!out.region) {
      var cities = ['厦门', '福州', '泉州', '漳州', '莆田', '宁德', '龙岩', '三明', '南平', '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '长沙', '西安', '重庆', '天津', '南京', '苏州', '郑州', '青岛', '合肥', '昆明', '南昌', '南宁', '贵阳', '海口', '石家庄', '太原', '济南', '沈阳', '长春', '哈尔滨', '兰州', '银川', '西宁', '乌鲁木齐', '呼和浩特', '拉萨'];
      for (var i = 0; i < cities.length; i++) {
        if (text.indexOf(cities[i]) >= 0) { out.region = cities[i]; break; }
      }
    }

    // 名称：优先「昵称：xxx」，否则第一行短文本
    var nm = text.match(/(?:昵称|商家名称|店名)[：:\s]*([^\n|]{2,30})/);
    if (nm) out.name = nm[1].trim();
    else if (lines[0] && lines[0].length <= 30 && !/粉丝|作品|关注|获赞/.test(lines[0])) out.name = lines[0];
    if (out.name) out.name = out.name.replace(/[（(].*?[）)]$/, function (m) { return m; }).trim();

    // 简介：取最长的一段不含数字统计的行
    var bioCandidates = lines.filter(function (l) {
      return l.length >= 8 && !/^(粉丝|作品|关注|获赞|IP属地|抖音号)/.test(l) && !/^[\d.\s万+]+$/.test(l);
    }).sort(function (a, b) { return b.length - a.length; });
    if (bioCandidates[0] && bioCandidates[0] !== out.name) out.bio = bioCandidates[0].slice(0, 200);

    var dym = text.match(/抖音号[：:\s]*([a-zA-Z0-9_.-]{2,30})/);
    if (dym) out.dyId = dym[1];

    return out;
  }

  /* ------------------------------------------------------------ 启动 */

  function boot() {
    var savedTheme = null;
    try { savedTheme = localStorage.getItem('ld_theme'); } catch (e) {}
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.documentElement.setAttribute('data-theme', 'light');
    }

    fetch('/api/session', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!s.authed) return showLogin();
        return loadState().then(function () { showApp(); renderAll(); });
      })
      .catch(function () { showLogin(); });
  }

  $('#themeBtn').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme') || 'dark';
    var next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('ld_theme', next); } catch (e) {}
  });

  if (typeof window !== 'undefined') {
    window.__leadDesk = { S: S, parseProfile: parseProfile, parseCsv: parseCsv, localLint: localLint, renderAll: renderAll, boot: boot, go: go };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
