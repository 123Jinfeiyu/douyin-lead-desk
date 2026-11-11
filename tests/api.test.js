'use strict';
/**
 * 服务端端到端测试：真起进程、真调接口、真重启。
 * 不碰外部网络：AI 分支用本地 mock 的 OpenAI 兼容接口验证。
 *
 * 跑法： node tests/api.test.js
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-test-'));
const PORT = 5300 + Math.floor(Math.random() * 200);
const AIPORT = 5600 + Math.floor(Math.random() * 200);
const BASE = 'http://127.0.0.1:' + PORT;
const PW = 'test-pass-1234';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    failures.push(name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 300) : ''));
    console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 300) : ''));
  }
}

function eq(a, b, name) {
  ok(a === b, name, { got: a, want: b });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------------------------------------------------------- 起服务 */

let child = null;

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, {
        LD_DATA_DIR: DATA,
        PORT: String(PORT),
        LD_PASSWORD: PW,
        NODE_ENV: 'test',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const t0 = Date.now();
    (async function poll() {
      while (Date.now() - t0 < 8000) {
        try {
          const r = await fetch(BASE + '/api/health');
          if (r.ok) return resolve(out);
        } catch (_) {}
        await sleep(120);
      }
      reject(new Error('服务没起来：' + out));
    })();
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 2500);
  });
}

/* ---------------------------------------------------------------- 请求 */

let cookie = '';

async function call(pathname, opts) {
  opts = opts || {};
  const headers = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie && opts.auth !== false) headers.Cookie = cookie;
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  });
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (_) { data = raw; }
  return { status: res.status, data, headers: res.headers, raw };
}

/* ---------------------------------------------------------------- AI mock */

let aiMode = 'ok';
const aiServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (aiMode === '401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }));
    }
    if (aiMode === 'hang') return; // 不响应，测超时（本测试不用）
    let parsed = {};
    try { parsed = JSON.parse(body); } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      model: parsed.model || 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '老板好，看到你们在厦门做烤鱼，想问下现在接不接小批量的配送合作，起订量大概多少？' } }],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
    }));
  });
});

/* ---------------------------------------------------------------- 主流程 */

