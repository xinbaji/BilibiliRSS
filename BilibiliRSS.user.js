// ==UserScript==
// @name         BilibiliRSS
// @namespace    https://github.com/xinbaji/BilibiliRSS
// @version      0.3.7
// @description  B站稍后再看 · UP/合集/视频订阅追更 · 增量监控 · 下载(直链+DASH ffmpeg合并mp4)+弹幕XML（独立油猴版）
// @author       xinbaji
// @match        https://www.bilibili.com/*
// @match        https://space.bilibili.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_notification
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @connect      www.bilibili.com
// @connect      space.bilibili.com
// @connect      comment.bilibili.com
// @connect      i0.hdslb.com
// @connect      i1.hdslb.com
// @connect      i2.hdslb.com
// @connect      bilivideo.com
// @connect      *.bilivideo.com
// @connect      mcdn.bilivideo.cn
// @connect      *.mcdn.bilivideo.cn
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

/* =========================================================================
 * BilibiliRSS — B 站稍后再看 · UP/合集/视频订阅追更 · 增量监控 · 下载助手
 * (油猴版, 数据存 GM 存储, 独立于桌面 RSS_Todo)
 *   - 订阅类型: up(UP投稿) / season(合集) / ugc(单视频分P)
 *   - 下载: durl 直链(≤720P)→GM_download; 高画质 DASH→GM_xmlhttpRequest 拉 m4s →
 *     页内 ffmpeg.wasm(-c copy) 合并 mp4; 引擎核心 IndexedDB 持久缓存; 附带弹幕 XML
 *   - UI 全部位于 #brs-host 的 Shadow DOM 内, 与主站样式隔离
 * 版本历史 / 变更说明见仓库 README.md。
 * ========================================================================= */
(function () {
'use strict';

/* ============================ 基础工具 ============================ */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const numFmt = n => {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(n);
};
const fmtTime = (sec) => {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
};
/* 下载报错压成一句短话放 toast(完整原文仍存任务 err 字段, 下载页可见) */
function shortErr(e) {
  let m = String((e && (e.message || e.error || e)) || e || '未知错误').replace(/\s+/g, ' ').trim();
  const rules = [
    [/net::ERR_(\w+)/i, r => '网络错误 ' + r[1].toLowerCase().replace(/_/g, ' ')],
    [/HTTP (\d{3})/i, r => 'HTTP ' + r[1]],
    [/GM_download/i, () => '下载已取消或通道超时'],
    [/GM_xmlhttpRequest/i, () => '下载通道错误'],
    [/Failed to fetch|NetworkError|Load failed/i, () => '网络连接失败'],
    [/超时|timeout/i, () => '网络超时'],
    [/网络错误|分块失败/, () => '网络错误'],
    [/引擎加载失败|ffmpeg/i, () => '下载引擎加载失败(可改用 ≤720P)']
  ];
  for (const [re, fn] of rules) { const r = m.match(re); if (r) return fn(r); }
  return m.length > 60 ? m.slice(0, 57) + '…' : m;
}
const fmtDate = ts => {
  const d = new Date(Number(ts) * 1000), now = Date.now(), diff = (now - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const https = u => String(u || '').replace(/^http:/, 'https:');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const KEY = (bvid, pid = 0) => bvid + ':' + pid;
const sanitizeName = s => String(s || 'video').replace(/[\\/:*?"<>|]/g, '_').replace(/\.(mp4|flv|m4s)$/i, '').slice(0, 80);

/* ---- 彩色 md5(公共域实现, 压缩版) ---- */
// 干净的 blueimp 风格 md5(hex 输出)
function md5(str) {
  'use strict';
  function utf8Encode(s){ try{return unescape(encodeURIComponent(s));}catch(e){return s;} }
  function str2bytes(s){ var a=[]; for(var i=0;i<s.length;i++) a.push(s.charCodeAt(i)&0xff); return a; }
  function bytes2words(bytes){
    var bin=[]; var mask=(1<<8)-1;
    for(var i=0;i<bytes.length;i++){ bin[i>>2] |= (bytes[i]&mask) << ((i%4)*8); }
    return bin;
  }
  function safeAdd(x,y){var lsw=(x&0xffff)+(y&0xffff),msw=(x>>16)+(y>>16)+(lsw>>16);return (msw<<16)|(lsw&0xffff);}
  function bitRotateLeft(n,c){return (n<<c)|(n>>>(32-c));}
  function md5cmn(q,a,b,x,s,t){return safeAdd(bitRotateLeft(safeAdd(safeAdd(a,q),safeAdd(x,t)),s),b);}
  function md5ff(a,b,c,d,x,s,t){return md5cmn((b&c)|(~b&d),a,b,x,s,t);}
  function md5gg(a,b,c,d,x,s,t){return md5cmn((b&d)|(c&~d),a,b,x,s,t);}
  function md5hh(a,b,c,d,x,s,t){return md5cmn(b^c^d,a,b,x,s,t);}
  function md5ii(a,b,c,d,x,s,t){return md5cmn(c^(b|~d),a,b,x,s,t);}
  function binlMD5(x,len){   // len = bit length of original msg
    x[len>>5]|=0x80<<(len%32);
    x[(((len+64)>>>9)<<4)+14]=len;
    var a=1732584193,b=-271733879,c=-1732584194,d=271733878;
    for(var i=0;i<x.length;i+=16){
      var olda=a,oldb=b,oldc=c,oldd=d;
      a=md5ff(a,b,c,d,x[i],7,-680876936);d=md5ff(d,a,b,c,x[i+1],12,-389564586);c=md5ff(c,d,a,b,x[i+2],17,606105819);b=md5ff(b,c,d,a,x[i+3],22,-1044525330);
      a=md5ff(a,b,c,d,x[i+4],7,-176418897);d=md5ff(d,a,b,c,x[i+5],12,1200080426);c=md5ff(c,d,a,b,x[i+6],17,-1473231341);b=md5ff(b,c,d,a,x[i+7],22,-45705983);
      a=md5ff(a,b,c,d,x[i+8],7,1770035416);d=md5ff(d,a,b,c,x[i+9],12,-1958414417);c=md5ff(c,d,a,b,x[i+10],17,-42063);b=md5ff(b,c,d,a,x[i+11],22,-1990404162);
      a=md5ff(a,b,c,d,x[i+12],7,1804603682);d=md5ff(d,a,b,c,x[i+13],12,-40341101);c=md5ff(c,d,a,b,x[i+14],17,-1502002290);b=md5ff(b,c,d,a,x[i+15],22,1236535329);
      a=md5gg(a,b,c,d,x[i+1],5,-165796510);d=md5gg(d,a,b,c,x[i+6],9,-1069501632);c=md5gg(c,d,a,b,x[i+11],14,643717713);b=md5gg(b,c,d,a,x[i],20,-373897302);
      a=md5gg(a,b,c,d,x[i+5],5,-701558691);d=md5gg(d,a,b,c,x[i+10],9,38016083);c=md5gg(c,d,a,b,x[i+15],14,-660478335);b=md5gg(b,c,d,a,x[i+4],20,-405537848);
      a=md5gg(a,b,c,d,x[i+9],5,568446438);d=md5gg(d,a,b,c,x[i+14],9,-1019803690);c=md5gg(c,d,a,b,x[i+3],14,-187363961);b=md5gg(b,c,d,a,x[i+8],20,1163531501);
      a=md5gg(a,b,c,d,x[i+13],5,-1444681467);d=md5gg(d,a,b,c,x[i+2],9,-51403784);c=md5gg(c,d,a,b,x[i+7],14,1735328473);b=md5gg(b,c,d,a,x[i+12],20,-1926607734);
      a=md5hh(a,b,c,d,x[i+5],4,-378558);d=md5hh(d,a,b,c,x[i+8],11,-2022574463);c=md5hh(c,d,a,b,x[i+11],16,1839030562);b=md5hh(b,c,d,a,x[i+14],23,-35309556);
      a=md5hh(a,b,c,d,x[i+1],4,-1530992060);d=md5hh(d,a,b,c,x[i+4],11,1272893353);c=md5hh(c,d,a,b,x[i+7],16,-155497632);b=md5hh(b,c,d,a,x[i+10],23,-1094730640);
      a=md5hh(a,b,c,d,x[i+13],4,681279174);d=md5hh(d,a,b,c,x[i],11,-358537222);c=md5hh(c,d,a,b,x[i+3],16,-722521979);b=md5hh(b,c,d,a,x[i+6],23,76029189);
      a=md5hh(a,b,c,d,x[i+9],4,-640364487);d=md5hh(d,a,b,c,x[i+12],11,-421815835);c=md5hh(c,d,a,b,x[i+15],16,530742520);b=md5hh(b,c,d,a,x[i+2],23,-995338651);
      a=md5ii(a,b,c,d,x[i],6,-198630844);d=md5ii(d,a,b,c,x[i+7],10,1126891415);c=md5ii(c,d,a,b,x[i+14],15,-1416354905);b=md5ii(b,c,d,a,x[i+5],21,-57434055);
      a=md5ii(a,b,c,d,x[i+12],6,1700485571);d=md5ii(d,a,b,c,x[i+3],10,-1894986606);c=md5ii(c,d,a,b,x[i+10],15,-1051523);b=md5ii(b,c,d,a,x[i+1],21,-2054922799);
      a=md5ii(a,b,c,d,x[i+8],6,1873313359);d=md5ii(d,a,b,c,x[i+15],10,-30611744);c=md5ii(c,d,a,b,x[i+6],15,-1560198380);b=md5ii(b,c,d,a,x[i+13],21,1309151649);
      a=md5ii(a,b,c,d,x[i+4],6,-145523070);d=md5ii(d,a,b,c,x[i+11],10,-1120210379);c=md5ii(c,d,a,b,x[i+2],15,718787259);b=md5ii(b,c,d,a,x[i+9],21,-343485551);
      a=safeAdd(a,olda);b=safeAdd(b,oldb);c=safeAdd(c,oldc);d=safeAdd(d,oldd);
    }
    return [a,b,c,d];
  }
  function words2hex(w){
    var hexTab='0123456789abcdef',s='';
    for(var i=0;i<w.length*4;i++){
      s+=hexTab.charAt((w[i>>2]>>>((i%4)*8+4))&0xF)+hexTab.charAt((w[i>>2]>>>((i%4)*8))&0xF);
    }
    return s;
  }
  var ascii = utf8Encode(str);
  var bytes = str2bytes(ascii);
  var words = bytes2words(bytes);
  return words2hex(binlMD5(words, bytes.length*8));
}



/* ============================ 存储 ============================ */
const NS = 'BilibiliRSS';
const DEFAULTS = {
  ver: '0.3.7',
  settings: {
    notify: true, dlQn: 127, dlDanmu: true,
    /* v0.3.1 下载形态开关 */
    dlCover: false,     /* 附带封面文件: 同目录另存一张封面图 */
    dlSplit: false,     /* 音视频分离: DASH 不合并, 分别存 .video.m4s / .audio.m4s */
    dlAudioOnly: false, /* 仅下载音频: 只取音轨存为 .m4a */
    /* v0.3.5 */
    dlThreads: 8,       /* 视频轨并发连接数(2~16, 用户可调) */
    dlAudioQn: 30280    /* 仅下载音频时的音质档: 30216/30232/30280/30250(杜比)/30251(Hi-Res) */
  },
  subs: [],      // {id,type:'up'|'ugc'|'season',name,face,author?,mid|bvid,sid?,baselineTs?,src,subText,kws:[],exkws:[],on,added}
  items: [],     // {id,key,bvid,pid,cid,title,author,face,pic,dur,pub,ts,subId,stat:[..],st:'todo'|'done'|'ignored',added}
  mons: [],      // {id,kind:'up'|'video',name,face,src,prev:{..},cur:{..},live,ltitle,added,lastAt}
  dls: [],       // 下载队列(v0.1.1 启用; v0.1.5 支持 dash 合并)
  dedupe: [],    // key[]: 忽略/删除过的稿件,永不再入
  ignore: [],
  ui: { curStatus: 'todo', curSub: '' },   /* curSub: 订阅id(字符串); '' = 全部 */
};
let store = null;

function loadStore() {
  let raw = {};
  try { raw = JSON.parse(GM_getValue(NS, '{}') || '{}'); } catch (e) { raw = {}; }
  store = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...raw };
  store.settings = { ...DEFAULTS.settings, ...(store.settings || {}) };
  store.subs = store.subs || []; store.items = store.items || []; store.mons = store.mons || [];
  store.dls = store.dls || []; store.dedupe = store.dedupe || []; store.ignore = store.ignore || [];
  /* 兜底：旧版本/异常存储里这些字段可能是对象或非数组，统一纠正为数组，防止 forEach 崩溃 */
  if (!Array.isArray(store.subs)) store.subs = [];
  if (!Array.isArray(store.items)) store.items = [];
  if (!Array.isArray(store.mons)) store.mons = [];
  if (!Array.isArray(store.dls)) store.dls = [];
  if (!Array.isArray(store.dedupe)) store.dedupe = (store.dedupe && typeof store.dedupe === 'object') ? Object.keys(store.dedupe) : [];
  if (!Array.isArray(store.ignore)) store.ignore = [];
  store.ui = { ...DEFAULTS.ui, ...(store.ui || {}) };
  if (store.ui.curSub && typeof store.ui.curSub === 'number') store.ui.curSub = '';   /* 旧数据兜底 */
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { GM_setValue(NS, JSON.stringify(store)); } catch (e) { console.error('[BilibiliRSS] save', e); }
  }, 150);
}
function getSet() { return store.settings; }

/* ============================ WBI 签名 ============================ */
const MIXIN_KEY_ENC_TAB = [
  46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,
  33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,
  61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,
  36,20,34,44,52
];
let wbiKey = { img: '', sub: '', mixin: '', ts: 0 };

async function fetchWbiKeys(force = false) {
  if (!force && wbiKey.ts && Date.now() - wbiKey.ts < 30 * 60 * 1000) return wbiKey;
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
    const j = await r.json();
    if (j && j.data && j.data.wbi_img) {
      const img = j.data.wbi_img.img_url, sub = j.data.wbi_img.sub_url;
      const tail = s => s.split('/').pop().split('.')[0];
      const i = tail(img), s = tail(sub);
      /* mixin = 重排表映射 img+sub 后仅取前 32 位(RSS_Todo 桌面版同款) */
      const mixin = MIXIN_KEY_ENC_TAB.map(k => (i + s)[k] || '').join('').slice(0, 32);
      wbiKey = { img: i, sub: s, mixin, ts: Date.now() };
    }
  } catch (e) { /* 网络失败保持原值,允许无签名重试 */ }
  return wbiKey;
}
function wbiSign(params) {
  const mixin = wbiKey.mixin;
  if (!mixin) return params;
  const p = { ...params };
  p.wts = Math.floor(Date.now() / 1000);
  /* 与桌面版(RSS_Todo)一致: 排序 + value 去除 !'()* → URLSearchParams.toString()
   * (空格转 +、中文 percent 编码, 与浏览器实际 query 同构) → md5(query + mixin) */
  const keys = Object.keys(p).filter(k => k !== 'w_rid').sort();
  const usp = new URLSearchParams();
  for (const k of keys) usp.append(k, String(p[k]).replace(/[!'()*]/g, ''));
  const q = usp.toString();
  p.w_rid = md5(q + mixin);
  return p;
}

/* ============================ 网络 ============================ */
/* arc/search 网页端反爬指纹参数(社区同款值)。注意: dm_img_list 传空数组会被 B 站判定
 * "无浏览器行为"而忽略 keyword(桌面版 RSS_Todo 实测注释), 故必须放真实轨迹形态;
 * dm_img_inter 需含"点击搜索图标"事件形态。 */
const DM_PARAMS = {
  dm_img_list: '[{"x":1258,"y":423,"z":23,"timestamp":1620,"k":88,"type":0},{"x":1472,"y":559,"z":64,"timestamp":1780,"k":104,"type":1},{"x":1650,"y":421,"z":11,"timestamp":1990,"k":77,"type":0},{"x":1811,"y":663,"z":45,"timestamp":2230,"k":120,"type":0},{"x":1533,"y":1021,"z":3,"timestamp":2470,"k":95,"type":1}]',
  dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
  dm_cover_img_str: 'QU5HTEUgKE5WSURJQSwgTlZJRElBIEdlRm9yY2UgUlRYIDQwNjAgTGFwdG9wIEdQVSAoMHgwMDAwMjhFMCkgRGlyZWN0M0QxMSB2c181XzAgcHNfNV8wLCBEM0QxMSlHb29nbGUgSW5jLiAoTlZJRElBKQ',
  dm_img_inter: '{"ds":[{"t":0,"c":"dnVpX2ljb24gc2ljLUJEQy1tYWduaWZpZXJfc2VhcmNoX2xpbmUgc2VhcmNo","p":[1544,30,423],"s":[140,220,280]}],"wh":[3417,2209,97],"of":[500,1000,500]}'
};
/* arc/search 单页公共参数: index 与页码对应(pn=1 → index=0, 对齐网页端行为) */
const arcParams = (index = 0) => Object.assign({ web_location: '333.1387', order_avoided: 'true', index }, DM_PARAMS);
/* 刷新 buvid 指纹 cookie: 412"安全风控"常因 buvid3/buvid4 缺失或过期。
 * x/frontend/finger/spi 返回全新的 b_3/b_4, 写入 .bilibili.com 域即可被各 api 带上。 */
let buvidAt = 0;
async function ensureBuvid(force = false) {
  if (!force && buvidAt && Date.now() - buvidAt < 6 * 60 * 60 * 1000) return;
  buvidAt = Date.now();
  try {
    const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { credentials: 'include' });
    const j = await r.json();
    const b = j && j.data;
    const set = (n, v) => {
      if (!v) return;
      try { document.cookie = n + '=' + v + '; Path=/; Domain=.bilibili.com; Max-Age=31536000; SameSite=None; Secure'; } catch (e) {}
    };
    /* 只在 cookie 缺失或强制刷新时写(已有值不动, 避免频繁变化触发风控) */
    if (force || !/buvid3=/.test(document.cookie)) set('buvid3', b && b.b_3);
    if (force || !/buvid4=/.test(document.cookie)) set('buvid4', b && b.b_4);
  } catch (e) { /* 静默 */ }
}
/* GM_xmlhttpRequest 通道(可带 Referer, 不依赖 CORS) */
function gmFetchText(url, referer) {
  return new Promise((resolve, reject) => {
    try {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 120000,
        headers: { 'Accept': 'application/json', ...(referer ? { 'Referer': referer } : {}) },
        onload: r => {
          const raw = (r.responseText != null) ? r.responseText
            : (r.response instanceof ArrayBuffer ? new TextDecoder().decode(r.response) : '');
          resolve({ status: r.status, text: String(raw || '') });
        },
        onerror: () => reject(new Error('load failed')),
        ontimeout: () => reject(new Error('load failed'))
      });
    } catch (e) { reject(e); }
  });
}
async function api(url, params = {}, { needWbi = false, raw = false, retry = 3, transport = '', referer = '', pick = 'data' } = {}) {
  if (needWbi) { try { await fetchWbiKeys(); params = wbiSign(params); } catch (e) {} }
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v != null && usp.append(k, String(v)));
  const full = url + (url.includes('?') ? '&' : '?') + usp.toString();
  const useXhr = transport === 'xhr' && typeof GM_xmlhttpRequest === 'function';
  const opt = { credentials: 'include', headers: { 'Accept': 'application/json' } };
  let lastErr = new Error('API empty');
  let buvidRefreshed = false;
  for (let attempt = 0; attempt <= retry; attempt++) {
    if (attempt > 0) await sleep(600 * attempt);
    try {
      let j = null;
      if (useXhr) {
        const res = await gmFetchText(full, referer);
        try { j = JSON.parse(res.text); } catch (e) { throw new Error('JSON 解析失败(HTTP ' + res.status + ')'); }
        if (raw) return res;
      } else {
        const r = await fetch(full, opt);
        if (raw) return r;
        try { j = await r.json(); } catch (e) { throw new Error('JSON 解析失败(HTTP ' + r.status + ')'); }
      }
      if (j && j.code === 0) return j[pick];   /* UGC 走 data, PGC(番剧) 走 result */
      if (j && j.code !== 0) {
        const e = new Error('API ' + j.code + (j.message ? (' · ' + j.message) : ''));
        /* -352(风控)/-412/-3/-101/网络抖动可重试; 业务错误(如 -404)不重试 */
        if ([-352, -412, -3, -101].includes(Number(j.code))) {
          lastErr = e;
          if (Number(j.code) === -412 && !buvidRefreshed) { await ensureBuvid(true); buvidRefreshed = true; }
          continue;
        }
        throw e;
      }
      throw new Error('API empty');
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || '');
      /* 412(返回防爬 HTML, JSON 解析失败) → 刷 buvid 后再试 */
      if (msg.includes('412') && !buvidRefreshed) { await ensureBuvid(true); buvidRefreshed = true; continue; }
      if (msg.startsWith('JSON 解析失败') || /failed to fetch|networkerror|load failed/i.test(msg)) continue;
      if (!/HTTP 5\d\d/.test(msg)) throw e;
    }
  }
  throw lastErr;
}

/* ============================ 抓取层 ============================ */
function parseLink(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  /* 番剧(官方 PGC): /bangumi/play/ss{season_id} 或 /bangumi/play/ep{ep_id}; 裸 ss5997 / ep103917 也认 */
  let m = s.match(/bangumi\/play\/ss(\d+)/i) || s.match(/^ss(\d+)$/i);
  if (m) return { type: 'bangumi', ssid: m[1] };
  m = s.match(/bangumi\/play\/ep(\d+)/i) || s.match(/^ep(\d+)$/i);
  if (m) return { type: 'bangumi', epId: m[1] };
  /* 合集/系列(空间「合集和列表」)三种 URL 形态:
   *   旧路由(query):   /mid/channel/collectiondetail?sid=xxx
   *   新路由(query):   /mid/lists?sid=xxx
   *   新路由(path):    /mid/lists/xxx  (?type=season|series)  ← 2025 起主流, sid 在路径里
   * type=series 的 sid 是「系列/专辑」id, 走 x/series/archives 接口, 与合集接口不同 */
  m = s.match(/space\.bilibili\.com\/(\d+)\/(?:channel\/collectiondetail|lists)/i);
  if (m) {
    let sid = null, isSeries = false;
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
      sid = u.searchParams.get('sid');
      isSeries = u.searchParams.get('type') === 'series';
      if (!sid) { const pm = u.pathname.match(/\/lists\/(\d+)/i); if (pm) sid = pm[1]; }
    } catch (e) {
      sid = (s.match(/[?&]sid=(\d+)/) || [])[1] || (s.match(/\/lists\/(\d+)/i) || [])[1] || null;
      isSeries = /type=series/i.test(s);
    }
    if (sid) return { type: 'season', mid: m[1], sid, isSeries };
  }
  if ((m = s.match(/space\.bilibili\.com\/(\d+)/))) return { type: 'up', mid: m[1] };
  if ((m = s.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/))) return { type: 'ugc', bvid: m[1] };
  if (/^\d+$/.test(s)) return { type: 'up', mid: s };
  if (/^BV[a-zA-Z0-9]+$/.test(s)) return { type: 'ugc', bvid: s };
  return null;
}

/* UP 资料 + 头像。优先 x/web-interface/card (免 wbi、无 -352 风控,实测稳),
 * acc/info 仅作兜底。 */
async function fetchUpInfo(mid) {
  try {
    const d = await api('https://api.bilibili.com/x/web-interface/card', { mid, photo: 'false' });
    const c = d.card || {};
    return { mid, name: c.name || d.name || ('UP' + mid), face: https(c.face || d.face || '') };
  } catch (e) { /* 回落 wbi acc/info */ }
  try {
    const d = await api('https://api.bilibili.com/x/space/acc/info', { mid, token: '' }, { needWbi: true });
    return { mid, name: d.name || ('UP' + mid), face: https(d.face || '') };
  } catch (e) { return { mid, name: 'UP' + mid, face: '' }; }
}

async function fetchRelationStat(mid) {
  try {
    const d = await api('https://api.bilibili.com/x/relation/stat', { vmid: mid });
    return { following: d.following, follower: d.follower };
  } catch (e) { return { following: 0, follower: 0 }; }
}
async function fetchUpstat(mid) {
  try {
    const d = await api('https://api.bilibili.com/x/space/upstat', { mid }, { needWbi: true });
    return { archive_view: d.archive?.view, article_view: d.article?.view, likes: d.likes };
  } catch (e) { return {}; }
}
async function fetchLive(mid) {
  try {
    const d = await api('https://api.live.bilibili.com/live_user/v1/Master/info', { uid: mid });
    return { live: !!d?.info?.live_status, roomid: d?.info?.room_id, title: d?.info?.title };
  } catch (e) { return { live: false }; }
}

const ARC_URL = 'https://api.bilibili.com/x/space/wbi/arc/search';
/* 412 静默期: 命中风控后 60s 内不再发"无 keyword 全量列表"请求(api() 已自动换 buvid 指纹重试,
 * 短冷却即可; 过长会连带误伤用户手动刷新的 keyword 直搜)。keyword 直搜单页低频, 豁免静默。 */
let arcQuietUntil = 0;
const arcBlocked = () => Date.now() < arcQuietUntil;
const arcMarkQuiet = () => { arcQuietUntil = Date.now() + 60 * 1000; };

/* UP 空间两个接口的时长字段都是 "mm:ss"/"h:mm:ss" 字符串(arc/search 的 vlist.length
 * 与 ajax 的 list.length), 而 view/season 接口给的是秒数 —— 统一在此归一化为秒。
 * v0.3.0 及之前直接把 "5:30" 喂给 fmtTime(Number("5:30")=NaN) → 稍后再看显示 00:00。 */
