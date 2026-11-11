'use strict';
/**
 * 抖音商家线索工作台 —— 服务端（零依赖 Node）
 *
 * 设计原则：
 * 1) 服务端是唯一数据权威。前端刷新、换设备、关页面都不会丢，暂停/续跑靠服务端游标。
 * 2) AI Key 只存在服务端，前端永远拿不到明文（只回打码尾号）。
 * 3) 不做任何自动登录、自动点击、自动发消息。发送动作由人完成，服务端只记录「已发送」。
 * 4) 写盘用「临时文件 + rename」原子替换，并保留最近 5 份快照，防半截写坏库。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA_DIR = process.env.LD_DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');
const PASS_FILE = path.join(DATA_DIR, 'password.txt');
const PORT = Number(process.env.PORT || process.env.LD_PORT || 5178);
const HOST = process.env.HOST || '0.0.0.0';

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ 基础工具 */

function secret() {
  if (process.env.LD_SECRET) return process.env.LD_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}
const SECRET = secret();

function passwordHash(pw) {
  return crypto.scryptSync(String(pw), SECRET.slice(0, 32), 32).toString('hex');
}

function ensurePassword() {
  if (process.env.LD_PASSWORD) return process.env.LD_PASSWORD;
  if (fs.existsSync(PASS_FILE)) {
    const v = fs.readFileSync(PASS_FILE, 'utf8').trim();
    if (v) return v;
  }
  // 生成一个好念但不易猜的口令：4 段小写词 + 4 位数字
  const words = ['lime', 'moss', 'fern', 'dune', 'reef', 'gale', 'kite', 'opal', 'silk', 'wave'];
  const pw = [0, 1, 2, 3].map(() => words[crypto.randomInt(words.length)]).join('-') + '-' + crypto.randomInt(1000, 9999);
  fs.writeFileSync(PASS_FILE, pw, { mode: 0o600 });
  return pw;
}
const PASSWORD = ensurePassword();
const PASS_HASH = passwordHash(PASSWORD);

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 32);
}

function makeSession() {
  const exp = Date.now() + 7 * 864e5;
  const payload = String(exp);
  return payload + '.' + sign(payload);
}

function checkSession(cookieVal) {
  if (!cookieVal || cookieVal.indexOf('.') < 0) return false;
  const [exp, sig] = cookieVal.split('.');
  if (!exp || !sig) return false;
  if (!safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now();
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

const now = () => Date.now();
const uid = (p) => (p || 'x') + '_' + now().toString(36) + crypto.randomBytes(3).toString('hex');

/* ------------------------------------------------------------------ 规范化 */

/** 全角转半角、去标点空格、小写：关键词去重与检索都用它 */
function normKw(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/[\s\-_·.,，。、;；:：!！?？'"'"()（）\[\]【】<>《》/\\|+*#@~`^&%$]/g, '')
    .trim();
}

function normDyId(s) {
  let v = String(s || '').trim().toLowerCase();
  v = v.replace(/^https?:\/\//, '');
  const m = v.match(/(?:douyin\.com)\/(?:user|share\/user)\/([a-z0-9_\-]+)/i);
  if (m) return 'sec:' + m[1].toLowerCase();
  v = v.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return v;
}

function kwKey(k) {
  return [normKw(k.text), normKw(k.cat), normKw(k.province), normKw(k.city)].join('|');
}

function leadKey(l) {
  const dy = normDyId(l.dyId || l.profileUrl || '');
  if (dy) return 'dy:' + dy;
  return 'nm:' + normKw(l.name) + '|' + normKw(l.region);
}

/* ------------------------------------------------------------------ 数据层 */

const EMPTY_DB = () => ({
  version: 3,
  createdAt: now(),
  revision: 0,
  settings: {
    brandName: '',
    industry: '',
    city: '',
    stationNote: '',
    dailyCap: 30,
    aiBaseUrl: 'https://api.deepseek.com',
    aiModel: 'deepseek-chat',
    aiKey: '',
    aiToneDefault: 'consult',
  },
  keywords: [],
  leads: [],
  drafts: [],
  messages: [],
  log: [],
  queue: { ids: [], cursor: 0, paused: false, builtAt: 0, filter: null },
});

let DB = null;
let writeChain = Promise.resolve();

function seedKeywords(db) {
  const preset = [
    { text: '餐饮', cat: '行业', province: '福建', city: '厦门' },
    { text: '烤鱼', cat: '品类', province: '福建', city: '厦门' },
    { text: '美容', cat: '行业', province: '福建', city: '厦门' },
    { text: '火锅', cat: '品类', province: '福建', city: '福州' },
    { text: '奶茶', cat: '品类', province: '福建', city: '泉州' },
  ];
  preset.forEach((p) => {
    const k = Object.assign({ id: uid('kw'), active: true, createdAt: now(), lastUsedAt: 0, useCount: 0, note: '' }, p);
    k.key = kwKey(k);
    db.keywords.push(k);
  });
}

function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') {
        const base = EMPTY_DB();
        DB = Object.assign(base, d);
        DB.settings = Object.assign(base.settings, d.settings || {});
        DB.queue = Object.assign(base.queue, d.queue || {});
        ['keywords', 'leads', 'drafts', 'messages', 'log'].forEach((k) => {
          if (!Array.isArray(DB[k])) DB[k] = [];
        });
        return;
      }
    } catch (e) {
      // 库坏了：把坏文件留档，从备份恢复，不静默清空
      const bad = DB_FILE + '.broken-' + now();
      try { fs.renameSync(DB_FILE, bad); } catch (_) {}
      console.error('[db] 数据库解析失败，已留档到', bad, e.message);
      const bak = listBackups()[0];
      if (bak) {
        try {
          DB = Object.assign(EMPTY_DB(), JSON.parse(fs.readFileSync(bak, 'utf8')));
          console.error('[db] 已从备份恢复：', bak);
          return;
        } catch (_) {}
      }
    }
  }
  DB = EMPTY_DB();
  seedKeywords(DB);
  saveDb('init');
}

