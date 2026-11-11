'use strict';
/**
 * 前端交互测试：真后端 + jsdom 跑页面脚本。
 * 只桩掉 jsdom 没实现的东西（fetch 的 Cookie 管理、clipboard、window.open、scrollTo）。
 *
 * 跑法： NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node tests/ui.test.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (e) {
  console.error('需要 jsdom：NODE_PATH 指向含 jsdom 的 node_modules');
  process.exit(2);
}

const SERVER = path.join(__dirname, '..', 'server.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-ui-'));
const PORT = 5800 + Math.floor(Math.random() * 150);
const BASE = 'http://127.0.0.1:' + PORT;
const PW = 'ui-test-pass';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 200) : '')); console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 200) : '')); }
}
function eq(a, b, name) { ok(a === b, name, { got: a, want: b }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
async function startServer() {
  child = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, { LD_DATA_DIR: DATA, PORT: String(PORT), LD_PASSWORD: PW }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch (_) {}
    await sleep(100);
  }
  throw new Error('server 没起来: ' + out);
}

async function main() {
  await startServer();

  let jar = '';
  const dom = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    beforeParse(window) {
      window.fetch = async (url, init) => {
        init = init || {};
        const u = new URL(url, BASE).href;
        const headers = Object.assign({}, init.headers || {});
        if (jar && init.credentials !== 'omit') headers.Cookie = jar;
        const res = await fetch(u, { method: init.method || 'GET', headers, body: init.body });
        const sc = res.headers.get('set-cookie');
        if (sc) {
          const m = sc.match(/ld_session=[^;]*/);
          jar = m ? m[0] : '';
        }
        const text = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          headers: { get: (k) => res.headers.get(k) },
          text: async () => text,
          json: async () => JSON.parse(text),
        };
      };
      window.open = () => ({ closed: false, focus() {} });
      window.scrollTo = () => {};
      window.alert = () => {};
      try {
        Object.defineProperty(window.navigator, 'clipboard', {
          value: { writeText: async () => {} },
          configurable: true,
        });
      } catch (_) {}
    },
  });

  const win = dom.window;
  const doc = win.document;
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(doc.querySelectorAll(s));

  async function waitFor(fn, name, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 5000)) {
      try { if (fn()) return true; } catch (_) {}
      await sleep(40);
    }
    return false;
  }

  async function booted() {
    return waitFor(() => win.__leadDesk && ($('#login').hidden === false || $('#app').hidden === false), 'boot', 8000);
  }

  try {
    console.log('\n1. 首屏与登录');
    ok(await booted(), '页面脚本跑起来');
    ok($('#login').hidden === false, '未登录先显示登录页');
    ok($('#app').hidden === true, '登录前不显示主界面');

    $('#pw').value = 'wrong-pass';
    $('#loginForm').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    ok(await waitFor(() => /口令不对/.test($('#loginErr').textContent), 'x', 3000), '错口令在界面上报错：' + $('#loginErr').textContent);

    $('#pw').value = PW;
    $('#loginForm').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    ok(await waitFor(() => $('#app').hidden === false, 'x', 5000), '正确口令进入主界面');
    ok($('#login').hidden === true, '登录页收起');
    eq($('#badgeKw').textContent, '5', '侧栏显示 5 个预置关键词');
    eq($('#badgeLeads').textContent, '0', '初始 0 条线索');
    ok($('#queueEmpty').hidden === false, '无线索时显示空态');
    ok(/还没有线索/.test($('#queueEmpty').textContent), '空态文案引导录入');

    console.log('\n2. 载入示例 → 队列渲染');
    $('[data-view="leads"]').click();
    await sleep(60);
    eq($('#view-leads').hidden, false, '切到线索库');
    $('#btnDemo').click();
    ok(await waitFor(() => $('#leadRows').querySelectorAll('tr[data-id]').length === 8, 'x', 5000), '表格渲染 8 条示例');
    eq($('#badgeQueue').textContent, '4', '队列只装 4 条合格线索');
    ok(/共 8 条/.test($('#leadCount').textContent), '计数文案：' + $('#leadCount').textContent.trim());

    const rows = $$('#leadRows tr[data-id]');
    const badRow = rows.find((r) => /御膳/.test(r.textContent));
    ok(/已排除/.test(badRow.textContent), '18.6 万粉那条显示已排除');
    ok(/超出上限/.test(badRow.querySelector('.tag[title]').getAttribute('title')), '悬停提示写了排除原因');

    console.log('\n3. 筛选与搜索');
    $('#leadStatus').value = 'excluded';
    $('#leadStatus').dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(80);
    eq($$('#leadRows tr[data-id]').length, 4, '按「已排除」筛出 4 条');
    $('#leadStatus').value = '';
    $('#leadStatus').dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(80);

    $('#leadSearch').value = '烤鱼';
    $('#leadSearch').dispatchEvent(new win.Event('input', { bubbles: true }));
    await sleep(320);
    eq($$('#leadRows tr[data-id]').length, 1, '搜「烤鱼」得 1 条');
    $('#leadSearch').value = '';
    $('#leadSearch').dispatchEvent(new win.Event('input', { bubbles: true }));
    await sleep(320);
    eq($$('#leadRows tr[data-id]').length, 8, '清空搜索恢复 8 条');

    console.log('\n4. 队列卡片与话术生成');
    $('[data-view="queue"]').click();
    await sleep(60);
    eq($('#queueBody').hidden, false, '队列主体显示');
    ok(/\S/.test($('#leadName').textContent), '当前商家有名字：' + $('#leadName').textContent.trim());
    ok(/粉丝/.test($('#leadMeta').textContent), '商家信息里有粉丝数');
    ok(Number($('#leadScore').textContent) > 0, '匹配分算出来了：' + $('#leadScore').textContent);
    ok($$('#toneChips .chip').length === 4, '四种语气 chip');
    ok($('#toneChips .chip.on'), '默认选中一种语气');

    const leadNameBefore = $('#leadName').textContent;
    $('#btnDraft').click();
    ok(await waitFor(() => $('#draftText').value.length > 10, 'x', 6000), '点生成后 textarea 有内容');
    ok($('#lintBox').textContent.length > 0, '生成后出现合规检查提示');
    ok(!/微信/.test($('#draftText').value), '模板话术不含站外导流词');

    const emptyLint = $('#lintBox').textContent;
    $('#draftText').value = '老板你好，方便加个微信聊聊吗，我这边有合作想谈';
    $('#draftText').dispatchEvent(new win.Event('input', { bubbles: true }));
    ok(await waitFor(() => /站外导流/.test($('#lintBox').textContent), 'x', 2000), '写到「微信」立刻标红提示：' + $('#lintBox').textContent.slice(0, 40));
    ok($('#lintBox').querySelector('.lint.bad'), '用的是红级别样式');
    ok(/不会帮你换字规避/.test($('#lintBox').textContent), '明确说明不做谐音规避');

    $('#draftText').value = '你好，我们是老客户介绍来的，想问下起订量';
    $('#draftText').dispatchEvent(new win.Event('input', { bubbles: true }));
    ok(await waitFor(() => /虚构身份/.test($('#lintBox').textContent), 'x', 2000), '「老客户」被判为虚构身份');

    console.log('\n5. 标记已发送 → 队列前进');
    $('#draftText').value = '老板好，看到你们主页在做烤鱼，想问下现在接不接小批量的配送，起订量大概多少？';
    $('#draftText').dispatchEvent(new win.Event('input', { bubbles: true }));
    await sleep(60);
    $('#btnSent').click();
    ok(await waitFor(() => $('#qRemain').textContent === '3', 'x', 6000), '发完队列少一家：' + $('#qRemain').textContent);
    ok(await waitFor(() => $('#leadName').textContent !== leadNameBefore, 'x', 4000), '自动切到下一家');
    eq($('#draftText').value, '', '新卡片草稿框清空');

    console.log('\n6. 跳过 / 排除');
    const beforeSkip = $('#qRemain').textContent;
    $('#btnSkip').click();
    ok(await waitFor(() => $('#qRemain').textContent !== beforeSkip, 'x', 5000), '跳过也会前进');

    $('[data-view="leads"]').click();
    await sleep(60);
    const contactedRow = $$('#leadRows tr[data-id]').find((r) => /已联系/.test(r.textContent));
    ok(!!contactedRow, '线索库里那条已是「已联系」');

    console.log('\n7. 关键词：批量添加 / 去重 / 开关');
    $('[data-view="keywords"]').click();
    await sleep(60);
    eq($$('#kwRows tr[data-id]').length, 5, '初始 5 个关键词');
    $('#kwBulk').value = '咖啡 | 厦门 | 行业\n咖啡 | 厦门 | 行业\n烘焙 | 厦门 | 品类';
    $('#btnKwAdd').click();
    ok(await waitFor(() => $$('#kwRows tr[data-id]').length === 7, 'x', 5000), '加了 2 个（重复那条被挡）');
    ok(/1 个重复被挡住/.test($('#kwAddResult').textContent), '界面回报去重结果：' + $('#kwAddResult').textContent);

    const firstKw = $('#kwRows tr[data-id]');
    const toggleBtn = firstKw.querySelector('[data-act="toggle"]');
    toggleBtn.click();
    ok(await waitFor(() => /停用/.test(firstKw.textContent) || /启用/.test(firstKw.querySelector('[data-act="toggle"]').textContent), 'x', 4000), '能停用关键词');
    ok(await waitFor(() => $('#badgeKw').textContent === '6', 'x', 4000), '侧栏启用数跟着变：' + $('#badgeKw').textContent);

    console.log('\n8. 主页文本解析（本地启发式）');
    const p = win.__leadDesk.parseProfile;
    const parsed = p('巷子里烤鱼\n抖音号：xiangzi_yu\nIP属地：福建\n粉丝 2380  作品 146\n十年老店，只做活鱼现杀，晚市需订位。\n企业认证');
    eq(parsed.name, '巷子里烤鱼', '解析出名称');
    eq(parsed.dyId, 'xiangzi_yu', '解析出抖音号');
    eq(parsed.region, '福建', '解析出 IP 属地');
    eq(parsed.fans, 2380, '解析出粉丝数');
    eq(parsed.works, 146, '解析出作品数');
    eq(parsed.verified, true, '认出企业认证');
    ok(/活鱼现杀/.test(parsed.bio || ''), '解析出简介');

    const parsed2 = p('某某美甲\n1.2万粉丝\n私密账号');
    eq(parsed2.fans, 12000, '「1.2万粉丝」换算成 12000');
    eq(parsed2.private, true, '认出私密账号');

    console.log('\n9. CSV 解析 / 本地 lint');
    const csv = win.__leadDesk.parseCsv('name,fans,verified,region\n"陈记, 小吃",320,true,厦门\n李记,88,false,福州');
    eq(csv.length, 2, 'CSV 解析 2 行');
    eq(csv[0].name, '陈记, 小吃', '带逗号的引号字段不掉格');
    eq(csv[0].fans, '320', '数字字段原样');
    eq(csv[0].verified, true, '布尔字段转换');

    const L = win.__leadDesk.localLint;
    ok(L('方便加vx吗').some((h) => h.type === 'offsite'), 'vx 被识别');
    ok(L('保证全网最低').length >= 2, '承诺类命中多条');
    eq(L('想问下你们的起订量大概多少').length, 0, '正常话术不误报');

    console.log('\n10. 设置页与主题');
    $('[data-view="settings"]').click();
    await sleep(60);
    eq($('#setBase').value, 'https://api.deepseek.com', '接口地址回填默认值');
    ok(/还没设置/.test($('#setKey').placeholder), 'key 未配置时提示语正确');
    $('#btnPresetArk').click();
    ok(/volces/.test($('#setBase').value), '方舟预设填进地址');

    const themeBefore = doc.documentElement.getAttribute('data-theme');
    $('#themeBtn').click();
    ok(doc.documentElement.getAttribute('data-theme') !== themeBefore, '主题能切换');
    eq(win.localStorage.getItem('ld_theme'), doc.documentElement.getAttribute('data-theme'), '主题记在 localStorage');

    console.log('\n11. 统计 / 跟进 / 草稿箱');
    $('[data-view="stats"]').click();
    ok(await waitFor(() => $$('#kpiGrid .kpi').length >= 6, 'x', 4000), '统计卡片渲染 ' + $$('#kpiGrid .kpi').length + ' 个');
    ok(/回复率/.test($('#kpiGrid').textContent), '有回复率指标');

    $('[data-view="follow"]').click();
    await sleep(400);
    ok(/巷子里|陈记|阿芬|海沧|悦己/.test($('#followList').textContent), '跟进页列出了发过的商家');
    ok($('#followList').querySelector('[data-act="reply"]'), '有「记回复」按钮');

    $('[data-view="drafts"]').click();
    await sleep(60);
    ok($$('#draftList .card').length >= 1, '草稿箱里有记录：' + $$('#draftList .card').length);

    console.log('\n12. 模态：录入商家并解析');
    $('[data-view="leads"]').click();
    await sleep(60);
    $('#btnAddLead').click();
    ok(!!$('.modal-mask'), '弹出录入框');
    const paste = $('[data-f="paste"]');
    ok(!!paste, '有「粘贴主页原文」框');
    paste.value = '海边咖啡\n抖音号：haibian_coffee\n粉丝 680\n作品 42\nIP属地：福建\n手冲咖啡、轻食，早八开到晚十。\n企业认证';
    $('[data-parse]').click();
    await sleep(60);
    eq($('[data-f="name"]').value, '海边咖啡', '解析填入名称');
    eq($('[data-f="fans"]').value, '680', '解析填入粉丝数');
    eq($('[data-f="verified"]').checked, true, '勾上企业认证');

    $('[data-f="region"]').value = '厦门';
    $('[data-f="industry"]').value = '咖啡';
    $('[data-ok]').click();
    ok(await waitFor(() => $$('#leadRows tr[data-id]').length === 9, 'x', 5000), '保存后表格多一行（9 条）');
    ok(!$('.modal-mask'), '保存后模态关闭');

    const newRow = $$('#leadRows tr[data-id]').find((r) => /海边咖啡/.test(r.textContent));
    ok(/待联系/.test(newRow.textContent), '新线索状态是待联系');

    console.log('\n13. 刷新页面（模拟换设备）后数据仍在');
    jar = ''; // 清掉会话，走一次重新登录
    const dom2 = await JSDOM.fromURL(BASE + '/', {
      runScripts: 'dangerously', resources: 'usable',
      beforeParse(w) {
        w.fetch = window2Fetch;
        w.open = () => ({});
        w.scrollTo = () => {};
        try { Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true }); } catch (_) {}
      },
    });
    const w2 = dom2.window, d2 = w2.document;
    const $2 = (s) => d2.querySelector(s);
    let t0 = Date.now();
    while (Date.now() - t0 < 6000 && !(w2.__leadDesk && $2('#login').hidden === false)) await sleep(50);
    $2('#pw').value = PW;
    $2('#loginForm').dispatchEvent(new w2.Event('submit', { bubbles: true, cancelable: true }));
    t0 = Date.now();
    while (Date.now() - t0 < 6000 && $2('#app').hidden !== false) await sleep(50);
    eq($2('#badgeLeads').textContent, '9', '新会话读到 9 条线索');
    ok(Number($2('#badgeQueue').textContent) <= 4, '队列剩余 ' + $2('#badgeQueue').textContent + '（冷却生效）');

    dom2.window.close();

  } catch (e) {
    fail++;
    console.error('\n[测试异常]', e && e.stack || e);
  } finally {
    try { dom.window.close(); } catch (_) {}
    if (child) child.kill('SIGTERM');
    await sleep(300);
    if (child) { try { child.kill('SIGKILL'); } catch (_) {} }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n' + '='.repeat(58));
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
  console.log('='.repeat(58) + '\n');
  process.exit(fail ? 1 : 0);
}

// 第二个窗口用的 fetch（同样的 Cookie jar 逻辑，闭包外提）
let sharedJar = '';
async function window2Fetch(url, init) {
  init = init || {};
  const u = new URL(url, BASE).href;
  const headers = Object.assign({}, init.headers || {});
  if (sharedJar) headers.Cookie = sharedJar;
  const res = await fetch(u, { method: init.method || 'GET', headers, body: init.body });
  const sc = res.headers.get('set-cookie');
  if (sc) { const m = sc.match(/ld_session=[^;]*/); sharedJar = m ? m[0] : ''; }
  const text = await res.text();
  return { ok: res.ok, status: res.status, headers: { get: (k) => res.headers.get(k) }, text: async () => text, json: async () => JSON.parse(text) };
}

main();