const parseLen = (s) => {
  if (typeof s === 'number') return s > 0 ? Math.round(s) : 0;
  const m = String(s || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  return m ? (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : (Number(s) || 0);
};
/* 空间投稿归一化(arc/search vlist 与 ajax list 字段近似) */
function mapUpVideo(v) {
  return {
    bvid: v.bvid, aid: v.aid, title: v.title, pic: https(v.pic), author: v.author || '',
    mid: v.mid, length: parseLen(v.length) || parseLen(v.duration) || 0, created: v.created || v.pubdate || 0, stat: {
      play: v.play || v.video_review || 0, view: v.video_review || v.play || 0,
      favorite: v.favorites || 0, danmaku: v.comment || v.danmaku || 0, share: 0
    }
  };
}
/* 自愈: 修复 v0.3.0 误存为 "00:00" 的存量 UP 条目 —— 用本次拉到的真实时长回填 */
function repairUpDurations(vlist) {
  if (!vlist || !vlist.length) return 0;
  const lenMap = new Map(vlist.map(v => [KEY(v.bvid, 0), v.length]));
  let n = 0;
  for (const it of store.items) {
    if (it && it.dur === '00:00' && lenMap.has(it.key)) { it.dur = fmtTime(lenMap.get(it.key)); n++; }
  }
  return n;
}
const upSpaceUrl = mid => 'https://space.bilibili.com/' + mid;
/* 兜底: 旧版空间 ajax 投稿接口(原生支持 keyword 服务端过滤)。arc/search 被 412/风控时可救急。 */
async function fetchUpAjax(mid, keyword = '', maxPages = 2) {
  const out = [];
  const kw = String(keyword || '').trim();
  for (let pn = 1; pn <= maxPages; pn++) {
    try {
      const d = await api('https://space.bilibili.com/ajax/member/getSubmitVideos',
        { mid, pagesize: 50, page: pn, tid: 0, keyword: kw, order: 'pubdate' },
        { transport: 'xhr', referer: upSpaceUrl(mid) });
      const list = (d && d.list) || [];
      out.push(...list.map(mapUpVideo));
      if (list.length < 50) break;
      await sleep(600);
    } catch (e) { break; }
  }
  return out;
}
const is412 = e => /412|风控|access rejected/i.test(String((e && e.message) || e));

async function fetchUpVideos(mid, ps = 50) {
  let wbiErr = null;
  if (!arcBlocked()) {
    try {
      const d = await api(ARC_URL,
        { mid, ps, tid: 0, pn: 1, keyword: '', order: 'pubdate', platform: 'web', ...arcParams(0) },
        { needWbi: true, retry: 1, transport: 'xhr', referer: upSpaceUrl(mid) });
      return ((d.list && d.list.vlist) || []).map(mapUpVideo);
    } catch (e) {
      if (is412(e)) arcMarkQuiet();
      wbiErr = e;
    }
  }
  /* 被 412 静默期/失败时: 走 ajax 兜底。注意旧 ajax 接口已逐步下线(匿名实测返回空体),
   * 若它也拿不到数据且 wbi 通道刚失败 → 大概率整条链路被风控, 抛错让上层提示,
   * 不再静默返空 —— 否则用户「刷新无新增」和「接口挂了」完全无法区分。 */
  const ajaxOut = await fetchUpAjax(mid, '').catch(() => []);
  if (!ajaxOut.length && (wbiErr || arcBlocked())) {
    throw new Error((wbiErr && wbiErr.message) || '空间投稿接口受限(412), 请稍后重试');
  }
  return ajaxOut;
}

/* UP 空间投稿关键词搜索 —— v0.1.29 起改为 keyword 服务端直搜:
 * arc/search 带 keyword 在登录态稳定生效(有头实测: 返回即服务端过滤后的匹配集, 非全量),
 * 一般 1 页(50 条)即覆盖全部匹配, 仅匹配 >50 条才翻第 2 页。
 * 相比旧"翻页拉全量(4页×50)本地过滤"请求量降一个量级, 不再因高频翻页触发 412。
 * 被 412/风控时自动退 ajax(member/getSubmitVideos 原生 keyword) 兜底。 */
async function fetchUpSearch(mid, keyword, maxPages = 2) {
  const out = [];
  const kw = String(keyword || '').trim();
  if (!kw) return out;
  const kwl = kw.toLowerCase();
  const seen = new Set();
  let wbiOk = false;
  /* 豁免 412 静默: keyword 直搜单页低频, 被 arcMarkQuiet 连带禁掉会让"订阅刷新"静默失败 */
  for (let pn = 1; pn <= maxPages; pn++) {
    try {
      const d = await api(ARC_URL,
        { mid, ps: 50, tid: 0, pn, keyword: kw, order: 'pubdate', platform: 'web', ...arcParams(pn - 1) },
        { needWbi: true, retry: 1, transport: 'xhr', referer: upSpaceUrl(mid) + '/search?keyword=' + encodeURIComponent(kw) });
      const list = (d.list && d.list.vlist) || [];
      for (const v of list) {
        if (!String(v.title || '').toLowerCase().includes(kwl)) continue;   /* 双保险 */
        const k = KEY(v.bvid, 0);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(mapUpVideo(v));
      }
      wbiOk = true;
      if (list.length < 50) break;   /* 服务端已过滤, 一般第 1 页即全 */
      await sleep(800);
    } catch (e) {
      if (is412(e)) arcMarkQuiet();
      console.warn('[BilibiliRSS] arc/search 关键词搜索受限(' + (e && e.message) + '), 尝试 ajax 兜底…');
      break;
    }
  }
  if (!wbiOk || !out.length) {
    try {
      for (const v of await fetchUpAjax(mid, kw)) {
        if (!String(v.title || '').toLowerCase().includes(kwl)) continue;
        const k = KEY(v.bvid, 0);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(v);
      }
    } catch (e) {}
  }
  return out;
}

async function fetchView(bvid) {
  try {
    const d = await api('https://api.bilibili.com/x/web-interface/view', { bvid });
    const pages = (d.pages || []).map(p => ({ cid: p.cid, part: p.part, duration: p.duration }));
    /* ugc_season: 该视频所属的「合集」(UP 主自己组的) —— 视频页工作台据此识别合集并展示专辑卡 */
    let ugc = null;
    if (d.ugc_season && d.ugc_season.id) {
      const us = d.ugc_season;
      ugc = { id: String(us.id), title: us.title || '', cover: https(us.cover || ''), mid: us.mid,
        count: (us.sections || []).reduce((a, s) => a + ((s.episodes || []).length), 0) };
    }
    return { bvid: d.bvid, aid: d.aid, title: d.title, pic: https(d.pic), author: d.owner?.name,
      mid: d.owner?.mid, length: d.duration, pubdate: d.pubdate, stat: d.stat, pages, ugc };
  } catch (e) { return null; }
}

/* 按 UP mid 列出其全部「合集」(seasons_series_list)。
 * 用途: 视频页 ugc_season 为空时, 反查该视频属于哪个合集 —— 逐个合集拉分集列表比对 bvid。
 * 结果按 mid 缓存 5 分钟, 避免同一页反复请求。 */
const SEASONS_LIST_API = 'https://api.bilibili.com/x/polymer/web-space/seasons_series_list';
const seasonsListCache = new Map();   /* mid -> { t, list } */
async function fetchUpSeasons(mid) {
  const key = String(mid);
  const hit = seasonsListCache.get(key);
  if (hit && Date.now() - hit.t < 300000) return hit.list;
  try {
    const d = await api(SEASONS_LIST_API, { mid, page_num: 1, page_size: 30, web_location: '333.1387' });
    const wraps = ((d.items_lists || {}).seasons_list) || [];
    const list = wraps.map(w => {
      const m = (w && w.meta) || w || {};
      return { id: String(m.season_id || m.id || ''), name: m.name || '', cover: https(m.cover || ''), total: Number(m.total) || 0 };
    }).filter(x => x.id);
    seasonsListCache.set(key, { t: Date.now(), list });
    return list;
  } catch (e) { return []; }
}
/* 反查: 该视频(或该分P) 属于哪个合集 → 返回 { seasonId, name, cover, mid } 或 null */
async function findVideoSeason(mid, bvid) {
  const seasons = await fetchUpSeasons(mid);
  for (const s of seasons) {
    try {
      const page = await fetchSeasonPage(mid, s.id, 1, 50);
      const hit = (page.archives || []).some(a => a.bvid === bvid);
      if (hit) return { seasonId: s.id, name: s.name, cover: s.cover, mid: String(mid) };
    } catch (e) { /* 单个合集失败不影响继续找 */ }
    await sleep(120);
  }
  return null;
}

const SEASON_API = 'https://api.bilibili.com/x/polymer/web-space/seasons_archives_list';
/* 系列(旧「专辑」)接口: 与合集不同的另一套 id 体系(?type=series 页面) */
const SERIES_API = 'https://api.bilibili.com/x/series/archives';
async function fetchSeasonPage(mid, sid, pn, ps = 50, isSeries = false) {
  if (isSeries) {
    const d = await api(SERIES_API, { mid, series_id: sid, pn, ps });
    const archives = d.archives || [];
    const meta = d.meta || {};
    const total = (d.page && d.page.total) || meta.total || archives.length;
    return {
      archives,
      meta: { name: meta.name || '', cover: https(meta.cover || ''), total },
      total,
      hasMore: (pn * ps) < total
    };
  }
  const d = await api(SEASON_API, { mid, season_id: sid, page_num: pn, page_size: ps, sort_reverse: false });
  return {
    archives: d.archives || [],
    meta: d.meta || null,
    total: (d.page && d.page.total) || (d.meta && d.meta.total) || 0,
    hasMore: (pn * ps) < ((d.page && d.page.total) || (d.meta && d.meta.total) || 0)
  };
}
async function fetchSeasonMeta(mid, sid, isSeries = false) {
  const p = await fetchSeasonPage(mid, sid, 1, 1, isSeries);
  return p.meta;
}

/* ============================ 番剧层 (PGC) ============================
 * 与 UGC 的差别:
 *   1) 返回体是 { code, message, result } —— 取 result 而非 data (api() 的 pick 选项)
 *   2) 必须带 Referer(分集页) 才能过风控 → 一律走 GM_xmlhttpRequest 通道(transport:'xhr')
 *   3) 接口需要 WBI 签名
 *   4) 元数据分两处: /pgc/view/web/season 给 标题+封面, /pgc/view/web/ep/page 给
 *      分节剧集列表(含"主题曲"等 section) —— 二者合并使用
 *   5) 无 UP mid / 无分P概念, 单集以 ep_id 唯一标识
 * ==================================================================== */

/* 大会员画质依赖登录态: GM_xmlhttpRequest 对 api.bilibili.com 自动携带 Cookie
 * (含 HttpOnly 的 SESSDATA), 不需要也无法从 document.cookie 手动取 → 不存凭据参数 */
/* 番剧接口的 Referer: 有 ep 用 ep 页, 否则用 ss 页 */
const bgReferer = (ssid, epId) => epId
  ? ('https://www.bilibili.com/bangumi/play/ep' + epId)
  : ('https://www.bilibili.com/bangumi/play/ss' + ssid);

const PGC_SEASON = 'https://api.bilibili.com/pgc/view/web/season';
const PGC_EPPAGE = 'https://api.bilibili.com/pgc/view/web/ep/page';
const PGC_PLAYURL = 'https://api.bilibili.com/pgc/player/web/playurl';

/* 番剧基础信息: 标题 / 封面 / 简介 / 总集数 (result 结构) */
async function fetchBangumiSeason(ssid) {
  return api(PGC_SEASON, { season_id: ssid }, {
    needWbi: true, transport: 'xhr', referer: bgReferer(ssid), pick: 'result'
  });
}
/* 分节剧集列表(含 OP/ED/花絮 section)。返回 { sections, sections_meta, locator } */
async function fetchBangumiEpPage(ssid) {
  return api(PGC_EPPAGE, { season_id: ssid, web_location: '666.25' }, {
    needWbi: true, transport: 'xhr', referer: bgReferer(ssid), pick: 'result'
  });
}

/* section_type → 中文分区名(sections_meta.title 为空时的兜底) */
const BG_SECTION_NAME = { 0: '正片', 1: '花絮', 2: '主题曲', 3: '其他', 4: '预告', 5: 'PV' };
/* 归一化单集: 统一字段名, 供订阅/下载/渲染共用 */
function normBgEp(e, sectionType, sectionTitle) {
  if (!e || !e.ep_id) return null;
  const st = (sectionType != null) ? Number(sectionType) : Number(e.section_type || 0);
  return {
    epId: Number(e.ep_id),
    aid: Number(e.aid) || 0,
    bvid: e.bvid || '',
    cid: Number(e.cid) || 0,
    /* show_title 形如 "第1话 妹妹与不可进入之屋" / "OP ClariS「ヒトリゴト」" —— 最适合列表展示 */
    title: e.show_title || e.long_title || String(e.title || ('EP' + e.ep_id)),
    longTitle: e.long_title || '',
    cover: https(e.cover || ''),
    duration: Number(e.duration) || 0,
    pubTime: Number(e.pub_time) || 0,
    sectionType: st,
    sectionName: sectionTitle || BG_SECTION_NAME[st] || '剧集',
    link: e.link || ('https://www.bilibili.com/bangumi/play/ep' + e.ep_id)
  };
}

/* 元数据 = season(名称/封面/简介) + ep/page(分节剧集) 合并。
 * ep/page 失败时回落 season.episodes, 保证任何一边挂了都还能用。 */
async function fetchBangumiMeta(ssid) {
  const [season, epPage] = await Promise.all([
    fetchBangumiSeason(ssid).catch(() => null),
    fetchBangumiEpPage(ssid).catch(() => null)
  ]);
  if (!season && !epPage) throw new Error('番剧信息获取失败(可能需登录或已下架)');

  const meta = {
    ssid: String(ssid || (season && season.season_id) || ''),
    title: (season && (season.season_title || season.title)) || '',
    cover: https((season && (season.cover || season.square_cover)) || ''),
    squareCover: https((season && season.square_cover) || ''),
    evaluate: (season && season.evaluate) || '',
    total: Number((season && season.total) || 0),
    eps: []
  };

  if (epPage && epPage.sections && epPage.sections.length) {
    const metas = epPage.sections_meta || [];
    const bySectionId = new Map();
    metas.forEach(sm => bySectionId.set(String(sm.id), sm));
    for (const sec of epPage.sections) {
      const sm = bySectionId.get(String(sec.section_id));
      const secName = (sm && sm.title) || '';
      const secType = sm && sm.type != null ? sm.type : 0;
      for (const pg of (sec.pages || [])) {
        for (const e of (pg.episodes || [])) {
          const n = normBgEp(e, secType, secName);
          if (n) meta.eps.push(n);
        }
      }
    }
  }
  /* 回落: ep/page 无数据 → 用 season.episodes(只有正片, 但保证可用) */
  if (!meta.eps.length && season && season.episodes) {
    for (const e of season.episodes) {
      const n = normBgEp(e, Number(e.section_type || 0), '');
      if (n) meta.eps.push(n);
    }
  }
  if (!meta.title) meta.title = '番剧 ' + meta.ssid;
  return meta;
}
/* 番剧条目的去重 key: ep_id 全局唯一且稳定 */
const bgKey = epId => 'bg:' + epId;

/* ep/page 返回里没有 season_id, 用 ep_id 反查所属季(用于 ep 链接入口) */
async function bgSsidFromEp(epId) {
  const season = await api(PGC_SEASON, { ep_id: epId }, {
    needWbi: true, transport: 'xhr', referer: bgReferer('', epId), pick: 'result'
  });
  if (!season) throw new Error('未找到该剧集');
  return String(season.season_id || '');
}

/* 关键词命中检测 (v0.1.23 起为 AND 语义):
 * kws  匹配关键词数组 —— 非空时标题须同时命中全部词(全部满足才收)
 * exkws排除关键词数组 —— 非空时标题命中任一即排除
 * 两者都空/都未命中规则 → 视为匹配(kws 空=全收, exkws 空=不过滤) */
function matchKw(title, kws, exkws) {
  const t = String(title || '').toLowerCase();
  if (Array.isArray(exkws) && exkws.length) {
    for (const x of exkws) { const s = String(x || '').trim().toLowerCase(); if (s && t.includes(s)) return false; }
  }
  if (!Array.isArray(kws) || kws.length === 0) return true;
  /* 空串/纯空白词无意义; 全为空视为"无匹配关键词 → 全收" */
  let anyValid = false;
  for (const k of kws) {
    const s = String(k).toLowerCase().trim();
    if (!s) continue;
    anyValid = true;
    if (!t.includes(s)) return false;   /* 有一个不命中即不收(AND) */
  }
  return true;
}

function itemsFromUpVideos(vlist, subId, kws, exkws, seenSet) {
  const out = [];
  for (const v of vlist) {
    const k = KEY(v.bvid, 0);
    if (seenSet.has(k)) continue;
    if (!matchKw(v.title, kws, exkws)) continue;
    seenSet.add(k);
    out.push({
      id: uid(), key: k, bvid: v.bvid, pid: 0, cid: 0,
      title: v.title, author: v.author, face: '', pic: v.pic,
      dur: fmtTime(v.length), pub: fmtDate(v.created), ts: v.created,
      subId, stat: v.stat, st: 'todo', added: Date.now()
    });
  }
  return out;
}
function itemsFromView(view, subId, kws, exkws, seenSet) {
  const out = [];
  const pages = view.pages && view.pages.length ? view.pages : [{ cid: 0, part: '', duration: view.length }];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i], pid = i + 1, k = KEY(view.bvid, pid);
    if (seenSet.has(k)) continue;
    const title = pages.length > 1 ? `${view.title} (P${pid} · ${p.part})` : view.title;
    if (!matchKw(title, kws, exkws)) continue;
    seenSet.add(k);
    out.push({
      id: uid(), key: k, bvid: view.bvid, pid, cid: p.cid,
      title, author: view.author, face: '', pic: view.pic,
      dur: fmtTime(p.duration), pub: fmtDate(view.pubdate), ts: view.pubdate,
      subId, stat: view.stat || {}, st: 'todo', added: Date.now()
    });
  }
  return out;
}

/* ============================ 引擎 ============================ */
const dedupeSet = new Set();
function rebuildDedupe() { dedupeSet.clear(); (store.items || []).forEach(i => dedupeSet.add(i.key)); (store.dedupe || []).forEach(k => dedupeSet.add(k)); }

/* 关键词订阅全历史匹配(仅订阅建立/手动刷新时执行);
 * 日常全局刷新走 refreshUp 的轻量单页路径, 避免每次开面板都刷全历史触发风控 */
async function upFullMatches(sub) {
  const merged = [];
  const seen = new Set();
  const kws = (sub.kws || []).filter(Boolean);
  if (!kws.length) return merged;
  /* v0.1.29: keyword 已走服务端过滤 → 只取"最具区分度(最长)"一词做服务端直搜。
   * AND 语义下命中视频必含该词, 不会漏; 其余词由 refreshUp 的本地 matchKw 统一校验。
   * 相比旧"每个词各翻 4 页全量"请求量降一个量级。 */
  const pick = kws.slice().sort((a, b) => b.length - a.length)[0];
  for (const v of await fetchUpSearch(sub.mid, pick)) {
    const k = KEY(v.bvid, 0);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(v);
  }
  return merged;
}

async function refreshUp(sub, opt = {}) {
  const ks = new Set([...dedupeSet, ...(store.ignore || [])]);
  let items = [];
  let vlist = [];
  const kws = (sub.kws || []).filter(Boolean);
  if (kws.length) {
    /* 全历史搜索(订阅/手动) 或 轻量单页最新 50 条(日常自动刷新) */
    vlist = opt.full ? await upFullMatches(sub) : await fetchUpVideos(sub.mid, 50);
    items = itemsFromUpVideos(vlist, sub.id, sub.kws || [], sub.exkws || [], ks);
  } else {
    vlist = await fetchUpVideos(sub.mid, 50);
    items = itemsFromUpVideos(vlist, sub.id, sub.kws || [], sub.exkws || [], ks);
  }
  repairUpDurations(vlist);
  store.items.unshift(...items);
  if (items.length) save();
  rebuildDedupe();
  return { added: items.length };
}

async function refreshUgc(sub) {
  const view = await fetchView(sub.bvid);
  if (!view) return { added: 0 };
  const ks = new Set([...dedupeSet, ...(store.ignore || [])]);
  const items = itemsFromView(view, sub.id, sub.kws || [], sub.exkws || [], ks);
  store.items.unshift(...items);
  if (items.length) save();
  rebuildDedupe();
  return { added: items.length };
}

async function refreshSeason(sub) {
  /* v0.1.25: 不再按 baseline 时间过滤 —— 只要是 dedupe 里没见过的分P就导入。
   * 效果: 新订阅合集 = 把当前全部现有分P一次导入; 之后每次刷新只补新增分P。 */
  const ks = new Set([...dedupeSet, ...(store.ignore || [])]);
  const batch = [];
  const MAX_PAGES = 20;
  for (let pn = 1; pn <= MAX_PAGES; pn++) {
    let page;
    try { page = await fetchSeasonPage(sub.mid, sub.sid, pn, 50, !!sub.isSeries); }
    catch (e) { break; }
    const arcs = page.archives;
    if (!arcs || !arcs.length) break;
    for (const a of arcs) {
      const k = KEY(a.bvid, 0);
      if (ks.has(k)) continue;
      if (!matchKw(a.title, sub.kws || [], sub.exkws || [])) continue;
      ks.add(k);
      batch.push({
        id: uid(), key: k, bvid: a.bvid, pid: 0, cid: 0, title: a.title,
        author: sub.author || '', face: sub.face || '', pic: https(a.pic),
        dur: fmtTime(a.duration), pub: fmtDate(a.pubdate), ts: a.pubdate,
        subId: sub.id, stat: { play: a.stat?.view || 0, danmaku: a.stat?.danmaku || 0, favorite: 0 },
        st: 'todo', added: Date.now()
      });
    }
    if (!page.hasMore) break;
    await sleep(160);
  }
  if (batch.length) { store.items.unshift(...batch); save(); }
  rebuildDedupe();
  return { added: batch.length };
}

/* 番剧订阅刷新: 拉全部分节剧集, 把没见过的新集导入稍后再看。
 * 与合集一致 —— 新订阅时把当前全部剧集一次导入, 之后只补新增。 */
async function refreshBangumi(sub) {
  const meta = await fetchBangumiMeta(sub.ssid);
  /* 订阅建立时若还没拿到名称/封面(接口抖动), 这里补上 */
  if (meta.title && (!sub.name || /^番剧\s/.test(sub.name))) sub.name = meta.title;
  if (meta.cover && !sub.face) sub.face = meta.cover;
  const ks = new Set([...dedupeSet, ...(store.ignore || [])]);
  const batch = [];
  for (const e of meta.eps) {
    const k = bgKey(e.epId);
    if (ks.has(k)) continue;
    if (!matchKw(e.title, sub.kws || [], sub.exkws || [])) continue;
    ks.add(k);
    batch.push({
      id: uid(), key: k, bvid: e.bvid, pid: 0, cid: e.cid, epId: e.epId,
      title: e.title, author: sub.name || '', face: '', pic: e.cover || meta.cover,
      dur: fmtTime(Math.round(e.duration / 1000)), pub: fmtDate(e.pubTime), ts: e.pubTime,
      subId: sub.id, stat: {}, st: 'todo', added: Date.now(),
      bg: true, bgSsid: meta.ssid, bgSection: e.sectionName
    });
  }
  if (batch.length) { store.items.unshift(...batch); save(); }
  rebuildDedupe();
  return { added: batch.length };
}

/* v0.1.29: 同一订阅并发去重 —— 订阅后 bgFinishSub 与开面板 refreshAll 可能同时触发,
 * 若不加锁, 两者各自基于旧 dedupeSet 计算, 会把同一稿件插两份进稍后再看 */
const subRefreshing = new Set();
let subFailTold = {};   /* 订阅刷新失败 toast 节流: subId -> ts */
async function refreshSub(sub, opt = {}) {
  if (!sub.on) return { added: 0 };
  const k = sub.id || sub.bvid || sub.mid || sub.ssid;
  if (subRefreshing.has(k)) return { added: 0 };
  subRefreshing.add(k);
  try {
    if (sub.type === 'up') return await refreshUp(sub, opt);
    if (sub.type === 'season') return await refreshSeason(sub);
    if (sub.type === 'ugc') return await refreshUgc(sub);
    if (sub.type === 'bangumi') return await refreshBangumi(sub);
  } catch (e) {
    console.warn('[BilibiliRSS] refreshSub', sub.id, e);
    /* 不再完全静默: 接口失败要给用户一个可感知的信号(同一订阅 60s 只提示一次) */
    const name = String(sub.name || sub.bvid || sub.mid || sub.ssid || '订阅').slice(0, 20);
    const now = Date.now();
    if (!subFailTold || !subFailTold[sub.id] || now - subFailTold[sub.id] > 60000) {
      subFailTold = subFailTold || {};
      subFailTold[sub.id] = now;
      try { toast('刷新「' + name + '」失败: ' + shortErr(e)); } catch (e2) {}
    }
  }
  finally { subRefreshing.delete(k); }
  return { added: 0 };
}

/* 全部刷新节流: 单飞锁 + 冷却, 避免与 B 站异步渲染抢资源 */
let refreshBusy = false;
let lastFullRefresh = 0;
async function refreshAll() {
  if (refreshBusy) return 0;
  const now = Date.now();
  if (now - lastFullRefresh < 4000) return 0;   /* 冷却 4s */
  refreshBusy = true;
  lastFullRefresh = now;
  try {
    rebuildDedupe();
    let totalAdded = 0, perSub = [];
    for (const sub of store.subs) {
      try { const { added } = await refreshSub(sub); totalAdded += added; if (added) perSub.push({ name: sub && sub.name || '订阅', added }); }
      catch (e) { /* 单源失败不影响其他 */ }
      await sleep(220);
    }
    if (totalAdded && getSet().notify) {
      const hits = perSub.slice(0, 3).map(p => (String(p.name).slice(0, 20) || '订阅') + ' +' + p.added).join(' · ');
      try { GM_notification({
        title: 'BilibiliRSS · 稍后再看新增 ' + totalAdded + ' 条',
        text: hits + (perSub.length > 3 ? ' 等' : '') + '，点开悬浮球查看',
        silent: true
      }); } catch (e) {}
    }
    return totalAdded;
  } finally {
    refreshBusy = false;
  }
}

/* 订阅去重签名 —— 同一个 UP 允许存在多条订阅, 但「关键词组合」必须不同:
 *   mid:k1|k2|k3#e1|e2   (kws 与 exkws 各自排序后归一, 忽略用户输入顺序)
 * 关键词为空的「全收」订阅签名为 mid:#, 因此同一 UP 最多只有一条全收订阅。
 * 这样「订阅 UP A 只看 攻略」与「订阅 UP A 只看 直播回放」可以共存,
 * 各自独立筛选、独立刷新, 互不干扰。 */
function subSig(type, idPart, kws, exkws) {
  const norm = a => (a || []).map(s => String(s).trim()).filter(Boolean).sort();
  return [type, idPart, norm(kws).join('|'), norm(exkws).join('|')].join('#');
}
/* 该 UP 已订阅的全部条目(可能多条) */
function subsOfUp(mid) {
  return (store.subs || []).filter(s => s.type === 'up' && String(s.mid) === String(mid));
}
/* 订阅卡片副标题: 同 UP 多条订阅时带上关键词, 便于一眼区分是哪一条 */
function subTextOf(sub) {
  const base = sub.subText || (sub.type === 'up' ? 'UP 投稿' : '订阅');
  const kw = (sub.kws || []).filter(Boolean);
  const ex = (sub.exkws || []).filter(Boolean);
  if (!kw.length && !ex.length) return base;
  let t = kw.length ? kw.join('+') : '全部';
  if (ex.length) t += ' 排除' + ex.join('/');
  return base + ' · ' + t;
}

/* 添加订阅(订阅即导入当前全部内容, 之后刷新只补新增)。
 * 关键词: kws=匹配(全部命中即收 AND), exkws=排除(命中即丢); 空=不过滤 */
async function addSubscription(input, kws = [], opt = {}) {
  const p = parseLink(input);
  if (!p) return { ok: false, msg: '链接无法识别' };
  const exkws = Array.isArray(opt.exkws) ? opt.exkws : [];
  let sub;
  if (p.type === 'up') {
    /* 关键词组合相同 → 视为重复; 组合不同 → 允许再建一条 */
    const sig = subSig('up', p.mid, kws, exkws);
    const same = subsOfUp(p.mid).find(s => subSig('up', s.mid, s.kws, s.exkws) === sig);
    if (same) return { ok: false, msg: '该 UP 的这组关键词已在订阅', dup: true, sub: same };
    let info; try { info = await fetchUpInfo(p.mid); } catch (e) { return { ok: false, msg: '获取 UP 信息失败' }; }
    sub = { id: uid(), type: 'up', name: info.name, face: info.face, mid: p.mid, src: 'uid ' + p.mid,
      subText: 'UP 投稿', kws: kws.slice(), exkws: exkws.slice(), on: true, added: Date.now() };
    store.subs.push(sub);
  } else if (p.type === 'season') {
    const isSeries = !!p.isSeries;
    const [info, meta] = await Promise.all([
      fetchUpInfo(p.mid).catch(() => null),
      fetchSeasonMeta(p.mid, p.sid, isSeries).catch(() => null)
    ]);
    if (!meta) return { ok: false, msg: (isSeries ? '专辑' : '合集') + '不存在或已失效' };
    const oldSe = store.subs.find(s => s.type === 'season' && s.sid === p.sid && s.mid === p.mid);
    if (oldSe) return { ok: false, msg: (isSeries ? '该专辑' : '该合集') + '已在订阅', dup: true, sub: oldSe };
    const sname = meta.name || (meta.title ? (isSeries ? '系列·' : '合集·') + meta.title : (isSeries ? '系列 ' : '合集 ') + p.sid);
    sub = { id: uid(), type: 'season', isSeries, name: sname, face: info?.face || '', author: info?.name || ('UP' + p.mid),
      mid: p.mid, sid: p.sid, src: (isSeries ? '系列 sid ' : '合集 sid ') + p.sid, subText: isSeries ? '系列(专辑)' : '合集投稿',
      kws: kws.slice(), exkws: exkws.slice(), on: true, added: Date.now(),
      baselineTs: Math.floor(Date.now() / 1000) };
    store.subs.push(sub);
  } else if (p.type === 'ugc') {
    let view; try { view = await fetchView(p.bvid); } catch (e) { return { ok: false, msg: '获取视频失败' }; }
    const oldUg = store.subs.find(s => s.type === 'ugc' && s.bvid === p.bvid);
    if (oldUg) return { ok: false, msg: '该视频已在订阅', dup: true, sub: oldUg };
    sub = { id: uid(), type: 'ugc', name: view.title, face: '', bvid: p.bvid, src: 'BV ' + p.bvid,
      subText: '分P视频', kws: kws.slice(), exkws: exkws.slice(), on: true, added: Date.now() };
    store.subs.push(sub);
  } else {
    /* 番剧(PGC): ss / ep 入口都归一化到 season_id */
    let ssid = p.ssid;
    if (!ssid && p.epId) {
      try { ssid = await bgSsidFromEp(p.epId); }
      catch (e) { return { ok: false, msg: '未找到该剧集(可能已下架)' }; }
    }
    if (!ssid) return { ok: false, msg: '链接无法识别' };
    let meta; try { meta = await fetchBangumiMeta(ssid); } catch (e) { return { ok: false, msg: e.message || '获取番剧信息失败' }; }
    const oldBg = store.subs.find(s => s.type === 'bangumi' && String(s.ssid) === String(ssid));
    if (oldBg) return { ok: false, msg: '该番剧已在订阅', dup: true, sub: oldBg };
    sub = { id: uid(), type: 'bangumi', name: meta.title, face: meta.cover, ssid: String(ssid),
      src: '番剧 ss' + ssid, subText: '番剧', kws: kws.slice(), exkws: exkws.slice(), on: true,
      added: Date.now(), baselineTs: Math.floor(Date.now() / 1000) };
    store.subs.push(sub);
  }
  /* v0.1.25: 先建订阅即返回(前端立即显示), 历史视频由调用方后台抓取 */
  if (opt.noBackfill) { save(); rebuildDedupe(); return { ok: true, msg: '已加入订阅', sub }; }
  try {
    const ks = new Set([...dedupeSet, ...(store.ignore || [])]);
    let added = 0;
    if (sub.type === 'up') {
      const kws = (sub.kws || []).filter(Boolean);
      if (kws.length) {
        /* 设关键词 → keyword 服务端直搜(取最长词, AND 语义完备; 其余词由 matchKw 本地校验) */
        const merged = [];
        const seen = new Set();
        const pick = kws.slice().sort((a, b) => b.length - a.length)[0];
        for (const v of await fetchUpSearch(sub.mid, pick)) {
          const k = KEY(v.bvid, 0); if (seen.has(k)) continue; seen.add(k); merged.push(v);
        }
        const its = merged.map(v => {
          const k = KEY(v.bvid, 0);
          if (ks.has(k)) return null;
          if (!matchKw(v.title, sub.kws || [], sub.exkws || [])) return null;
          ks.add(k);
          return {
            id: uid(), key: k, bvid: v.bvid, pid: 0, cid: 0, title: v.title,
            author: v.author, face: '', pic: v.pic, dur: fmtTime(v.length),
            pub: fmtDate(v.created), ts: v.created, subId: sub.id, stat: v.stat,
            st: 'todo', added: Date.now()
          };
        }).filter(Boolean);
        repairUpDurations(merged);
        store.items.unshift(...its); added = its.length;
      } else {
        const vlist = await fetchUpVideos(sub.mid, 50);
        const its = itemsFromUpVideos(vlist, sub.id, sub.kws || [], sub.exkws || [], ks);
        repairUpDurations(vlist);
        store.items.unshift(...its); added = its.length;
      }
    } else if (sub.type === 'season') {
      const MAX_PAGES = 20;
      const batch = [];
      for (let pn = 1; pn <= MAX_PAGES; pn++) {
        let page;
        try { page = await fetchSeasonPage(sub.mid, sub.sid, pn, 50, !!sub.isSeries); }
        catch (e) { break; }
        const arcs = page.archives || [];
        if (!arcs.length) break;
        for (const a of arcs) {
          const k = KEY(a.bvid, 0);
          if (ks.has(k)) continue;
          if (!matchKw(a.title, sub.kws || [], sub.exkws || [])) continue;
          ks.add(k);
          batch.push({
            id: uid(), key: k, bvid: a.bvid, pid: 0, cid: 0, title: a.title,
            author: sub.author || '', face: sub.face || '', pic: https(a.pic),
            dur: fmtTime(a.duration), pub: fmtDate(a.pubdate), ts: a.pubdate,
            subId: sub.id, stat: { play: a.stat?.view || 0, danmaku: a.stat?.danmaku || 0, favorite: 0 },
            st: 'todo', added: Date.now()
          });
          added++;
        }
        if (!page.hasMore) break;
        await sleep(160);
      }
      store.items.unshift(...batch);
    } else if (sub.type === 'bangumi') {
      /* 用户选择: 番剧订阅一次导入全部剧集(含 OP/ED/花絮各 section) */
      const meta = await fetchBangumiMeta(sub.ssid);
      const batch = [];
      for (const e of meta.eps) {
        const k = bgKey(e.epId);
        if (ks.has(k)) continue;
        if (!matchKw(e.title, sub.kws || [], sub.exkws || [])) continue;
        ks.add(k);
        batch.push({
          id: uid(), key: k, bvid: e.bvid, pid: 0, cid: e.cid, epId: e.epId, bg: true,
          title: e.title, author: sub.name || '', face: '', pic: e.cover || meta.cover,
          dur: fmtTime(Math.round(e.duration / 1000)), pub: fmtDate(e.pubTime), ts: e.pubTime,
          subId: sub.id, stat: {}, st: 'todo', added: Date.now(),
          bgSsid: meta.ssid, bgSection: e.sectionName
        });
      }
      store.items.unshift(...batch); added = batch.length;
    } else {
      const view = await fetchView(sub.bvid);
      const its = itemsFromView(view, sub.id, sub.kws || [], sub.exkws || [], ks);
      store.items.unshift(...its); added = its.length;
    }
  } catch (e) { console.warn('[BilibiliRSS] initial import', e); }
  save(); rebuildDedupe();
  return { ok: true, msg: '已加入订阅', sub };
}

function delSub(id) {
  store.subs = store.subs.filter(s => s.id !== id);
  store.items = store.items.filter(i => i.subId !== id || i.st === 'done');
  save(); rebuildDedupe();
  updateAllUI();
}
function toggleSub(id) { const s = store.subs.find(x => x.id === id); if (s) { s.on = !s.on; save(); updateAllUI(); } }
/* 编辑订阅筛选规则。
 * UP 订阅要额外做一次去重: 改后的关键词组合若与该 UP 的另一条订阅撞车,
 * 会导致两条订阅筛选完全相同 —— 拒绝并保持原值, 由返回值告知调用方。 */
function editSub(id, kwRaw, exRaw) {
  const s = store.subs.find(x => x.id === id); if (!s) return { ok: true };
  const kws = kwRaw ? kwRaw.split(/[,，\s]+/).filter(Boolean).map(x => x.trim()).slice(0, 20) : [];
  const exkws = exRaw ? exRaw.split(/[,，\s]+/).filter(Boolean).map(x => x.trim()).slice(0, 20) : [];
  if (s.type === 'up') {
    const sig = subSig('up', s.mid, kws, exkws);
    const clash = subsOfUp(s.mid).find(o => o.id !== s.id && subSig('up', o.mid, o.kws, o.exkws) === sig);
    if (clash) return { ok: false, msg: '同一 UP 已有相同关键词的订阅，请修改或先删除另一条' };
  }
  s.kws = kws;
  s.exkws = exkws;
  save(); updateAllUI();
  return { ok: true };
}

/* 状态机:todo/done/ignored。删除时进 dedupe(下次刷新不再入) */
function setItemStatus(itemId, st) {
  const i = store.items.find(x => x.id === itemId); if (!i) return;
  i.st = st;
  if (st === 'ignored') { store.ignore = Array.from(new Set([...(store.ignore || []), i.key])); }
  save(); rebuildDedupe(); updateAllUI();
}
function deleteItem(itemId) {
  const i = store.items.find(x => x.id === itemId); if (!i) return;
  store.dedupe = Array.from(new Set([...(store.dedupe || []), i.key]));
  store.items = store.items.filter(x => x.id !== itemId);
  save(); rebuildDedupe(); updateAllUI();
}
/* ============================ 监控引擎 ============================ */
async function refreshMonUp(m) {
  const [acc, rs, us, lv] = await Promise.all([
    fetchUpInfo(m.mid).catch(() => null),
    fetchRelationStat(m.mid).catch(() => ({ follower: 0, following: 0 })),
    fetchUpstat(m.mid).catch(() => ({})),
    fetchLive(m.mid).catch(() => ({ live: false }))
  ]);
  const cur = {
    follower: rs.follower, following: rs.following,
    archive_view: us.archive_view, likes: us.likes,
    face: acc?.face || m.face, name: acc?.name || m.name,
    live: lv.live, ltitle: lv.title
  };
  const prev = m.cur || null;
  m.cur = cur; m.prev = prev; m.lastAt = Date.now();
  return { prev, cur };
}
async function refreshMonVideo(m) {
  const v = await fetchView(m.bvid).catch(() => null);
  if (!v) return null;
  const cur = { stat: v.stat, title: v.title, pic: https(v.pic), author: v.author || '', mid: v.mid || 0 };
  const prev = m.cur || null;
  m.cur = cur; m.prev = prev; m.lastAt = Date.now();
  return { prev, cur };
}
async function refreshMon(m) {
  try {
    if (m.kind === 'up') return await refreshMonUp(m);
    if (m.kind === 'video') return await refreshMonVideo(m);
  } catch (e) { console.warn('[BilibiliRSS] refreshMon', e); }
  return null;
}
let monBusy = false;
async function refreshAllMons() {
  if (monBusy) return;
  monBusy = true;
  try {
    for (const m of store.mons) { try { await refreshMon(m); await sleep(220); } catch (e) {} }
    save();
  } finally { monBusy = false; }
}
async function refreshMonById(id) {
  const m = store.mons.find(x => x.id === id); if (!m) return;
  try { await refreshMon(m); save(); updateAllUI(); toast('已刷新'); }
  catch (e) { toast('刷新失败: ' + (e && e.message || e)); }
}
/* 加入监控; 返回 { ok, id, dup, msg }。id 供入口立即刷新该条 */
function addMon(input) {
  const p = parseLink(input); if (!p) return { ok: false };
  if (p.type === 'season') return { ok: false, msg: '合集请用「订阅」跟进新投稿' };
  let id;
  if (p.type === 'up') {
    const old = store.mons.find(x => x.kind === 'up' && x.mid === p.mid);
    if (old) return { ok: false, dup: true, id: old.id, msg: '已在监控' };
    id = uid();
    store.mons.push({ id, kind: 'up', mid: p.mid, name: 'UP' + p.mid, face: '', cur: null, prev: null, added: Date.now() });
  } else {
    const old = store.mons.find(x => x.kind === 'video' && x.bvid === p.bvid);
    if (old) return { ok: false, dup: true, id: old.id, msg: '已在监控' };
    id = uid();
    store.mons.push({ id, kind: 'video', bvid: p.bvid, name: '', face: '', cur: null, prev: null, added: Date.now() });
  }
  save(); return { ok: true, id };
}
function delMon(id) { store.mons = store.mons.filter(x => x.id !== id); save(); updateAllUI(); }