function listBackups() {
  try {
    return fs
      .readdirSync(DATA_DIR)
      .filter((f) => /^snapshot-.*\.json$/.test(f))
      .sort()
      .reverse()
      .map((f) => path.join(DATA_DIR, f));
  } catch (_) {
    return [];
  }
}

function saveDb(reason) {
  DB.revision = (DB.revision || 0) + 1;
  DB.updatedAt = now();
  const text = JSON.stringify(DB, null, 1);
  const tmp = DB_FILE + '.tmp-' + process.pid;
  writeChain = writeChain.then(() => {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, DB_FILE); // 原子替换
    if (reason !== 'quiet') maybeSnapshot(text);
  }).catch((e) => {
    console.error('[db] 写盘失败', e.message);
  });
  return writeChain;
}

let lastSnap = 0;
function maybeSnapshot(text) {
  if (now() - lastSnap < 10 * 60 * 1000) return;
  lastSnap = now();
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'snapshot-' + now() + '.json'), text);
    const all = listBackups();
    all.slice(5).forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
  } catch (_) {}
}

function logAct(act, ref, extra) {
  DB.log.unshift({ id: uid('lg'), at: now(), act, ref: ref || '', extra: extra || '' });
  if (DB.log.length > 800) DB.log.length = 800;
}

/* ------------------------------------------------------------------ 业务规则 */

const FANS_MIN = 50;
const FANS_MAX = 10000;
const LEAD_COOLDOWN_DAYS = 30;
const KW_COOLDOWN_DAYS = 7;
const DAY = 864e5;

/** 硬筛选。返回 null 表示合格，否则返回不合格原因 */
function ineligible(l) {
  const fans = Number(l.fans);
  if (l.private === true) return '私密账号（无法查看主页作品）';
  if (Number.isFinite(fans) && fans > FANS_MAX) return '粉丝 ' + fmtFans(fans) + ' 超出上限 1 万';
  if (Number.isFinite(fans) && fans < FANS_MIN) return '粉丝 ' + fmtFans(fans) + ' 低于下限 50';
  if (!Number.isFinite(fans)) return '粉丝数未知（无法判断是否在 50–10000 区间）';
  if (l.verified !== true) return '非企业认证账号';
  return null;
}

function fmtFans(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(n);
}

function cooldownLeft(l) {
  if (!l.lastTouchAt) return 0;
  const left = l.lastTouchAt + LEAD_COOLDOWN_DAYS * DAY - now();
  return left > 0 ? left : 0;
}

function eligibleAt(ts) {
  return ts + LEAD_COOLDOWN_DAYS * DAY - now();
}

function scoreOf(l) {
  let s = 0;
  const fans = Number(l.fans) || 0;
  // 500–5000 粉的商家最像「有预算、还没被骚扰烂」
  if (fans >= 500 && fans <= 5000) s += 30;
  else if (fans >= 200) s += 18;
  else s += 8;
  if (l.verified) s += 22;
  if (l.bio) s += 10;
  if (Number(l.works) >= 20) s += 8;
  if (l.recentActive) s += 8;
  if (l.industryMatch) s += 12;
  if (l.followUpAt && l.followUpAt < now()) s += 6;
  return Math.min(100, s);
}

function statusOf(l) {
  if (l.status === 'excluded') return 'excluded';
  if (l.status === 'replied') return 'replied';
  if (l.status === 'won') return 'won';
  if (l.status === 'invalid') return 'invalid';
  if (l.lastTouchAt) return 'contacted';
  return 'new';
}

function normalizeLead(input, existing) {
  const l = Object.assign({}, existing || {}, input || {});
  l.id = (existing && existing.id) || l.id || uid('ld');
  l.name = String(l.name || '').trim().slice(0, 60) || '未命名商家';
  l.dyId = String(l.dyId || '').trim().slice(0, 120);
  l.profileUrl = String(l.profileUrl || '').trim().slice(0, 300);
  l.region = String(l.region || '').trim().slice(0, 40);
  l.industry = String(l.industry || '').trim().slice(0, 40);
  l.bio = String(l.bio || '').slice(0, 600);
  l.note = String(l.note || '').slice(0, 600);
  l.source = String(l.source || '').slice(0, 60);
  l.fans = l.fans === '' || l.fans === undefined || l.fans === null ? NaN : Number(l.fans);
  l.works = l.works === '' || l.works === undefined ? NaN : Number(l.works);
  l.verified = l.verified === true || l.verified === 'true' || l.verified === 1;
  l.private = l.private === true || l.private === 'true' || l.private === 1;
  l.recentActive = l.recentActive === true || l.recentActive === 'true';
  l.industryMatch = l.industryMatch === true || l.industryMatch === 'true';
  l.tags = Array.isArray(l.tags) ? l.tags.slice(0, 8).map((t) => String(t).slice(0, 16)) : [];
  l.createdAt = l.createdAt || now();
  l.updatedAt = now();
  l.key = leadKey(l);
  l.score = scoreOf(l);
  const reason = ineligible(l);
  if (reason) {
    l.excludeReason = reason;
    if (l.status !== 'excluded') l.status = 'excluded';
  } else if (l.status === 'excluded' && !l.manualExclude) {
    l.status = l.lastTouchAt ? 'contacted' : 'new';
    l.excludeReason = '';
  }
  return l;
}