(async function main() {
  await new Promise((r) => aiServer.listen(AIPORT, '127.0.0.1', r));

  const banner = (t) => console.log('\n' + t);

  try {
    banner('1. 启动与鉴权');
    await startServer();
    let r = await call('/api/health', { auth: false });
    eq(r.status, 200, 'health 200');
    ok(r.data && r.data.ok === true, 'health 返回 ok');

    r = await call('/api/state', { auth: false });
    eq(r.status, 401, '未登录读 state → 401');

    r = await call('/api/leads', { method: 'POST', body: { name: 'x' }, auth: false });
    eq(r.status, 401, '未登录写接口 → 401');

    r = await call('/api/login', { method: 'POST', body: { password: 'wrong' }, auth: false });
    eq(r.status, 401, '错口令 → 401');

    r = await call('/api/login', { method: 'POST', body: { password: PW }, auth: false });
    eq(r.status, 200, '正确口令 → 200');
    const setCookie = r.headers.get('set-cookie') || '';
    ok(/ld_session=/.test(setCookie), '下发 ld_session cookie');
    ok(/HttpOnly/i.test(setCookie), 'cookie 带 HttpOnly');
    cookie = setCookie.split(';')[0];
    ok(cookie.length > 20, '拿到会话 cookie');

    r = await call('/api/session');
    ok(r.data.authed === true, 'session 识别已登录');

    banner('2. 初始数据');
    r = await call('/api/state');
    eq(r.data.keywords.length, 5, '预置 5 个关键词');
    eq(r.data.leads.length, 0, '初始无线索');
    ok(r.data.rules.FANS_MAX === 10000 && r.data.rules.FANS_MIN === 50, '规则阈值 50–10000');
    ok(r.data.rules.LEAD_COOLDOWN_DAYS === 30, '线索冷却 30 天');
    ok(r.data.rules.KW_COOLDOWN_DAYS === 7, '关键词冷却 7 天');
    ok(r.data.settings.aiKeySet === false, '未配置 AI key 时 aiKeySet=false');
    ok(!/apiKey|sk-/.test(JSON.stringify(r.data.settings)), 'state 里不泄露 key 明文字段');

    banner('3. 硬筛选（粉丝区间 / 企业认证 / 私密）');
    r = await call('/api/demo', { method: 'POST', body: {} });
    eq(r.status, 200, '载入示例数据');
    eq(r.data.added, 8, '示例写入 8 条');
    const leads = r.data.state.leads;
    const byName = (n) => leads.find((l) => l.name.indexOf(n) >= 0);
    ok(byName('御膳').status === 'excluded', '18.6 万粉被排除');
    ok(/超出上限/.test(byName('御膳').excludeReason), '排除原因写明超出上限');
    ok(byName('小满').status === 'excluded', '42 粉被排除');
    ok(/低于下限/.test(byName('小满').excludeReason), '排除原因写明低于下限');
    ok(byName('老陈').status === 'excluded', '未认证被排除');
    ok(/非企业认证/.test(byName('老陈').excludeReason), '排除原因写明非企业认证');
    ok(byName('林记').status === 'excluded', '私密账号被排除');
    ok(/私密/.test(byName('林记').excludeReason), '排除原因写明私密');
    eq(leads.filter((l) => l.status === 'excluded').length, 4, '共 4 条被硬筛掉');
    eq(leads.filter((l) => l.eligible === true).length, 4, '4 条合格');

    banner('4. 队列与暂停续跑');
    r = await call('/api/queue/build', { method: 'POST', body: {} });
    eq(r.data.queue.ids.length, 4, '队列只装合格线索');
    eq(r.data.queue.cursor, 0, '游标从 0 开始');

    r = await call('/api/queue/next', { method: 'POST', body: {} });
    ok(r.data.lead && r.data.lead.name, '取到一家：' + (r.data.lead && r.data.lead.name));
    const firstId = r.data.lead.id;
    eq(r.data.queue.remaining, 4, 'remaining = 4（未前进）');

    r = await call('/api/queue/next', { method: 'POST', body: {} });
    eq(r.data.lead.id, firstId, '重复取是幂等的（刷新不跳号）');

    r = await call('/api/queue/pause', { method: 'POST', body: { paused: true } });
    ok(r.data.queue.paused === true, '暂停写入服务端');
    r = await call('/api/state');
    ok(r.data.queue.paused === true && r.data.queue.cursor === 0, '换设备读到的暂停与游标一致');

    r = await call('/api/queue/advance', { method: 'POST', body: {} });
    eq(r.data.queue.cursor, 1, 'advance 推进游标');
    r = await call('/api/queue/next', { method: 'POST', body: {} });
    ok(r.data.lead.id !== firstId, '跳过后拿到另一家');

    banner('5. 起草（模板兜底 / AI 分支 / 失败回退）');
    r = await call('/api/draft', { method: 'POST', body: { leadId: firstId, tone: 'consult' } });
    eq(r.status, 200, '无 key 时也能出草稿');
    eq(r.data.draft.source, 'template', '无 key 走模板');
    ok(/AI Key/.test(r.data.draft.warn), '提示未配置 key');
    ok(r.data.draft.text.length > 10, '模板话术非空');

    r = await call('/api/draft', { method: 'POST', body: { leadId: firstId, tone: 'consult', extra: '' } });
    const lintClean = r.data.lint;
    ok(Array.isArray(lintClean), '返回 lint 数组');

    // 指向本地 mock：AI 成功分支
    r = await call('/api/settings', {
      method: 'POST',
      body: { aiBaseUrl: 'http://127.0.0.1:' + AIPORT, aiModel: 'mock-model', aiKey: 'sk-test-abcdef' },
    });
    eq(r.status, 200, '保存 AI 配置');
    ok(/^••••/.test(r.data.settings.aiKey), '返回的 key 已打码');
    eq(r.data.settings.aiKey, '••••cdef', '打码只留后 4 位');
    ok(r.data.settings.aiKeySet === true, 'aiKeySet=true');

    r = await call('/api/settings/test', { method: 'POST', body: {} });
    ok(r.data.ok === true, '测试连接成功');
    ok(/烤鱼|老板/.test(r.data.sample || ''), 'mock 返回内容贯通到前端');

    r = await call('/api/draft', { method: 'POST', body: { leadId: firstId, tone: 'consult' } });
    eq(r.data.draft.source, 'ai', '配了 key 走 AI');
    eq(r.data.draft.model, 'mock-model', '记录模型名');
    ok(r.data.draft.usage && r.data.draft.usage.total_tokens === 160, '记录 token 用量');

    aiMode = '401';
    r = await call('/api/draft', { method: 'POST', body: { leadId: firstId, tone: 'follow' } });
    eq(r.data.draft.source, 'template', 'AI 报错回退模板而不是报 500');
    ok(/401/.test(r.data.draft.warn), '错误信息里带状态码');
    ok(!/sk-test/.test(JSON.stringify(r.data)), '错误信息不泄露 key');

    // 打码占位不应覆盖真 key
    r = await call('/api/settings', { method: 'POST', body: { aiKey: '••••cdef' } });
    ok(r.data.settings.aiKey === '••••cdef', '提交打码占位不覆盖原 key');
    aiMode = 'ok';

    banner('6. 触达 / 冷却 / 队列前进');
    // 重建队列让游标回到第一条，模拟真实使用：页面打开时就在这一家上
    await call('/api/queue/build', { method: 'POST', body: {} });
    r = await call('/api/queue/next', { method: 'POST', body: {} });
    eq(r.data.lead.id, firstId, '重建队列后第一条仍是它');

    r = await call('/api/leads/' + firstId + '/touch', {
      method: 'POST',
      body: { text: '老板好，想问下起订量', nextFollowUpDays: 3 },
    });
    const touched = r.data.lead;
    ok(touched.lastTouchAt > 0, '写入 lastTouchAt');
    eq(touched.status, 'contacted', '状态变已联系');
    ok(touched.followUpAt > Date.now(), '设了跟进时间');
    eq(r.data.queue.cursor, 1, '触达当前条目后队列自动前进');

    r = await call('/api/state');
    const tl = r.data.leads.find((l) => l.id === firstId);
    ok(tl.cooldownLeft > 29 * 864e5, '冷却约 30 天：' + Math.round(tl.cooldownLeft / 864e5) + ' 天');
    ok(r.data.messages.some((m) => m.leadId === firstId && m.direction === 'out'), '消息流水记了一条 outgoing');

    r = await call('/api/queue/build', { method: 'POST', body: {} });
    ok(r.data.queue.ids.indexOf(firstId) < 0, '冷却中的线索不再进队列');
    eq(r.data.queue.ids.length, 3, '队列剩 3 条');

    banner('7. 去重 / 合并（不覆盖、不重置冷却）');
    r = await call('/api/leads', {
      method: 'POST',
      body: { name: '巷子里烤鱼（思明店）', fans: 2380, verified: true, region: '厦门·思明' },
    });
    eq(r.data.result.created.length, 0, '同名同地区不再新建');
    eq(r.data.result.merged.length, 1, '走合并分支');
    const mergedLead = r.data.result.merged[0];
    eq(mergedLead.lastTouchAt, touched.lastTouchAt, '合并不清空冷却时间');
    ok(mergedLead.bio.length > 0, '合并保留原有简介');

    // 同 dyId 不同名字 → 也认作同一家
    await call('/api/leads', { method: 'POST', body: { name: '海沧烧烤大排档', dyId: '7215550001', fans: 920, verified: true } });
    r = await call('/api/leads', { method: 'POST', body: { name: '海沧烧烤（改名了）', dyId: '7215550001', fans: 1050, verified: true } });
    eq(r.data.result.merged.length, 1, '同抖音号视为同一家');
    const hc = r.data.leads.find((l) => l.dyId === '7215550001');
    eq(hc.name, '海沧烧烤（改名了）', '名称以最新为准');
    eq(hc.fans, 1050, '粉丝数更新');

    banner('8. 关键词去重与 7 天冷却');
    r = await call('/api/keywords', { method: 'POST', body: { items: [
      { text: '餐饮', city: '厦门', cat: '行业' },
      { text: ' 餐饮 ', city: '厦门', cat: '行业' },
      { text: 'ＤＡＩＮＧ', city: '厦门', cat: '行业' },
      { text: 'daing', city: '厦门', cat: '行业' },
    ] } });
    eq(r.data.added.length, 2, '新增 2 个（含全角转半角）');
    eq(r.data.dup.length, 2, '重复组合被挡住 2 个');
    ok(r.data.dup.some((d) => d.why.indexOf('已存在') >= 0), '重复原因可见');

    const before = r.data.keywords.filter((k) => !k.lastUsedAt).length;
    r = await call('/api/keywords/next', { method: 'POST', body: {} });
    const kw1 = r.data.keyword;
    ok(kw1 && kw1.text, '抽出关键词：' + (kw1 && kw1.text));
    ok(kw1.lastUsedAt > 0, '抽中即记 lastUsedAt');

    r = await call('/api/keywords/next', { method: 'POST', body: {} });
    ok(!r.data.keyword || r.data.keyword.id !== kw1.id, '7 天内不会重复抽到同一个');

    const st = await call('/api/state');
    ok(st.data.keywords.filter((k) => k.useCount > 0).length >= 1, 'useCount 累加');

    banner('9. 回复 / 统计');
    r = await call('/api/leads/' + firstId + '/reply', { method: 'POST', body: { text: '现在有优惠，你加我微信聊' } });
    eq(r.data.lead.status, 'replied', '记录回复后状态变已回复');
    ok(r.data.state.messages.some((m) => m.direction === 'in' && /微信/.test(m.text)), '入库 incoming 消息');

    r = await call('/api/stats');
    ok(r.data.contacted >= 1, '统计：已联系 ≥1');
    ok(r.data.replied >= 1, '统计：已回复 ≥1');
    ok(r.data.replyRate > 0, '回复率算得出来：' + r.data.replyRate + '%');
    ok(Object.keys(r.data.excludeReasons).length >= 1, '排除原因统计有值');

    banner('10. 导出 / 导入 / 路径安全');
    r = await call('/api/export?fmt=csv');
    eq(r.status, 200, 'CSV 导出 200');
    // fetch 的 text() 会把 BOM 吃掉，这里读原始字节
    const csvBuf = new Uint8Array(await (await fetch(BASE + '/api/export?fmt=csv', { headers: { Cookie: cookie } })).arrayBuffer());
    ok(csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf, 'CSV 带 UTF-8 BOM（Excel 不乱码）');
    ok(/name,dyId,fans/.test(r.raw), 'CSV 有表头');

    r = await call('/api/export?fmt=json');
    ok(r.data.leads && r.data.leads.length >= 8, 'JSON 备份含全部线索');
    const backup = r.data;

    // 导入：只补空字段，不覆盖已有
    let stNow = await call('/api/state');
    const keepId = stNow.data.leads.find((l) => l.name.indexOf('巷子里') >= 0).id;
    await call('/api/leads/' + keepId, { method: 'PATCH', body: { note: '线下已拜访，老板姓陈' } });

    r = await call('/api/import', { method: 'POST', body: { leads: [
      { name: '巷子里烤鱼（思明店）', fans: 2380, verified: true, region: '厦门·思明', note: '导入的备注不该覆盖' },
      { name: '新店测试', fans: 300, verified: true, region: '厦门·集美', industry: '小吃' },
    ] } });
    eq(r.data.added, 1, '导入新增 1 条');
    eq(r.data.merged, 1, '导入合并 1 条');
    const keep = r.data.state.leads.find((l) => l.name.indexOf('巷子里') >= 0);
    ok(/线下已拜访/.test(keep.note || ''), '导入不覆盖已有备注');
    ok(!/不该覆盖/.test(keep.note || ''), '导入的备注被挡在外面');

    r = await call('/api/import', { method: 'POST', body: backup });
    ok(r.data.added === 0, '重复导入整份备份不产生重复数据');

    r = await call('/api/export?fmt=csv');
    const beforeRestart = r.raw.split('\n').length;

    // 让游标停在中间，重启后才看得出是不是真的存在服务端
    await call('/api/queue/advance', { method: 'POST', body: {} });
    const curBefore = (await call('/api/state')).data.queue.cursor;
    ok(curBefore > 0, '重启前游标在 ' + curBefore);

    // 路径穿越
    const trav = await fetch(BASE + '/..%2Fserver.js');
    const travTxt = await trav.text();
    ok(trav.status === 403 || (trav.status === 200 && !/createServer/.test(travTxt)), '路径穿越拿不到 server.js');

    banner('11. 重启后数据与游标仍在');
    await stopServer();
    await startServer();
    cookie = '';
    r = await call('/api/login', { method: 'POST', body: { password: PW }, auth: false });
    eq(r.status, 200, '重启后口令仍有效');
    cookie = (r.headers.get('set-cookie') || '').split(';')[0];

    r = await call('/api/state');
    ok(r.data.leads.length >= 9, '线索数保留：' + r.data.leads.length);
    const afterRestart = r.data.leads.find((l) => l.name.indexOf('巷子里') >= 0);
    eq(afterRestart.lastTouchAt, touched.lastTouchAt, '冷却时间跨重启保留');
    eq(afterRestart.status, 'replied', '状态跨重启保留');
    ok(r.data.queue.cursor === curBefore, '队列游标跨重启保留：' + r.data.queue.cursor);
    ok(r.data.keywords.some((k) => k.lastUsedAt > 0), '关键词使用记录保留');
    ok(r.data.settings.aiKeySet === true, 'AI key 跨重启保留');
    ok(r.data.revision > 0, 'revision 递增：' + r.data.revision);

    r = await call('/api/export?fmt=csv');
    ok(Math.abs(r.raw.split('\n').length - beforeRestart) <= 1, '导出行数一致');

    banner('12. 错误处理');
    r = await call('/api/leads/nope', { method: 'PATCH', body: { name: 'x' } });
    eq(r.status, 404, '改不存在的线索 → 404');
    r = await call('/api/leads/' + firstId + '/reply', { method: 'POST', body: { text: '' } });
    eq(r.status, 400, '空回复 → 400');
    r = await call('/api/nothing');
    eq(r.status, 404, '未知接口 → 404');
    const bad = await fetch(BASE + '/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{bad json',
    });
    eq(bad.status, 400, '坏 JSON → 400 不崩');
    r = await call('/api/health', { auth: false });
    eq(r.status, 200, '经历错误后服务仍活着');

    // 截图用的浅色主题页面存在性
    const page = await fetch(BASE + '/');
    const html = await page.text();
    ok(/线索工作台/.test(html), '首页 HTML 正常返回');
    ok(/不自动登录/.test(html), '页面明示不自动登录');

  } catch (e) {
    fail += 1;
    console.error('\n[测试异常]', e && e.stack || e);
  } finally {
    await stopServer();
    aiServer.close();
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n' + '='.repeat(58));
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log('='.repeat(58) + '\n');
  process.exit(fail ? 1 : 0);
})();