/* ============================ 下载引擎 v2 ============================
 * 1) durl 直链(fnval=1, ≤720P) → GM_download 直接落盘 {标题}.mp4
 * 2) 需求 > durl 可用上限 且 DASH(fnval=16) 有更高档 → 取视频+音频 m4s:
 *    GM_xmlhttpRequest(带 Referer/UA, 等价扩展级请求可跨域 206) 拉取分片,
 *    字节传页内 ffmpeg.wasm -c copy 合并 → <a download> {标题}.mp4
 * 3) DASH 不可用则回落 durl。全程无需登录也能拿 720P 直链。 */
const QN_TIERS = [127, 120, 116, 112, 108, 80, 74, 64, 32, 16];
const QN_LABEL = { 127: '原画', 120: '4K', 116: '1080P60', 112: '1080P+', 108: '1080P60', 80: '1080P', 74: '720P60', 64: '720P', 32: '480P', 16: '360P' };
/* 音轨 id → 档位名(30280=192K/30232=132K/30216=64K; 30250/30251 为杜比/无损) */
const AUDIO_QN_LABEL = { 30280: '192K', 30232: '132K', 30216: '64K', 30251: '无损', 30250: '杜比全景声' };
/* ffmpeg.wasm 0.12.x 引擎(照抄 bilibili视频下载 2.9.2 方案, 大量用户验证可用):
 * - @ffmpeg/ffmpeg@0.12.15 UMD(window.FFmpegWASM), 核心 @ffmpeg/core(-mt)@0.12.10
 * - 页面 crossOriginIsolated → 用多线程 core-mt(带 worker); 否则用单线程 core,
 *   无需 B 站加 COI 头(0.11 的多线程 core 在无 COI 页面必报 SharedArrayBuffer → 合并失败)
 * - 所有核心文件 fetch 成本地 blob 再 load, 规避 worker 跨域限制
 * - CDN 多源: npmmirror(国内优先) / jsdelivr / unpkg, 逐个尝试取最优
 * - IndexedDB 持久缓存: 首次并行抓取后不再联网(见下方 ffAsset/ffDbGet) */
const FF_CDN = [
  { name: 'npmmirror', base: 'https://registry.npmmirror.com/@ffmpeg/ffmpeg/0.12.15/files/dist/umd', core: 'https://registry.npmmirror.com/@ffmpeg/core/0.12.10/files/dist/umd', coremt: 'https://registry.npmmirror.com/@ffmpeg/core-mt/0.12.10/files/dist/umd' },
  { name: 'jsdelivr', base: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd', core: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd', coremt: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/umd' },
  { name: 'unpkg', base: 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd', core: 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd', coremt: 'https://unpkg.com/@ffmpeg/core-mt@0.12.10/dist/umd' }
];

function gmxArrayBuffer(url, onProg, referer) {
  return new Promise((res, rej) => {
    GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'arraybuffer', timeout: 0,
      headers: { Referer: referer || 'https://www.bilibili.com/', 'User-Agent': navigator.userAgent },
      onloadstart: r => { try { if (onProg) { const cl = /content-length:\s*(\d+)/i.exec(r.responseHeaders || ''); if (cl) onProg(0, Number(cl[1])); } } catch (e) {} },
      onprogress: r => { try { if (onProg && r.total) onProg(r.loaded, r.total); } catch (e) {} },
      onload: r => { if (r.status >= 200 && r.status < 300) res(r.response); else rej(new Error('HTTP ' + r.status)); },
      onerror: () => rej(new Error('网络错误')), ontimeout: () => rej(new Error('超时'))
    });
  });
}

/* ================= DASH 视频轨多线程下载 =================
 * CDN 实测(见 build/probe_range.js): bilivideo 对 Range 返回 206 + content-range 总长,
 * 8 并发分块全部 206 → 视频轨按字节分块并发拉, 音频轨保持单线程(体积小, 且省连接数)。
 * 任一环节不支持(无 206 / 分块失败重试耗尽) → 上层回退单线程 gmxArrayBuffer。 */
const DL_VIDEO_THREADS_DEF = 8;   /* 设置缺失时的默认值; 实际以 settings.dlThreads 为准 */
/* 探测文件总长: Range 0-0 → content-range; 不支持返回 0 */
function gmxRangeLen(url, referer) {
  return new Promise((res) => {
    GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'arraybuffer', timeout: 120000,
      headers: { Referer: referer || 'https://www.bilibili.com/', 'User-Agent': navigator.userAgent, Range: 'bytes=0-0' },
      onload: r => {
        if (r.status !== 206) return res(0);
        const m = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(r.responseHeaders || '');
        res(m ? Number(m[1]) : 0);
      },
      onerror: () => res(0), ontimeout: () => res(0)
    });
  });
}
/* 单个 Range 分块, 自带重试; 非 206 视为不支持 Range → 直接抛错触发整体回退 */
function gmxChunk(url, start, end, referer, onProg, tries) {
  const n = Math.max(1, tries || 3);
  const once = () => new Promise((res, rej) => {
    GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'arraybuffer', timeout: 0,
      headers: { Referer: referer || 'https://www.bilibili.com/', 'User-Agent': navigator.userAgent, Range: 'bytes=' + start + '-' + end },
      onprogress: r => { try { if (onProg) onProg(r.loaded || 0); } catch (e) {} },
      onload: r => { if (r.status === 206) res(r.response); else rej(new Error('HTTP ' + r.status)); },
      onerror: () => rej(new Error('网络错误')), ontimeout: () => rej(new Error('超时'))
    });
  });
  return (async () => {
    let last;
    for (let i = 0; i < n; i++) {
      try { return await once(); } catch (e) { last = e; }
    }
    throw last || new Error('分块失败');
  })();
}
/* 视频轨多线程: 返回按序分块数组 ArrayBuffer[](落盘零拷贝; 合并路径用 joinParts 拼回) */
async function gmxVideoParts(url, onProg, referer) {
  const total = await gmxRangeLen(url, referer);
  if (!total) throw new Error('CDN 不支持 Range');
  const userThreads = Number(getSet().dlThreads) || DL_VIDEO_THREADS_DEF;
  /* 每连接至少 4MiB 才开班: 纯 2~4MiB 的小视频即使设了 16 线程也不会真的开 16 条连接
   * (小文件多连接纯属浪费, 且更容易触发 CDN 限速) */
  const threads = Math.max(2, Math.min(userThreads, 16, Math.ceil(total / 4194304)));
  if (threads < 2) throw new Error('文件过小, 不值得多线程');
  const chunk = Math.ceil(total / threads);
  const loaded = new Array(threads).fill(0);
  const upd = () => { try { if (onProg) onProg(loaded.reduce((a, b) => a + b, 0), total); } catch (e) {} };
  const parts = await Promise.all(Array.from({ length: threads }, (_, i) => {
    const s = i * chunk, e = Math.min(total - 1, s + chunk - 1);
    return gmxChunk(url, s, e, referer, l => { loaded[i] = l; upd(); }, 3)
      .then(buf => { loaded[i] = buf.byteLength || (e - s + 1); upd(); return buf; });
  }));
  return parts;
}
/* 按序拼接分块(合并路径需要连续 buffer 交给 ffmpeg) */
function joinParts(parts) {
  if (!Array.isArray(parts)) return parts;
  if (parts.length === 1) return parts[0];
  let n = 0;
  for (const p of parts) n += p.byteLength || 0;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(new Uint8Array(p), o); o += p.byteLength || 0; }
  return out.buffer;
}
/* ================= ffmpeg.wasm 引擎(0.12, 照抄 bilibili视频下载 2.9.2) =================
 * 本地化策略:
 *   - 4 个核心文件(ffmpeg.js / ffmpeg-core.js / ffmpeg-core.wasm / 814.ffmpeg.js)
 *     首次从多 CDN 并行抓取后写入 IndexedDB, 之后跨页面/跨重启直接读本地, 不再联网;
 *   - 清站点数据才需要重新下载一次。
 * 加载要点: ffmpeg.js 必须 fetch 成 blob 再 <script src=blob:> 注入(webpack publicPath
 * 本地化), 否则 load() 会拿 CDN 直连 URL new Worker → 跨域 SecurityError。 */
const FF_LIB_KEY = 'ffmpeg.js';
const FF_DB = 'brs-ff';
let _ffdb = null;
function ffDB() {
  if (_ffdb) return _ffdb;
  _ffdb = new Promise((res, rej) => {
    try {
      const rq = indexedDB.open(FF_DB, 1);
      rq.onupgradeneeded = () => { try { rq.result.createObjectStore('files'); } catch (e) {} };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => { _ffdb = null; rej(rq.error); };
    } catch (e) { _ffdb = null; rej(e); }
  });
  return _ffdb;
}
async function ffDbGet(key) {
  try {
    const db = await ffDB();
    return await new Promise(res => {
      const tx = db.transaction('files', 'readonly');
      const rq = tx.objectStore('files').get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => res(null);
    });
  } catch (e) { return null; }
}
async function ffDbPut(key, blob) {
  try {
    const db = await ffDB();
    await new Promise(res => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(blob, key);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch (e) {}
}
/* 抓单个文件(带超时); 成功即写缓存 */
async function ffFetchBlob(url, key) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    if (key) ffDbPut(key, blob);
    return blob;
  } finally { clearTimeout(timer); }
}
/* 取核心文件: 缓存命中返回本地 Blob, 否则从选定 CDN 并行抓取并落缓存 */
async function ffAsset(key, url) {
  const hit = await ffDbGet(key);
  if (hit) return hit;
  return ffFetchBlob(url, key);
}

let ffPromise = null;
/* 有 @grant 时脚本运行在隔离沙箱, 主世界的 window.FFmpegWASM 必须经 unsafeWindow 读取 */
const ffWin = () => (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
function loadFFmpeg() {
  if (ffPromise) return ffPromise;
  window.__brsFF = window.__brsFF || {};
  window.__brsFF.tried = [];
  ffPromise = new Promise((res, rej) => {
    (async () => {
      /* 1) 优先读本地缓存 */
      const cached = await ffDbGet(FF_LIB_KEY);
      let cfg = null;
      let libBlob = cached;
      if (!libBlob) {
        for (const c of FF_CDN) {
          try {
            libBlob = await ffFetchBlob(c.base + '/ffmpeg.js', FF_LIB_KEY);
            cfg = c;
            break;
          } catch (e) { window.__brsFF.tried.push(c.name); }
        }
        if (!libBlob) throw new Error('ffmpeg 引擎加载失败: 已尝试 ' + (window.__brsFF.tried.join('、') || '无') + '，可能被网络/CDN 拦截。可改用 ≤720P 直链下载');
      } else {
        cfg = FF_CDN[0];   /* 缓存已含库, 后续 core 若缺仍用默认 CDN 补 */
      }
      /* 2) 注入 ffmpeg.js 前做 2.9.2 同款改写:
       * ffmpeg.js 是 webpack 产物, worker 分包 814.ffmpeg.js 的加载地址由
       * `new URL(e.p+e.u(814),e.b)` 按「当前脚本 URL」推导 —— 我们以 blob: 注入,
       * 推导出的 publicPath 是 blob:..., 会去加载不存在的 blob:.../814.ffmpeg.js
       * → worker 创建静默失败 → ff.load() 永不 resolve → 任务卡死在"合并 80%"。
       * 照抄 2.9.2: 注入前把该表达式替换成 `r.workerLoadURL`(load 的命名参数),
       * worker 改从我们传入的 814 blob 加载。 */
      let libText = await libBlob.text();
      /* 宽松匹配 webpack worker 分包地址推导: new URL(<publicPath>+<u>(814),<baseURI>) */
      const wc = libText.replace(/new URL\([^)]*u\(814\)[^)]*\)/g, 'r.workerLoadURL');
      if (wc !== libText) {
        console.log('[BRS] ffmpeg.js 已改写 814 分包地址');
        libText = wc;
      }
      /* 该 script 在主世界执行 */
      const url = URL.createObjectURL(new Blob([libText], { type: 'text/javascript' }));
      await new Promise((ok, no) => {
        const s = document.createElement('script');
        s.src = url;
        let waited = 0;
        const check = () => {
          /* 主世界全局须读 unsafeWindow */
          if (ffWin().FFmpegWASM && ffWin().FFmpegWASM.FFmpeg) { URL.revokeObjectURL(url); return ok(); }
          waited += 150;
          if (waited > 5000) { URL.revokeObjectURL(url); return no(new Error('FFmpegWASM 未就绪')); }
          setTimeout(check, 150);
        };
        s.onload = check;
        s.onerror = () => { URL.revokeObjectURL(url); no(new Error('注入失败')); };
        (document.head || document.documentElement).appendChild(s);
      });
      window.__brsFF.cfg = cfg;
      window.__brsFF.ready = true;
      res();
    })().catch(e => rej(e));
  });
  ffPromise.catch(() => { ffPromise = null; });
  return ffPromise;
}

/* 页内单例 FFmpeg 实例: 核心文件(缓存或网络)全部本地 blob 后 load()。
 * 无 COI → 单线程 core; 有 COI → core-mt 多线程(额外 worker)。
 * ffLoading 并发锁: 预载与正式合并同时触发只 load 一次。 */
let ffInst = null, ffInstBusy = false;
let ffLoading = null;
async function getFF() {
  await loadFFmpeg();
  const W = ffWin();
  if (!W.FFmpegWASM || !W.FFmpegWASM.FFmpeg) throw new Error('FFmpeg 环境异常');
  if (ffInst) return ffInst;
  if (ffLoading) return ffLoading;
  ffLoading = (async () => {
    const cfg = window.__brsFF.cfg;
    const isCOI = !!W.crossOriginIsolated;
    const coreBase = isCOI ? cfg.coremt : cfg.core;
    const ff = new W.FFmpegWASM.FFmpeg();
    ff.on('log', ({ message }) => { if (/error/i.test(message || '')) console.warn('[BRS ffmpeg]', message.slice(0, 200)); });
    ff._brsProgCb = null;
    ff._brsLogCb = null;
    try { ff.on('progress', ({ progress }) => { const cb = ff._brsProgCb; if (cb && typeof progress === 'number') cb(progress); }); } catch (e) {}
    /* ffmpeg 真实 stderr 行包含默认进度行 `frame=... time=HH:MM:SS.xx ...` —— 这是
     * 0.12 不依赖 `progress` 事件也能拿到的真信息, 用于兜底显示与百分比计算 */
    try {
      ff.on('log', ({ type, message }) => {
        const cb = ff._brsLogCb; if (!cb || !message) return;
        cb({ type: type || '', message });
      });
    } catch (e) {}
    try {
      /* 并行抓取核心(缓存优先, 缺失的走网络), 全部转 blob URL */
      const chunkBlob = ffAsset('814.ffmpeg.js', cfg.base + '/814.ffmpeg.js');
      const coreBlob = ffAsset('ffmpeg-core.js', coreBase + '/ffmpeg-core.js');
      const wasmBlob = ffAsset('ffmpeg-core.wasm', coreBase + '/ffmpeg-core.wasm');
      const [chunkB, coreB, wasmB] = await Promise.all([chunkBlob, coreBlob, wasmBlob]);
    const opt = {
      coreURL: URL.createObjectURL(new Blob([coreB], { type: 'text/javascript' })),
      wasmURL: URL.createObjectURL(new Blob([wasmB], { type: 'application/wasm' })),
      workerLoadURL: URL.createObjectURL(new Blob([chunkB], { type: 'text/javascript' }))
    };
    if (isCOI) {
      const workerB = await ffAsset('ffmpeg-core.worker.js', coreBase + '/ffmpeg-core.worker.js');
      opt.workerURL = URL.createObjectURL(new Blob([workerB], { type: 'application/javascript' }));
    }
    await ff.load(opt);
    } catch (e) {
      console.warn('[BRS ffmpeg] load 失败', e);
      throw new Error('ffmpeg 核心加载失败: ' + (e && e.message || e) + '。可重试或改用 ≤720P 直链下载');
    }
    ffInst = ff;
    return ff;
  })().finally(() => { ffLoading = null; });
  return ffLoading;
}
/* 合并音视频 m4s → mp4 (照抄 bilibili视频下载 2.9.2: writeFile→exec -c copy→readFile)。
 * 返回 ArrayBuffer 供 saveBlob 落盘; 实例忙锁 + 出错销毁重建。 */