function buildQueue(filter) {
  const f = filter || {};
  const ids = [];
  DB.leads.forEach((l) => {
    if (l.status === 'excluded' || l.status === 'invalid' || l.status === 'won') return;
    if (cooldownLeft(l) > 0) return;
    if (f.industry && l.industry !== f.industry) return;
    if (f.region && l.region.indexOf(f.region) < 0) return;
    if (f.status && statusOf(l) !== f.status) return;
    ids.push(l.id);
  });
  ids.sort((a, b) => {
    const A = DB.leads.find((x) => x.id === a) || {};
    const B = DB.leads.find((x) => x.id === b) || {};
    if ((B.score || 0) !== (A.score || 0)) return (B.score || 0) - (A.score || 0);
    return (A.createdAt || 0) - (B.createdAt || 0);
  });
  DB.queue = { ids, cursor: 0, paused: false, builtAt: now(), filter: f };
  return DB.queue;
}

/** 新线索进来时，如果队列是空的或已经跑完，自动重建一次。
    队列还有剩余时不打断当前进度。 */
function ensureQueue() {
  const q = DB.queue || {};
  if (!Array.isArray(q.ids) || !q.ids.length || q.cursor >= q.ids.length) {
    buildQueue(q.filter);
    return true;
  }
  return false;
}

function pickNextKeyword() {  const usable = DB.keywords.filter((k) => {
    if (!k.active) return false;
    if (!k.lastUsedAt) return true;
    return now() - k.lastUsedAt > KW_COOLDOWN_DAYS * DAY;
  });
  if (!usable.length) return null;
  // 用得少的优先，避免某个词被反复抽
  usable.sort((a, b) => (a.useCount || 0) - (b.useCount || 0) || (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
  return usable[0];
}

/* ------------------------------------------------------------------ AI 起草 */

const BANNED_ASK = ['微信', '威信', '薇信', 'vx', 'v信', 'wx', '加我', '私聊', '转账', '支付宝', '手机号', '电话'];

function systemPrompt(s) {
  const brand = s.brandName || '我方';
  const ind = s.industry || '本地服务';
  return [
    '你是一名' + ind + '行业的商务拓展，代表「' + brand + '」在抖音上给本地商家发站内私信。',
    '写作要求：',
    '1. 你是以「潜在客户/询价方」的身份做正常商务咨询，不是商家本人的熟人。',
    '2. 严禁虚构身份：不要说自己是老客户、回头客、之前来过、朋友介绍过，也不要假装已经下过单。',
    '3. 严禁索要或提及微信、VX、手机号、支付宝等站外联系方式，也不要提转账、私下交易——平台规则不允许，写了会被限流甚至封号。',
    '4. 结合对方主页信息（地区、主营、简介、作品）提一个具体问题，证明你看过他的主页。',
    '5. 不承诺效果、不贬低同行、不用感叹号堆砌，不群发感。',
    '6. 中文口语，60–90 字，只输出正文，不要加引号、不要写「你好我是」这种开场套话以外的多余解释。',
    '7. 结尾用一句轻问句（如「方便说下大概价位吗」），不做强推。',
  ].join('\n');
}

function userPrompt(lead, tone, extra) {
  const bits = [];
  bits.push('商家名称：' + lead.name);
  if (lead.industry) bits.push('主营：' + lead.industry);
  if (lead.region) bits.push('地区：' + lead.region);
  if (Number.isFinite(Number(lead.fans))) bits.push('粉丝数：' + lead.fans);
  if (lead.bio) bits.push('主页简介：' + lead.bio);
  if (lead.works) bits.push('作品数：' + lead.works);
  if (lead.note) bits.push('我的备注：' + lead.note);
  const toneMap = {
    consult: '目的：第一次接触，以潜在客户身份问一个跟主营相关的具体问题，试探是否有合作/采购意向。',
    follow: '目的：之前发过一条没回，这次换个角度跟进，不要重复上次内容，语气更轻。',
    reply: '目的：对方已经回复了，接着他的话往下聊，目标是约到一个明确的下一步（报价/到店/发案例）。',
    sample: '目的：对方在卖服务/产品，我想先要个报价或案例，语气像真实买家。',
  };
  bits.push(toneMap[tone] || toneMap.consult);
  if (extra) bits.push('补充要求：' + extra);
  return bits.join('\n');
}

async function callAI(db, opts) {
  const s = db.settings;
  if (!s.aiKey) {
    const err = new Error('还没配置 AI Key（设置 → AI 起草）');
    err.code = 'NO_KEY';
    throw err;
  }
  let base = String(s.aiBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) {
    const err = new Error('还没配置接口地址');
    err.code = 'NO_BASE';
    throw err;
  }
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const body = {
    model: s.aiModel || 'deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt(s) },
      { role: 'user', content: userPrompt(opts.lead, opts.tone, opts.extra) },
    ],
    temperature: 0.8,
    max_tokens: 400,
    stream: false,
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.aiKey },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error(e.name === 'AbortError' ? 'AI 接口 30 秒未响应' : '连不上 AI 接口：' + e.message);
    err.code = 'NET';
    throw err;
  }
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = (j.error && (j.error.message || j.error.code)) || j.message || detail;
    } catch (_) {}
    const err = new Error('AI 接口返回 ' + res.status + '：' + detail);
    err.code = 'HTTP';
    err.status = res.status;
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch (_) {
    const err = new Error('AI 接口返回的不是 JSON');
    err.code = 'PARSE';
    throw err;
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) {
    const err = new Error('AI 接口返回内容为空');
    err.code = 'EMPTY';
    throw err;
  }
  return {
    text: String(content).trim().replace(/^["「『]|["」』]$/g, ''),
    model: data.model || body.model,
    usage: data.usage || null,
  };
}

/** 只做提示，不改写。规避检测是另一回事，这里只标出「平台不允许」的东西 */
function lintDraft(text) {
  const hits = [];
  const lower = String(text).toLowerCase();
  BANNED_ASK.forEach((w) => {
    if (lower.indexOf(w.toLowerCase()) >= 0) hits.push({ type: 'offsite', word: w });
  });
  ['老客户', '回头客', '之前来过', '上次在', '老朋友'].forEach((w) => {
    if (text.indexOf(w) >= 0) hits.push({ type: 'falseid', word: w });
  });
  ['保证', '包治', '100%', '百分百', '最便宜', '全网最低'].forEach((w) => {
    if (text.indexOf(w) >= 0) hits.push({ type: 'promise', word: w });
  });
  if (text.length > 160) hits.push({ type: 'length', word: '正文 ' + text.length + ' 字' });
  return hits;
}

const TEMPLATES = {
  consult: [
    '你好，看到你们在{region}做{industry}，我这边最近想找一家长期合作的门店，请问现在接单大概是什么价位？',
    '老板好，翻了下你们主页的作品，{industry}这块做得挺细。想问下如果小批量的话能不能接，起订大概多少？',
    '你好，{region}这边{industry}的门店我在对比几家，方便说下你们的服务和报价区间吗？我先了解下再决定。',
  ],
  follow: [
    '老板好，前两天发过一条可能被刷下去了。就一个小问题：你们{industry}这块现在忙不忙，接新的合作吗？',
    '再打扰一次，还是想确认下{industry}的报价大概区间，不方便细说也没关系，给个大致范围就行。',
  ],
  reply: [
    '收到，谢谢回复。那我先按你刚说的记一下，方便的话能不能发个之前的案例或者价目，我看完给你准信。',
    '明白了。那我这边整理下需求，明天给你回个具体的量，到时候再麻烦你报个价。',
  ],
  sample: [
    '你好，想先要一份{industry}的报价单或者做过的案例，我这边在选供应商，看完再约时间细聊。',
  ],
};

function templateDraft(lead, tone) {
  const pool = TEMPLATES[tone] || TEMPLATES.consult;
  const t = pool[Math.floor(Math.random() * pool.length)];
  return t.replace(/\{region\}/g, lead.region || '本地').replace(/\{industry\}/g, lead.industry || '这块业务');
}

/* ------------------------------------------------------------------ HTTP */

function send(res, status, obj, headers) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 4 * 1024 * 1024)) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUB, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUB)) return send(res, 403, { error: '禁止访问' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 兜底：未知路径回首页
      const idx = path.join(PUB, 'index.html');
      if (fs.existsSync(idx)) {
        const b = fs.readFileSync(idx);
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        return res.end(b);
      }
      return send(res, 404, { error: 'Not found' });
    }
    const ext = path.extname(file).toLowerCase();
    const b = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': b.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(b);
  });
}

function publicState() {
  const s = DB.settings;
  return {
    revision: DB.revision,
    serverTime: now(),
    settings: Object.assign({}, s, {
      aiKey: s.aiKey ? '••••' + String(s.aiKey).slice(-4) : '',
      aiKeySet: Boolean(s.aiKey),
    }),
    keywords: DB.keywords,
    leads: DB.leads.map((l) => Object.assign({}, l, {
      eligible: ineligible(l) === null,
      cooldownLeft: cooldownLeft(l),
      status: statusOf(l),
      nextEligibleAt: l.lastTouchAt ? l.lastTouchAt + LEAD_COOLDOWN_DAYS * DAY : 0,
    })),
    drafts: DB.drafts.slice(0, 200),
    messages: DB.messages.slice(0, 400),
    log: DB.log.slice(0, 200),
    queue: Object.assign({}, DB.queue, { remaining: Math.max(0, DB.queue.ids.length - DB.queue.cursor) }),
    rules: {
      FANS_MIN, FANS_MAX,
      LEAD_COOLDOWN_DAYS, KW_COOLDOWN_DAYS,
      LEAD_COOLDOWN_MS: LEAD_COOLDOWN_DAYS * DAY,
      KW_COOLDOWN_MS: KW_COOLDOWN_DAYS * DAY,
    },
    nextKeyword: pickNextKeyword(),
  };
}

const routes = [];
function route(method, re, fn) {
  routes.push({ method, re, fn });
}

/* --- 认证 --- */

route('GET', /^\/api\/health$/, async (req, res) => {
  send(res, 200, { ok: true, revision: DB.revision, time: now() });
});

route('POST', /^\/api\/login$/, async (req, res, m, body, ctx) => {
  const pw = String(body.password || '');
  if (!pw) return send(res, 400, { error: '请输入访问口令' });
  if (!safeEqual(passwordHash(pw), PASS_HASH)) {
    ctx.delay();
    return send(res, 401, { error: '口令不对' });
  }
  const token = makeSession();
  send(res, 200, { ok: true, revision: DB.revision }, {
    'Set-Cookie': 'ld_session=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + 7 * 86400,
  });
});