async function ffMerge(vBuf, aBuf, durMs, onProg) {
  if (ffInstBusy) throw new Error('ffmpeg 忙');
  ffInstBusy = true;
  try {
    const ff = await getFF();
    const asU8 = b => (b instanceof Uint8Array) ? b : new Uint8Array(b);
    onProg && onProg(0.05);
    ff.writeFile('video.m4s', asU8(vBuf));
    ff.writeFile('audio.m4s', asU8(aBuf));
    onProg && onProg(0.25);
    /* 双轨真 progress: 0.12 emit 的 `progress` 事件 + ffmpeg stderr 默认 `time=` 行
     * (用户实测 v0.1.16 卡 80% = 0.12 progress 事件未触发, 改靠 stderr log) */
    let lastT = -1;
    ff._brsProgCb = r => { if (onProg && typeof r === 'number') onProg(0.8 + Math.min(0.2, Math.max(0, r) * 0.2)); };
    ff._brsLogCb = ({ message }) => {
      if (!message) return;
      /* ffmpeg 默认进度行: `frame=... time=HH:MM:SS.xx ...`; 也兼容 -progress 的 out_time_us= */
      let tMs = -1;
      const tm = /\btime=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
      if (tm) tMs = ((+tm[1]) * 3600 + (+tm[2]) * 60 + (+tm[3])) * 1000;
      const om = /\bout_time_us=(-?\d+)/.exec(message);
      if (om) tMs = Math.max(tMs, Math.round(+om[1] / 1000));
      if (tMs < 0 || tMs === lastT) return;
      lastT = tMs;
      if (onProg) {
        /* 有总时长 → 真百分比; 没有 → 仅显示 ffmpeg 真实 time, 进度按 log 频率累加到 0.95 */
        const ratio = durMs > 0 ? Math.min(1, tMs / durMs) : Math.min(0.95, 0.8 + (tMs / 30000));
        const prog = 0.8 + Math.min(0.18, (ratio * 0.18));
        onProg(prog, tMs);
      }
    };
    await ff.exec(['-y', '-i', 'video.m4s', '-i', 'audio.m4s', '-c', 'copy', 'output.mp4']);
    ff._brsProgCb = null; ff._brsLogCb = null;
    onProg && onProg(0.95);
    const data = await ff.readFile('output.mp4');
    try { ff.deleteFile('video.m4s'); ff.deleteFile('audio.m4s'); ff.deleteFile('output.mp4'); } catch (e) {}
    onProg && onProg(1);
    const out = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return out;
  } catch (e) {
    ffInst = null;   /* 实例状态未知 → 销毁, 下次重建 */
    throw new Error('ffmpeg 合并失败: ' + (e && e.message || e));
  } finally { ffInstBusy = false; }
}
function saveBlob(buf, name, mime) {
  /* buf 可为 ArrayBuffer 或分块数组(ArrayBuffer[]) —— 多线程下载的 parts 直接零拷贝落盘 */
  const blob = new Blob(Array.isArray(buf) ? buf : [buf], { type: mime || 'video/mp4' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return true;
}
/* 点击下载后的引擎预载: 高画质(>720P)可能走 DASH → 后台把引擎核心拉齐, 合并时不再等待。
 * 仅下载音频 / 音视频分离都不用 ffmpeg, 跳过预载(省 ~30MB 流量)。 */
function warmFF() {
  const s = getSet();
  if (s.dlAudioOnly || s.dlSplit) return;
  loadFFmpeg().catch(() => {});
  if ((s.dlQn || 127) > 64) getFF().catch(() => {});
}

/* playurl 决策: 返回 { mode:'durl', durl:{url,size,quality} } 或 { mode:'dash', video:{...}, audio:{...}, quality } */
/* 音轨挑选: mp4a 优先, 同编码内取 id 最大者(码率最高: 30280 > 30232 > 30216)。
 * wantId 指定时(仅下载音频的「音质」设置): 取 ≤ wantId 的最高可用档 ——
 * 例如要 30251(Hi-Res) 但视频只有 30280, 则退到 30280; 指定 30216 则精确取最低档。 */
function pickBestAudio(list, wantId) {
  const arr = (list || []).slice();
  if (!arr.length) return null;
  const hasCodec = a => /^mp4a|^ec-3|^flac|^fLaC/i.test(a.codecs || '');
  let pool = arr.filter(hasCodec);
  if (!pool.length) pool = arr;
  const byId = pool.slice().sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
  if (wantId) {
    const want = Number(wantId) || 0;
    const hit = byId.find(a => (Number(a.id) || 0) <= want);
    if (hit) return hit;
  }
  return byId[0];
}
/* 从 playurl 响应里挑视频轨 + 音轨: 视频取 ≤ 目标档的最高轨(h264 优先), 音轨取最高码率。
 * UGC 与番剧共用, 避免两处各写一份。返回 null 表示该响应没有可用 DASH。 */
function pickDashTracks(resp, want, audioWant) {
  const dash = resp && resp.dash;
  if (!dash || !(dash.video || []).length || !(dash.audio || []).length) return null;
  const desc = (resp.accept_quality || []).map(Number).filter(Boolean).sort((a, b) => b - a);
  const realTop = (dash.video || []).reduce((m, v) => Math.max(m, Number(v.id) || 0), 0);
  const target = desc.find(q => q <= want) || realTop || 80;
  const vv = dash.video.slice().sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
  const hasCodec = v => /^(avc1|hev1|hvc1|av01)/.test(v.codecs || '');
  const video = vv.find(v => v.id <= target && hasCodec(v))
    || vv.find(v => v.id <= target) || vv.find(v => hasCodec(v)) || vv[0];
  const audio = pickBestAudio(dash.audio, audioWant);
  if (!video || !audio) return null;
  return { video, audio, quality: Number(video.id) || target, realTop };
}

async function resolveStream(bvid, cid, wantQn, opt = {}) {
  const want = Number(wantQn) || 127;
  const reqDurl = q => api('https://api.bilibili.com/x/player/wbi/playurl',
    { bvid, cid, qn: q, fnval: 1, fnver: 0, fourk: 1 }, { needWbi: true });
  const reqDash = q => api('https://api.bilibili.com/x/player/wbi/playurl',
    { bvid, cid, qn: q, fnval: 16, fnver: 0, fourk: 1 }, { needWbi: true });

  /* 仅下载音频 / 音视频分离 → 必须拿到独立音视频轨, 而 durl 是音视频混流的单文件,
   * 所以这两种形态都跳过直链探测, 直接走 DASH。 */
  if (opt.audioOnly || opt.forceDash) {
    const dd = await reqDash(Math.min(Math.max(want, 80), 127));
    const tr = pickDashTracks(dd, want, opt.audioOnly ? getSet().dlAudioQn : 0);
    if (!tr) throw new Error(opt.audioOnly ? '该视频未提供独立音轨，无法仅下载音频' : '该视频未提供 DASH 流，无法音视频分离');
    if (opt.audioOnly) return { mode: 'audio', audio: tr.audio, quality: Number(tr.audio.id) || 0, timelength: dd.timelength };
    return { mode: 'dash', video: tr.video, audio: tr.audio, quality: tr.quality, timelength: dd.timelength };
  }

  /* 1) durl 可用档(通常上限 720P) */
  let durlMax = 0, durlProbe = null;
  try {
    const pr = await reqDurl(64);
    const acc = (pr.accept_quality || []).map(Number).filter(Boolean);
    durlMax = Math.max(64, pr.quality || 64, ...acc);
    if (pr.durl && pr.durl.length) durlProbe = pr;
  } catch (e) {}

  /* 2) 需要更高画质才探 DASH */
  let dash = null;
  if (want > durlMax || !durlProbe) {
    try {
      const dd = await reqDash(Math.min(Math.max(want, 80), 127));
      if (dd.dash && ((dd.dash.video || []).length) && ((dd.dash.audio || []).length)) dash = dd;
    } catch (e) {}
  }

  /* 3) 决策: 仅在 DASH 真能提供高于 durl 直链上限的画质时才走合并(否则白等一遍 ffmpeg) */
  if (dash && (want > durlMax || !durlProbe)) {
    const tr = pickDashTracks(dash, want);
    /* 以 DASH 实际返回的视频轨最高档为准(accept 有时虚高) */
    if (tr && !(durlProbe && tr.realTop <= durlMax)) {
      return { mode: 'dash', video: tr.video, audio: tr.audio, quality: tr.quality, timelength: dash.timelength };
    }
  }

  /* 4) durl 直链(≤720P 或 DASH 失败兜底) */
  if (durlProbe && durlProbe.durl && durlProbe.durl.length) {
    /* 用户档 < durl 上限(如要 480P/360P)时, 按目标档精确复请求 */
    const wantQ = Math.min(want, durlMax);
    if (wantQ < durlProbe.quality && wantQ > 0) {
      try {
        const dd = await reqDurl(wantQ);
        if (dd.durl && dd.durl.length) return { mode: 'durl', durl: dd.durl[0], quality: wantQ, timelength: dd.timelength };
      } catch (e) {}
    }
    const d0 = durlProbe.durl[0];
    return { mode: 'durl', durl: d0, quality: durlProbe.quality || 64, timelength: durlProbe.timelength };
  }
  throw new Error('该视频可能需登录或大会员才能下载');
}

/* 番剧流解析。与 UGC 的差别: 走 /pgc/player/web/playurl, 必须带 ep_id/cid/session(SESSDATA)
 * 与剧集页 Referer。
 * 实测(fnval/qn 组合):
 *   fnval=1  → durl 单文件 mp4 直链(1080P 可用, 免 ffmpeg)  ★优先
 *   fnval=16 → 仅 DASH
 *   fnval=4048 → DASH 且解锁 1080P+/HDR 档
 * 决策与 resolveStream 同构: 直链够用就走直链, 要更高档才拉 DASH 合并。 */
async function resolveBangumiStream(task, wantQn, opt = {}) {
  const want = Number(wantQn) || 127;
  const ref = bgReferer(task.bgSsid || '', task.epId);
  const reqUrl = (fnval, qn) => api(PGC_PLAYURL,
    { ep_id: task.epId, cid: task.cid, qn, fnval, fnver: 0, fourk: 1, otype: 'json' },
    { needWbi: true, transport: 'xhr', referer: ref, retry: 2, pick: 'result' });

  /* 仅下载音频 / 音视频分离: 番剧直链同样是混流单文件 → 跳过它, 直接走 DASH */
  if (opt.audioOnly || opt.forceDash) {
    const dd = await reqUrl(16, Math.min(Math.max(want, 80), 127));
    const tr = pickDashTracks(dd, want, opt.audioOnly ? getSet().dlAudioQn : 0);
    if (!tr) throw new Error(opt.audioOnly ? '该剧集未提供独立音轨，无法仅下载音频' : '该剧集未提供 DASH 流，无法音视频分离');
    if (opt.audioOnly) return { mode: 'audio', audio: tr.audio, quality: Number(tr.audio.id) || 0, timelength: dd.timelength };
    return { mode: 'dash', video: tr.video, audio: tr.audio, quality: tr.quality, timelength: dd.timelength };
  }

  /* 1) 直链探测(番剧直链上限一般 1080P → 80) */
  let durlProbe = null, durlMax = 0;
  try {
    const pr = await reqUrl(1, Math.min(want, 80));
    durlMax = Math.max(80, Number(pr.quality) || 0, ...((pr.accept_quality || []).map(Number).filter(q => q && q <= 80)));
    if (pr.durl && pr.durl.length) durlProbe = pr;
  } catch (e) {}

  /* 2) 直链不可用, 或用户要的档位高于直链上限 → 探 DASH */
  let dash = null;
  if (!durlProbe || want > durlMax) {
    try {
      const dd = await reqUrl(4048, Math.min(Math.max(want, 80), 127));
      if (dd.dash && (dd.dash.video || []).length && (dd.dash.audio || []).length) dash = dd;
    } catch (e) {}
  }

  /* 3) 决策: 仅当 DASH 真能给出高于直链的画质时才走合并 */
  if (dash && (!durlProbe || want > durlMax)) {
    const tr = pickDashTracks(dash, want);
    if (tr && !(durlProbe && tr.realTop <= durlMax)) {
      return { mode: 'dash', video: tr.video, audio: tr.audio, quality: tr.quality, timelength: dash.timelength };
    }
  }

  /* 4) 直链。用户要的档位低于直链返回档时, 按目标档精确复请求(省流量) */
  if (durlProbe && durlProbe.durl && durlProbe.durl.length) {
    const wantQ = Math.min(want, durlMax);
    if (wantQ < Number(durlProbe.quality || 0) && wantQ > 0) {
      try {
        const dd = await reqUrl(1, wantQ);
        if (dd.durl && dd.durl.length) return { mode: 'durl', durl: dd.durl[0], quality: wantQ, timelength: dd.timelength };
      } catch (e) {}
    }
    const d0 = durlProbe.durl[0];
    return { mode: 'durl', durl: d0, quality: Number(durlProbe.quality) || 80, timelength: durlProbe.timelength };
  }
  throw new Error('该剧集可能需大会员或为付费/地区限制内容');
}

async function ensureCid(bvid, pid = 1) {
  const view = await fetchView(bvid);
  if (!view || !view.pages || !view.pages.length) throw new Error('获取分P失败');
  const i = Math.max(0, Math.min(pid - 1, view.pages.length - 1));
  return view.pages[i].cid;
}

/* 串行下载队列：一次 doing 一个 */
/* 下载进度高频回调 → UI 节流重绘, 避免整表 innerHTML 卡顿 */
let dlUiT = null;
function uiThrottle() {
  if (dlUiT) return;
  dlUiT = setTimeout(() => { dlUiT = null; updateAllUI(); }, 160);
}

async function dlTick() {
  const doing = store.dls.find(d => d.st === 'doing');
  if (doing) return;
  const next = store.dls.find(d => d.st === 'queue');
  if (!next) return;
  next.st = 'doing'; next.prog = 0.02; next.startedAt = Date.now(); next.sub = '获取播放地址…'; save(); updateAllUI();
  try {
    let cid = next.cid;
    if (!cid) {
      if (next.epId) throw new Error('剧集缺少 cid，请重新加入下载');
      cid = await ensureCid(next.bvid, next.pid || 1);
    }
    next.cid = cid; save();
    const set = getSet();
    const audioOnly = !!set.dlAudioOnly;
    /* 分离模式也需要独立音视频轨 → 强制走 DASH(否则番剧会走直链混流单文件, 分离形同失效) */
    const opts = { audioOnly, forceDash: !!set.dlSplit };
    const plan = next.epId
      ? await resolveBangumiStream(next, set.dlQn || 127, opts)
      : await resolveStream(next.bvid, cid, set.dlQn || 127, opts);
    next.quality = plan.quality; next.planDone = true; next.rPlan = 0;   /* plan 成功: 标记 + 清回队重试计数 */
    /* 文件名随形态变: 仅音频 → .m4a; 其余 → .mp4(分离模式会由基名派生两个文件) */
    const base = sanitizeName(next.title || next.bvid || ('EP' + next.epId));
    next.path = audioOnly ? (base + '.m4a') : (base + '.mp4');
    save(); updateAllUI();

    /* ---- 仅下载音频: 只拉音轨存 .m4a, 不碰 ffmpeg ---- */
    if (plan.mode === 'audio') {
      const aRef = next.epId ? bgReferer(next.bgSsid || '', next.epId) : '';
      let aDone = 0, aTotal = 0;
      const mb1 = b => (b / 1048576).toFixed(0) + 'MB';
      const ab = await gmxArrayBuffer(plan.audio.baseUrl, (l, t) => {
        aDone = l; aTotal = t || aTotal;
        next.prog = 0.05 + (aTotal ? aDone / aTotal : 0) * 0.8;
        next.sub = '下载音轨 ' + mb1(aDone) + (aTotal ? '/' + mb1(aTotal) : '') + '…';
        save(); uiThrottle();
      }, aRef);
      next.size = ab.byteLength || 0;
      next.format = '仅音频 ' + (AUDIO_QN_LABEL[plan.quality] || ('a' + plan.quality));
      next.prog = 1; next.st = 'done'; next.doneAt = Date.now();
      save(); updateAllUI();
      saveBlob(ab, next.path, 'audio/mp4');
      toast('已保存音频: ' + next.path);
      dlTick();
      afterDownloaded(next);
      return;
    }

    if (plan.mode === 'durl') {
      next.size = plan.durl.size || 0;
      next.format = '直链 ' + (QN_LABEL[plan.quality] || ('qn' + plan.quality));
      next.sub = '浏览器下载中(交给系统下载)…'; next.prog = 0.5; save(); updateAllUI();
      if (typeof GM_download !== 'function') throw new Error('GM_download 不可用');
      GM_download({
        url: plan.durl.url,
        name: next.path,
        headers: {
          Referer: next.epId ? bgReferer(next.bgSsid || '', next.epId) : 'https://www.bilibili.com/',
          'User-Agent': navigator.userAgent
        },
        onload: () => { next.prog = 1; next.st = 'done'; next.doneAt = Date.now(); save(); updateAllUI(); toast('下载完成: ' + next.path); dlTick(); afterDownloaded(next); },
        onerror: (err) => { next.st = 'err'; next.err = String(err?.error || err?.message || err || '未知错误'); save(); updateAllUI(); toast('下载失败: ' + shortErr(next.err)); dlTick(); },
        ontimeout: () => { next.st = 'err'; next.err = 'timeout'; save(); updateAllUI(); dlTick(); }
      });
      return;
    }

    /* DASH → 拉分片 + ffmpeg 合并。
     * 视频轨多线程(8 连接 Range 分块, 失败自动回退单线程); 音频轨单线程(体积小, 省连接)。 */
    let vDone = 0, vTotal = 0, aDone = 0, aTotal = 0;
    const mb = b => (b / 1048576).toFixed(0) + 'MB';
    const updSub = () => {
      const total = (vTotal || 0) + (aTotal || 0);
      next.prog = 0.05 + (total ? (vDone + aDone) / total : 0) * 0.75;
      next.sub = '下载分片 v ' + mb(vDone) + (vTotal ? '/' + mb(vTotal) : '') + ' · a ' + mb(aDone) + (aTotal ? '/' + mb(aTotal) : '') + '…';
      save(); uiThrottle();
    };
    const dlRef = next.epId ? bgReferer(next.bgSsid || '', next.epId) : '';
    const [vparts, ab] = await Promise.all([
      (async () => {
        try { return await gmxVideoParts(plan.video.baseUrl, (l, t) => { vDone = l; vTotal = t || vTotal; updSub(); }, dlRef); }
        catch (e) {
          console.warn('[BilibiliRSS] 视频轨多线程回退单线程:', e && e.message);
          return [await gmxArrayBuffer(plan.video.baseUrl, (l, t) => { vDone = l; vTotal = t || vTotal; updSub(); }, dlRef)];
        }
      })(),
      gmxArrayBuffer(plan.audio.baseUrl, (l, t) => { aDone = l; aTotal = t || aTotal; updSub(); }, dlRef)
    ]);
    const vLen = vparts.reduce((a, b) => a + (b.byteLength || 0), 0);
    next.size = vLen + (ab.byteLength || 0);

    /* ---- 音视频分离: 不调 ffmpeg, 分别落盘 .video.m4s / .audio.m4s ---- */
    if (set.dlSplit) {
      const stem = next.path.replace(/\.mp4$/, '');
      next.path = stem;
      next.format = 'DASH ' + (QN_LABEL[plan.quality] || ('qn' + plan.quality)) + ' 分离';
      next.prog = 1; next.st = 'done'; next.doneAt = Date.now();
      save(); updateAllUI();
      saveBlob(vparts, stem + '.video.m4s', 'video/mp4');   /* 分块数组零拷贝落盘 */
      /* 两次落盘之间留一点间隔: 连续触发下载容易被浏览器当作批量下载拦下 */
      setTimeout(() => {
        try { saveBlob(ab, stem + '.audio.m4s', 'audio/mp4'); }
        catch (e) { toast('音频文件保存失败: ' + (e && e.message || e)); }
      }, 350);
      toast('已分离保存: ' + stem + '.video.m4s + .audio.m4s');
      dlTick();
      afterDownloaded(next);
      return;
    }

    next.format = 'DASH ' + (QN_LABEL[plan.quality] || ('qn' + plan.quality)) + ' 合并';
    /* 多线程分块拼回连续 buffer 交给 ffmpeg(单线程路径只有一个分块, 原样返回) */
    const vb = joinParts(vparts);
    /* B 站 playurl 的 timelength 是毫秒; ffMerge 内基于此算 time= 行 → 百分比 */
    const durMs = Number(plan.timelength) || 0;
    next.sub = 'ffmpeg 合并中…'; save(); updateAllUI();
    try {
      const merged = await ffMerge(vb, ab, durMs, (r, tMs) => {
        next.prog = r;
        if (typeof tMs === 'number') {
          const sec = (tMs / 1000).toFixed(1);
          const total = durMs > 0 ? ' / ' + (durMs / 1000).toFixed(0) + 's' : '';
          const pct = durMs > 0 ? ' (' + Math.round(Math.min(1, tMs / durMs) * 100) + '%)' : '';
          next.sub = 'ffmpeg 处理中  ' + sec + 's' + total + pct;
        } else {
          next.sub = 'ffmpeg 合并中 ' + Math.round(r * 100) + '%…';
        }
        save(); uiThrottle();
      });
      next.size = merged.byteLength || next.size;
      next.prog = 1; next.st = 'done'; next.doneAt = Date.now();
      save(); updateAllUI();
      saveBlob(merged, next.path);
      toast('已合并并开始下载: ' + next.path);
      dlTick();
      afterDownloaded(next);
    } catch (e) {
      next.st = 'err'; next.err = e.message || String(e);
      save(); updateAllUI(); toast('合并失败: ' + shortErr(next.err));
      dlTick();
    }
  } catch (e) {
    /* plan 阶段(尚未开始拉分片)失败 → 弱网常见, 自动回队重试至多 3 次;
     * 业务性错误(大会员/付费/地区/未提供音轨等)不重试直接判死; 开始下载后失败维持判死 */
    const msg = (e && e.message) || String(e);
    if (!next.planDone && (next.rPlan || 0) < 3 && !/需大会员|付费|地区限制|缺少 cid|需登录|未提供/.test(msg)) {
      next.rPlan = (next.rPlan || 0) + 1;
      next.st = 'queue'; next.prog = 0; next.sub = '网络不佳, 自动重试 ' + next.rPlan + '/3';
      next.err = msg; save(); updateAllUI();
      toast('网络不佳, 自动重试 ' + next.rPlan + '/3: ' + shortErr(msg));
      dlTick();
      return;
    }
    next.rPlan = 0;
    next.st = 'err'; next.err = msg; save(); updateAllUI();
    toast('下载失败: ' + shortErr(next.err));
    dlTick();
  }
}

function gmxText(url) {
  return new Promise((res, rej) => {
    GM_xmlhttpRequest({
      method: 'GET', url, timeout: 120000,
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': navigator.userAgent },
      onload: r => { if (r.status >= 200 && r.status < 300) res(r.responseText); else rej(new Error('HTTP ' + r.status)); },
      onerror: () => rej(new Error('网络错误')), ontimeout: () => rej(new Error('超时'))
    });
  });
}
async function downloadDanmu(task) {
  try {
    if (!task || !task.cid) return false;
    const xml = await gmxText('https://comment.bilibili.com/' + task.cid + '.xml');
    if (!xml || xml.indexOf('<') !== 0) return false;
    const xmlName = String(task.path || task.title || 'danmu').replace(/\.(mp4|flv|m4s|m4a)$/i, '') + '.xml';
    const dataUrl = 'data:text/xml;charset=utf-8,' + encodeURIComponent(xml);
    await new Promise((res, rej) => {
      GM_download({ url: dataUrl, name: xmlName, saveAs: false, onload: res,
        onerror: e => rej(new Error(String((e && (e.error || e.message)) || '下载失败'))) });
    });
    toast('已附带弹幕: ' + xmlName);
    return true;
  } catch (e) { console.warn('[BilibiliRSS] 弹幕下载失败', task && task.cid, e); return false; }
}
/* 附带封面: 把封面图另存到同目录(与视频同名, 便于归档配对)。
 * 封面来自 task.pic(视频封面 / 剧集封面), 都在 i*.hdslb.com —— 已在 @connect 内。 */
async function downloadCover(task) {
  try {
    if (!task) return false;
    const url = https(task.pic || '');
    if (!url) return false;
    const base = String(task.path || task.title || 'cover').replace(/\.(mp4|m4a|m4s)$/i, '');
    const ext = ((url.match(/\.(jpe?g|png|webp|gif|bmp)(?:[?@]|$)/i) || [])[1] || 'jpg').toLowerCase();
    const name = base + '.' + ext;
    await new Promise((res, rej) => {
      GM_download({
        url, name, saveAs: false,
        headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': navigator.userAgent },
        onload: res,
        onerror: e => rej(new Error(String((e && (e.error || e.message)) || '下载失败')))
      });
    });
    toast('已附带封面: ' + name);
    return true;
  } catch (e) { console.warn('[BilibiliRSS] 封面下载失败', task && task.pic, e); return false; }
}
/* 下载成功后的附加产物: 弹幕 + 封面。所有完成路径统一走这里, 避免各分支漏挂。 */
function afterDownloaded(task) {
  const set = getSet();
  if (set.dlDanmu !== false) downloadDanmu(task);
  if (set.dlCover) downloadCover(task);
}
function startDownload(input) {
  const bvid = input.bvid, pid = input.pid || 1;
  const epId = input.epId ? Number(input.epId) : 0;
  /* v0.1.22 防御: 同 bvid+pid(或同 ep_id) 已在排队/下载中则直接复用, 不再重复入队。
   * 兜底防止任何路径(双击/重复触发/监听器累积)导致一份视频下多份。 */
  const dup = (store.dls || []).find(d => (epId
    ? (Number(d.epId) === epId)
    : (d.bvid === bvid && (d.pid || 1) === pid)) && (d.st === 'queue' || d.st === 'doing'));
  if (dup) {
    /* 复用时补齐封面(首次可能来自没有封面信息的入口) */
    if (!dup.pic && input.pic) { dup.pic = https(input.pic); save(); }
    return dup;
  }
  const task = {
    id: uid(),
    bvid: bvid || '',
    pid: pid,
    cid: input.cid || 0,
    pic: https(input.pic || ''),
    title: input.title || input.bvid || ('EP' + epId),
    added: Date.now(),
    st: 'queue'
  };
  if (epId) { task.epId = epId; task.bgSsid = String(input.bgSsid || ''); }
  store.dls.unshift(task); save(); updateAllUI(); dlTick();
  warmFF();   /* 加入下载即自动预载引擎(高画质才拉核心, 合并时不再等待) */
  return task;
}
function delDl(id) { store.dls = store.dls.filter(d => d.id !== id); save(); updateAllUI(); }
function retryDl(id) {
  const d = store.dls.find(x => x.id === id); if (!d) return;
  d.st = 'queue'; d.err = ''; d.sub = ''; d.doneAt = 0; d.quality = 0; d.format = ''; d.size = 0;
  save(); updateAllUI(); toast('已重新加入下载队列'); dlTick();
}
/* =========================================================================
 * BilibiliRSS · 前端 v3 —— 用户友好 / 高性能 / 快速响应
 * -------------------------------------------------------------------------
 * 后端（存储 / 签名 / 抓取 / 引擎 / 监控 / 下载 / 订阅动作）完全复用，上文原样保留。
 *
 * 性能设计
 *   1) 差分渲染：列表按 key 复用 DOM 节点，就地 patch，不再整表 innerHTML 重建
 *   2) rAF 合帧 + 视图脏标记：只重绘当前可见视图
 *   3) 事件委托：每个列表根节点只绑一次监听器，永不累积
 *   4) 惰性渲染 + 分页窗口：切到哪个 Tab 才渲染哪个列表，长列表滚动加载
 *   5) 属性级写入缓存：标题/封面/统计等仅在值变化时写 DOM
 *   6) content-visibility:auto：屏幕外的卡片跳过布局与绘制
 *   7) 乐观更新：状态类操作立即变色，不等重算
 * ========================================================================= */

/* ---------------------- 图标（Bootstrap Icons, solid 实心风格） ---------------------- */
const _bi = d => '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' + d + '</svg>';
const ICO = {
  /* 首页 / 稍后再看 */
  home: _bi('<path d="M8.707 1.5a1 1 0 0 0-1.414 0L.646 8.146a.5.5 0 0 0 .708.708L2 8.207V13.5A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V8.207l.646.647a.5.5 0 0 0 .708-.708L13 5.793V2.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.293zM13 7.207V13.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V7.207l5-5z"/>'),
  /* 监控雷达 */
  radar: _bi('<path d="M8 0a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6zm0 4a4 4 0 1 0 4 4h-2a2 2 0 1 1-2-2z"/><path d="M8 7a1 1 0 1 0 0 2 1 1 0 0 0 0-2"/><path d="M10.5 5.5 8 8l1.5-.5z"/>'),
  /* 工作台（网格） */
  toolbox: _bi('<path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3A1.5 1.5 0 0 1 7 2.5v3A1.5 1.5 0 0 1 5.5 7h-3A1.5 1.5 0 0 1 1 5.5zm1.5-.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5zM9 2.5A1.5 1.5 0 0 1 10.5 1h3A1.5 1.5 0 0 1 15 2.5v3A1.5 1.5 0 0 1 13.5 7h-3A1.5 1.5 0 0 1 9 5.5zm1.5-.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5zM1 10.5A1.5 1.5 0 0 1 2.5 9h3A1.5 1.5 0 0 1 7 10.5v3A1.5 1.5 0 0 1 5.5 15h-3A1.5 1.5 0 0 1 1 13.5zm1.5-.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5zM9 10.5A1.5 1.5 0 0 1 10.5 9h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 13.5zm1.5-.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5z"/>'),
  /* 订阅（层叠） */
  layers: _bi('<path d="M8.235 1.559a.5.5 0 0 0-.47 0l-7.5 4a.5.5 0 0 0 0 .882L8 10.441l7.735-4a.5.5 0 0 0 0-.882z"/><path d="m3.5 8.5-2.735 1.5 7.235 3.941 7.235-3.941L12.5 8.5 8.235 10.559a.5.5 0 0 1-.47 0z"/><path d="m3.5 12-2.735 1.5 7.235 3.941 7.235-3.941L12.5 12 8.235 14.059a.5.5 0 0 1-.47 0z"/>'),
  /* 设置（齿轮） */
  gear: _bi('<path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/>'),
  /* 刷新 */
  refresh: _bi('<path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466"/>'),
  /* 关闭 */
  close: _bi('<path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8z"/>'),
  /* 搜索 */
  search: _bi('<path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"/>'),
  /* 勾选 */
  check: _bi('<path d="M12.736 3.97a.733.733 0 0 1 1.047 0c.286.289.29.756.01 1.05L7.88 12.01a.733.733 0 0 1-1.065.02L3.217 8.384a.757.757 0 0 1 0-1.06.733.733 0 0 1 1.047 0l3.052 3.093 5.4-6.425z"/>'),
  /* 禁止 */
  ban: _bi('<path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/><path d="M11.354 4.646a.5.5 0 0 0-.708 0l-6 6a.5.5 0 0 0 .708.708l6-6a.5.5 0 0 0 0-.708"/>'),
  /* 垃圾桶 */
  trash: _bi('<path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>'),
  /* 撤销 */
  undo: _bi('<path fill-rule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2z"/><path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466"/>'),
  /* 播放 */
  play: _bi('<path d="M0 12V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2m6.79-6.907A.5.5 0 0 0 6 5.5v5a.5.5 0 0 0 .79.407l3.5-2.5a.5.5 0 0 0 0-.814z"/>'),
  /* 胶片 */
  film: _bi('<path d="M0 1a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1zm4 0v6h8V1zm8 8v6h1V9zM1 9h3v6H1zM1 1v6h3V1zm11 0v6h3V1zM4 9v6h8V9z"/>'),
  /* 下载 */
  download: _bi('<path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708z"/>'),
  /* 电源 */
  power: _bi('<path d="M7.5 1v7h1V1z"/><path d="M3 8.812a5 5 0 0 1 2.578-4.375l-.485-.874A6 6 0 1 0 11 3.616l-.501.865A5 5 0 1 1 3 8.812"/>'),
  /* 编辑 */
  edit: _bi('<path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325"/>'),
  /* 外链 */
  external: _bi('<path d="M8.636 3.5a.5.5 0 0 0-.5-.5H1.5A1.5 1.5 0 0 0 0 4.5v10A1.5 1.5 0 0 0 1.5 16h10a1.5 1.5 0 0 0 1.5-1.5V7.864a.5.5 0 0 0-1 0V14.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5h6.636a.5.5 0 0 0 .5-.5"/><path d="M16 .5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0 0 1h3.793L6.146 9.146a.5.5 0 1 0 .708.708L15 1.707V5.5a.5.5 0 0 0 1 0z"/>'),
  /* 太阳 */
  sun: _bi('<path d="M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6m0 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8M8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0m0 13a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 13m8-5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5M3 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 3 8m10.657-5.657a.5.5 0 0 1 0 .707l-1.414 1.415a.5.5 0 1 1-.707-.708l1.414-1.414a.5.5 0 0 1 .707 0m-9.193 9.193a.5.5 0 0 1 0 .707L3.05 13.657a.5.5 0 0 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0m9.193 2.121a.5.5 0 0 1-.707 0l-1.414-1.414a.5.5 0 0 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .707M4.464 4.465a.5.5 0 0 1-.707 0L2.343 3.05a.5.5 0 1 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .708"/>'),
  /* 月亮 */
  moon: _bi('<path d="M6 .278a.77.77 0 0 1 .08.858 7.2 7.2 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277q.792-.001 1.533-.16a.79.79 0 0 1 .81.316.73.73 0 0 1-.031.893A8.35 8.35 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.75.75 0 0 1 6 .278"/>'),
  /* 箭头 */
  chev: _bi('<path fill-rule="evenodd" d="M6.776 1.553a.5.5 0 0 1 .671.223l3 6a.5.5 0 0 1 0 .448l-3 6a.5.5 0 1 1-.894-.448L9.44 8 6.553 2.224a.5.5 0 0 1 .223-.671"/>'),
  /* 收件箱 */
  inbox: _bi('<path d="M4.98 4a.5.5 0 0 0-.39.188L1.54 8H6a.5.5 0 0 1 .5.5 1.5 1.5 0 1 0 3 0A.5.5 0 0 1 10 8h4.46l-3.05-3.812A.5.5 0 0 0 11.02 4zm-1.17-.437A1.5 1.5 0 0 1 4.98 3h6.04a1.5 1.5 0 0 1 1.17.563l3.7 4.625a.5.5 0 0 1 .106.374l-.39 3.124A1.5 1.5 0 0 1 14.117 13H1.883a1.5 1.5 0 0 1-1.489-1.314l-.39-3.124a.5.5 0 0 1 .106-.374z"/>'),
  /* 保存 */
  save: _bi('<path d="M2 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H9.5a1 1 0 0 0-1 1v4.5h2a.5.5 0 0 1 .354.854l-2.5 2.5a.5.5 0 0 1-.708 0l-2.5-2.5A.5.5 0 0 1 5.5 6.5h2V2a2 2 0 0 1 2-2H14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2z"/>'),
  /* 信息 */
  info: _bi('<path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16m.93-9.412-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.47l-.451-.081.082-.381 2.29-.287zM8 5.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2"/>'),
  /* 警告 */
  warn: _bi('<path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"/>'),
  /* 时钟（用于“最近更新”） */
  clock: _bi('<path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71z"/><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16m7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0"/>'),
  /* 星标 */
  star: _bi('<path d="M2.866 14.85c-.078.444.36.791.746.593l4.39-2.256 4.389 2.256c.386.198.824-.149.746-.592l-.83-4.73 3.522-3.356c.33-.314.16-.888-.282-.95l-4.898-.696L8.465.792a.513.513 0 0 0-.927 0L5.354 5.12l-4.898.696c-.441.062-.612.636-.283.95l3.523 3.356z"/>'),
  /* 闪电（性能） */
  zap: _bi('<path d="M11.251.068a.5.5 0 0 1 .227.58L9.677 6.5H13a.5.5 0 0 1 .364.843l-8 8.5a.5.5 0 0 1-.842-.49L6.323 9.5H3a.5.5 0 0 1-.364-.843l8-8.5a.5.5 0 0 1 .615-.09z"/>'),
  /* 加号 */
  plus: _bi('<path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2"/>'),
  /* 合集 / 专辑（播放列表） */
  album: _bi('<path d="M6.5 12.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0"/><path d="M10.5 9a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5"/>')
};

/* ---------------------- 主题 ---------------------- */
const THEME_KEY = NS + '_theme';
let curTheme = 'light';
function readTheme() { try { const v = GM_getValue(THEME_KEY, ''); return (v === 'dark' || v === 'light') ? v : 'light'; } catch (e) { return 'light'; } }
function applyTheme(t) {
  try { GM_setValue(THEME_KEY, t); } catch (e) {}
  const dr = q('#drawer'); if (dr) dr.setAttribute('data-theme', t);
  const b = q('#brsThemeBtn'); if (b) { b.innerHTML = t === 'dark' ? ICO.sun : ICO.moon; b.title = t === 'dark' ? '切换为浅色主题' : '切换为深色主题'; }
}
function toggleTheme() { curTheme = curTheme === 'dark' ? 'light' : 'dark'; applyTheme(curTheme); }

/* ---------------------- 视图状态（仅前端本地） ---------------------- */
const V = {
  tab: 'todo',
  search: '', monSearch: '',
  dlOpen: false,
  seg: { mon: 'all', subs: 'all' },
  _todoSeg: 'todo',
  limit: { todo: 60 }
};

/* ---------------------- 渲染调度：rAF 合帧 + 脏标记 ---------------------- */
const dirtySet = new Set();
let rafHandle = 0;
function markDirty(...views) { views.forEach(v => dirtySet.add(v)); scheduleRender(); }
function scheduleRender() {
  if (rafHandle) return;
  rafHandle = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb => setTimeout(cb, 16)))(() => {
    rafHandle = 0;
    const views = new Set(dirtySet); dirtySet.clear();
    flushCounts();
    if (V.tab === 'todo' && views.has('todo')) renderTodo();
    if (V.tab === 'mon' && views.has('mon')) renderMon();
    if (V.tab === 'subs' && views.has('subs')) renderSubs();
    if (V.tab === 'bench' && views.has('pick')) renderDlPick();
    if (V.tab === 'dl' && views.has('dl')) renderDl();
  });
}
/* 后端统一入口（契约） */
function updateAllUI() { if (!shadowRoot) return; markDirty('todo', 'mon', 'subs', 'dl'); }