route('POST', /^\/api\/logout$/, async (req, res) => {
  send(res, 200, { ok: true }, { 'Set-Cookie': 'ld_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
});

route('GET', /^\/api\/session$/, async (req, res, m, b, ctx) => {
  send(res, 200, { authed: ctx.authed });
});

/* --- 状态 --- */

route('GET', /^\/api\/state$/, async (req, res) => {
  send(res, 200, publicState());
});

/* --- 关键词 --- */

route('POST', /^\/api\/keywords$/, async (req, res, m, body) => {
  const items = Array.isArray(body.items) ? body.items : [body];
  const added = [];
  const dup = [];
  items.forEach((raw) => {
    const k = {
      id: uid('kw'),
      text: String(raw.text || '').trim().slice(0, 40),
      cat: String(raw.cat || '行业').trim().slice(0, 20),
      province: String(raw.province || '').trim().slice(0, 20),
      city: String(raw.city || '').trim().slice(0, 20),
      note: String(raw.note || '').slice(0, 100),
      active: true,
      createdAt: now(),
      lastUsedAt: 0,
      useCount: 0,
    };
    if (!k.text) return;
    k.key = kwKey(k);
    const hit = DB.keywords.find((x) => x.key === k.key);
    if (hit) {
      dup.push({ text: k.text, cat: k.cat, city: k.city, why: '已存在同一组合' });
      return;
    }
    DB.keywords.push(k);
    added.push(k);
  });
  if (added.length) {
    logAct('keyword.add', '', '新增 ' + added.length + ' 个');
    saveDb();
  }
  send(res, 200, { added, dup, keywords: DB.keywords });
});

route('PATCH', /^\/api\/keywords\/([^/]+)$/, async (req, res, m, body, ctx) => {
  const k = DB.keywords.find((x) => x.id === ctx.params[0]);
  if (!k) return send(res, 404, { error: '关键词不存在' });
  if (typeof body.active === 'boolean') k.active = body.active;
  if (body.text !== undefined) {
    k.text = String(body.text).trim().slice(0, 40);
    k.key = kwKey(k);
  }
  if (body.note !== undefined) k.note = String(body.note).slice(0, 100);
  saveDb();
  send(res, 200, { keyword: k, keywords: DB.keywords });
});

route('DELETE', /^\/api\/keywords\/([^/]+)$/, async (req, res, m, b, ctx) => {
  const i = DB.keywords.findIndex((x) => x.id === ctx.params[0]);
  if (i < 0) return send(res, 404, { error: '关键词不存在' });
  DB.keywords.splice(i, 1);
  saveDb();
  send(res, 200, { keywords: DB.keywords });
});

/** 抽一个可用关键词（7 天冷却；抽过就记 lastUsedAt） */
route('POST', /^\/api\/keywords\/next$/, async (req, res) => {
  const k = pickNextKeyword();
  if (!k) {
    const cooling = DB.keywords.filter((x) => x.active).length;
    return send(res, 200, {
      keyword: null,
      cooling,
      message: cooling ? '所有启用的关键词都在 7 天冷却里' : '关键词库是空的，先去加几个',
    });
  }
  k.lastUsedAt = now();
  k.useCount = (k.useCount || 0) + 1;
  logAct('keyword.use', k.id, k.text);
  saveDb();
  send(res, 200, { keyword: k, keywords: DB.keywords });
});

/* --- 线索 --- */

route('POST', /^\/api\/leads$/, async (req, res, m, body) => {
  const raw = Array.isArray(body.items) ? body.items : [body];
  const out = { created: [], merged: [], rejected: [] };
  raw.forEach((item) => {
    if (!item || (!item.name && !item.dyId && !item.profileUrl)) {
      out.rejected.push({ name: (item && item.name) || '', why: '缺少商家名称' });
      return;
    }
    const probe = normalizeLead(item, null);
    const hit = DB.leads.find((x) => x.key === probe.key);
    if (hit) {
      // 合并而不是覆盖：新数据补齐旧数据里空着的字段，已有值保留
      const merged = normalizeLead(item, hit);
      ['fans', 'works', 'region', 'industry', 'bio', 'dyId', 'profileUrl'].forEach((f) => {
        const v = item[f];
        const empty = hit[f] === undefined || hit[f] === '' || (typeof hit[f] === 'number' && !Number.isFinite(hit[f]));
        if (empty && v !== undefined && v !== '') merged[f] = hit[f] === undefined ? v : merged[f];
      });
      DB.leads[DB.leads.indexOf(hit)] = merged;
      out.merged.push(merged);
      return;
    }
    DB.leads.push(probe);
    out.created.push(probe);
  });
  if (out.created.length || out.merged.length) {
    ensureQueue();
    logAct('lead.import', '', '新增 ' + out.created.length + '，合并 ' + out.merged.length);
    saveDb();
  }
  send(res, 200, { result: out, leads: publicState().leads });
});

route('PATCH', /^\/api\/leads\/([^/]+)$/, async (req, res, m, body, ctx) => {
  const i = DB.leads.findIndex((x) => x.id === ctx.params[0]);
  if (i < 0) return send(res, 404, { error: '线索不存在' });
  const before = DB.leads[i];
  if (body.status === 'excluded') {
    DB.leads[i] = normalizeLead({ status: 'excluded', manualExclude: true, excludeReason: body.reason || '手动排除' }, before);
  } else if (body.status) {
    DB.leads[i] = normalizeLead({ status: body.status, manualExclude: false, excludeReason: '' }, before);
  } else {
    DB.leads[i] = normalizeLead(body, before);
  }
  logAct('lead.update', DB.leads[i].id, Object.keys(body).join(','));
  saveDb();
  send(res, 200, { lead: DB.leads[i], leads: publicState().leads });
});

route('DELETE', /^\/api\/leads\/([^/]+)$/, async (req, res, m, b, ctx) => {
  const i = DB.leads.findIndex((x) => x.id === ctx.params[0]);
  if (i < 0) return send(res, 404, { error: '线索不存在' });
  DB.leads.splice(i, 1);
  DB.drafts = DB.drafts.filter((d) => d.leadId !== ctx.params[0]);
  DB.messages = DB.messages.filter((d) => d.leadId !== ctx.params[0]);
  saveDb();
  send(res, 200, { leads: publicState().leads });
});

/** 人工点过发送之后，记一次触达：写冷却、加消息、推进游标 */
route('POST', /^\/api\/leads\/([^/]+)\/touch$/, async (req, res, m, body, ctx) => {
  const l = DB.leads.find((x) => x.id === ctx.params[0]);
  if (!l) return send(res, 404, { error: '线索不存在' });
  const text = String(body.text || '').slice(0, 1000);
  l.lastTouchAt = now();
  l.msgCount = (l.msgCount || 0) + 1;
  l.status = 'contacted';
  l.excludeReason = '';
  l.updatedAt = now();
  if (!l.firstTouchAt) l.firstTouchAt = l.lastTouchAt;
  if (text) {
    DB.messages.unshift({ id: uid('ms'), leadId: l.id, direction: 'out', text, at: now(), channel: 'douyin-dm' });
  }
  if (body.draftId) {
    const d = DB.drafts.find((x) => x.id === body.draftId);
    if (d) d.sentAt = now();
  }
  if (body.nextFollowUpDays) {
    l.followUpAt = now() + Number(body.nextFollowUpDays) * DAY;
  }
  const qi = DB.queue.ids.indexOf(l.id);
  if (qi === DB.queue.cursor) DB.queue.cursor = qi + 1;
  else if (qi > DB.queue.cursor) DB.queue.ids.splice(qi, 1);
  logAct('lead.touch', l.id, l.name);
  saveDb();
  send(res, 200, { lead: l, queue: DB.queue, state: publicState() });
});

route('POST', /^\/api\/leads\/([^/]+)\/reply$/, async (req, res, m, body, ctx) => {
  const l = DB.leads.find((x) => x.id === ctx.params[0]);
  if (!l) return send(res, 404, { error: '线索不存在' });
  const text = String(body.text || '').slice(0, 1000);
  if (!text) return send(res, 400, { error: '回复内容不能为空' });
  DB.messages.unshift({ id: uid('ms'), leadId: l.id, direction: 'in', text, at: now(), channel: 'douyin-dm' });
  l.status = 'replied';
  l.replyAt = now();
  l.updatedAt = now();
  if (body.nextFollowUpDays) l.followUpAt = now() + Number(body.nextFollowUpDays) * DAY;
  logAct('lead.reply', l.id, l.name);
  saveDb();
  send(res, 200, { lead: l, state: publicState() });
});

/* --- 队列 --- */

route('POST', /^\/api\/queue\/build$/, async (req, res, m, body) => {
  const q = buildQueue(body || {});
  saveDb();
  send(res, 200, { queue: Object.assign({}, q, { remaining: q.ids.length - q.cursor }) });
});

route('POST', /^\/api\/queue\/next$/, async (req, res) => {
  if (!DB.queue.ids.length) buildQueue(DB.queue.filter);
  const q = DB.queue;
  while (q.cursor < q.ids.length) {
    const l = DB.leads.find((x) => x.id === q.ids[q.cursor]);
    if (l && l.status !== 'excluded' && cooldownLeft(l) === 0) break;
    q.cursor += 1;
  }
  if (q.cursor >= q.ids.length) {
    saveDb();
    return send(res, 200, { lead: null, queue: Object.assign({}, q, { remaining: 0 }), done: true });
  }
  saveDb();
  send(res, 200, {
    lead: DB.leads.find((x) => x.id === q.ids[q.cursor]),
    queue: Object.assign({}, q, { remaining: q.ids.length - q.cursor }),
    keyword: pickNextKeyword(),
  });
});

route('POST', /^\/api\/queue\/advance$/, async (req, res) => {
  DB.queue.cursor = Math.min(DB.queue.ids.length, DB.queue.cursor + 1);
  saveDb();
  send(res, 200, { queue: DB.queue });
});

route('POST', /^\/api\/queue\/pause$/, async (req, res, m, body) => {
  DB.queue.paused = Boolean(body.paused);
  saveDb();
  send(res, 200, { queue: DB.queue });
});

/* --- 起草 --- */

route('POST', /^\/api\/draft$/, async (req, res, m, body) => {
  const lead = DB.leads.find((x) => x.id === body.leadId);
  if (!lead) return send(res, 404, { error: '线索不存在' });
  const tone = String(body.tone || DB.settings.aiToneDefault || 'consult');
  let ai = null;
  let warn = '';
  try {
    ai = await callAI(DB, { lead, tone, extra: body.extra });
  } catch (e) {
    warn = e.message;
  }
  const text = ai ? ai.text : templateDraft(lead, tone);
  const draft = {
    id: uid('dr'),
    leadId: lead.id,
    leadName: lead.name,
    tone,
    text,
    source: ai ? 'ai' : 'template',
    model: ai ? ai.model : '',
    usage: ai ? ai.usage : null,
    warn,
    createdAt: now(),
  };
  DB.drafts.unshift(draft);
  if (DB.drafts.length > 300) DB.drafts.length = 300;
  saveDb();
  send(res, 200, { draft, lint: lintDraft(text), lead });
});

route('PATCH', /^\/api\/drafts\/([^/]+)$/, async (req, res, m, body, ctx) => {
  const d = DB.drafts.find((x) => x.id === ctx.params[0]);
  if (!d) return send(res, 404, { error: '草稿不存在' });
  if (body.text !== undefined) d.text = String(body.text).slice(0, 1200);
  if (body.used !== undefined) d.usedAt = body.used ? now() : 0;
  saveDb();
  send(res, 200, { draft: d, lint: lintDraft(d.text) });
});

route('DELETE', /^\/api\/drafts\/([^/]+)$/, async (req, res, m, b, ctx) => {
  DB.drafts = DB.drafts.filter((x) => x.id !== ctx.params[0]);
  saveDb();
  send(res, 200, { drafts: DB.drafts.slice(0, 200) });
});

/* --- 设置 --- */

route('POST', /^\/api\/settings$/, async (req, res, m, body) => {
  const s = DB.settings;
  ['brandName', 'industry', 'city', 'stationNote', 'aiBaseUrl', 'aiModel', 'aiToneDefault'].forEach((k) => {
    if (body[k] !== undefined) s[k] = String(body[k]).slice(0, 300);
  });
  if (body.dailyCap !== undefined) s.dailyCap = Math.max(1, Math.min(200, Number(body.dailyCap) || 30));
  // 打码占位不算修改；空字符串才是真的清空
  if (body.aiKey !== undefined && String(body.aiKey).indexOf('••••') !== 0) {
    s.aiKey = String(body.aiKey).trim().slice(0, 200);
  }
  logAct('settings.update', '', Object.keys(body).join(','));
  saveDb();
  send(res, 200, { settings: publicState().settings });
});

route('POST', /^\/api\/settings\/test$/, async (req, res) => {
  const s = DB.settings;
  const t0 = now();
  try {
    const r = await callAI(DB, {
      lead: { name: '测试门店', industry: '餐饮', region: '本地', bio: '测试用' },
      tone: 'consult',
      extra: '这是连接测试，随便回一句即可',
    });
    send(res, 200, { ok: true, ms: now() - t0, model: r.model, sample: r.text });
  } catch (e) {
    send(res, 200, { ok: false, ms: now() - t0, error: e.message, code: e.code || '' });
  }
});

/* --- 统计 / 导出 / 演示数据 --- */

route('GET', /^\/api\/stats$/, async (req, res) => {
  const s = publicState();
  const byStatus = {};
  s.leads.forEach((l) => { byStatus[l.status] = (byStatus[l.status] || 0) + 1; });
  const touched = s.leads.filter((l) => l.lastTouchAt);
  const replied = s.leads.filter((l) => l.replyAt);
  const excluded = s.leads.filter((l) => l.status === 'excluded');
  const reasons = {};
  excluded.forEach((l) => { reasons[l.excludeReason || '其他'] = (reasons[l.excludeReason || '其他'] || 0) + 1; });
  const byIndustry = {};
  s.leads.forEach((l) => { if (l.industry) byIndustry[l.industry] = (byIndustry[l.industry] || 0) + 1; });
  send(res, 200, {
    total: s.leads.length,
    byStatus,
    byIndustry,
    excludeReasons: reasons,
    contacted: touched.length,
    replied: replied.length,
    replyRate: touched.length ? Math.round((replied.length / touched.length) * 1000) / 10 : 0,
    keywords: s.keywords.length,
    coolingKeywords: s.keywords.filter((k) => k.active && k.lastUsedAt && now() - k.lastUsedAt <= KW_COOLDOWN_DAYS * DAY).length,
    drafts: s.drafts.length,
    queueRemaining: s.queue.remaining,
    dueFollowUps: s.leads.filter((l) => l.followUpAt && l.followUpAt <= now()).length,
  });
});

route('GET', /^\/api\/export$/, async (req, res, m, b, ctx) => {
  const fmt = ctx.query.get('fmt') || 'json';
  if (fmt === 'csv') {
    const head = ['name', 'dyId', 'fans', 'verified', 'private', 'region', 'industry', 'works', 'status', 'score', 'lastTouchAt', 'followUpAt', 'bio', 'profileUrl', 'note'];
    const esc = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [head.join(',')];
    DB.leads.forEach((l) => lines.push(head.map((h) => esc(l[h])).join(',')));
    const body = '\ufeff' + lines.join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="leads.csv"',
      'Cache-Control': 'no-store',
    });
    return res.end(Buffer.from(body));
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="lead-desk-backup.json"',
    'Cache-Control': 'no-store',
  });
  res.end(Buffer.from(JSON.stringify({ exportedAt: now(), settings: DB.settings, keywords: DB.keywords, leads: DB.leads, messages: DB.messages }, null, 1)));
});