/* ---------------------- 小工具 ---------------------- */
const relTime = ts => { const t = Number(ts) || 0; return t ? fmtDate(Math.floor(t / 1000)) : '—'; };
const clampTxt = (s, n) => { const v = String(s || ''); return v.length > n ? v.slice(0, n) + '…' : v; };
const initial = s => (String(s || '').trim()[0] || '·').toUpperCase();
const fmtSize = s => {
  s = Number(s) || 0; if (!s) return '';
  if (s >= 1073741824) return (s / 1073741824).toFixed(2) + ' GB';
  if (s >= 1048576) return (s / 1048576).toFixed(1) + ' MB';
  return Math.round(s / 1024) + ' KB';
};
const numPlain = n => (Number(n) || 0).toLocaleString('zh-CN');
const qnName = q => QN_LABEL[q] || ('qn' + q);
const cssUrl = u => "url('" + String(u).replace(/['\\]/g, '\\$&') + "')";
const attr = s => esc(String(s == null ? '' : s)).replace(/"/g, '&quot;');

/* ---------------------- 头像本地缓存 (v0.1.23) ----------------------
 * 订阅 / 监控 / 稍后再看里的头像 URL, 首次成功下载后以 dataURL 存本地(GM 独立 key,
 * 不混入 store 以免备份膨胀); 之后绘制直接调本地, 不再发网络请求。
 * 上限: 400 个头像, 单个 >400KB 不缓存, 写入失败自动删半降级, 全程静默。 */
const AVA_KEY = NS + '_ava';
let avaCache = null;
let avaWarm = {};
function getAvaCache() {
  if (avaCache) return avaCache;
  try { avaCache = JSON.parse(GM_getValue(AVA_KEY, '{}') || '{}'); } catch (e) { avaCache = {}; }
  if (!avaCache || typeof avaCache !== 'object') avaCache = {};
  return avaCache;
}
function saveAvaCache() {
  try { GM_setValue(AVA_KEY, JSON.stringify(getAvaCache())); }
  catch (e) {
    try {
      const ks = Object.keys(getAvaCache());
      for (let i = 0; i < Math.ceil(ks.length / 2); i++) delete getAvaCache()[ks[i]];
      GM_setValue(AVA_KEY, JSON.stringify(getAvaCache()));
    } catch (e2) { /* 静默 */ }
  }
}
/* 渲染时取用: 有本地缓存用本地, 否则先用原 URL 占位 */
const faceSrc = u => { if (!u) return ''; const m = getAvaCache(); return m[u] || u; };
/* 预取远程头像到本地; 成功后直接回填到该元素并缓存, 下次渲染 faceSrc 直接命中 */
function warmAva(el, url) {
  if (!url || /^data:/i.test(url)) return;
  const m = getAvaCache();
  if (m[url]) { if (el && el.isConnected) el.style.backgroundImage = "url('" + m[url] + "')"; return; }
  if (!el || !el.isConnected) return;
  const dr = q('#drawer');
  if (!dr || !dr.classList.contains('show')) return;   /* 面板未打开不后台预取 */
  if (avaWarm[url]) { avaWarm[url].push(el); return; }
  avaWarm[url] = [el];
  const finish = data => {
    const els = avaWarm[url] || [];
    if (data) {
      m[url] = data;
      const ks = Object.keys(m);
      if (ks.length > 400) delete m[ks[0]];
      saveAvaCache();
    }
    for (const e of els) { if (e && e.isConnected) e.style.backgroundImage = "url('" + (data || url) + "')"; }
    delete avaWarm[url];
  };
  try {
    GM_xmlhttpRequest({
      url, method: 'GET', responseType: 'arraybuffer', timeout: 15000,
      onload: r => {
        try {
          if (r.status !== 200 || !r.response) { finish(null); return; }
          const fr = new FileReader();
          fr.onload = () => { try { const d = String(fr.result); finish(d.length < 400000 ? d : null); } catch (e) { finish(null); } };
          fr.readAsDataURL(new Blob([r.response]));
        } catch (e) { finish(null); }
      },
      onerror: () => finish(null),
      ontimeout: () => finish(null)
    });
  } catch (e) { delete avaWarm[url]; }
}

function avaHtml(url, fallbackText, cls, extraTitle) {
  const cached = url ? faceSrc(url) : '';
  return '<span class="ava ' + (cls || '') + '" data-ava="' + attr(url || '') + '" data-ini="' + attr(fallbackText || '') + '"' +
    (extraTitle ? ' title="' + attr(extraTitle) + '"' : '') +
    (cached ? ' style="background-image:' + cssUrl(cached) + '"' : '') + '>' +
    (cached ? '' : esc(fallbackText || '')) + '</span>';
}

/* ---------------------- 弹层 ---------------------- */
/* 输入类标签: 这些元素里的按键是「用户正在打字」, 绝不能漏给宿主页面 */
const TYPING_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1 };
const isTypingEl = el => !!(el && TYPING_TAGS[el.tagName]);
const TL = {
  _done: null, _key: null, _key0: null,
  close(val) {
    const m = q('#brsMask'); if (m) m.classList.remove('show');
    const fn = TL._done; TL._done = null;
    if (TL._key) {
      for (const t of ['keydown', 'keyup', 'keypress']) document.removeEventListener(t, TL._key, true);
      TL._key = null;
    }
    if (fn) fn(val);
  },
  open(cfg) {
    const m = q('#brsMask'), box = q('#brsModal');
    if (!m || !box) return Promise.resolve(null);
    if (TL._done) { const f = TL._done; TL._done = null; f(null); }
    const fields = cfg.fields || [];
    box.innerHTML =
      '<div class="mh"><div class="mi' + (cfg.danger ? ' err' : '') + '">' + (cfg.danger ? ICO.warn : (cfg.icon || ICO.info)) + '</div>' +
        '<div style="flex:1;min-width:0"><div class="mt">' + esc(cfg.title || '') + '</div>' +
        (cfg.desc ? '<div class="ms">' + cfg.desc + '</div>' : '') + '</div></div>' +
      '<div class="mb">' + (cfg.html || '') +
        fields.map(f => '<div class="fld"><div class="fl">' + esc(f.label || '') +
          (f.hint ? '<span class="hint">' + esc(f.hint) + '</span>' : '') + '</div>' +
          (f.multiline
            ? '<textarea rows="' + (f.rows || 2) + '" id="tl-' + f.id + '" placeholder="' + attr(f.placeholder || '') + '">' + esc(f.value || '') + '</textarea>'
            : '<input type="text" id="tl-' + f.id + '" value="' + attr(f.value || '') + '" placeholder="' + attr(f.placeholder || '') + '">') +
          (f.note ? '<div class="desc">' + f.note + '</div>' : '') + '</div>').join('') +
      '</div>' +
      '<div class="mf">' +
        (cfg.cancelText === null ? '' : '<button class="sbtn" id="tl-cancel">' + esc(cfg.cancelText || '取消') + '</button>') +
        '<button class="sbtn ' + (cfg.danger ? 'danger' : 'pink') + '" id="tl-ok">' + esc(cfg.okText || '确定') + '</button>' +
      '</div>';
    const okBtn = box.querySelector('#tl-ok'), noBtn = box.querySelector('#tl-cancel');
    if (okBtn) okBtn.addEventListener('click', () => {
      const out = {}; let bad = null;
      for (const f of fields) {
        const el = box.querySelector('#tl-' + f.id);
        const v = el ? el.value : '';
        if (f.required && !String(v).trim()) { if (!bad) bad = el; continue; }
        out[f.id] = v;
      }
      if (bad) { bad.focus(); bad.classList.add('bad'); setTimeout(() => bad.classList.remove('bad'), 1500); return; }
      TL.close({ ok: true, fields: out });
    });
    if (noBtn) noBtn.addEventListener('click', () => TL.close(null));
    m.onclick = ev => { if (ev.target === m) TL.close(null); };
    const p = new Promise(res => { TL._done = res; });
    m.classList.add('show');
    const first = fields[0] ? box.querySelector('#tl-' + fields[0].id) : okBtn;
    if (first) setTimeout(() => { try { first.focus(); if (first.select && first.tagName === 'INPUT') first.select(); } catch (e) {} }, 80);
    /* 键盘处理（capture 阶段, 先于宿主页面拿到事件）。
     *
     * 为什么大多数键都要阻止传播: B 站播放器的全局快捷键挂在 document 上,
     * 我们在 shadow DOM 里输入时事件会一路冒泡到 document 被播放器接管 ——
     * 典型症状就是「在关键词框里敲空格, 视频反而暂停/播放了」(空格是播放器暂停键),
     * 左右方向键还会被当成快进/快退。弹层打开期间用户的按键意图都属于弹层,
     * 所以除明确要交给弹层的键外, 其余在「输入框/文本域聚焦时」一律拦在弹层内。
     * 只拦 keydown/keyup/keypress, 不动其它事件类型, 不影响页面滚动与点击。 */
    const typing = () => isTypingEl(document.activeElement) || isTypingEl(m.querySelector('input:focus, textarea:focus'));
    TL._key = ev => {
      if (!m.classList.contains('show')) return;
      if (ev.key === 'Escape') { ev.stopPropagation(); TL.close(null); return; }
      if (ev.key === 'Enter' && isTypingEl(ev.target) && okBtn) {
        ev.stopPropagation(); ev.preventDefault(); okBtn.click(); return;
      }
      if (typing()) ev.stopPropagation();
    };
    document.addEventListener('keydown', TL._key, true);
    document.addEventListener('keyup', TL._key, true);
    document.addEventListener('keypress', TL._key, true);
    return p;
  },
  show(cfg) { return TL.open(cfg); },
  async confirm(cfg) {
    const r = await TL.open({
      title: cfg.title, desc: cfg.desc, danger: !!cfg.danger,
      okText: cfg.okText || '确定', cancelText: cfg.cancelText || '取消',
      html: cfg.html ? '<div style="font-size:12.9px;line-height:1.78;color:var(--t2)">' + cfg.html + '</div>' : ''
    });
    return !!(r && r.ok);
  }
};
/* ============================ 样式 ============================ */
const CSS = `
:host{
  --brand:#fb7299; --brand-2:#e6407c; --brand-soft:#fff0f5;
  --ok:#16a34a; --warn:#f0a020; --err:#e64552; --info:#00a1d6;
  --t1:#0e1218; --t2:#4c5461; --t3:#939aa7; --t4:#b7bdc8;
  --line:#ecedf2; --line-2:#dfe2e9;
  --panel:#ffffff; --panel-2:#fafbfd; --hover:#f2f4f8; --sunk:#f7f8fb;
  --shadow-lg:0 22px 68px rgba(15,20,32,.24);
  --shadow-md:0 6px 22px rgba(15,20,32,.09);
  --shadow-sm:0 2px 8px rgba(15,20,32,.06);
  --radius:16px; --glass:rgba(255,255,255,.78);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --rail:62px;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
button{font-family:inherit}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:rgba(147,154,167,.34);border-radius:10px;border:2.5px solid transparent;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:rgba(147,154,167,.56);background-clip:content-box}
::-webkit-scrollbar-track{background:transparent}

/* ========== 悬浮球 ========== */
#fab{
  position:fixed;right:24px;bottom:26px;z-index:2147483001;width:58px;height:58px;border-radius:19px;
  background:linear-gradient(150deg,#ff9ebd 0%,var(--brand) 46%,var(--brand-2) 100%);
  box-shadow:0 12px 30px rgba(251,114,153,.46),0 2px 6px rgba(0,0,0,.10);
  display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;border:none;padding:0;color:#fff;
  transition:transform .22s cubic-bezier(.34,1.56,.64,1),box-shadow .22s;
}
#fab:hover{transform:translateY(-3px) scale(1.05);box-shadow:0 18px 40px rgba(251,114,153,.55)}
#fab:active{transform:translateY(0) scale(.96)}
#fab .logo-dot{width:34px;height:34px;border-radius:11px;background:#fff;display:flex;align-items:center;
  justify-content:center;font-weight:900;font-size:20px;color:var(--brand);box-shadow:0 2px 6px rgba(0,0,0,.1);
  font-family:var(--font);line-height:1}
#fab .x{display:none;align-items:center;justify-content:center}
#fab .x svg{width:26px;height:26px;display:block}
#fab.close-state .logo-dot{display:none}
#fab.close-state .x{display:flex}
#fab .badge{
  position:absolute;top:-6px;right:-8px;min-width:23px;height:23px;padding:0 6px;border-radius:12px;
  background:linear-gradient(160deg,#ff6b81,var(--err));border:2.5px solid #fff;color:#fff;
  font-size:11.5px;font-weight:800;display:flex;align-items:center;justify-content:center;
  box-shadow:0 3px 9px rgba(230,69,82,.42);font-family:var(--font);
}
#fab .badge[hidden]{display:none!important}

/* ========== 抽屉 ========== */
#drawer{
  position:fixed;right:20px;bottom:18px;z-index:2147483003;width:720px;max-width:calc(100vw - 32px);
  height:min(770px,calc(100vh - 96px));max-height:min(770px,calc(100vh - 96px));
  background:var(--panel);color:var(--t1);border:1px solid var(--line-2);border-radius:var(--radius);
  box-shadow:var(--shadow-lg);display:flex;flex-direction:column;overflow:hidden;font-family:var(--font);font-size:13px;
  transform:translateY(18px) scale(.985);opacity:0;pointer-events:none;
  transition:opacity .2s ease,transform .24s cubic-bezier(.22,1,.36,1);
  contain:layout style paint;
}
#drawer.show{transform:translateY(0) scale(1);opacity:1;pointer-events:auto}
#drawer[data-theme="dark"]{
  --t1:#e9edf4; --t2:#a9b2c1; --t3:#75808f; --t4:#5b6472;
  --line:#262c37; --line-2:#333a47;
  --panel:#181d26; --panel-2:#1d222c; --hover:#232935; --sunk:#1b2029;
  --brand-soft:#33202a; --glass:rgba(24,29,38,.8);
  --shadow-lg:0 24px 72px rgba(0,0,0,.62); --shadow-md:0 6px 22px rgba(0,0,0,.4); --shadow-sm:0 2px 8px rgba(0,0,0,.3);
}

/* ---------- 顶栏 ---------- */
.d-head{
  display:flex;align-items:center;gap:11px;padding:13px 15px;flex:none;
  background:linear-gradient(180deg,var(--panel),var(--panel-2));border-bottom:1px solid var(--line);position:relative;
}
.d-head::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;
  background:linear-gradient(90deg,transparent,rgba(251,114,153,.42),transparent)}
.d-head .mk{width:34px;height:34px;border-radius:11px;flex:none;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(150deg,#ff9ebd,var(--brand) 50%,var(--brand-2));box-shadow:0 4px 12px rgba(251,114,153,.36);
  color:#fff;font-weight:800;font-size:16px}
.d-head .tt{min-width:0}
.d-head .t1{font-weight:800;font-size:15px;letter-spacing:.2px;display:flex;align-items:center;gap:7px;line-height:1.2}
.ver{font-size:10px;font-weight:700;color:var(--brand);background:var(--brand-soft);border-radius:5px;padding:1px 5px;letter-spacing:.3px}
.d-head .t2{font-size:11px;color:var(--t3);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.head-sp{flex:1}
.icobtn{width:31px;height:31px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;color:var(--t2);
  border:none;background:none;cursor:pointer;transition:.13s;flex:none;padding:0}
.icobtn:hover{background:var(--hover);color:var(--t1)}
.icobtn:active{transform:scale(.92)}
.icobtn svg{width:18px;height:18px;display:block}
.icobtn.on{color:var(--ok)}.icobtn.off{color:var(--t4)}
.icobtn.danger:hover{background:rgba(230,69,82,.12);color:var(--err)}
.icobtn.busy svg{animation:brs-spin .85s linear infinite}
@keyframes brs-spin{to{transform:rotate(360deg)}}

/* ---------- 三段式主体 ---------- */
.d-main{flex:1;display:flex;min-height:0}
.rail{width:var(--rail);flex:none;background:var(--panel-2);border-right:1px solid var(--line);
  display:flex;flex-direction:column;padding:10px 0;gap:2px}
.rail .d-tab{position:relative;width:100%;padding:9px 2px 8px;border:none;background:none;cursor:pointer;
  display:flex;flex-direction:column;align-items:center;gap:5px;color:var(--t3);transition:.15s;font-size:10.5px;font-family:inherit}
.rail .d-tab .i-wrap{position:relative;width:40px;height:31px;border-radius:9px;display:flex;align-items:center;justify-content:center;transition:.15s}
.rail .d-tab svg{width:22px;height:22px;transition:transform .16s}
.rail .d-tab:hover{color:var(--t1);background:var(--hover)}
.rail .d-tab:hover svg{transform:scale(1.1)}
.rail .d-tab.on{color:var(--brand);font-weight:700}
.rail .d-tab.on .i-wrap{background:var(--brand-soft)}
.rail .d-tab.on::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:22px;
  border-radius:0 3px 3px 0;background:var(--brand)}
.rail .cb{position:absolute;top:-4px;right:-1px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;
  background:linear-gradient(160deg,#ff6b81,var(--err));color:#fff;font-size:10px;font-weight:800;
  display:flex;align-items:center;justify-content:center;box-shadow:0 2px 5px rgba(230,69,82,.35)}
.rail .cb[hidden]{display:none!important}
.pgwrap{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--panel)}

/* ---------- 工具条 ---------- */
.bar{flex:none;display:flex;align-items:center;gap:8px;padding:11px 14px 9px;flex-wrap:wrap;
  border-bottom:1px solid var(--line);background:var(--panel)}
.seg{display:inline-flex;padding:2.5px;gap:2px;background:var(--sunk);border:1px solid var(--line);border-radius:11px}
.seg button{border:none;background:none;cursor:pointer;color:var(--t2);font-size:12px;font-family:inherit;height:25px;
  padding:0 11px;border-radius:8.5px;display:inline-flex;align-items:center;gap:5px;transition:.13s;white-space:nowrap}
.seg button:hover{color:var(--t1)}
.seg button.on{background:var(--panel);color:var(--t1);font-weight:700;box-shadow:var(--shadow-sm)}
.seg button .n{font-size:10.5px;font-weight:800;color:var(--brand);font-variant-numeric:tabular-nums}
.grow{flex:1;min-width:6px}
.sel{height:31px;border:1px solid var(--line-2);border-radius:9px;padding:0 27px 0 10px;background:var(--panel);font-size:12px;
  color:var(--t1);outline:none;font-family:inherit;cursor:pointer;max-width:200px;appearance:none;-webkit-appearance:none;
  background-image:url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23939aa7' stroke-width='2.2' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 7px center;background-size:13px}
.sel:hover{border-color:rgba(251,114,153,.5)}
.sel:focus{border-color:var(--brand)}
.sbox{position:relative;flex:1;min-width:132px;max-width:262px}
.sbox>svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--t3);pointer-events:none}
.sbox input{width:100%;height:31px;border:1px solid var(--line-2);border-radius:9px;padding:0 27px 0 29px;background:var(--panel);
  font-size:12.5px;color:var(--t1);outline:none;font-family:inherit;transition:.14s}
.sbox input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(251,114,153,.15)}
.sbox .clr{position:absolute;right:5px;top:50%;transform:translateY(-50%);width:20px;height:20px;border:none;background:none;
  color:var(--t3);cursor:pointer;border-radius:6px;display:none;align-items:center;justify-content:center;padding:0}
.sbox.has .clr{display:flex}
.sbox .clr:hover{background:var(--hover);color:var(--t1)}
.sbox .clr svg{width:13px;height:13px;display:block}

/* ---------- 滚动区 ---------- */
.d-body{flex:1;overflow-y:auto;overflow-x:hidden;padding:12px 14px 22px;background:var(--panel);overscroll-behavior:contain}
.pg{display:none}
.pg.on{display:block}

/* ---------- 视频卡 ---------- */
.card{display:flex;gap:12px;padding:11px;border:1px solid var(--line);border-radius:13px;margin-bottom:9px;
  background:var(--panel);position:relative;content-visibility:auto;contain-intrinsic-size:auto 120px;
  transition:border-color .15s,box-shadow .15s}
.card:hover{border-color:rgba(251,114,153,.4);box-shadow:var(--shadow-md)}
.card::before{content:"";position:absolute;left:0;top:11px;bottom:11px;width:3px;border-radius:0 3px 3px 0;
  background:var(--brand);opacity:0;transition:opacity .15s}
.card:hover::before{opacity:.85}
.card.done{opacity:.74;background:var(--panel-2)}
.card.done::before{background:var(--ok)}
.card.ignored{opacity:.8;background:var(--sunk)}
.card.ignored::before{background:var(--t3)}
.card.ignored .cov,.card.ignored .vtitle,.card.ignored .vby{filter:grayscale(.85)}
.cov{width:172px;height:97px;border-radius:9px;flex:none;background:var(--sunk) center/cover no-repeat;position:relative;
  cursor:pointer;overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--t4);border:1px solid var(--line)}
.cov img.ci{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.cov:hover .cov-mask{opacity:1}
.cov-mask{position:absolute;inset:0;background:linear-gradient(0deg,rgba(8,10,16,.6),rgba(8,10,16,.05));opacity:0;
  transition:.16s;display:flex;align-items:center;justify-content:center;color:#fff;z-index:2}
.cov-mask svg{width:30px;height:30px;filter:drop-shadow(0 2px 6px rgba(0,0,0,.5))}
.cov .dur{position:absolute;right:5px;bottom:5px;z-index:3;background:rgba(8,10,16,.74);color:#fff;font-size:10.5px;
  padding:1px 5px;border-radius:5px;font-variant-numeric:tabular-nums}
.cov .pg-tag{position:absolute;left:5px;bottom:5px;z-index:3;background:rgba(251,114,153,.94);color:#fff;font-size:10.5px;
  padding:1px 5px;border-radius:5px;font-weight:700}
.cov .ph svg{width:26px;height:26px;opacity:.32}
.vmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.vtitle{font-size:13.6px;font-weight:650;line-height:1.42;color:var(--t1);cursor:pointer;word-break:break-word;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.vtitle:hover{color:var(--brand-2)}
.vby{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.vby .ava{width:20px;height:20px;font-size:10px}
.vby .nm{font-size:12px;color:var(--t2);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{font-size:10.5px;height:18px;padding:0 7px;border-radius:6px;display:inline-flex;align-items:center;gap:4px;
  background:var(--sunk);color:var(--t2);border:1px solid var(--line);white-space:nowrap}
.chip.p{background:var(--brand-soft);color:var(--brand-2);border-color:rgba(251,114,153,.28)}
.chip.ok{background:rgba(22,163,74,.12);color:var(--ok);border-color:rgba(22,163,74,.26)}
.chip.ig{background:rgba(147,154,167,.14);color:var(--t2);border-color:var(--line-2)}
.vfoot{display:flex;align-items:center;gap:2px;margin-top:auto;padding-top:3px;justify-content:flex-end}

.ava{border-radius:50%;flex:none;background:var(--sunk) center/cover no-repeat;display:inline-flex;align-items:center;
  justify-content:center;color:#fff;font-weight:700;overflow:hidden;background-color:rgba(251,114,153,.72)}

.act{width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;color:var(--t2);
  border:none;background:none;cursor:pointer;transition:.13s;padding:0}
.act:hover{background:var(--hover);color:var(--t1)}
.act:active{transform:scale(.9)}
.act svg{width:17px;height:17px;display:block}
.act.ok:hover{color:var(--ok);background:rgba(22,163,74,.13)}
.act.ign:hover{color:var(--warn);background:rgba(240,160,32,.14)}
.act.del:hover{color:var(--err);background:rgba(230,69,82,.12)}
.act.watch:hover{color:var(--info);background:rgba(0,161,214,.13)}
.act.rf:hover{color:var(--brand-2);background:var(--brand-soft)}

/* ---------- 空态 / 骨架 / 加载更多 ---------- */
.empty{text-align:center;color:var(--t3);padding:52px 22px;font-size:12.5px;line-height:1.75}
.empty .eico{width:56px;height:56px;margin:0 auto 13px;border-radius:18px;display:flex;align-items:center;justify-content:center;
  background:var(--sunk);border:1px solid var(--line);color:var(--t4)}
.empty .eico svg{width:30px;height:30px}
.empty .et{font-size:13.5px;font-weight:700;color:var(--t2);margin-bottom:4px}
.empty .es{font-size:11.5px;color:var(--t3)}
.empty .eb{margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.sk{display:flex;gap:12px;padding:11px;border:1px solid var(--line);border-radius:13px;margin-bottom:9px}
.sk .a{width:172px;height:97px;border-radius:9px;flex:none}
.sk .b{flex:1;display:flex;flex-direction:column;gap:8px;padding-top:3px}
.sk .b i{display:block;height:11px;border-radius:5px}
.sk .a,.sk .b i{background:linear-gradient(90deg,var(--sunk) 25%,var(--hover) 37%,var(--sunk) 63%);background-size:400% 100%;
  animation:brs-shim 1.3s ease infinite}
.sk .b i:nth-child(1){width:82%}.sk .b i:nth-child(2){width:52%}.sk .b i:nth-child(3){width:34%;margin-top:auto}
@keyframes brs-shim{0%{background-position:100% 0}100%{background-position:0 0}}
.more{text-align:center;padding:10px 0 4px}
.more button{height:30px;padding:0 16px;border-radius:9px;border:1px dashed var(--line-2);background:none;color:var(--t2);
  font-size:12px;cursor:pointer;font-family:inherit;transition:.14s}
.more button:hover{border-color:var(--brand);color:var(--brand-2);background:var(--brand-soft)}

/* ---------- 按钮 ---------- */
.sbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 13px;border-radius:9px;
  background:var(--sunk);color:var(--t2);font-size:12.3px;border:1px solid var(--line-2);cursor:pointer;font-family:inherit;
  white-space:nowrap;transition:.13s;font-weight:600}
.sbtn:hover{background:var(--hover);color:var(--t1);border-color:var(--t4)}
.sbtn:active{transform:scale(.975)}
.sbtn svg{width:16px;height:16px;flex:none}
.sbtn.pink{background:linear-gradient(150deg,#ff8fb1,var(--brand) 60%,var(--brand-2));color:#fff;border-color:transparent;
  box-shadow:0 3px 10px rgba(251,114,153,.34)}
.sbtn.pink:hover{filter:brightness(1.06);color:#fff}
.sbtn.danger{color:var(--err);border-color:rgba(230,69,82,.32)}
.sbtn.danger:hover{background:rgba(230,69,82,.1);border-color:var(--err)}
.sbtn:disabled{opacity:.5;cursor:not-allowed}
.sbtn.sm{height:28px;padding:0 11px;font-size:11.8px;border-radius:8px}
.sbtn.sm svg{width:15px;height:15px}

/* ---------- 监控卡 ---------- */
.mcard{border:1px solid var(--line);border-radius:13px;background:var(--panel);margin-bottom:9px;padding:11px;
  content-visibility:auto;contain-intrinsic-size:auto 150px;transition:border-color .15s,box-shadow .15s}
.mcard:hover{border-color:rgba(251,114,153,.38);box-shadow:var(--shadow-md)}
.mrow{display:flex;gap:11px;align-items:flex-start}
.mface{width:46px;height:46px;font-size:16px;border-radius:14px}
.mcover{width:150px;height:86px;border-radius:9px;flex:none;background:var(--sunk) center/cover no-repeat;position:relative;
  overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--t4);border:1px solid var(--line)}
.mcover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.mcover svg{width:26px;height:26px;opacity:.32}
.mcol{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.mline1{display:flex;align-items:center;gap:10px;min-width:0}
.mname{flex:1;min-width:0;font-weight:750;font-size:13.4px;line-height:1.35;display:flex;align-items:center;gap:7px}
.mname .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.live-tag{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:6px;font-size:10.5px;flex:none;
  background:rgba(230,69,82,.12);color:var(--err);font-weight:700;border:1px solid rgba(230,69,82,.24)}
.live-tag .dotp{width:5px;height:5px;border-radius:50%;background:var(--err);animation:brs-pulse 1.25s infinite}
@keyframes brs-pulse{50%{opacity:.25}}
.mstat{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px 8px;width:100%;max-width:452px}
.mstat .metric{display:flex;flex-direction:column;align-items:flex-end;min-width:0;background:var(--sunk);
  border:1px solid var(--line);border-radius:9px;padding:4px 8px;transition:.14s}
.mstat .metric:hover{background:var(--hover)}
.mstat .mv{font-size:13.5px;font-weight:800;color:var(--t1);line-height:1.28;white-space:nowrap;
  font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:3px}
.mstat .mv .dl{color:var(--brand-2);font-size:10px;font-weight:800}
.mstat .ml{font-size:10px;color:var(--t3);line-height:1.2;white-space:nowrap;margin-top:1px}
.mmeta{font-size:11px;color:var(--t3);display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-variant-numeric:tabular-nums}
.mmeta .sep{width:1px;height:10px;background:var(--line-2)}
.mbottom{display:flex;align-items:center;gap:8px;margin-top:9px;padding-top:8px;border-top:1px dashed var(--line);font-size:10.5px;
  color:var(--t3);flex-wrap:wrap}
.mbottom .sp{flex:1}
.mkind{font-size:10px;padding:1.5px 7px;border-radius:6px;background:var(--sunk);border:1px solid var(--line);color:var(--t2);font-weight:700}
.mkind.up{background:var(--brand-soft);color:var(--brand-2);border-color:rgba(251,114,153,.26)}
.mkind.video{background:rgba(0,161,214,.12);color:var(--info);border-color:rgba(0,161,214,.26)}

/* ---------- 订阅行 ---------- */
.subrow{display:flex;align-items:center;gap:11px;padding:11px;border:1px solid var(--line);border-radius:13px;
  margin-bottom:8px;background:var(--panel);content-visibility:auto;contain-intrinsic-size:auto 84px;transition:.15s}
.subrow:hover{border-color:rgba(251,114,153,.38);box-shadow:var(--shadow-md)}
.subrow.off{opacity:.68}
.subrow .ic{width:40px;height:40px;border-radius:13px;font-size:15px;font-weight:800}
.submid{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.subname{font-size:13.3px;font-weight:700;display:flex;align-items:center;gap:7px;min-width:0}
.subname .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.stype{font-size:10px;font-weight:700;height:18px;padding:0 7px;border-radius:6px;display:inline-flex;align-items:center;
  flex:none;border:1px solid transparent}
.stype.up{background:rgba(0,161,214,.12);color:var(--info);border-color:rgba(0,161,214,.26)}
.stype.ugc{background:rgba(240,160,32,.14);color:#c8791a;border-color:rgba(240,160,32,.3)}
.stype.season{background:rgba(138,92,246,.13);color:#7c5cd6;border-color:rgba(138,92,246,.28)}
.stype.bangumi{background:rgba(251,114,153,.14);color:var(--brand-2);border-color:rgba(251,114,153,.32)}
.subsub{font-size:11px;color:var(--t3);display:flex;gap:9px;flex-wrap:wrap;font-variant-numeric:tabular-nums;align-items:center}
.subsub .sep{width:1px;height:9px;background:var(--line-2)}
.subflt{font-size:10.5px;color:var(--t2);display:flex;gap:5px;flex-wrap:wrap;margin-top:1px}
.subflt .kw{background:var(--brand-soft);color:var(--brand-2);border-radius:5px;padding:1px 6px}
.subflt .ex{background:rgba(147,154,167,.14);border-radius:5px;padding:1px 6px}
.subacts{display:flex;gap:2px;flex:none}

.toggle{width:36px;height:21px;border-radius:11px;background:var(--line-2);position:relative;flex:none;transition:.17s;
  cursor:pointer;border:none;padding:0}
.toggle::after{content:"";position:absolute;left:2.5px;top:2.5px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:.17s;box-shadow:0 1px 3px rgba(0,0,0,.24)}
.toggle.on{background:linear-gradient(135deg,#ff8fb1,var(--brand))}
.toggle.on::after{left:17.5px}

/* ---------- 设置 ---------- */
.setcard{border:1px solid var(--line);border-radius:13px;background:var(--panel);overflow:hidden;margin-bottom:11px}
.setcard .ct{padding:11px 14px 9px;font-size:11.5px;font-weight:800;color:var(--t3);letter-spacing:.6px;
  border-bottom:1px solid var(--line);background:var(--panel-2);display:flex;align-items:center;gap:7px}
.setcard .ct svg{width:16px;height:16px}
.setrow{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line);transition:.13s}
.setrow:last-child{border-bottom:none}
.setrow:hover{background:var(--panel-2)}
.setlabel{flex:1;min-width:0}
/* 互斥项置灰提示: 另一开关已生效时, 本行标签淡出(开关仍可点, 用于切换回来) */
.setrow.dep-off .setlabel{opacity:.42}
.setlabel .st{font-size:13px;font-weight:600}
.setlabel .sd{font-size:11px;color:var(--t3);margin-top:2px;line-height:1.5}
.setrow input[type=number]{height:31px;border:1px solid var(--line-2);border-radius:9px;padding:0 10px;background:var(--panel);
  font-size:13px;color:var(--t1);outline:none;font-family:inherit;width:86px;transition:.14s}
.setrow input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(251,114,153,.15)}
.about{background:linear-gradient(150deg,var(--brand-soft),var(--panel));border:1px solid rgba(251,114,153,.28);
  border-radius:13px;padding:14px;display:flex;gap:13px;align-items:center}
.about .lg{width:48px;height:48px;border-radius:15px;flex:none;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(150deg,#ff9ebd,var(--brand) 55%,var(--brand-2));color:#fff;font-weight:800;font-size:21px;
  box-shadow:0 6px 16px rgba(251,114,153,.36)}
.about .an{font-weight:800;font-size:15px;display:flex;align-items:center;gap:7px}
.about .av{font-size:11px;color:var(--t3);margin-top:2px}
.about .al{margin-top:9px;display:flex;gap:7px;flex-wrap:wrap;align-items:center}

/* ---------- 工作台（页面识别操作卡） ---------- */
.dlpick{border:1px solid rgba(251,114,153,.32);background:linear-gradient(160deg,var(--brand-soft),var(--panel) 62%);
  border-radius:14px;padding:12px;margin-bottom:12px;box-shadow:var(--shadow-sm)}
.dlp-title{display:flex;align-items:center;gap:8px;font-size:12.5px;margin-bottom:9px}
.dlp-title .hb{display:flex;align-items:center;gap:6px;font-weight:800;color:var(--brand-2);font-size:12.5px}
.dlp-title .hb svg{width:17px;height:17px}
.dlp-title .rt{margin-left:auto;font-size:11px;color:var(--t3)}
.dlp-body{display:flex;gap:11px;align-items:flex-start}
.dlp-cover{width:142px;height:84px;border-radius:10px;object-fit:cover;flex:none;background:var(--sunk);border:1px solid var(--line)}
.dlp-upface{width:58px;height:58px;border-radius:18px;background:var(--sunk) center/cover no-repeat;flex:none;display:flex;
  align-items:center;justify-content:center;font-size:22px;color:#fff;font-weight:700;border:1px solid var(--line)}
.dlp-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.dlp-name{font-size:13.6px;font-weight:700;line-height:1.4;word-break:break-word;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dlp-meta{font-size:11.5px;color:var(--t3);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dlp-acts{display:flex;gap:7px;margin-top:3px;flex-wrap:wrap}
.dlp-rows{max-height:200px;overflow-y:auto;margin:8px -4px 0;padding:0 4px;border-top:1px solid rgba(251,114,153,.2)}

.dlp-dlwrap{margin-top:2px;animation:dlpDlIn .18s ease-out}

@keyframes dlpDlIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.dlp-row{display:flex;align-items:center;gap:8px;padding:5px 6px;font-size:12.3px;cursor:pointer;border-radius:7px;transition:.12s}
.dlp-row:hover{background:var(--hover)}
.dlp-row input[type=checkbox]{accent-color:var(--brand);flex:none;width:14px;height:14px;cursor:pointer}
.dlp-pn{flex:none;width:30px;font-size:10.5px;color:var(--t3);font-variant-numeric:tabular-nums;text-align:center;
  background:var(--sunk);border-radius:5px;padding:1px 0}
.dlp-pt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlp-pd{flex:none;font-size:10.5px;color:var(--t3);font-variant-numeric:tabular-nums}
.dlp-foot{display:flex;align-items:center;gap:8px;margin-top:9px;padding-top:9px;border-top:1px solid rgba(251,114,153,.2)}
.dlp-foot .sp{flex:1}
.dlp-note{font-size:11.5px;color:var(--t3);line-height:1.75;padding:6px 2px}
.dlp-note b{color:var(--t2)}
/* 番剧: 剧集多, 列表给更高上限; 分节标题行 */
.dlpick[data-kind="bangumi"] .dlp-rows{max-height:272px}
.dlp-sec{display:flex;align-items:center;gap:8px;margin:9px 2px 3px;font-size:10.5px;font-weight:800;
  color:var(--brand-2);letter-spacing:.4px}
.dlp-sec::after{content:"";flex:1;height:1px;background:rgba(251,114,153,.22)}
.dlp-sec:first-child{margin-top:4px}
.dlp-row .dlp-ep{flex:none;font-size:10.5px;color:var(--t3);font-variant-numeric:tabular-nums}

/* ---------- 内联订阅卡片（在工作台里就地填关键词, 不弹全局遮罩） ---------- */
.dlpk{border:1px dashed rgba(251,114,153,.5);background:var(--panel);border-radius:14px;
  padding:11px 12px;margin-bottom:12px;box-shadow:var(--shadow-sm);animation:dlpkIn .18s ease-out}
@keyframes dlpkIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.dlpk .fld{margin-bottom:9px}
.dlpk .fld:last-of-type{margin-bottom:0}
.dlpk .fl{font-size:11.5px;font-weight:800;color:var(--t1);display:flex;align-items:center;gap:6px;margin-bottom:5px}
.dlpk .fl .hint{font-weight:400;font-size:10.5px;color:var(--t3)}
.dlpk input[type=text],.dlpk textarea{width:100%;box-sizing:border-box;font-size:12.6px;padding:7px 9px;
  border-radius:9px;border:1px solid var(--line);background:var(--sunk);color:var(--t1);outline:none;
  font-family:inherit;transition:border-color .12s}
.dlpk input[type=text]:focus,.dlpk textarea:focus{border-color:var(--brand)}
.dlpk input.bad{border-color:#e5484d;animation:dlpkShake .3s}
@keyframes dlpkShake{25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
.dlpk .desc{font-size:10.6px;color:var(--t3);line-height:1.7;margin-top:5px}
.dlpk .desc b{color:var(--t2)}
.dlpk .dlpk-ex{margin-top:9px;font-size:11.4px;color:var(--t2);line-height:1.7}
.dlpk .dlpk-ex ul{margin:3px 0 0;padding-left:17px}
.dlpk .dlpk-ex .off{color:var(--t3)}
.dlpk .dlpk-acts{display:flex;gap:7px;justify-content:flex-end;margin-top:11px;
  padding-top:10px;border-top:1px solid rgba(251,114,153,.2)}

/* ---------- 下载 ---------- */
.dlhead{display:flex;align-items:center;gap:9px;padding:12px 14px 10px;border-bottom:1px solid var(--line);
  background:var(--panel);user-select:none;flex:none}
.dl-arrow{display:inline-flex;width:18px;color:var(--brand);transition:transform .17s}
.dl-arrow svg{width:16px;height:16px;display:block}
.dlhead.open .dl-arrow{transform:rotate(90deg)}
.dl-head-t{font-size:13px;font-weight:750;display:inline-flex;align-items:center;gap:5px}
.dl-head-t svg{width:17px;height:17px;display:block;color:var(--brand)}
.dl-sum{font-size:11px;color:var(--t3);font-variant-numeric:tabular-nums}
.dl-badge{min-width:19px;height:19px;padding:0 6px;border-radius:10px;background:linear-gradient(160deg,#ff6b81,var(--err));
  color:#fff;font-size:10.5px;font-weight:800;display:inline-flex;align-items:center;justify-content:center}
.dl-badge[hidden]{display:none!important}
#brsDlList{padding:10px 12px 14px}
.dlcard{border:1px solid var(--line);border-radius:12px;padding:11px 12px;margin-bottom:8px;background:var(--panel);
  content-visibility:auto;contain-intrinsic-size:auto 84px;transition:.14s}
.dlcard:hover{border-color:var(--line-2);box-shadow:var(--shadow-sm)}
.dlcard .r1{display:flex;align-items:center;gap:9px}
.dlcard .tt{font-size:13px;font-weight:650;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlbadge{font-size:10.5px;height:20px;padding:0 8px;border-radius:7px;display:inline-flex;align-items:center;background:var(--sunk);
  color:var(--t3);flex:none;font-weight:700;border:1px solid var(--line)}
.dlbadge.st-doing{background:rgba(0,161,214,.12);color:var(--info);border-color:rgba(0,161,214,.26)}
.dlbadge.st-done{background:rgba(22,163,74,.12);color:var(--ok);border-color:rgba(22,163,74,.26)}
.dlbadge.st-err{background:rgba(230,69,82,.11);color:var(--err);border-color:rgba(230,69,82,.25)}
.dlmeta{font-size:11px;color:var(--t3);margin-top:7px;display:flex;gap:9px;flex-wrap:wrap;font-variant-numeric:tabular-nums}
.dlbar{height:6px;border-radius:4px;background:var(--sunk);overflow:hidden;margin-top:9px;border:1px solid var(--line)}
.dlbar i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#ff8fb1,var(--brand) 60%,var(--brand-2));
  background-size:200% 100%;animation:brs-flow 1.5s linear infinite;transition:width .28s}
@keyframes brs-flow{0%{background-position:0 0}100%{background-position:200% 0}}
.dlop{font-size:11px;color:var(--t2);margin-top:5px;font-variant-numeric:tabular-nums}
.dlerr{font-size:11px;color:var(--err);margin-top:7px;word-break:break-all;line-height:1.55;
  background:rgba(230,69,82,.07);border-radius:7px;padding:5px 8px;border:1px solid rgba(230,69,82,.18);
  display:flex;align-items:flex-start;gap:6px}
.dlerr svg{width:14px;height:14px;flex:none;margin-top:1.5px;display:block}

/* ---------- toast ---------- */
#brs-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%) translateY(16px);z-index:2147483002;
  background:var(--glass);backdrop-filter:blur(16px) saturate(1.7);-webkit-backdrop-filter:blur(16px) saturate(1.7);
  color:var(--t1);font-size:12.8px;padding:9px 17px;border-radius:12px;display:flex;align-items:center;gap:9px;
  opacity:0;transition:opacity .2s,transform .24s cubic-bezier(.22,1,.36,1);pointer-events:none;font-family:var(--font);
  border:1px solid var(--line-2);box-shadow:var(--shadow-lg);max-width:min(560px,88vw);font-weight:600}
#brs-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#brs-toast .tdot{width:7px;height:7px;border-radius:50%;flex:none;background:linear-gradient(135deg,#ff8fb1,var(--brand-2));
  box-shadow:0 0 0 3px rgba(251,114,153,.2)}
#brs-toast .tmsg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---------- 弹层 ---------- */
.mask{position:fixed;inset:0;z-index:2147483004;background:rgba(10,14,22,.42);backdrop-filter:blur(3px);
  -webkit-backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:24px;opacity:0;
  pointer-events:none;transition:opacity .17s;font-family:var(--font)}
.mask.show{opacity:1;pointer-events:auto}
.modal{width:100%;max-width:436px;background:var(--panel);border:1px solid var(--line-2);border-radius:17px;
  box-shadow:var(--shadow-lg);overflow:hidden;transform:translateY(12px) scale(.97);
  transition:transform .22s cubic-bezier(.22,1,.36,1);color:var(--t1)}
.mask.show .modal{transform:translateY(0) scale(1)}
.modal .mh{display:flex;align-items:center;gap:10px;padding:15px 16px 11px}
.modal .mh .mi{width:32px;height:32px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;
  background:var(--brand-soft);color:var(--brand-2)}
.modal .mh .mi.err{background:rgba(230,69,82,.12);color:var(--err)}
.modal .mh .mi svg{width:17px;height:17px}
.modal .mh .mt{font-size:14.5px;font-weight:800}
.modal .mh .ms{font-size:11.5px;color:var(--t3);margin-top:1px;line-height:1.5}
.modal .mb{padding:2px 16px 14px;font-size:12.8px;color:var(--t2);line-height:1.7;max-height:54vh;overflow-y:auto}
.modal .mb .fld{margin-bottom:12px}
.modal .mb .fld:last-child{margin-bottom:2px}
.modal .mb .fl{font-size:12px;font-weight:700;color:var(--t1);margin-bottom:5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.modal .mb .fl .hint{font-weight:500;color:var(--t3);font-size:10.5px}
.modal .mb input[type=text],.modal .mb textarea{width:100%;border:1px solid var(--line-2);border-radius:10px;padding:8px 11px;
  background:var(--panel-2);font-size:12.8px;color:var(--t1);outline:none;font-family:inherit;resize:vertical;transition:.14s}
.modal .mb input[type=text]{height:36px}
.modal .mb input:focus,.modal .mb textarea:focus{border-color:var(--brand);background:var(--panel);
  box-shadow:0 0 0 3px rgba(251,114,153,.15)}
.modal .mb input.bad,.modal .mb textarea.bad{border-color:var(--err);box-shadow:0 0 0 3px rgba(230,69,82,.15)}
.modal .mb .desc{font-size:11.5px;color:var(--t3);margin-top:4px;line-height:1.6}
.modal .mf{display:flex;gap:9px;justify-content:flex-end;padding:0 16px 15px}
.modal .mf .sbtn{height:33px;padding:0 17px;font-size:12.6px}

/* ---------- 响应式 / 无障碍 ---------- */
@media (max-width:760px){
  #drawer{right:8px;bottom:8px;width:calc(100vw - 16px);height:min(88vh,calc(100vh - 24px));border-radius:14px}
  .cov{width:132px;height:75px}
  .mstat{max-width:none}
  .sbox{max-width:none;flex-basis:100%}
  :host{--rail:52px}
  .rail .d-tab{padding:7px 2px 6px;font-size:9.5px}
  .rail .d-tab .i-wrap{width:33px;height:26px}
  .rail .d-tab svg{width:18px;height:18px}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}
`;
/* ============================ 骨架 HTML ============================ */
const HTML = `
<div id="fab" title="BilibiliRSS · 打开面板 (Alt+B)">
  <span class="logo-dot">B</span><span class="x">${ICO.close}</span>
  <span class="badge" id="brsFabBadge" hidden>0</span>
</div>
<aside id="drawer" data-theme="light">
  <div class="d-head">
    <div class="mk">B</div>
    <div class="tt">
      <div class="t1">BilibiliRSS <span class="ver">v${DEFAULTS.ver}</span></div>
      <div class="t2" id="brsHeadSub">稍后再看 · 订阅追更 · 增量监控 · 下载</div>
    </div>
    <span class="head-sp"></span>
    <button class="icobtn" id="brsThemeBtn" title="切换主题">${ICO.moon}</button>
    <button class="icobtn" id="brsBtnRefresh" title="立即刷新订阅与监控">${ICO.refresh}</button>
    <button class="icobtn" id="brsBtnClose" title="关闭 (Esc)">${ICO.close}</button>
  </div>
  <div class="d-main">
    <nav class="rail" id="brsTabs">
      <button class="d-tab on" data-tab="todo" title="稍后再看"><span class="i-wrap">${ICO.home}<span class="cb" id="brsCntTodo" hidden>0</span></span><span>稍后</span></button>
      <button class="d-tab" data-tab="bench" title="工作台"><span class="i-wrap">${ICO.toolbox}</span><span>工作台</span></button>
      <button class="d-tab" data-tab="mon" title="增量监控"><span class="i-wrap">${ICO.radar}<span class="cb" id="brsCntMon" hidden>0</span></span><span>监控</span></button>
      <button class="d-tab" data-tab="subs" title="订阅管理"><span class="i-wrap">${ICO.layers}<span class="cb" id="brsCntSubs" hidden>0</span></span><span>订阅</span></button>
      <button class="d-tab" data-tab="dl" title="下载管理"><span class="i-wrap">${ICO.download}<span class="cb" id="brsCntDl" hidden>0</span></span><span>下载</span></button>
      <button class="d-tab" data-tab="set" title="设置"><span class="i-wrap">${ICO.gear}</span><span>设置</span></button>
    </nav>
    <div class="pgwrap">
      <div class="d-body" id="brsBody">
        <div id="pg-todo" class="pg on">
          <div class="bar">
            <div class="seg" id="brsSegTodo">
              <button data-seg="todo" class="on">稍后再看 <span class="n" id="brsSegTodoN">0</span></button>
              <button data-seg="done">已完成 <span class="n" id="brsSegDoneN">0</span></button>
              <button data-seg="ignored">已忽略 <span class="n" id="brsSegIgnN">0</span></button>
              <button data-seg="total">全部 <span class="n" id="brsSegAllN">0</span></button>
            </div>
            <span class="grow"></span>
            <div class="sbox" id="brsSearchBox">${ICO.search}<input type="text" id="brsSearch" placeholder="搜索标题 / UP…" autocomplete="off"><button class="clr" id="brsSearchClr" title="清空">${ICO.close}</button></div>
            <div id="brsFltRow" style="display:contents"></div>
          </div>
          <div id="brsTodoList"></div>
        </div>
        <div id="pg-bench" class="pg">
          <div id="brsDlPick"></div>
        </div>
        <div id="pg-mon" class="pg">
          <div class="bar">
            <div class="seg" id="brsSegMon">
              <button data-seg="all" class="on">全部</button><button data-seg="up">UP 监控</button><button data-seg="video">视频监控</button>
            </div>
            <span class="grow"></span>
            <div class="sbox" id="brsMonSearchBox">${ICO.search}<input type="text" id="brsMonSearch" placeholder="搜索监控…" autocomplete="off"><button class="clr" id="brsMonSearchClr" title="清空">${ICO.close}</button></div>
          </div>
          <div id="brsMonList"></div>
        </div>
        <div id="pg-subs" class="pg">
          <div class="bar">
            <div class="seg" id="brsSegSubs">
              <button data-seg="all" class="on">全部</button><button data-seg="up">UP 投稿</button><button data-seg="season">合集</button><button data-seg="ugc">分P视频</button><button data-seg="bangumi">番剧</button><button data-seg="off">已停用</button>
            </div>
            <span class="grow"></span>
            <span class="dl-sum" id="brsSubsSum"></span>
          </div>
          <div id="brsSubList"></div>
        </div>
        <div id="pg-dl" class="pg">
          <div class="dlhead" id="brsDlHead" title="展开 / 收起下载管理">
            <span class="dl-arrow">${ICO.chev}</span><span class="dl-head-t">${ICO.download}下载管理</span>
            <span class="dl-sum" id="brsDlSum"></span><span class="grow"></span>
            <span class="dl-badge" id="brsDlHdCnt" hidden></span>
          </div>
          <div id="brsDlBody"><div id="brsDlList"></div></div>
        </div>
        <div id="pg-set" class="pg">
          <div class="setcard">
            <div class="ct">${ICO.gear}通用</div>
            <div class="setrow"><div class="setlabel"><div class="st">系统通知</div><div class="sd">新内容汇总为一条通知，自动去重</div></div><label class="toggle" id="brsSetNotify"></label></div>
          </div>
          <div class="setcard">
            <div class="ct">${ICO.download}下载</div>
            <div class="setrow"><div class="setlabel"><div class="st">下载画质</div><div class="sd">&gt;720P 自动走 DASH 分片 + ffmpeg 合并；引擎加载一次同页复用</div></div>
              <select class="sel" id="brsSetQn"><option value="127">原画 / 最高</option><option value="120">4K</option><option value="116">1080P60</option><option value="80">1080P</option><option value="64">720P</option><option value="32">480P</option><option value="16">360P</option></select></div>
            <div class="setrow"><div class="setlabel"><div class="st">下载线程数</div><div class="sd">视频分片并发连接数，2~16；调高更快但更吃带宽与 CPU</div></div>
              <div style="display:flex;align-items:center;gap:6px"><input type="number" id="brsSetThreads" min="2" max="16" step="1"><span style="font-size:12px;color:var(--t3)">线程</span></div></div>
            <div class="setrow"><div class="setlabel"><div class="st">附带弹幕文件</div><div class="sd">下载视频时同目录保存一份弹幕 .xml</div></div><label class="toggle" id="brsSetDanmu"></label></div>
            <div class="setrow"><div class="setlabel"><div class="st">附带封面文件</div><div class="sd">下载视频时同目录保存一张同名封面图（视频封面 / 剧集封面）</div></div><label class="toggle" id="brsSetCover"></label></div>
            <div class="setrow" id="brsRowSplit"><div class="setlabel"><div class="st">音视频分离</div><div class="sd">DASH 不调 ffmpeg 合并，分别保存 <b>.video.m4s</b> 与 <b>.audio.m4s</b> 两个文件</div></div><label class="toggle" id="brsSetSplit"></label></div>
            <div class="setrow" id="brsRowAudioOnly"><div class="setlabel"><div class="st">仅下载音频</div><div class="sd">只取音轨存为 <b>.m4a</b>，不下视频、不需要 ffmpeg</div></div><label class="toggle" id="brsSetAudioOnly"></label></div>
            <div class="setrow" id="brsRowAudioQn"><div class="setlabel"><div class="st">音频音质</div><div class="sd">仅下载音频时的音轨档位；实际可用档取决于视频（Hi-Res / 杜比需大会员内容）</div></div>
              <select class="sel" id="brsSetAudioQn"><option value="30251">Hi-Res 无损</option><option value="30250">杜比全景声</option><option value="30280">192K</option><option value="30232">132K</option><option value="30216">64K</option></select></div>
          </div>
          <div class="setcard">
            <div class="ct">${ICO.save}数据</div>
            <div class="setrow"><div class="setlabel"><div class="st">导出 / 导入</div><div class="sd">订阅、稍后再看、监控、设置（JSON 备份）</div></div>
              <div style="display:flex;gap:8px"><button class="sbtn sm" id="brsBtnExport">${ICO.save}导出</button><button class="sbtn sm" id="brsBtnImport">导入</button></div></div>
            <div class="setrow"><div class="setlabel"><div class="st">清理全部数据</div><div class="sd">删除本脚本的全部本地存储（订阅 / 稍后再看 / 监控 / 设置）</div></div>
              <button class="sbtn sm danger" id="brsBtnClear">${ICO.trash}清空</button></div>
          </div>
          <div class="about">
            <div class="lg">B</div>
            <div style="flex:1;min-width:0">
              <div class="an">BilibiliRSS <span class="ver">v${DEFAULTS.ver}</span></div>
              <div class="av">作者 xinbaji · 数据仅存本地 · 前端 v3</div>
              <div class="al"><a class="sbtn sm" style="text-decoration:none" href="https://github.com/xinbaji/BilibiliRSS" target="_blank" rel="noopener">${ICO.external}GitHub</a><span class="chip p">${ICO.zap}高性能渲染</span></div>
            </div>
          </div>
          <div style="height:8px"></div>
        </div>
      </div>
    </div>
  </div>
</aside>
<div id="brs-toast"><span class="tdot"></span><span class="tmsg" id="brsToastMsg">ok</span></div>
<div class="mask" id="brsMask"><div class="modal" id="brsModal"></div></div>
`;

/* ============================ 挂载 ============================ */
let shadowRoot = null;
/* document-start 阶段 documentElement/body 可能都不存在。
   挂载动作只在宿主可用时执行；否则等到 DOM 就绪再挂，避免 null.appendChild 崩溃。 */
function hostParent() {
  return document.documentElement || document.body || null;
}
function whenHostReady(fn) {
  if (hostParent()) { fn(); return; }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { if (hostParent()) fn(); }, { once: true });
  } else {
    /* 兜底：轮询到宿主出现（异常文档结构场景） */
    let n = 0;
    const tk = setInterval(() => {
      if (hostParent()) { clearInterval(tk); fn(); }
      else if (++n > 200) clearInterval(tk);
    }, 50);
  }
}
function mountUI() {
  if (document.getElementById('brs-host')) return;
  const parent = hostParent();
  if (!parent) { whenHostReady(mountUI); return; }
  const host = document.createElement('div');
  host.id = 'brs-host';
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000';
  const sr = host.attachShadow({ mode: 'open' });
  const st = document.createElement('style');
  st.textContent = CSS;
  sr.appendChild(st);
  const wrap = document.createElement('div');
  wrap.innerHTML = HTML;
  while (wrap.firstChild) sr.appendChild(wrap.firstChild);
  hostParent().appendChild(host);
  shadowRoot = sr;
  curTheme = readTheme();
  applyTheme(curTheme);
  bindUI();
  updateAllUI();
}
const q = sel => shadowRoot ? shadowRoot.querySelector(sel) : null;
const qa = sel => shadowRoot ? Array.from(shadowRoot.querySelectorAll(sel)) : [];

/* ============================ 差分渲染内核 ============================ */
/* 按 key 复用节点；顺序一致时零 DOM 移动（高频更新最快路径） */
function patchList(container, items, keyOf, makeNode, updateNode) {
  if (!container) return;
  const map = new Map();
  for (const child of Array.from(container.children)) if (child.__k != null) map.set(child.__k, child);
  const wanted = [];
  const seen = new Set();
  for (const it of items) {
    const k = keyOf(it);
    if (k == null || seen.has(k)) continue;
    seen.add(k);
    let node = map.get(k);
    if (!node) { node = makeNode(it); if (!node) continue; node.__k = k; }
    updateNode(node, it);
    wanted.push(node);
  }
  let same = container.children.length === wanted.length;
  if (same) for (let i = 0; i < wanted.length; i++) if (container.children[i] !== wanted[i]) { same = false; break; }
  if (!same) {
    const frag = document.createDocumentFragment();
    for (const n of wanted) frag.appendChild(n);
    container.appendChild(frag);
  }
  for (const [k, node] of map) if (!seen.has(k) && node.parentNode === container) container.removeChild(node);
}
/* 头像预热：仅处理连通的节点 */
function warmAvatars(root) {
  if (!root) return;
  const els = root.querySelectorAll('[data-ava]');
  for (let i = 0; i < els.length; i++) {
    const el = els[i], url = el.dataset.ava;
    if (url && !/^data:/i.test(url)) warmAva(el, url);
  }
}
/* 滚动到底加载更多 */
function maybeMore(scroller, view, step, total) {
  if (!scroller) return;
  if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 240) return;
  const cur = V.limit[view] || 0;
  if (cur >= total) return;
  V.limit[view] = cur + step;
  markDirty(view);
}

/* ============================ 事件绑定（委托优先） ============================ */
function bindUI() {
  q('#fab').addEventListener('click', toggleDrawer);
  q('#brsBtnClose').addEventListener('click', toggleDrawer);
  q('#brsThemeBtn').addEventListener('click', toggleTheme);

  const rfBtn = q('#brsBtnRefresh');
  rfBtn.addEventListener('click', async () => {
    if (rfBtn.classList.contains('busy')) return;
    rfBtn.classList.add('busy');
    toast('正在刷新订阅与监控…');
    try {
      const n = await refreshAll();
      await refreshAllMons();
      updateAllUI();
      if (V.tab === 'todo') renderTodo(); else if (V.tab === 'mon') renderMon();
      toast(n ? ('刷新完成，新增 ' + n + ' 条') : '刷新完成，暂无新增');
    } catch (e) { toast('刷新失败：' + errMsg(e)); }
    finally { rfBtn.classList.remove('busy'); }
  });

  /* 左侧图标导航 */
  qa('#brsTabs .d-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  /* 分段筛选（委托到 seg 容器） */
  bindSeg('#brsSegTodo', s => { store.ui.curStatus = s; save(); V._todoSeg = s; renderChips(); V.limit.todo = 60; markDirty('todo'); });
  bindSeg('#brsSegMon', s => { V.seg.mon = s; markDirty('mon'); });
  bindSeg('#brsSegSubs', s => { V.seg.subs = s; markDirty('subs'); });
  /* 搜索（120ms 防抖） */
  bindSearch('#brsSearch', '#brsSearchBox', '#brsSearchClr', v => { V.search = v; V.limit.todo = 60; markDirty('todo'); });
  bindSearch('#brsMonSearch', '#brsMonSearchBox', '#brsMonSearchClr', v => { V.monSearch = v; markDirty('mon'); });
  /* 下载页头部：点击滚回顶部（下载已独立成页，不再折叠） */
  const dlHead = q('#brsDlHead');
  if (dlHead) dlHead.addEventListener('click', () => { const b = q('#brsBody'); if (b) b.scrollTop = 0; });
  /* 列表事件委托：每根节点只绑一次 */
  bindList('#brsTodoList', onTodoClick);
  bindList('#brsMonList', onMonClick);
  bindList('#brsSubList', onSubsClick);
  bindList('#brsDlList', onDlClick);
  /* 滚动加载更多 */
  const body = q('#brsBody');
  body.addEventListener('scroll', () => {
    if (V.tab === 'todo') maybeMore(body, 'todo', 60, V._todoTotal || 0);
  }, { passive: true });

  /* 设置项 */
  const setN = q('#brsSetNotify');
  setN.classList.toggle('on', !!getSet().notify);
  setN.addEventListener('click', () => { setN.classList.toggle('on'); getSet().notify = setN.classList.contains('on'); save(); });
  const setTh = q('#brsSetThreads');
  setTh.value = String(Math.min(16, Math.max(2, Number(getSet().dlThreads) || 8)));
  setTh.addEventListener('change', () => {
    const v = Math.min(16, Math.max(2, parseInt(setTh.value) || 8));
    setTh.value = String(v);
    getSet().dlThreads = v; save(); toast('下载线程数已设为 ' + v);
  });
  const setQ = q('#brsSetQn'), qv = getSet().dlQn;
  setQ.value = String([127, 120, 116, 80, 64, 32, 16].includes(qv) ? qv : 127);
  setQ.addEventListener('change', () => { getSet().dlQn = parseInt(setQ.value) || 127; save(); toast('下载画质已设为 ' + (setQ.options[setQ.selectedIndex] || {}).text); });
  const setAq = q('#brsSetAudioQn'), aqv = Number(getSet().dlAudioQn) || 30280;
  setAq.value = String([30251, 30250, 30280, 30232, 30216].includes(aqv) ? aqv : 30280);
  setAq.addEventListener('change', () => { getSet().dlAudioQn = parseInt(setAq.value) || 30280; save(); toast('音频音质已设为 ' + (setAq.options[setAq.selectedIndex] || {}).text); });
  const setDm = q('#brsSetDanmu');
  setDm.classList.toggle('on', getSet().dlDanmu !== false);
  setDm.addEventListener('click', () => { setDm.classList.toggle('on'); getSet().dlDanmu = setDm.classList.contains('on'); save(); });
  const setCv = q('#brsSetCover');
  setCv.classList.toggle('on', !!getSet().dlCover);
  setCv.addEventListener('click', () => { setCv.classList.toggle('on'); getSet().dlCover = setCv.classList.contains('on'); save(); });
  /* 音视频分离 / 仅下载音频 互斥: 仅音频优先, 另一项置灰提示(仍可点开另一项以切换) */
  const setSp = q('#brsSetSplit'), setAo = q('#brsSetAudioOnly');
  const refreshDlMode = () => {
    setSp.classList.toggle('on', !!getSet().dlSplit);
    setAo.classList.toggle('on', !!getSet().dlAudioOnly);
    const rowSp = q('#brsRowSplit'), rowAo = q('#brsRowAudioOnly'), rowAq = q('#brsRowAudioQn');
    if (rowSp) rowSp.classList.toggle('dep-off', !!getSet().dlAudioOnly);
    if (rowAo) rowAo.classList.toggle('dep-off', !!getSet().dlSplit && !getSet().dlAudioOnly);
    /* 音质行仅在「仅下载音频」开启时可用 */
    if (rowAq) rowAq.classList.toggle('dep-off', !getSet().dlAudioOnly);
  };
  setSp.addEventListener('click', () => {
    const on = !setSp.classList.contains('on');
    getSet().dlSplit = on;
    if (on) getSet().dlAudioOnly = false;   /* 互斥: 开分离即关仅音频 */
    save(); refreshDlMode();
    toast(on ? '已开启音视频分离（不合并，分别落盘）' : '已关闭音视频分离');
  });
  setAo.addEventListener('click', () => {
    const on = !setAo.classList.contains('on');
    getSet().dlAudioOnly = on;
    if (on) getSet().dlSplit = false;       /* 互斥: 开仅音频即关分离 */
    save(); refreshDlMode();
    toast(on ? '已开启仅下载音频（.m4a，无视频）' : '已关闭仅下载音频');
  });
  refreshDlMode();

  q('#brsBtnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'bilibili-rss-backup.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('已导出备份到下载目录');
  });
  q('#brsBtnImport').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const obj = JSON.parse(fr.result);
          if (obj && typeof obj === 'object') { store = { ...store, ...obj }; save(); rebuildDedupe(); V.limit.todo = 60; updateAllUI(); renderAllNow(); toast('导入成功'); }
          else toast('数据无效');
        } catch (e) { toast('解析失败：JSON 格式错误'); }
      };
      fr.readAsText(f);
    };
    inp.click();
  });
  q('#brsBtnClear').addEventListener('click', async () => {
    const ok = await TL.confirm({
      title: '确认清空全部数据？', danger: true, okText: '确认清空', desc: '此操作不可撤销，建议先导出备份',
      html: '将删除本脚本保存在本地的：<br>· 订阅（<b>' + (store.subs || []).length + '</b> 个）<br>· 稍后再看（<b>' + (store.items || []).length + '</b> 条）<br>· 监控（<b>' + (store.mons || []).length + '</b> 个）<br>· 全部设置与头像缓存'
    });
    if (!ok) return;
    store = JSON.parse(JSON.stringify(DEFAULTS));
    GM_deleteValue(NS);
    try { GM_deleteValue(NS + '_ava'); } catch (e) {}
    avaCache = null; V.limit.todo = 60;
    rebuildDedupe(); updateAllUI(); renderAllNow(); toast('已清空全部数据');
  });

  /* 键盘快捷键 */
  document.addEventListener('keydown', ev => {
    if (ev.altKey && (ev.key === 'b' || ev.key === 'B')) { ev.preventDefault(); toggleDrawer(); return; }
    if (ev.key === 'Escape' && !TL._done) {
      const d = q('#drawer');
      if (d && d.classList.contains('show')) { ev.stopPropagation(); toggleDrawer(); }
    }
  }, true);
}
function bindSeg(sel, cb) {
  const root = q(sel); if (!root) return;
  root.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-seg]'); if (!b) return;
    const cur = root.querySelector('button.on'); if (cur && cur !== b) cur.classList.remove('on');
    b.classList.add('on');
    cb(b.dataset.seg);
  });
}
function bindSearch(inpSel, boxSel, clrSel, cb) {
  const inp = q(inpSel), box = q(boxSel), clr = q(clrSel);
  if (!inp) return;
  let t = 0;
  inp.addEventListener('input', () => {
    box.classList.toggle('has', !!inp.value);
    clearTimeout(t);
    t = setTimeout(() => cb(inp.value), 120);
  });
  if (clr) clr.addEventListener('click', () => { inp.value = ''; box.classList.remove('has'); clearTimeout(t); cb(''); inp.focus(); });
}
function bindList(sel, handler) {
  const root = q(sel); if (!root || root.__bound) return;
  root.__bound = true;
  root.addEventListener('click', handler);
  root.addEventListener('change', ev => {
    const t = ev.target;
    if (t && t.classList && t.classList.contains('dlp-cb')) onPickChange();
    if (t && t.id === 'brsDlPickAll') onPickAll(t.checked);
  });
}

/* ============================ 计数 / 徽标 ============================ */
function statusCounts() {
  const c = { todo: 0, done: 0, ignored: 0, total: 0 };
  (store.items || []).forEach(i => { c[i.st] = (c[i.st] || 0) + 1; c.total++; });
  return c;
}
let _cntSig = '';
function flushCounts() {
  const c = statusCounts();
  const mon = (store.mons || []).length;
  const dlBusy = (store.dls || []).filter(d => d.st === 'queue' || d.st === 'doing').length;
  const subs = (store.subs || []).length;
  const sig = [c.todo, c.done, c.ignored, c.total, mon, dlBusy, subs].join('|');
  if (sig === _cntSig) return;
  _cntSig = sig;
  const setCb = (sel, n) => {
    const el = q(sel); if (!el) return;
    if (n > 0) { el.textContent = n > 999 ? '999+' : String(n); el.hidden = false; } else el.hidden = true;
  };
  setCb('#brsCntTodo', c.todo); setCb('#brsCntMon', mon); setCb('#brsCntDl', dlBusy); setCb('#brsCntSubs', subs);
  const fb = q('#brsFabBadge');
  if (fb) { if (c.todo > 0) { fb.textContent = c.todo > 999 ? '999+' : String(c.todo); fb.hidden = false; } else fb.hidden = true; }
  const map = { '#brsSegTodoN': c.todo, '#brsSegDoneN': c.done, '#brsSegIgnN': c.ignored, '#brsSegAllN': c.total };
  Object.keys(map).forEach(k => { const el = q(k); if (el) el.textContent = numPlain(map[k]); });
  const hd = q('#brsDlHdCnt');
  if (hd) { if (dlBusy > 0) { hd.textContent = dlBusy > 99 ? '99+' : String(dlBusy); hd.hidden = false; } else hd.hidden = true; }
}

/* ============================ Tab 切换（惰性渲染） ============================ */
const TAB_HINT = {
  todo: '稍后再看 · 状态与订阅筛选',
  bench: '工作台 · 一键订阅 / 监控 / 下载当前页面',
  mon: '增量监控 · 粉丝 / 播放 / 互动数据',
  subs: '订阅管理 · UP / 合集 / 分P视频',
  dl: '下载管理 · 任务队列与进度',
  set: '设置 · 通知 / 下载 / 数据'
};
const TAB_LIST = ['todo', 'bench', 'mon', 'subs', 'dl', 'set'];
/* 兼容旧数据：早期版本只有 tool 页签，把工作台与下载合在一页 */
const normTab = t => (t === 'tool' ? 'bench' : t);
function switchTab(tab) {
  tab = normTab(tab);
  if (tab === V.tab) { const b = q('#brsBody'); if (b) b.scrollTop = 0; return; }
  V.tab = tab;
  qa('#brsTabs .d-tab').forEach(x => x.classList.toggle('on', x.dataset.tab === tab));
  TAB_LIST.forEach(p => {
    const el = q('#pg-' + p); if (el) el.classList.toggle('on', p === tab);
  });
  const body = q('#brsBody'); if (body) body.scrollTop = 0;
  const sub = q('#brsHeadSub'); if (sub) sub.textContent = TAB_HINT[tab] || '';
  if (tab === 'todo') renderTodo();
  else if (tab === 'mon') renderMon();
  else if (tab === 'subs') renderSubs();
  else if (tab === 'bench') renderDlPick();
  else if (tab === 'dl') renderDl();
  flushCounts();
}
/* 强制立即渲染当前视图（用于导入/清空等结构级变更） */
function renderAllNow() {
  if (V.tab === 'todo') renderTodo();
  else if (V.tab === 'mon') renderMon();
  else if (V.tab === 'subs') renderSubs();
  else if (V.tab === 'bench') renderDlPick();
  else if (V.tab === 'dl') renderDl();
  flushCounts();
}

/* ============================ 抽屉开关 ============================ */
function toggleDrawer() {
  const d = q('#drawer'), f = q('#fab');
  if (!d) return;
  const opening = !d.classList.contains('show');
  d.classList.toggle('show', opening);
  f.classList.toggle('close-state', opening);
  if (opening) {
    /* 打开时补渲染当前视图 */
    renderAllNow();
    refreshOnOpen();
  }
}
const OPEN_REFRESH_CD = 3 * 60 * 1000;
let lastOpenRefresh = 0, lastOpenRefreshTip = 0;
async function refreshOnOpen() {
  const now = Date.now();
  if (now - lastOpenRefresh < OPEN_REFRESH_CD) {
    if (now - lastOpenRefreshTip > 30 * 1000) {
      lastOpenRefreshTip = now;
      toast('刚刷新过，3 分钟内打开不重复刷新；可点右上角刷新按钮强制更新');
    }
    return;
  }
  lastOpenRefresh = now;
  const rf = q('#brsBtnRefresh');
  if (rf) rf.classList.add('busy');
  try {
    const n = await refreshAll();
    await refreshAllMons();
    updateAllUI();
    renderAllNow();
    toast(n ? ('已刷新，新增 ' + n + ' 条') : '已刷新');
  } catch (e) { toast('刷新失败：' + errMsg(e)); }
  finally { if (rf) rf.classList.remove('busy'); }
}