route('POST', /^\/api\/import$/, async (req, res, m, body) => {
  const d = body || {};
  let added = 0, merged = 0, skipped = 0;
  function put(item) {
    if (!item || (!item.name && !item.dyId)) { skipped += 1; return; }
    const probe = normalizeLead(item, null);
    const hit = DB.leads.find((x) => x.key === probe.key);
    if (hit) {
      const keep = Object.assign({}, hit);
      const next = normalizeLead(item, keep);
      // 导入不覆盖本地已有非空字段，也不重置冷却时间
      Object.keys(keep).forEach((k) => {
        if (keep[k] !== '' && keep[k] !== undefined && keep[k] !== null && !Number.isNaN(keep[k])) next[k] = keep[k];
      });
      next.lastTouchAt = keep.lastTouchAt;
      next.status = keep.status;
      next.excludeReason = keep.excludeReason;
      DB.leads[DB.leads.indexOf(hit)] = next;
      merged += 1;
    } else {
      DB.leads.push(probe);
      added += 1;
    }
  }
  (Array.isArray(d.leads) ? d.leads : []).forEach(put);
  if (Array.isArray(d.keywords)) {
    d.keywords.forEach((raw) => {
      const k = { id: uid('kw'), text: String(raw.text || '').trim(), cat: raw.cat || '行业', province: raw.province || '', city: raw.city || '', note: raw.note || '', active: raw.active !== false, createdAt: now(), lastUsedAt: Number(raw.lastUsedAt) || 0, useCount: Number(raw.useCount) || 0 };
      if (!k.text) return;
      k.key = kwKey(k);
      if (!DB.keywords.find((x) => x.key === k.key)) DB.keywords.push(k);
    });
  }
  logAct('import', '', '新增 ' + added + '，合并 ' + merged);
  ensureQueue();
  saveDb();
  send(res, 200, { added, merged, skipped, state: publicState() });
});