/* ============================ toast ============================ */
let toastTimer = null;
function errMsg(e) {
  if (e == null) return '未知原因';
  const m = (typeof e === 'object' && e.message) ? e.message : String(e);
  if (!m || m === 'undefined' || m === 'null') return '未知原因';
  return m;
}
function toast(m) {
  const t = q('#brs-toast'); if (!t) return;
  q('#brsToastMsg').textContent = m;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
/* ============================ 稍后再看 ============================ */
function openTodoItem(id) {
  const it = store.items.find(x => x.id === id); if (!it) return;
  /* 番剧条目没有 /video/ 路由, 要开剧集页; UGC 走 video/(分P 带 ?p=) */
  if (it.epId) { window.open('https://www.bilibili.com/bangumi/play/ep' + it.epId, '_blank'); return; }
  window.open('https://www.bilibili.com/video/' + it.bvid + (it.pid > 1 ? '?p=' + it.pid : ''), '_blank');
}
const metaOf = i => store.subs.find(x => x.id === i.subId);
const shortName = (n, len = 12) => { const s = String(n || ''); return s.length > len ? s.slice(0, len) + '…' : s; };

/* 订阅维度下拉（保留后端契约 #brsFltRow / #brsFltSub） */
function renderChips() {
  const st = store.ui.curStatus;
  if (!['todo', 'done', 'ignored', 'total'].includes(st)) store.ui.curStatus = 'todo';
  V._todoSeg = st;
  const subs = store.subs || [];
  if (store.ui.curSub && !subs.some(x => x.id === store.ui.curSub)) { store.ui.curSub = ''; save(); }
  const cs = store.ui.curSub;
  const row = q('#brsFltRow');
  if (!row) return;
  const sig = cs + '||' + subs.map(s => s.id + s.name).join(',');
  if (row.__sig !== sig) {
    row.__sig = sig;
    row.innerHTML = '<select class="sel" id="brsFltSub" title="按订阅筛选">' +
      '<option value=""' + (cs === '' ? ' selected' : '') + '>全部订阅</option>' +
      subs.map(s => '<option value="' + attr(s.id) + '"' + (cs === s.id ? ' selected' : '') + ' title="' + attr(s.name) + '">' + esc(shortName(s.name, 14)) + '</option>').join('') +
      '</select>';
    const el = q('#brsFltSub');
    if (el) el.addEventListener('change', () => { store.ui.curSub = el.value; save(); V.limit.todo = 60; markDirty('todo'); });
  }
  qa('#brsSegTodo button').forEach(b => b.classList.toggle('on', b.dataset.seg === st));
  flushCounts();
}

function renderTodo() {
  const el = q('#brsTodoList');
  if (!el) return;
  const cur = store.ui.curStatus;
  const kw = V.search.trim().toLowerCase();
  let list = store.items.filter(i => (cur === 'total' || i.st === cur) && (!store.ui.curSub || i.subId === store.ui.curSub));
  if (kw) list = list.filter(i => (String(i.title || '') + ' ' + String(i.author || '') + ' ' + String(i.bvid || '')).toLowerCase().includes(kw));
  list = list.slice().sort((a, b) =>
    (Number(b.ts) || Math.floor((b.added || 0) / 1000)) - (Number(a.ts) || Math.floor((a.added || 0) / 1000)));
  V._todoTotal = list.length;

  if (!list.length) {
    const filtering = kw || store.ui.curSub || cur !== 'total';
    const sig = 'empt:' + (filtering ? 1 : 0);
    if (el.__sig !== sig) {
      el.__sig = sig;
      el.innerHTML = '<div class="empty"><div class="eico">' + ICO.inbox + '</div>' +
        '<div class="et">' + (filtering ? '当前筛选下没有内容' : '稍后再看还是空的') + '</div>' +
        '<div class="es">' + (filtering
          ? '试试切换状态 / 订阅筛选，或清空搜索关键词'
          : '打开 UP 空间页或视频页，在「工作台」标签一键订阅 UP，之后的新投稿会自动收进这里') + '</div>' +
        (filtering ? '<div class="eb"><button class="sbtn sm" data-act="reset-flt">重置筛选</button></div>' : '') + '</div>';
    }
    return;
  }
  /* 从空态切回列表时清空标记，避免残留 */
  if (el.__sig) { el.__sig = ''; el.innerHTML = ''; }

  const shown = list.slice(0, V.limit.todo || 60);

  patchList(el, shown, it => it.id, it => {
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML =
      '<div class="cov" data-open="1">' +
        '<div class="cov-mask">' + ICO.play + '</div>' +
        '<span class="dur"></span><span class="pg-tag" style="display:none"></span>' +
      '</div>' +
      '<div class="vmain">' +
        '<div class="vtitle" data-open="1"></div>' +
        '<div class="vby"><span class="ava"></span><span class="nm"></span><span class="chip tm"></span>' +
          '<span class="chip ok st-ok" style="display:none">已完成</span><span class="chip ig st-ig" style="display:none">已忽略</span></div>' +
        '<div class="vfoot">' +
          '<button class="act b-done" data-act="done" title="标记完成">' + ICO.check + '</button>' +
          '<button class="act ign b-ign" data-act="ignore" title="忽略（不再提示）">' + ICO.ban + '</button>' +
          '<button class="act b-restore" data-act="restore" title="还原为稍后再看" style="display:none">' + ICO.undo + '</button>' +
          '<button class="act b-dl" data-act="dl" title="下载视频">' + ICO.download + '</button>' +
          '<button class="act watch b-open" data-act="open" title="在 B 站打开">' + ICO.external + '</button>' +
          '<button class="act del b-del" data-act="del" title="删除（永不再入）">' + ICO.trash + '</button>' +
        '</div>' +
      '</div>';
    return d;
  }, (node, it) => {
    const $ = s => node.querySelector(s);
    const isDone = it.st === 'done', isIgn = it.st === 'ignored';
    const cls = 'card' + (isDone ? ' done' : '') + (isIgn ? ' ignored' : '');
    if (node.className !== cls) node.className = cls;
    if (node.dataset.id !== it.id) node.dataset.id = it.id;

    const cov = $('.cov');
    if (cov.__pic !== it.pic) {
      cov.__pic = it.pic;
      cov.style.backgroundImage = it.pic ? cssUrl(it.pic) : '';
      let img = cov.querySelector('img.ci');
      if (it.pic) {
        if (!img) {
          img = document.createElement('img');
          img.className = 'ci'; img.loading = 'lazy'; img.alt = ''; img.referrerPolicy = 'no-referrer';
          cov.insertBefore(img, cov.firstChild);
        }
        if (img.getAttribute('src') !== it.pic) img.src = it.pic;
      } else if (img) img.remove();
    }
    const durEl = $('.dur');
    const durTxt = it.dur || '';
    if (durEl.textContent !== durTxt) durEl.textContent = durTxt;
    const pgEl = $('.pg-tag');
    if (it.pid > 1) { if (pgEl.style.display === 'none') pgEl.style.display = ''; pgEl.textContent = 'P' + it.pid; }
    else if (it.epId) {
      /* 番剧条目: 角标显示所属分区(正片 / 主题曲 / 花絮…) */
      const t = it.bgSection || '番剧';
      if (pgEl.style.display === 'none') pgEl.style.display = '';
      if (pgEl.textContent !== t) pgEl.textContent = t;
    }
    else if (pgEl.style.display !== 'none') pgEl.style.display = 'none';

    const vt = $('.vtitle');
    if (vt.__t !== it.title) { vt.__t = it.title; vt.textContent = it.title || ''; vt.title = it.title || ''; }

    const sub = metaOf(it);
    const face = (sub && sub.face) || it.face || '';
    const ava = $('.ava');
    if (ava.dataset.ava !== (face || '')) {
      ava.dataset.ava = face || '';
      const cached = face ? faceSrc(face) : '';
      if (cached) { ava.style.backgroundImage = cssUrl(cached); ava.textContent = ''; }
      else { ava.style.backgroundImage = ''; ava.textContent = initial(it.author || '?'); }
    }
    const nm = $('.nm');
    const au = it.author || '未知 UP';
    if (nm.textContent !== au) { nm.textContent = au; nm.title = au; }
    const tm = $('.tm');
    const pub = it.pub || '';
    if (tm.textContent !== pub) tm.textContent = pub;

    $('.st-ok').style.display = isDone ? '' : 'none';
    $('.st-ig').style.display = isIgn ? '' : 'none';
    $('.b-done').style.display = (isDone || isIgn) ? 'none' : '';
    $('.b-ign').style.display = (isDone || isIgn) ? 'none' : '';
    $('.b-restore').style.display = (isDone || isIgn) ? '' : 'none';
  });

  /* 加载更多 */
  const rest = list.length - shown.length;
  const moreOld = el.querySelector('.more');
  if (rest > 0) {
    if (!moreOld) {
      const m = document.createElement('div');
      m.className = 'more'; m.__k = '__more';
      m.innerHTML = '<button data-act="more"></button>';
      el.appendChild(m);
      const mb = m.querySelector('button');
      if (mb) mb.dataset.act = 'more';
    }
    const btn = el.querySelector('.more button');
    const txt = '向下滚动或点击加载更多（还有 ' + rest + ' 条）';
    if (btn && btn.textContent !== txt) btn.textContent = txt;
  } else if (moreOld) moreOld.remove();

  warmAvatars(el);
}

async function onTodoClick(ev) {
  const b = ev.target.closest('button[data-act]');
  if (b) {
    const act = b.dataset.act;
    if (act === 'more') { V.limit.todo = (V.limit.todo || 60) + 60; markDirty('todo'); return; }
    if (act === 'reset-flt') {
      store.ui.curStatus = 'total'; store.ui.curSub = ''; V.search = ''; V.limit.todo = 60;
      const si = q('#brsSearch'); if (si) si.value = '';
      const sb = q('#brsSearchBox'); if (sb) sb.classList.remove('has');
      save(); renderChips(); markDirty('todo'); return;
    }
    const card = b.closest('.card');
    const id = card && card.dataset.id;
    if (!id) return;
    const it = store.items.find(x => x.id === id);
    if (!it) return;
    /* 乐观更新：状态切换立即在本地生效并重绘，不等任何网络 */
    if (act === 'done' || act === 'ignore' || act === 'restore') {
      const st = act === 'restore' ? 'todo' : act;
      it.st = st;
      if (act === 'ignore') store.ignore = Array.from(new Set([...(store.ignore || []), it.key]));
      if (act === 'restore') store.ignore = (store.ignore || []).filter(k => k !== it.key);
      save(); rebuildDedupe();
      renderTodo(); flushCounts();
      return;
    }
    if (act === 'open') { openTodoItem(id); return; }
    if (act === 'dl') {
      const t = startDownload({
        bvid: it.bvid, pid: it.pid || 1, cid: it.cid || 0, title: it.title,
        epId: it.epId || 0, bgSsid: it.bgSsid || '', pic: it.pic || ''
      });
      toast('已加入下载队列：' + ((t && t.title) || it.title));
      switchTab('dl'); setDlOpen(true);
      return;
    }
    if (act === 'del') {
      const ok = await TL.confirm({
        title: '删除这条稍后再看？', danger: true, okText: '删除',
        html: '<b>' + esc(clampTxt(it.title, 60)) + '</b><br><br>删除后该稿件会加入去重名单，订阅刷新时<b>不会再自动收进来</b>。'
      });
      if (ok) { deleteItem(id); renderTodo(); flushCounts(); toast('已删除，且不再自动收录'); }
      return;
    }
    return;
  }
  const card = ev.target.closest('.card');
  if (card && ev.target.closest('[data-open]')) openTodoItem(card.dataset.id);
}

/* ============================ 监控 ============================ */
function renderMon() {
  const el = q('#brsMonList');
  if (!el) return;
  const seg = V.seg.mon || 'all';
  const kw = V.monSearch.trim().toLowerCase();
  let ms = (store.mons || []).slice();
  if (seg === 'up') ms = ms.filter(m => m.kind === 'up');
  else if (seg === 'video') ms = ms.filter(m => m.kind === 'video');
  if (kw) ms = ms.filter(m => {
    const nm = m.kind === 'up' ? (m.cur?.name || m.name || ('UP' + m.mid)) : (m.cur?.title || m.name || m.bvid);
    return (String(nm) + ' ' + String(m.cur?.author || '') + ' ' + String(m.mid || '') + ' ' + String(m.bvid || '')).toLowerCase().includes(kw);
  });
  flushCounts();

  if (!ms.length) {
    const filtering = kw || seg !== 'all';
    const sig = 'empt:' + (filtering ? 1 : 0);
    if (el.__sig !== sig) {
      el.__sig = sig;
      el.innerHTML = '<div class="empty"><div class="eico">' + ICO.radar + '</div>' +
        '<div class="et">' + (filtering ? '没有匹配的监控' : '还没有监控项') + '</div>' +
        '<div class="es">' + (filtering ? '换个关键词或切换上方分类看看'
          : '打开任意 UP 空间页 / 视频页，在「工作台」标签点「加监控」；之后会记录粉丝、播放、互动数据的变化量') + '</div></div>';
    }
    return;
  }
  if (el.__sig) { el.__sig = ''; el.innerHTML = ''; }

  const metric = (label, val, prev) => {
    const hasPrev = prev != null && Number.isFinite(Number(prev));
    const cv = Number(val) || 0, pv = Number(prev) || 0;
    const diff = hasPrev ? cv - pv : 0;
    const dl = (hasPrev && diff !== 0) ? '<span class="dl">' + (diff > 0 ? '+' : '−') + numFmt(Math.abs(diff)) + '</span>' : '';
    return '<div class="metric"><div class="mv">' + numFmt(cv) + dl + '</div><div class="ml">' + label + '</div></div>';
  };

  patchList(el, ms, m => m.id, () => {
    const d = document.createElement('div');
    d.className = 'mcard';
    d.innerHTML =
      '<div class="mrow">' +
        '<div class="mface ava" style="display:none"></div>' +
        '<div class="mcover" style="display:none"></div>' +
        '<div class="mcol">' +
          '<div class="mline1"><div class="mname"><span class="nm"></span>' +
            '<span class="live-tag" style="display:none"><span class="dotp"></span>直播中</span></div></div>' +
          '<div class="mmeta"></div>' +
          '<div class="mstat"></div>' +
        '</div>' +
      '</div>' +
      '<div class="mbottom">' +
        '<span class="ts">上次刷新 —</span><span class="sp"></span>' +
        '<span class="mkind"></span>' +
        '<button class="act rf" data-act="refresh" title="刷新该项">' + ICO.refresh + '</button>' +
        '<button class="act del" data-act="del" title="删除监控">' + ICO.trash + '</button>' +
      '</div>';
    return d;
  }, (node, m) => {
    const $ = s => node.querySelector(s);
    const up = m.kind === 'up';
    if (node.dataset.mid !== m.id) node.dataset.mid = m.id;
    const nm = up ? (m.cur?.name || m.name || ('UP' + m.mid)) : (m.cur?.title || m.name || m.bvid);

    const faceBox = $('.mface'), coverBox = $('.mcover');
    if (up) {
      if (faceBox.style.display === 'none') faceBox.style.display = '';
      if (coverBox.style.display !== 'none') coverBox.style.display = 'none';
      const face = m.cur?.face || m.face || '';
      if (faceBox.dataset.ava !== face) {
        faceBox.dataset.ava = face;
        const cached = face ? faceSrc(face) : '';
        if (cached) { faceBox.style.backgroundImage = cssUrl(cached); faceBox.textContent = ''; }
        else { faceBox.style.backgroundImage = ''; faceBox.textContent = initial(nm); }
      }
    } else {
      if (faceBox.style.display !== 'none') faceBox.style.display = 'none';
      if (coverBox.style.display === 'none') coverBox.style.display = '';
      const pic = (m.cur && m.cur.pic) || '';
      if (coverBox.__pic !== pic) {
        coverBox.__pic = pic;
        coverBox.innerHTML = pic ? '<img loading="lazy" alt="" referrerpolicy="no-referrer" src="' + attr(pic) + '">' : ICO.film;
      }
    }
    const nmEl = $('.nm');
    if (nmEl.textContent !== (nm || '')) { nmEl.textContent = nm || ''; nmEl.title = nm || ''; }
    const lt = $('.live-tag');
    const showLive = !!(up && m.cur && m.cur.live);
    if ((lt.style.display !== 'none') !== showLive) lt.style.display = showLive ? '' : 'none';

    const metaEl = $('.mmeta');
    const metaHtml = up
      ? '<span>uid ' + esc(String(m.mid || '')) + '</span><span class="sep"></span><span>UP 监控</span>'
      : '<span>' + esc((m.cur && m.cur.author) || '未知 UP') + '</span><span class="sep"></span><span>' + esc(m.bvid || '') + '</span><span class="sep"></span><span>视频监控</span>';
    if (metaEl.__h !== metaHtml) { metaEl.__h = metaHtml; metaEl.innerHTML = metaHtml; }

    const statEl = $('.mstat');
    let statHtml = '';
    if (up) {
      const c = m.cur || {}, p = m.prev || {};
      statHtml = metric('粉丝', c.follower, p.follower) + metric('关注', c.following, p.following) +
        metric('总播放', c.archive_view, p.archive_view) + metric('获赞', c.likes, p.likes);
    } else {
      const s = (m.cur && m.cur.stat) || {}, p = (m.prev && m.prev.stat) || {};
      statHtml = metric('播放', s.view, p.view) + metric('弹幕', s.danmaku, p.danmaku) + metric('点赞', s.like, p.like) + metric('投币', s.coin, p.coin) +
        metric('收藏', s.favorite, p.favorite) + metric('评论', s.reply, p.reply) + metric('分享', s.share, p.share) + metric('日排行', s.his_rank, p.his_rank);
    }
    if (statEl.__h !== statHtml) { statEl.__h = statHtml; statEl.innerHTML = statHtml; }

    const ts = $('.ts');
    const tsTxt = '上次刷新 ' + relTime(m.lastAt);
    if (ts.textContent !== tsTxt) ts.textContent = tsTxt;
    const mk = $('.mkind');
    const mkCls = 'mkind ' + (up ? 'up' : 'video');
    if (mk.className !== mkCls) mk.className = mkCls;
    const mkTxt = up ? 'UP' : '视频';
    if (mk.textContent !== mkTxt) mk.textContent = mkTxt;
  });

  warmAvatars(el);
}

async function onMonClick(ev) {
  const b = ev.target.closest('button[data-act]'); if (!b) return;
  const card = b.closest('.mcard');
  const id = card && card.dataset.mid; if (!id) return;
  const act = b.dataset.act;
  if (act === 'refresh') { refreshMonById(id); return; }
  if (act === 'del') {
    const m = (store.mons || []).find(x => x.id === id);
    const nm = m ? (m.kind === 'up' ? (m.cur?.name || m.name || ('UP' + m.mid)) : (m.cur?.title || m.name || m.bvid)) : '';
    const ok = await TL.confirm({
      title: '删除该监控？', danger: true, okText: '删除',
      html: '<b>' + esc(clampTxt(nm, 60)) + '</b><br><br>删除后不再记录其数据变化，可随时重新加入监控。'
    });
    if (ok) { delMon(id); renderMon(); toast('已删除监控'); }
  }
}

/* ============================ 订阅 ============================ */
function renderSubs() {
  const el = q('#brsSubList');
  if (!el) return;
  const seg = V.seg.subs || 'all';
  let ss = (store.subs || []).slice();
  if (seg === 'off') ss = ss.filter(s => !s.on);
  else if (seg !== 'all') ss = ss.filter(s => (s.type || 'up') === seg);
  flushCounts();
  const sum = q('#brsSubsSum');
  if (sum) sum.textContent = '共 ' + (store.subs || []).length + ' 个订阅';

  if (!ss.length) {
    const sig = 'empt:' + seg;
    if (el.__sig !== sig) {
      el.__sig = sig;
      el.innerHTML = '<div class="empty"><div class="eico">' + ICO.layers + '</div>' +
        '<div class="et">' + (seg !== 'all' ? '该分类下暂无订阅' : '还没有任何订阅') + '</div>' +
        '<div class="es">' + (seg !== 'all' ? '切换到「全部」查看其他订阅'
          : '打开 UP 空间页 / 合集页 / 视频页 / 番剧页，在「工作台」标签一键订阅；也可只收录含指定关键词的投稿') + '</div></div>';
    }
    return;
  }
  if (el.__sig) { el.__sig = ''; el.innerHTML = ''; }
  const typeName = t => t === 'season' ? '合集'
    : (t === 'up' ? 'UP 投稿' : (t === 'bangumi' ? '番剧' : '分P视频'));
  const typeLabel = s => (s.type === 'season' && s.isSeries) ? '专辑' : typeName(s.type);

  patchList(el, ss, s => s.id, () => {
    const d = document.createElement('div');
    d.className = 'subrow';
    d.innerHTML =
      '<span class="ic ava"></span>' +
      '<div class="submid">' +
        '<div class="subname"><span class="nm"></span><span class="stype"></span><span class="chip ig multi-tag" style="display:none"></span><span class="chip ig off-tag" style="display:none">已停用</span></div>' +
        '<div class="subsub"><span class="src"></span><span class="sep"></span><span class="cnt"></span><span class="sep"></span><span class="added"></span></div>' +
        '<div class="subflt" style="display:none"></div>' +
      '</div>' +
      '<div class="subacts">' +
        '<button class="act rf" data-act="refresh" title="刷新该订阅（全历史匹配）">' + ICO.refresh + '</button>' +
        '<button class="act" data-act="edit" title="编辑筛选关键词">' + ICO.edit + '</button>' +
        '<button class="act" data-act="toggle" title="启用 / 停用">' + ICO.power + '</button>' +
        '<button class="act del" data-act="del" title="删除订阅">' + ICO.trash + '</button>' +
      '</div>';
    return d;
  }, (node, s) => {
    const $ = x => node.querySelector(x);
    if (node.dataset.sid !== s.id) node.dataset.sid = s.id;
    node.classList.toggle('off', !s.on);
    const t = s.type || 'up';

    const ava = $('.ic');
    if (ava.dataset.ava !== (s.face || '')) {
      ava.dataset.ava = s.face || '';
      const cached = s.face ? faceSrc(s.face) : '';
      if (cached) { ava.style.backgroundImage = cssUrl(cached); ava.textContent = ''; }
      else { ava.style.backgroundImage = ''; ava.textContent = initial(s.name); }
    }
    const nm = $('.nm');
    const label = s.name || '(未命名)';
    if (nm.textContent !== label) { nm.textContent = label; nm.title = label; }
    const st = $('.stype');
    if (st.__t !== t) { st.__t = t; st.className = 'stype ' + t; st.textContent = typeLabel(s); }
    /* 同一个 UP 可能有多条订阅(各自不同关键词) → 用「第 n/m 条」小标记区分, 否则
     * 列表里会出现两行完全同名的 UP 卡片, 用户无从分辨。 */
    const multi = $('.multi-tag');
    const sib = (t === 'up' && s.mid) ? subsOfUp(s.mid) : [];
    const mi = sib.findIndex(x => x.id === s.id);
    const mTxt = (sib.length > 1 && mi >= 0) ? ('第 ' + (mi + 1) + '/' + sib.length + ' 条') : '';
    if (multi.__t !== mTxt) {
      multi.__t = mTxt;
      multi.textContent = mTxt;
      multi.style.display = mTxt ? '' : 'none';
    }
    const offTag = $('.off-tag');
    const showOff = !s.on;
    if ((offTag.style.display !== 'none') !== showOff) offTag.style.display = showOff ? '' : 'none';

    const cnt = (store.items || []).filter(i => i.subId === s.id && i.st !== 'done').length;
    const cntEl = $('.cnt');
    const cntTxt = cnt + ' 条未完成';
    if (cntEl.textContent !== cntTxt) cntEl.textContent = cntTxt;
    const srcEl = $('.src');
    const srcTxt = s.src || '';
    if (srcEl.textContent !== srcTxt) srcEl.textContent = srcTxt;
    const addEl = $('.added');
    const addTxt = relTime(s.added) + ' 加入';
    if (addEl.textContent !== addTxt) addEl.textContent = addTxt;

    const kws = Array.isArray(s.kws) ? s.kws.filter(Boolean) : [];
    const exs = Array.isArray(s.exkws) ? s.exkws.filter(Boolean) : [];
    const fltEl = $('.subflt');
    const fh = (kws.length || exs.length)
      ? kws.map(k => '<span class="kw">' + esc(k) + '</span>').join('') + exs.map(k => '<span class="ex">排除 ' + esc(k) + '</span>').join('')
      : '';
    if (fltEl.__h !== fh) {
      fltEl.__h = fh; fltEl.innerHTML = fh;
      fltEl.style.display = fh ? '' : 'none';
    }
    const pw = node.querySelector('[data-act="toggle"]');
    if (pw) {
      const on = !!s.on;
      if (pw.classList.contains('on') !== on) pw.classList.toggle('on', on);
      if (pw.classList.contains('off') !== !on) pw.classList.toggle('off', !on);
      const pwTitle = on ? '停用该订阅' : '启用该订阅';
      if (pw.title !== pwTitle) pw.title = pwTitle;
    }
  });

  warmAvatars(el);
}

async function onSubsClick(ev) {
  const b = ev.target.closest('button[data-act]'); if (!b) return;
  const row = b.closest('.subrow');
  const sid = row && row.dataset.sid; if (!sid) return;
  const s = store.subs.find(x => x.id === sid); if (!s) return;
  const act = b.dataset.act;

  if (act === 'toggle') {
    s.on = !s.on; save();
    renderSubs(); flushCounts();
    toast(s.on ? '已启用订阅' : '已停用订阅');
    return;
  }
  if (act === 'del') {
    const cnt = (store.items || []).filter(i => i.subId === sid && i.st !== 'done').length;
    const ok = await TL.confirm({
      title: '删除该订阅？', danger: true, okText: '删除',
      html: '<b>' + esc(clampTxt(s.name, 70)) + '</b><br><br>该订阅下 <b>' + cnt + '</b> 条未完成的稍后再看会一并删除；已完成的条目会保留。'
    });
    if (ok) { delSub(sid); renderSubs(); renderChips(); flushCounts(); toast('已删除订阅'); }
    return;
  }
  if (act === 'edit') {
    const cur = { kws: (s.kws || []).filter(Boolean), exkws: (s.exkws || []).filter(Boolean) };
    const r = await TL.show({
      title: '编辑筛选规则', icon: ICO.edit, desc: esc(clampTxt(s.name, 40)),
      fields: [
        { id: 'kws', label: '匹配关键词', hint: '逗号 / 空格分隔', value: cur.kws.join('、'),
          placeholder: '留空 = 收录全部投稿', note: '标题需<b>同时包含全部</b>关键词的投稿才会收（AND 逻辑）' },
        { id: 'exkws', label: '排除关键词', hint: '逗号 / 空格分隔', value: cur.exkws.join('、'),
          placeholder: '留空 = 不排除任何投稿', note: '标题含其中<b>任一</b>词的投稿会被跳过' }
      ],
      okText: '保存'
    });
    if (!r) return;
    const er = editSub(sid, r.fields.kws.trim(), r.fields.exkws.trim());
    if (er && !er.ok) { toast(er.msg || '保存失败'); return; }
    renderSubs(); renderChips();
    const nk = (store.subs.find(x => x.id === sid) || {}).kws || [];
    toast(nk.length ? ('筛选已更新，需同时包含：' + nk.join('、')) : '筛选已更新，将收录全部投稿');
    return;
  }
  if (act === 'refresh') {
    if (!s.on) { toast('该订阅已停用，请先点电源图标启用'); return; }
    if (b.classList.contains('busy')) return;
    b.classList.add('busy');
    toast('正在刷新「' + clampTxt(s.name, 20) + '」…');
    try {
      const { added } = await refreshSub(s, { full: true });
      updateAllUI(); renderSubs(); renderChips();
      toast(added ? ('新增 ' + added + ' 条到稍后再看') : '已是最新，无新增');
    } catch (e) { toast('刷新失败：' + errMsg(e)); }
    finally { b.classList.remove('busy'); }
  }
}
/* ============================ 下载管理 ============================ */
/* 下载已独立成页签，不再折叠；保留 setDlOpen 作为兼容入口（跳到下载页） */
function setDlOpen(open) {
  V.dlOpen = !!open;
  const head = q('#brsDlHead'), body = q('#brsDlBody');
  if (head) head.classList.toggle('open', true);
  if (body) body.style.display = '';
  if (V.dlOpen && V.tab !== 'dl') switchTab('dl');
}
function renderDl() {
  const el = q('#brsDlList');
  const ds = store.dls || [];
  const nBusy = ds.filter(d => d.st === 'queue' || d.st === 'doing').length;
  const sum = q('#brsDlSum');
  if (sum) sum.textContent = ds.length ? (nBusy ? (nBusy + ' 个进行中 / 共 ' + ds.length + ' 个') : ('共 ' + ds.length + ' 个任务')) : '暂无任务';
  flushCounts();
  if (!el) return;

  if (!ds.length) {
    const sig = 'empt';
    if (el.__sig !== sig) {
      el.__sig = sig;
      el.innerHTML = '<div class="empty"><div class="eico">' + ICO.download + '</div>' +
        '<div class="et">暂无下载任务</div>' +
        '<div class="es">在上方操作卡点「下载」或「下载所选」即可加入队列</div></div>';
    }
    return;
  }
  if (el.__sig) { el.__sig = ''; el.innerHTML = ''; }

  const badgeTxt = { queue: '排队', doing: '下载中', done: '已完成', err: '失败' };
  const clsMap = { queue: 'st-queue', doing: 'st-doing', done: 'st-done', err: 'st-err' };

  patchList(el, ds, d => d.id, () => {
    const d = document.createElement('div');
    d.className = 'dlcard';
    d.innerHTML =
      '<div class="r1">' +
        '<span class="tt"></span>' +
        '<span class="dlbadge"></span>' +
        '<button class="icobtn b-retry" data-act="retry" title="重试" style="display:none">' + ICO.refresh + '</button>' +
        '<button class="icobtn danger b-del" data-act="del" title="删除任务">' + ICO.trash + '</button>' +
      '</div>' +
      '<div class="dlmeta" style="display:none"></div>' +
      '<div class="dlbar" style="display:none"><i></i></div>' +
      '<div class="dlop" style="display:none"></div>' +
      '<div class="dlerr" style="display:none"></div>';
    return d;
  }, (node, d) => {
    const $ = s => node.querySelector(s);
    if (node.dataset.did !== d.id) node.dataset.did = d.id;
    const t = $('.tt');
    const title = d.title || d.bvid || '';
    if (t.textContent !== title) { t.textContent = title; t.title = title; }
    const bg = $('.dlbadge');
    const bgCls = 'dlbadge ' + (clsMap[d.st] || '');
    if (bg.className !== bgCls) bg.className = bgCls;
    const bgTxt = badgeTxt[d.st] || d.st;
    if (bg.textContent !== bgTxt) bg.textContent = bgTxt;
    const retry = $('.b-retry');
    const showRetry = d.st === 'err';
    if ((retry.style.display !== 'none') !== showRetry) retry.style.display = showRetry ? '' : 'none';

    const meta = [d.quality ? qnName(d.quality) : '', fmtSize(d.size)].filter(Boolean).join(' · ');
    const metaEl = $('.dlmeta');
    if (metaEl.__h !== meta) { metaEl.__h = meta; metaEl.innerHTML = meta ? esc(meta) : ''; metaEl.style.display = meta ? '' : 'none'; }

    const busy = d.st === 'queue' || d.st === 'doing';
    const bar = $('.dlbar'), op = $('.dlop');
    if (busy) {
      if (bar.style.display === 'none') bar.style.display = '';
      if (op.style.display === 'none') op.style.display = '';
      const pct = Math.max(0, Math.min(1, Number(d.prog) || 0));
      const w = Math.round(pct * 100) + '%';
      const fill = bar.querySelector('i');
      if (fill && fill.style.width !== w) fill.style.width = w;
      const opTxt = d.st === 'queue' ? (d.sub || '排队中…') : ((d.sub || '处理中…') + (d.prog ? ' ' + Math.round(pct * 100) + '%' : ''));
      if (op.textContent !== opTxt) op.textContent = opTxt;
    } else {
      if (bar.style.display !== 'none') bar.style.display = 'none';
      if (op.style.display !== 'none') op.style.display = 'none';
    }
    const errEl = $('.dlerr');
    if (d.err) {
      const et = d.err;
      if (errEl.getAttribute('data-e') !== et) {
        errEl.setAttribute('data-e', et);
        errEl.innerHTML = ICO.warn + '<span>' + esc(et) + '</span>';
      }
      if (errEl.style.display === 'none') errEl.style.display = '';
    } else if (errEl.style.display !== 'none') errEl.style.display = 'none';
  });
}
function onDlClick(ev) {
  const b = ev.target.closest('button[data-act]'); if (!b) return;
  const card = b.closest('.dlcard');
  const id = card && card.dataset.did; if (!id) return;
  if (b.dataset.act === 'retry') { retryDl(id); renderDl(); }
  else if (b.dataset.act === 'del') { delDl(id); renderDl(); }
}

/* ============================ 工作台（页面识别操作卡） ============================ */
let dlPickCache = { key: '', html: '', t: 0 };
let dlPickBusy = false;
/* 合集/专辑页的下载区默认折叠, 只露资料卡。用户点过「下载」展开后要记住这个选择 ——
 * 否则每 15 秒缓存窗口一过 DOM 重建, 展开状态会被静默重置回折叠。
 * key 用 pathname+search, 换页面即失效, 不会把 A 页的展开态带到 B 页。 */
let dlDlOpenKey = '';
const key0 = () => location.pathname + location.search;
function renderDlPick() {
  const hostEl = q('#brsDlPick');
  if (!hostEl) return;
  const key = location.pathname + location.search;
  const now = Date.now();
  if (dlPickCache.key === key && dlPickCache.html && now - dlPickCache.t < 15000) {
    /* 内容未变则不重建 DOM，避免重置勾选状态 */
    if (hostEl.innerHTML !== dlPickCache.html) { hostEl.innerHTML = dlPickCache.html; bindDlPick(); }
    return;
  }
  if (dlPickBusy) return;
  dlPickBusy = true;
  dlPickCache.key = key; dlPickCache.t = now; dlPickCache.html = '';
  hostEl.innerHTML = '<div class="dlpick" style="background:var(--panel);border-color:var(--line)">' +
    '<div class="sk" style="border:none;padding:0;margin:0;gap:11px">' +
    '<div class="a" style="width:142px;height:84px"></div><div class="b"><i></i><i></i><i></i></div></div></div>';
  detectPagePick().then(html => {
    if (dlPickCache.key !== key) return;
    dlPickCache.html = html;
    hostEl.innerHTML = html;
    bindDlPick();
  }).catch(e => {
    console.warn('[BilibiliRSS] 工作台识别失败:', e && e.message, '| path:', location.pathname);
    if (dlPickCache.key !== key) return;
    dlPickCache.html = '<div class="dlpick"><div class="dlp-title"><span class="hb">' + ICO.toolbox + '工作台</span></div>' +
      '<div class="dlp-note">当前页面没有可处理的内容。<br>在 <b>视频页</b> / <b>合集页</b> / <b>UP 空间页</b> / <b>番剧页</b> 打开本面板，即可一键 <b>订阅 · 监控 · 下载</b> 当前内容。</div></div>';
    hostEl.innerHTML = dlPickCache.html;
  }).finally(() => { dlPickBusy = false; });
}
const actBtn = (act, label, pink) => '<button class="sbtn' + (pink ? ' pink' : '') + '" data-act="' + act + '" type="button">' + label + '</button>';
const dlSelBtn = n => '<button class="sbtn pink" id="brsDlPickGoMulti" data-act="dl-sel" type="button">' + ICO.download + '<span class="sel-n">下载所选 (' + n + ')</span></button>';
const pickHead = (kind, right) => '<div class="dlp-title"><span class="hb">' + ICO.toolbox + kind + '</span>' + (right || '') + '</div>';
const actRow = acts => '<div class="dlp-acts">' + acts.join('') + '</div>';
/* 注意: 卡片里有「两处」计数 —— 页脚左侧的 .dl-sum 与右下角按钮内的 .sel-n。
 * v0.3.0 之前只更新了第一个(左侧), 导致点全选/取消全选时右下角按钮数字不变。 */
const selN = () => {
  const pick = q('#brsDlPick'); if (!pick) return;
  const n = pick.querySelectorAll('.dlp-cb:checked').length;
  pick.querySelectorAll('.sel-n').forEach(sp => { sp.textContent = '下载所选 (' + n + ')'; });
};
function onPickChange() { selN(); }
function onPickAll(checked) {
  const pick = q('#brsDlPick'); if (!pick) return;
  pick.querySelectorAll('.dlp-cb').forEach(cb => { cb.checked = checked; });
  selN();
}
function detectPagePick() {
  const path = location.pathname;
  /* ---------- 番剧页 ---------- */
  if (/^\/bangumi\/play\/(ss|ep)\d+/i.test(path)) {
    const p = parseLink(location.href);
    if (!p || p.type !== 'bangumi') return Promise.reject(new Error('no ssid'));
    /* ep 链接要先反查所属季 */
    const ssidP = p.ssid ? Promise.resolve(p.ssid) : bgSsidFromEp(p.epId);
    return ssidP.then(ssid => fetchBangumiMeta(ssid)).then(meta => {
      if (!meta.eps.length) throw new Error('empty');
      const ssid = meta.ssid;
      /* 按 section 分组渲染(正片 / 主题曲 / 花絮 …), 保持接口给的顺序 */
      const groups = [];
      for (const e of meta.eps) {
        let g = groups[groups.length - 1];
        if (!g || g.name !== e.sectionName) { g = { name: e.sectionName, eps: [] }; groups.push(g); }
        g.eps.push(e);
      }
      const multiSec = groups.length > 1;
      let rows = '';
      let idx = 0;
      for (const g of groups) {
        if (multiSec) rows += '<div class="dlp-sec">' + esc(g.name) + '</div>';
        for (const e of g.eps) {
          idx++;
          rows += '<label class="dlp-row"><input type="checkbox" class="dlp-cb" checked' +
            ' data-ep="' + e.epId + '" data-cid="' + e.cid + '" data-bvid="' + attr(e.bvid) + '"' +
            ' data-ssid="' + attr(ssid) + '" data-title="' + encodeURIComponent(e.title) + '"' +
            ' data-pic="' + attr(e.cover || meta.cover || '') + '">' +
            '<span class="dlp-pn">' + idx + '</span>' +
            '<span class="dlp-pt" title="' + attr(e.title) + '">' + esc(e.title) + '</span>' +
            '<span class="dlp-ep">ep' + e.epId + '</span>' +
            '<span class="dlp-pd">' + fmtTime(Math.round(e.duration / 1000)) + '</span></label>';
        }
      }
      const ev = String(meta.evaluate || '').replace(/\s+/g, ' ').trim();
      const metaTxt = (ev ? esc(ev.slice(0, 54)) + (ev.length > 54 ? '…' : '') + ' · ' : '') +
        '目标画质 ' + qnName(getSet().dlQn || 127);
      return '<div class="dlpick" data-kind="bangumi" data-ssid="' + attr(ssid) + '" data-bgname="' + encodeURIComponent(meta.title) + '">' +
        pickHead('当前番剧', '<span class="rt">共 ' + meta.eps.length + ' 集</span>') +
        '<div class="dlp-body">' +
          (meta.cover ? '<img src="' + attr(meta.cover) + '" class="dlp-cover" onerror="this.style.display=\'none\'">' : '') +
          '<div class="dlp-info">' +
            '<div class="dlp-name">' + esc(meta.title) + '</div>' +
            '<div class="dlp-meta">' + metaTxt + '<span class="chip p">ss' + esc(ssid) + '</span></div>' +
            actRow([
              actBtn('sub-bangumi', ICO.layers + '订阅本番剧', false),
              actBtn('bg-all', ICO.check + '全选剧集', false)
            ]) +
          '</div></div>' +
        '<div class="dlp-rows">' + rows + '</div>' +
        '<div class="dlp-foot">' + dlSelBtn(meta.eps.length) + '</div></div>';
    });
  }
  /* ---------- 视频页 ---------- */
  if (/^\/video\//.test(path)) {
    const m = path.match(/\/video\/(BV[a-zA-Z0-9]+)/);
    if (!m) return Promise.reject(new Error('no bvid'));
    return fetchView(m[1]).then(view => {
      if (!view) throw new Error('fetch fail');
      const pages = view.pages || [];
      const bvid = m[1];
      const titleEnc = encodeURIComponent(view.title || bvid);
      const upNameEnc = encodeURIComponent(view.author || '');
      const midAttr = view.mid ? ' data-mid="' + view.mid + '"' : '';
      const metaTxt = esc(view.author || '') + ' · 目标画质 ' + qnName(getSet().dlQn || 127) +
        (view.stat && view.stat.view ? ' · ' + numFmt(view.stat.view) + ' 播放' : '');
      const acts = [actBtn('todo-add', ICO.plus + '加入稍后再看', false)];
      if (view.mid) acts.push(actBtn('sub-up', ICO.layers + '订阅该 UP', false), actBtn('mon', ICO.radar + '加监控', false));
      /* 合集卡: 视频属于某个「合集」时额外渲染一张卡(封面 + UP + 一键订阅整季)。
       * ugc_season 直接给了就用; 没给则按 UP 反查(逐个合集比对 bvid)。反查是异步的,
       * 不阻塞主卡渲染 —— 先出主卡, 合集卡就绪后追加。 */
      const seasonCard = () => {
        const mk = sg => {
          const encName = encodeURIComponent(sg.name || '');
          return '<div class="dlpick" data-kind="season" data-mid="' + attr(sg.mid) + '" data-sid="' + attr(sg.seasonId) + '">' +
            pickHead('视频所属合集') +
            '<div class="dlp-body">' +
              (sg.cover ? '<img src="' + attr(sg.cover) + '" class="dlp-cover" onerror="this.style.display=\'none\'">' : '') +
              '<div class="dlp-info">' +
                '<div class="dlp-name">' + esc(sg.name || ('合集 ' + sg.seasonId)) + '</div>' +
                '<div class="dlp-meta">' + esc(view.author || '') + ' · ' + (sg.count ? (sg.count + ' 个视频') : '合集') + '</div>' +
                actRow([actBtn('sub-season-page', ICO.layers + '订阅该合集', false)]) +
              '</div></div></div>';
        };
        if (view.ugc) {
          return Promise.resolve(mk({ seasonId: view.ugc.id, name: view.ugc.title, cover: view.ugc.cover, mid: view.mid, count: view.ugc.count }));
        }
        if (!view.mid) return Promise.resolve('');
        return findVideoSeason(view.mid, bvid).then(sg => sg ? mk(Object.assign({}, sg, { count: 0 })) : '').catch(() => '');
      };

      if (pages.length <= 1) {
        const main = '<div class="dlpick" data-kind="video" data-bvid="' + bvid + '" data-pid="1" data-title="' + titleEnc + '"' + midAttr + ' data-upname="' + upNameEnc + '" data-pic="' + attr(view.pic || '') + '">' +
          pickHead('当前视频', '<span class="rt">' + (view.length ? fmtTime(view.length) : '') + '</span>') +
          '<div class="dlp-body">' +
            (view.pic ? '<img src="' + attr(view.pic) + '" class="dlp-cover" onerror="this.style.display=\'none\'">' : '') +
            '<div class="dlp-info">' +
              '<div class="dlp-name">' + esc(view.title || bvid) + '</div>' +
              '<div class="dlp-meta">' + metaTxt + '<span class="chip p">' + esc(bvid) + '</span></div>' +
              actRow(acts.concat([actBtn('dl-one', ICO.download + '下载', true)])) +
            '</div></div></div>';
        return seasonCard().then(extra => main + extra);
      }
      const rows = pages.map((p, i) =>
        '<label class="dlp-row"><input type="checkbox" class="dlp-cb" checked data-bvid="' + bvid + '" data-pid="' + (i + 1) + '" data-title="' + encodeURIComponent((view.title || bvid) + ' P' + (i + 1)) + '" data-pic="' + attr(view.pic || '') + '">' +
        '<span class="dlp-pn">P' + (i + 1) + '</span><span class="dlp-pt" title="' + attr(p.part || '') + '">' + esc(p.part || ('分P ' + (i + 1))) + '</span>' +
        '<span class="dlp-pd">' + fmtTime(p.duration) + '</span></label>').join('');
      const mainMulti = '<div class="dlpick" data-kind="multi" data-bvid="' + bvid + '" data-title="' + titleEnc + '"' + midAttr + ' data-upname="' + upNameEnc + '" data-vtitle="' + titleEnc + '">' +
        pickHead('当前视频 · ' + pages.length + ' 个分P',
          '<label style="font-size:11px;color:var(--t2);display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="brsDlPickAll" checked style="accent-color:var(--brand)">全选</label>') +
        '<div class="dlp-meta" style="margin:0 0 2px">' + esc(view.title || bvid) + '</div>' +
        actRow(acts) +
        '<div class="dlp-rows">' + rows + '</div>' +
        '<div class="dlp-foot">' + dlSelBtn(pages.length) + '</div></div>';
      return seasonCard().then(extra => mainMulti + extra);
    });
  }
  /* ---------- 合集/专辑(空间「合集和列表」) ---------- */
  if (/^\/\d+\/channel\/collectiondetail/.test(path) || /^\/\d+\/lists/.test(path)) {
    /* sid 两种位置: query(?sid=, 旧路由) 与 path(/lists/<sid>, 2025 起新路由);
     * type=series 的 sid 是「系列/专辑」id, 走另一套接口, 需要透传 */
    const mid = (path.match(/^\/(\d+)/) || [])[1] || '';
    const usp = new URLSearchParams(location.search);
    const sid = usp.get('sid') || (path.match(/\/lists\/(\d+)/) || [])[1] || '';
    const isSeries = usp.get('type') === 'series';
    if (!mid || !sid) return Promise.reject(new Error('no sid'));
    const loadAll = async () => {
      const out = []; let metaName = ''; let metaCover = '';
      for (let pn = 1; pn <= 4; pn++) {
        const page = await fetchSeasonPage(mid, sid, pn, 50, isSeries);
        if (page.meta && page.meta.name) metaName = page.meta.name;
        if (page.meta && page.meta.cover) metaCover = page.meta.cover;
        const arcs = page.archives || [];
        out.push(...arcs);
        if (!page.hasMore) break;
        await sleep(150);
      }
      return { arcs: out, metaName, metaCover };
    };
    return loadAll().then(({ arcs, metaName, metaCover }) => {
      if (!arcs.length) throw new Error('empty');
      const rows = arcs.map((a, i) =>
        '<label class="dlp-row"><input type="checkbox" class="dlp-cb" checked data-bvid="' + a.bvid + '" data-pid="1" data-title="' + encodeURIComponent(a.title || a.bvid) + '" data-pic="' + attr(a.pic || '') + '">' +
        '<span class="dlp-pn">' + (i + 1) + '</span><span class="dlp-pt" title="' + attr(a.title || '') + '">' + esc(a.title || '') + '</span>' +
        '<span class="dlp-pd">' + fmtTime(a.duration || a.length || 0) + '</span></label>').join('');
      const author = (arcs.find(x => x.author) || {}).author || '';
      const kindName = isSeries ? '专辑' : '合集';
      /* 合集/专辑动辄几十上百集, 全量列表铺开会把工作台撑成一条长柱, 挡住页面本身。
       * 所以默认只给「资料卡」(封面 / 名称 / 集数 / 订阅按钮), 下载区收进 .dlp-dlwrap,
       * 由「下载」按钮切换 display —— 列表 HTML 照旧预渲染好, 揭开是纯 CSS 切换, 不重新拉接口。 */
      const open = dlDlOpenKey === key0();
      return '<div class="dlpick" data-kind="season" data-mid="' + attr(mid) + '" data-sid="' + attr(sid) + '">' +
        pickHead('当前' + kindName, '<span class="rt">共 ' + arcs.length + ' 集</span>') +
        '<div class="dlp-body">' +
          (metaCover ? '<img src="' + attr(metaCover) + '" class="dlp-cover" onerror="this.style.display=\'none\'">' : '') +
          '<div class="dlp-info">' +
            '<div class="dlp-name">' + esc(metaName || (author ? author + ' 的' + kindName : kindName + ' sid ' + sid)) + '</div>' +
            '<div class="dlp-meta">' + kindName + '<span class="chip p">共 ' + arcs.length + ' 集</span></div>' +
            actRow([
              actBtn('sub-season', ICO.layers + '订阅该' + kindName, false),
              actBtn('season-dl-open', ICO.download + (open ? '收起' : '下载'), false)
            ]) +
          '</div></div>' +
        '<div class="dlp-dlwrap"' + (open ? '' : ' style="display:none"') + '>' +
          '<div class="dlp-rows">' + rows + '</div>' +
          '<div class="dlp-foot">' + dlSelBtn(arcs.length) + '</div>' +
        '</div></div>';
    });
  }
  /* ---------- UP 空间页 ---------- */
  if (/^\/(\d+)(?:\/|$)/.test(path)) {
    /* 用正则取 mid, 不能用 slice(1, indexOf('/',1)): URL 无尾斜杠时 indexOf=-1,
     * slice(1,-1) 会把 mid 末位数字削掉 → 订阅/监控到错误的 UP (v0.3.0 真 bug) */
    const mid = (path.match(/^\/(\d+)/) || [])[1] || '';
    if (!/^\d+$/.test(mid)) return Promise.reject(new Error('no mid'));
    return fetchUpInfo(mid).then(info => {
      if (!info) throw new Error('fetch fail');
      return '<div class="dlpick" data-kind="up" data-mid="' + mid + '" data-upname="' + encodeURIComponent(info.name || '') + '">' +
        pickHead('UP 空间', '<span class="rt">uid ' + mid + '</span>') +
        '<div class="dlp-body">' +
          avaHtml(info.face, initial(info.name), 'dlp-upface', info.name) +
          '<div class="dlp-info">' +
            '<div class="dlp-name">' + esc(info.name || ('UP ' + mid)) + '</div>' +
            '<div class="dlp-meta"><span>uid ' + mid + '</span><span class="chip">头像 / 昵称随订阅一同保存</span></div>' +
            actRow([actBtn('sub-up', ICO.layers + '订阅该 UP', false), actBtn('mon', ICO.radar + '加监控', false)]) +
          '</div></div></div>';
    });
  }
  return Promise.reject(new Error('not support page'));
}
function bindDlPick() {
  const pick = q('#brsDlPick');
  if (!pick) return;
  if (!pick.__dlpickBound) { pick.__dlpickBound = true; pick.addEventListener('click', onDlPickClick); }
  const all = pick.querySelector('#brsDlPickAll');
  if (all) all.addEventListener('change', () => onPickAll(all.checked));
  pick.querySelectorAll('.dlp-cb').forEach(cb => cb.addEventListener('change', selN));
  pick.querySelectorAll('[data-ava]').forEach(el => { const u = el.dataset.ava; if (u) warmAva(el, u); });
  /* 切 Tab / 缓存失效会重建 DOM, 重建后把用户此前展开的下载区还原回去 */
  const wrap = pick.querySelector('.dlp-dlwrap');
  if (wrap) {
    const open = dlDlOpenKey === key0();
    wrap.style.display = open ? '' : 'none';
    const b = pick.querySelector('[data-act="season-dl-open"]');
    if (b) b.innerHTML = ICO.download + (open ? '收起' : '下载');
  }
  selN();
}
/* 合集/专辑卡片底部下载区的展开 / 收起。列表 HTML 早已渲染好, 这里只切 display。 */
function toggleSeasonDl(b) {
  const card = b.closest('.dlpick');
  const wrap = card && card.querySelector('.dlp-dlwrap');
  if (!wrap) return;
  const open = wrap.style.display === 'none';
  wrap.style.display = open ? '' : 'none';
  b.innerHTML = ICO.download + (open ? '收起' : '下载');
  dlDlOpenKey = open ? key0() : '';
  if (open) {
    card.querySelectorAll('.dlp-cb').forEach(cb => { cb.checked = true; });
    selN();
  }
}
async function onDlPickClick(ev) {
  const pick = q('#brsDlPick');
  if (!pick) return;
  const b = ev.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  b.disabled = true;
  try {
    /* 用按钮所在的那张卡读数据, 不能用 pick.querySelector('.dlpick') ——
     * 视频页可能同时存在主卡与合集卡, 取「第一张」会读到错误的 mid/sid。 */
    const card = b.closest('.dlpick') || pick.querySelector('.dlpick');
    const D = card ? card.dataset : {};
    const act = b.dataset.act;
    if (act === 'sub-up') {
      if (!D.mid) { toast('未获取到 UP 信息'); return; }
      await subscribeUp(D.mid, D.upname ? decodeURIComponent(D.upname) : undefined,
        { defKw: D.title ? decodeURIComponent(D.title) : '', anchor: card });
    } else if (act === 'sub-season') {
      await subscribeSeasonNow();
    } else if (act === 'season-dl-open') {
      /* 合集/专辑页: 下载区默认折叠, 这里只负责揭开/收起(不拉接口) */
      toggleSeasonDl(b);
    } else if (act === 'sub-season-page') {
      /* 视频页里的「合集卡」按钮: 用卡片自己带的 sid/mid 订阅(与所在页面 URL 无关) */
      if (!D.sid || !D.mid) { toast('未获取到合集信息'); return; }
      await subscribeSeasonById(D.mid, D.sid, false);
    } else if (act === 'todo-add') {
      /* 把当前视频(多分P则只收当前选中/全部分P)加入稍后再看 */
      await addCurrentToTodo(pick, D);
    } else if (act === 'sub-bangumi') {
      await subscribeBangumiNow('https://www.bilibili.com/bangumi/play/ss' + D.ssid);
    } else if (act === 'bg-all') {
      /* 番剧集数多, 提供一键全选/反选 */
      const cbs = Array.from(pick.querySelectorAll('.dlp-cb'));
      const allOn = cbs.length > 0 && cbs.every(c => c.checked);
      cbs.forEach(c => { c.checked = !allOn; });
      selN();
      toast(allOn ? '已取消全选' : '已全选 ' + cbs.length + ' 集');
    } else if (act === 'mon') {
      monAfterAdd(D.kind === 'up' ? addMon(D.mid) : addMon(location.href));
    } else if (act === 'dl-one') {
      if (!D.bvid) { toast('未获取到视频信息'); return; }
      const t = startDownload({ bvid: D.bvid, pid: Number(D.pid || 1), title: D.title ? decodeURIComponent(D.title) : '', pic: D.pic || '' });
      toast('已加入下载队列：' + (t && t.title));
      setDlOpen(true); renderDl();
    } else if (act === 'dl-sel') {
      const checked = Array.from(pick.querySelectorAll('.dlp-cb:checked'));
      if (!checked.length) { toast('未勾选任何内容'); return; }
      let n = 0;
      for (const cb of checked) {
        const ds = cb.dataset;
        startDownload({
          bvid: ds.bvid || '', pid: Number(ds.pid || 1),
          epId: ds.ep ? Number(ds.ep) : 0, cid: Number(ds.cid || 0), bgSsid: ds.ssid || '',
          title: ds.title ? decodeURIComponent(ds.title) : '',
          /* 封面: 优先取行级(番剧/合集每行封面不同), 回落卡片级(视频页全卡共享同一封面) */
          pic: ds.pic || D.pic || ''
        });
        n++;
      }
      toast('已加入下载队列 ' + n + ' 个');
      setDlOpen(true); renderDl();
    }
  } catch (e) { toast(String((e && e.message) || e)); }
  b.disabled = false;
}

/* ============================ 订阅与监控动作 ============================
 * 订阅/监控全部收进悬浮球工作台, 不在主站页面注入按钮。
 * 订阅即建即显: 先落库并显示订阅信息(头像/昵称), 再后台抓取内容;
 * 合集/番剧订阅 = 当前全部内容一次导入, 之后每次刷新只补新增。
 * 关键词: 标题须同时命中全部(AND); 排除词: 命中任一即排除 */
/* 关键词输入 —— 内联卡片（不弹全局遮罩）。
 *
 * 为什么不做成弹窗: 弹窗盖住整个页面, 用户看不到当前视频/UP 的信息, 而且
 * 打开弹窗期间播放器快捷键仍在后台生效(在输入框里敲空格会把视频暂停)。
 * 改成在工作台里就地插一张卡片: 位置紧贴触发它的卡片下方, 视野内,
 * 确认/取消后自动移除。返回 { kws, exkws } 或 null(取消)。
 *
 * anchor: 插入位置参考节点, 卡片插到它后面; 不传则插到 #brsDlPick 末尾。
 * exist:  该 UP 已有的订阅数组(可能多条), 列出已用过的关键词组合避免建重复。 */
function askSubKwInline(upName, defKw = '', exist = [], anchor = null) {
  let hostEl = q('#brsDlPick');
  if (!hostEl) return Promise.resolve(null);
  const old = hostEl.querySelector('#brsSubKwCard');
  if (old) old.remove();

  /* 先把抽屉打开、页签切到「工作台」—— 必须赶在插卡之前做。
   * 因为 switchTab('bench') 会触发 renderDlPick() 把 #brsDlPick 的 innerHTML 整个
   * 重建一遍, 插好的卡片会被一起抹掉。切换后容器可能换了新节点, 所以要重新取一次;
   * anchor 也可能随旧节点一起被替换, 失效时退化成「插到工作台末尾」。 */
  const anchorAct = ensureBenchVisible(anchor);
  hostEl = q('#brsDlPick');
  if (!hostEl) return Promise.resolve(null);

  const existHtml = (exist || []).length
    ? '<div class="dlpk-ex"><div>该 UP 已有 ' + exist.length + ' 条订阅，填一组<b>不同</b>的关键词即可再订阅一次：</div><ul>'
      + exist.map(s => {
          const kw = (s.kws || []).filter(Boolean), ex = (s.exkws || []).filter(Boolean);
          let t = kw.length ? kw.join('+') : '全部投稿';
          if (ex.length) t += '（排除 ' + ex.join('/') + '）';
          return '<li>' + esc(t) + (s.on ? '' : ' <span class="off">· 已停用</span>') + '</li>';
        }).join('')
      + '</ul></div>'
    : '';

  const card = document.createElement('div');
  card.className = 'dlpk';
  card.id = 'brsSubKwCard';
  card.innerHTML =
    '<div class="dlp-title"><span class="hb">' + ICO.search + '订阅「' + esc(upName) + '」</span>' +
      '<span class="rt" style="margin-left:auto;font-size:11px;color:var(--t3)">设置筛选关键词（可选）</span></div>' +
    '<div class="fld"><div class="fl">匹配关键词<span class="hint">AND · 留空 = 全收</span></div>' +
      '<input type="text" id="brsKwMain" placeholder="逗号或空格分隔" value="' + attr(defKw || '') + '">' +
      '<div class="desc">标题需<b>同时包含全部</b>关键词才会收进稍后再看</div></div>' +
    '<div class="fld"><div class="fl">排除关键词<span class="hint">命中任一即跳过</span></div>' +
      '<input type="text" id="brsKwEx" placeholder="留空 = 不排除"></div>' +
    existHtml +
    '<div class="dlpk-acts">' +
      '<button class="sbtn" id="brsKwCancel" type="button">取消</button>' +
      '<button class="sbtn pink" id="brsKwOk" type="button">开始订阅</button>' +
    '</div>';
  /* anchor 若在重建中被换掉, anchorAct 会是 null, 此时插到末尾 */
  if (anchorAct && anchorAct.parentNode === hostEl) anchorAct.insertAdjacentElement('afterend', card);
  else hostEl.appendChild(card);

  const main = card.querySelector('#brsKwMain');
  let settled = false, resolve;
  const p = new Promise(res => { resolve = res; });

  /* 键盘拦截挂在 document 的「捕获」阶段 —— 这是整条传播链的最上游。
   *
   * 为什么不在 card 上拦: B 站播放器把快捷键监听挂在 document 上, document 的捕获
   * 监听总是比 card 的捕获监听先跑; 挂在 card 上就是慢一步, 根本轮不到。
   *
   * 为什么不用 document.activeElement 判「是否在打字」: 事件来自 shadow DOM 内部时,
   * activeElement 会被重定向成宿主 #brs-host(不是 INPUT), 判定必然失败(实测已验证)。
   * 所以只认事件的真实目标 —— shadow DOM 内部事件在 document 层同样被重定向,
   * 必须用 composedPath() 才能回看到 INPUT 本身。 */
  const inCard = ev => {
    try {
      const path = ev.composedPath ? ev.composedPath() : [];
      if (path.length) return path.indexOf(card) >= 0;
    } catch (e) {}
    return !!(ev.target && (ev.target === card || card.contains(ev.target)));
  };
  const realTarget = ev => {
    try {
      const path = ev.composedPath ? ev.composedPath() : [];
      for (const n of path) { if (n && TYPING_TAGS[n.tagName]) return n; }
    } catch (e) {}
    return isTypingEl(ev.target) ? ev.target : null;
  };
  /* 用 stopImmediatePropagation 而不是 stopPropagation:
   * 同一个节点上同阶段的监听是按「注册顺序」跑的, 本监听注册得晚, 单靠
   * stopPropagation 只能挡住它之后注册的, 挡不住之前注册的同类监听。
   * stopImmediatePropagation 能一次性掐断该节点上所有后续监听 —— 这是后注册者
   * 能拿到的最强手段, 也正是这里必须用的。 */
  const onKey0 = ev => {
    if (settled || !inCard(ev)) return;
    const t = realTarget(ev);
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); cancel(); return; }
    if (ev.key === 'Enter' && t) { ev.preventDefault(); ev.stopImmediatePropagation(); ok(); return; }
    if (t) { ev.stopImmediatePropagation(); ev.stopPropagation(); }
  };
  const onKey0up = ev => {
    if (settled || !inCard(ev) || !realTarget(ev)) return;
    ev.stopImmediatePropagation(); ev.stopPropagation();
  };

  /* 卡片回收时把监听摘干净, 否则 document 上会残留旧监听:
   * 轻则下次开卡重复拦截, 重则误伤页面上别的输入框 */
  const done = val => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKey0, true);
    document.removeEventListener('keyup', onKey0up, true);
    document.removeEventListener('keypress', onKey0up, true);
    if (TL._key0 === onKey0) TL._key0 = null;
    card.remove();
    resolve(val);
  };
  const split = v => String(v || '').trim()
    ? String(v).split(/[,，\s]+/).filter(Boolean).map(s => s.trim()).slice(0, 20)
    : [];
  const ok = () => done({ kws: split(main.value), exkws: split(card.querySelector('#brsKwEx').value) });
  const cancel = () => done(null);

  TL._key0 = onKey0;
  document.addEventListener('keydown', onKey0, true);
  document.addEventListener('keyup', onKey0up, true);
  document.addEventListener('keypress', onKey0up, true);

  card.querySelector('#brsKwOk').addEventListener('click', ok);
  card.querySelector('#brsKwCancel').addEventListener('click', cancel);

  /* 自动聚焦。
   *
   * 必须等输入框真的拿到布局盒再聚焦 —— 实测: 若卡片所在容器还是 display:none,
   * 或宿主 #brs-host(width:0;height:0) 里尚未完成布局, 输入框 getClientRects()
   * 会返回空, 浏览器**静默拒绝** focus, 用户看到的就是「点了订阅但什么都没发生」。
   * 上面 ensureBenchVisible() 已保证容器可见, 这里再轮询等布局落地, 拿到盒子才聚焦。 */
  let tries = 0;
  const tryFocus = () => {
    if (settled) return;
    if (main.getClientRects().length) {
      try { main.focus(); main.select(); } catch (e) {}
      return;
    }
    if (++tries > 40) return;   /* ~1s 后放弃, 不做无限轮询 */
    setTimeout(tryFocus, 25);
  };
  setTimeout(tryFocus, 30);
  return p;
}
/* 把抽屉打开、并把页签切到「工作台」—— 关键词卡片就插在那儿。
 *
 * 不这么做的话, 卡片会被插进一个 display:none 的容器:
 * 用户在视频页点「订阅该 UP」, 面板却停在别的页签, 卡片既看不见、输入框也拿不到
 * 布局盒(浏览器会静默拒绝 focus), 用户会觉得整个按钮失灵了。
 *
 * 返回 anchor: 切页签会触发 renderDlPick() 重建 #brsDlPick 的内部 DOM,
 * 传进来的 anchor 节点可能已随旧 DOM 一起被丢弃 —— 那时返回 null, 让调用方插到末尾。
 * 若节点还活着(没发生重建), 原样返回。 */