route('POST', /^\/api\/demo$/, async (req, res) => {
  const demo = [
    { name: '巷子里烤鱼（思明店）', fans: 2380, verified: true, private: false, region: '厦门·思明', industry: '烤鱼', works: 146, bio: '十年老店，只做活鱼现杀。晚市需提前订位。', recentActive: true, source: '抖音搜索' },
    { name: '阿芬美容工作室', fans: 860, verified: true, private: false, region: '厦门·湖里', industry: '美容', works: 62, bio: '问题肌调理 / 小气泡 / 光子嫩肤，可先做皮肤检测。', recentActive: true, source: '抖音搜索' },
    { name: '老陈沙茶面', fans: 128, verified: false, private: false, region: '厦门·集美', industry: '餐饮', works: 18, bio: '街边小店，主营沙茶面、卤味。', source: '抖音搜索' },
    { name: '御膳火锅（连锁）', fans: 186000, verified: true, private: false, region: '福州·鼓楼', industry: '火锅', works: 890, bio: '全国连锁 32 家门店，加盟请私信。', recentActive: true, source: '抖音搜索' },
    { name: '小满奶茶', fans: 42, verified: true, private: false, region: '泉州·丰泽', industry: '奶茶', works: 5, bio: '新店开业，手作鲜果茶。', source: '抖音搜索' },
    { name: '林记私房菜', fans: 4100, verified: true, private: true, region: '厦门·思明', industry: '餐饮', works: 0, bio: '', source: '抖音搜索' },
    { name: '海沧烧烤大排档', fans: 920, verified: true, private: false, region: '厦门·海沧', industry: '烧烤', works: 73, bio: '夜宵档，营业到凌晨三点，烤生蚝每天限量。', recentActive: true, source: '抖音搜索' },
    { name: '悦己轻医美', fans: 6500, verified: true, private: false, region: '厦门·思明', industry: '美容', works: 210, bio: '轻医美连锁，主营光电项目，有执业医师。', recentActive: true, source: '抖音搜索' },
  ];
  let added = 0, merged = 0;
  demo.forEach((d) => {
    const probe = normalizeLead(Object.assign({ note: '', dyId: '' }, d), null);
    if (DB.leads.find((x) => x.key === probe.key)) { merged += 1; return; }
    DB.leads.push(probe);
    added += 1;
  });
  logAct('demo', '', '新增 ' + added);
  ensureQueue();
  saveDb();
  send(res, 200, { added, merged, state: publicState() });
});