function ensureBenchVisible(anchor) {
  const d = q('#drawer');
  if (d && !d.classList.contains('show')) {
    d.classList.add('show');
    const f = q('#fab'); if (f) f.classList.add('close-state');
  }
  if (V.tab !== 'bench') switchTab('bench');
  if (!anchor) return null;
  /* 重取一次容器, 看 anchor 是否还在同一棵子树里 */
  const hostEl = q('#brsDlPick');
  if (hostEl && anchor.parentNode === hostEl && hostEl.contains(anchor)) return anchor;
  return null;
}
/* 后台收尾: 抓取该订阅的内容并入库, 完成后更新列表 + 提示新增数 */
async function bgFinishSub(sub) {
  try {
    const r = await refreshSub(sub, { full: true });
    const added = (r && r.added) || 0;
    save(); rebuildDedupe(); updateAllUI();
    if (added) toast('已导入 ' + added + ' 条到稍后再看');
  } catch (e) { console.warn('[BilibiliRSS] bg refresh', sub && sub.id, e); }
}
/* 订阅 UP(mid)。
 * 同一个 UP 允许建多条订阅 —— 只要关键词组合不同(例如「攻略」与「直播回放」)；
 * 关键词完全相同的组合则视为重复, 直接刷新已有那条。
 * 所以即便该 UP 已有订阅, 也照常弹关键词框, 让用户决定是新开一条还是复用自己的筛选。
 *
 * opt.anchor: 关键词卡片要插到哪个节点之后(通常是触发它的那张工作台卡片)。
 *             不传则插到工作台末尾。 */
async function subscribeUp(mid, upName, opt = {}) {
  const exist = subsOfUp(mid);
  if (!upName) {
    try { const info = await fetchUpInfo(mid); upName = info && info.name; } catch (e) {}
  }
  const kw = await askSubKwInline(upName || ('UP ' + mid), opt.defKw || '', exist, opt.anchor || null);
  if (!kw) return true;   /* 用户取消 */
  const sig = subSig('up', mid, kw.kws, kw.exkws);
  const same = exist.find(s => subSig('up', s.mid, s.kws, s.exkws) === sig);
  if (same) {
    if (!same.on) { toast('该关键词组合的订阅已停用，请到订阅页点电源图标启用'); return true; }
    toast('该关键词组合已在订阅，后台刷新中…');
    bgFinishSub(same);
    return true;
  }
  toast('订阅中…');
  const r = await addSubscription(String(mid), kw.kws, { exkws: kw.exkws, noBackfill: true });
  if (r.ok && r.sub) {
    updateAllUI();
    toast('已订阅「' + (r.sub.name || upName || mid) + '」' +
      (kw.kws.length ? '(关键词 ' + kw.kws.join('、') + ')' : '') + '，后台抓取中…');
    bgFinishSub(r.sub);
  } else if (r.dup && r.sub) {
    updateAllUI(); toast(r.msg || '该 UP 已在订阅');
    bgFinishSub(r.sub);
  } else {
    updateAllUI(); toast(r.msg || '订阅失败');
  }
  return true;
}
/* 订阅当前合集页: 立即把全部现有分P导入稍后再看; 之后每次刷新只补新增分P */
async function subscribeSeasonNow() {
  const p = parseLink(location.href);
  if (!p || p.type !== 'season') { toast('当前不是合集/专辑页'); return; }
  const kn = p.isSeries ? '专辑' : '合集';
  const existing = store.subs.find(s => s.type === 'season' && String(s.sid) === String(p.sid) && String(s.mid) === String(p.mid));
  if (existing) {
    if (!existing.on) { toast('该' + kn + '订阅已停用，请到订阅页点电源图标启用'); return; }
    toast('该' + kn + '已在订阅，后台刷新中…');
    bgFinishSub(existing);
    return;
  }
  toast('订阅中…');
  const r = await addSubscription(location.href, [], { noBackfill: true });
  if (r.ok && r.sub) {
    updateAllUI();
    toast('已订阅' + kn + '「' + (r.sub.name || '') + '」，正在导入全部现有分P…');
    bgFinishSub(r.sub);
  } else if (r.dup && r.sub) {
    updateAllUI(); toast('该' + kn + '已在订阅');
    bgFinishSub(r.sub);
  } else {
    updateAllUI(); toast(r.msg || '订阅失败');
  }
}
/* 用 mid + sid 直接订阅合集/专辑(不依赖当前页面 URL) —— 供视频页的合集卡使用 */
async function subscribeSeasonById(mid, sid, isSeries) {
  const kn = isSeries ? '专辑' : '合集';
  const existing = store.subs.find(s => s.type === 'season' && String(s.sid) === String(sid) && String(s.mid) === String(mid));
  if (existing) {
    if (!existing.on) { toast('该' + kn + '订阅已停用，请到订阅页点电源图标启用'); return; }
    toast('该' + kn + '已在订阅，后台刷新中…');
    bgFinishSub(existing);
    return;
  }
  toast('订阅中…');
  const link = 'https://space.bilibili.com/' + mid + '/lists/' + sid + (isSeries ? '?type=series' : '');
  const r = await addSubscription(link, [], { noBackfill: true });
  if (r.ok && r.sub) {
    updateAllUI();
    toast('已订阅' + kn + '「' + (r.sub.name || '') + '」，正在导入全部视频…');
    bgFinishSub(r.sub);
  } else if (r.dup && r.sub) {
    updateAllUI(); toast('该' + kn + '已在订阅');
    bgFinishSub(r.sub);
  } else {
    updateAllUI(); toast(r.msg || '订阅失败');
  }
}
/* 把当前视频加入稍后再看。
 * 单分P: 一条; 多分P: 每分P一条, 命名「分P名 - 视频标题」(P1 无独立分P名时用主标题)。
 * 标题本身已含序号的情况(「第1话」等)交给用户自行判断, 不做猜测改写。 */
async function addCurrentToTodo(pick, D) {
  const bvid = D.bvid || (location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/) || [])[1] || '';
  if (!bvid) { toast('未获取到视频信息'); return; }
  const view = await fetchView(bvid);
  if (!view) { toast('获取视频信息失败'); return; }
  const pages = (view.pages && view.pages.length) ? view.pages : [{ cid: 0, part: '', duration: view.length }];
  const vtitle = view.title || bvid;
  const ks = new Set([...dedupeSet, ...(store.ignore || [])]);
  const batch = [];
  /* 多分P时只收勾选中的行(尊重用户的勾选), 单分P直接收 */
  const checkedPids = new Set(Array.from(pick.querySelectorAll('.dlp-cb:checked')).map(cb => Number(cb.dataset.pid || 1)));
  let skipped = 0;
  pages.forEach((p, i) => {
    const pid = i + 1;
    if (pages.length > 1 && checkedPids.size && !checkedPids.has(pid)) return;
    const k = KEY(bvid, pid);
    if (ks.has(k)) { skipped++; return; }
    ks.add(k);
    const partName = (pages.length > 1) ? ((p.part || '').trim() || ('P' + pid)) : '';
    const title = partName ? (partName + ' - ' + vtitle) : vtitle;
    batch.push({
      id: uid(), key: k, bvid, pid, cid: p.cid || 0,
      title, author: view.author || '', face: '', pic: view.pic || '',
      dur: fmtTime(p.duration || view.length), pub: fmtDate(view.pubdate), ts: view.pubdate,
      subId: '', stat: view.stat || {}, st: 'todo', added: Date.now()
    });
  });
  if (!batch.length) { toast(skipped ? '已在稍后再看中（' + skipped + ' 条）' : '没有可加入的内容'); return; }
  store.items.unshift(...batch);
  save(); rebuildDedupe(); updateAllUI();
  toast('已加入稍后再看 ' + batch.length + ' 条' + (skipped ? '（跳过已在列表的 ' + skipped + ' 条）' : ''));
}
/* 订阅番剧(ss/ep 链接): 全部剧集一次导入(含 OP/ED/花絮各 section) */
async function subscribeBangumiNow(link) {
  const href = link || location.href;
  const p = parseLink(href);
  if (!p || p.type !== 'bangumi') { toast('当前不是番剧页'); return; }
  const existing = store.subs.find(s => s.type === 'bangumi' &&
    (p.ssid ? String(s.ssid) === String(p.ssid) : false));
  if (existing) {
    if (!existing.on) { toast('该番剧订阅已停用，请到订阅页点电源图标启用'); return; }
    toast('该番剧已在订阅，后台刷新中…');
    bgFinishSub(existing);
    return;
  }
  toast('订阅中…');
  const r = await addSubscription(href, [], { noBackfill: true });
  if (r.ok && r.sub) {
    updateAllUI();
    toast('已订阅番剧「' + (r.sub.name || '') + '」，正在导入全部剧集…');
    bgFinishSub(r.sub);
  } else if (r.dup && r.sub) {
    updateAllUI(); toast('该番剧已在订阅');
    bgFinishSub(r.sub);
  } else {
    updateAllUI(); toast(r.msg || '订阅失败');
  }
}
/* 监控点击后的通用收尾: 立即抓取该监控数据 */
function monAfterAdd(r) {
  if (!r || !r.ok) { toast((r && r.msg) || '失败'); return; }
  toast(r.dup ? '已在监控, 刷新中…' : '已加入监控, 刷新中…');
  if (r.id) refreshMonById(r.id);
}

/* ============================ 头像兜底修复 ============================
 * 旧数据里 subs/mons 可能因 acc/info -352 没拿到 face → 用 card 接口补 */
let healRunning = false;
function healFaces() {
  if (healRunning) return; healRunning = true;
  const targets = [];
  (store.subs || []).forEach(s => { if (s.type === 'up' && !s.face && s.mid) targets.push(['sub', s]); });
  (store.mons || []).forEach(m => { if (m.kind === 'up' && !m.face && m.mid) targets.push(['mon', m]); });
  (async () => {
    let changed = false;
    for (const [, obj] of targets.slice(0, 12)) {
      try {
        const info = await fetchUpInfo(obj.mid);
        if (info && info.face) { obj.face = info.face; changed = true; }
      } catch (e) {}
      await sleep(250);
    }
    if (changed) { save(); updateAllUI(); }
  })().finally(() => { healRunning = false; });
}

/* ============================ 启动 ============================ */
async function init() {
  loadStore(); rebuildDedupe();
  mountUI();
  healFaces();
  setTimeout(async () => {
    try {
      if (document.visibilityState === 'visible') { await refreshAll(); updateAllUI(); renderAllNow(); }
    } catch (e) { console.warn('[BilibiliRSS] first refresh', e); }
  }, 6000);
}
init();

})();