/* ------------------------------------------------------------------ 启动 */

loadDb();

let lastFail = 0;
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (_) { return send(res, 400, { error: 'bad url' }); }
  const pathname = url.pathname;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const cookies = parseCookies(req.headers.cookie);
  const authed = checkSession(cookies.ld_session);

  for (const r of routes) {
    const m = pathname.match(r.re);
    if (!m || r.method !== req.method) continue;
    // 登录与健康检查放行，其余都要登录
    const open = pathname === '/api/login' || pathname === '/api/health' || pathname === '/api/session';
    if (!open && !authed) return send(res, 401, { error: '需要登录', code: 'AUTH' });
    let body = {};
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      try { body = await readBody(req); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    const ctx = {
      params: m.slice(1),
      query: url.searchParams,
      authed,
      delay: () => { lastFail = now(); },
    };
    try {
      return await r.fn(req, res, m, body, ctx);
    } catch (e) {
      console.error('[api]', pathname, e && e.stack || e);
      return send(res, 500, { error: '服务端错误：' + (e.message || 'unknown') });
    }
  }
  send(res, 404, { error: '接口不存在' });
});

server.listen(PORT, HOST, () => {
  const line = '  抖音商家线索工作台已启动  http://localhost:' + PORT;
  console.log('\n' + line);
  console.log('  数据目录：' + DATA_DIR);
  if (!process.env.LD_PASSWORD && fs.existsSync(PASS_FILE)) {
    console.log('  访问口令：' + PASSWORD + '   （存在 ' + PASS_FILE + '，可用 LD_PASSWORD 覆盖）');
  }
  console.log('  这是人工在环工具：不自动登录抖音、不自动发消息。\n');
});

process.on('SIGTERM', () => { try { saveDb('quiet'); } catch (_) {} process.exit(0); });
process.on('SIGINT', () => { try { saveDb('quiet'); } catch (_) {} process.exit(0); });

module.exports = { server, normKw, kwKey, leadKey, ineligible, cooldownLeft, lintDraft, scoreOf };
