// ==UserScript==
// @name         メルカリ助手
// @namespace    shen.mercari.helper
// @homepageURL  https://github.com/Bright-ShenJiahao/mercari-helper
// @updateURL    https://raw.githubusercontent.com/Bright-ShenJiahao/mercari-helper/main/mercari-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Bright-ShenJiahao/mercari-helper/main/mercari-helper.user.js
// @version      5.25
// @description  メルカリ商品を Yahoo!フリマ・ヤフオクへ複製出品／一括再出品・一括削除。抓取全部商品、批量再出品、批量删除；一键复制到三个平台
// @match        https://jp.mercari.com/*
// @match        https://paypayfleamarket-sec.yahoo.co.jp/*
// @match        https://auctions.yahoo.co.jp/sell/*
// @match        https://paypayfleamarket.yahoo.co.jp/*
// @match        https://auctions.yahoo.co.jp/jp/auction/*
// @match        https://page.auctions.yahoo.co.jp/jp/auction/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      static.mercdn.net
// @connect      auctions.c.yimg.jp
// @connect      yimg.jp
// @grant        window.close
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ============ 通用 ============
  const GAP_MIN = 3, GAP_MAX = 8;          // 批量操作每件之间随机秒数
  const BATCH_GAP_MIN = 20, BATCH_GAP_MAX = 60; // 连续出品每件之间
  const TITLE_MAX = 40;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const path = () => location.pathname;
  const idFromPath = () => path().split('/').filter(Boolean).pop();
  const norm = s => (s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const baseTitle = s => norm(s).replace(/\s*[A-Za-z]{1,2}\d+$/, '').trim();
  const makeTitle = (base, prefix, n) => prefix ? `${base} ${prefix}${n}` : base;

  function toast(msg, color = '#333') {
    let el = document.getElementById('mbr-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mbr-toast';
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 14px;border-radius:8px;color:#fff;font-size:14px;max-width:360px;box-shadow:0 2px 8px rgba(0,0,0,.3)';
      document.body.appendChild(el);
    }
    el.style.background = color;
    el.textContent = msg;
  }

  async function waitFor(fn, timeoutMs = 30000, step = 500) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }
  const btnByText = (re, root = document) =>
    [...root.querySelectorAll('button')].find(b => re.test(b.textContent.trim()) && !b.disabled);

  // 点按钮后若弹出确认框，点确认框里的同类按钮
  // 煤炉的确认框不是标准 dialog，所以在整个页面找：文字匹配、可见、且不是原按钮
  async function clickWithConfirm(btn, confirmRe) {
    const before = new Set(document.querySelectorAll('button'));
    btn.click();
    const dlgBtn = await waitFor(() => [...document.querySelectorAll('button')].find(b =>
      b !== btn && !b.disabled && b.offsetParent !== null &&
      confirmRe.test(b.textContent.trim()) &&
      (!before.has(b) || b.textContent.trim() !== btn.textContent.trim())), 6000);
    if (dlgBtn) { await sleep(rand(500, 1200)); dlgBtn.click(); }
    return !!dlgBtn;
  }

  // ============ 后台任务（管理面板派发，单件执行） ============
  // JOB = { op:'relist'|'del-stopped'|'del-sold', id, phase, token, msg }
  const JOB = 'mbr_job';
  const getJob = () => GM_getValue(JOB, null);
  const setJob = j => GM_setValue(JOB, j);
  const finishJob = (ok, msg) => { const j = getJob(); if (j) setJob({ ...j, phase: ok ? 'done' : 'error', msg, trace: [...(j.trace || []), `${ok ? '✓' : '✗'} ${msg} @${path()}`] }); };
  // 步骤记录：每一步写下当时的网址，出问题时在面板日志里能看到全过程
  const trace = s => { const j = getJob(); if (j) setJob({ ...j, trace: [...(j.trace || []), `${new Date().toLocaleTimeString()} ${s} @${path()}`] }); };

  // ---- 编辑页：停止 / 删除停止中 ----
  async function editPageWorker() {
    const j = getJob();
    const id = idFromPath();
    if (!j || j.id !== id) return;

    if (j.op === 'relist' && j.phase === 'stop') {
      toast('停止旧商品…');
      trace('到达旧商品编辑页');
      const stopBtn = await waitFor(() => btnByText(/一時停止|出品を停止/));
      trace(stopBtn ? `找到停止按钮「${stopBtn.textContent.trim()}」` : '没找到停止按钮');
      if (!stopBtn) {
        if (btnByText(/出品を再開/)) { finishJob(true, '旧商品本来就是停止状态'); return closeSoon(); }
        finishJob(false, '编辑页找不到「一時停止」按钮'); return;
      }
      const hadConfirm = await clickWithConfirm(stopBtn, /^(一時停止する|停止する|出品を一時停止する)$/);
      trace(hadConfirm ? '点了停止 + 确认框' : '点了停止（没有出现确认框）');
      setTimeout(() => trace('点停止 3 秒后'), 3000);
      // 停止后煤炉可能直接跳到别的页面，所以「出现再開按钮」或「离开编辑页」都算成功
      const ok = await waitFor(() => btnByText(/出品を再開/) || !/\/sell\/edit\//.test(path()), 15000);
      finishJob(!!ok, ok ? '已再出品，旧的已停止' : '点了停止但没确认成功，请检查');
      if (ok) closeSoon();
      return;
    }

    if (j.op === 'del-stopped' && j.phase === 'run') {
      toast('删除中…');
      await waitFor(() => btnByText(/出品を再開|一時停止/), 20000);
      if (!btnByText(/出品を再開/)) { finishJob(false, '不是停止中的商品，跳过'); return closeSoon(); }
      const del = await waitFor(() => document.querySelector('[data-testid="delete-button"]') || btnByText(/この商品を削除する/));
      if (!del) { finishJob(false, '找不到删除按钮'); return; }
      await clickWithConfirm(del, /^削除する$/);
      const gone = await waitFor(() => !/\/sell\/edit\//.test(path()) || !document.querySelector('[data-testid="delete-button"]'), 15000);
      finishJob(!!gone, gone ? '已删除' : '点了删除但页面没变化，请检查');
      if (gone) closeSoon();
    }
  }

  // ---- 交易页：删除已售出 ----
  async function transactionPageWorker() {
    const j = getJob();
    if (!j || j.id !== idFromPath() || j.op !== 'del-sold' || j.phase !== 'run') return;
    toast('删除已售出…');
    const clickable = re => [...document.querySelectorAll('button, a, [role="button"]')]
      .find(b => re.test(b.textContent.trim()) && !b.disabled && b.offsetParent !== null);
    await waitFor(() => clickable(/非表示にする|この商品を削除する/), 20000);
    // 删除按钮可能比「非表示」晚出现，再专门等最多 8 秒
    const del = await waitFor(() => clickable(/^この商品を削除する$/), 8000);
    if (!del) { finishJob(false, '还不能删除（未满14天），跳过'); return closeSoon(); }
    await clickWithConfirm(del, /^削除する$/);
    const gone = await waitFor(() => !/\/transaction\//.test(path()) || !clickable(/^この商品を削除する$/), 15000);
    finishJob(!!gone, gone ? '已删除' : '点了删除但页面没变化，请检查');
    if (gone) closeSoon();
  }

  function closeSoon() { setTimeout(() => window.close(), 1500); }

  // ============ 商品页 ============
  function itemPage() {
    const itemId = idFromPath();

    // --- 管理面板派来的再出品任务 ---
    const j = getJob();
    if (j && j.op === 'relist' && j.id === itemId && j.phase === 'clone') {
      (async () => {
        toast('再出品：读取商品信息…');
        const ok = await waitFor(() => document.querySelector('[data-testid="description"]') && document.querySelector('h1'), 30000);
        if (!ok) return finishJob(false, '商品页没加载出来');
        await sleep(1500);
        const src = readSrc();
        setJob({ ...getJob(), phase: 'filling', ts: Date.now(), src });
        trace('商品页：读好商品，打开出品页');
        GM_openInTab(location.origin + '/sell/create', { active: true, insert: true });
      })();
      GM_addValueChangeListener(JOB, (_k, _o, nj) => {
        if (nj && nj.id === itemId && nj.op === 'relist' && nj.phase === 'stop' && !window.__mbrGoEdit) {
          window.__mbrGoEdit = true;
          trace('商品页：收到出品成功，跳去编辑页');
          location.href = '/sell/edit/' + itemId;
        }
      });
    }

    // --- 多平台出品（商品页按钮） ---
    multiPlatformUI(itemId);
  }

  // ============ 多平台出品 ============
  // 状态 mbr_multi = { tasks:[{plat:'m'|'f'|'a', title, price}], i, phase, itemUrl, dry, cat, memKey, msg }
  // phase: 'run'（等待目标页面处理）| 'wait'（这件完成，商品页倒计时后做下一件）| 'done' | 'error' | 'stopped'
  const MKEY = 'mbr_multi';
  const getM = () => GM_getValue(MKEY, null);
  const setM = m => GM_setValue(MKEY, m);
  const PLAT = {
    m: { name: 'メルカリ', span: 'frima-assist-clone-mercari-0', color: '#e33' },
    f: { name: 'Yahoo!フリマ', span: 'frima-assist-clone-yahoofleamarket-0', color: '#f60' },
    a: { name: 'ヤフオク', span: 'frima-assist-clone-yahooauction-0', color: '#c90' },
  };
  const TITLE_LIMIT = { m: 40, f: 65, a: 65 };

  // 煤炉类别 → Yahoo!フリマ 卓球子类别 / ヤフオク 配送方法
  // Yahoo!フリマ 卓球 子类别
  const FLEA_CATS = ['ラバー', 'ラケット', 'ボール', 'ウエア', 'シューズ', 'バッグ、ケース', '設備、備品', 'その他卓球用品'];
  // ヤフオク 类别：显示名 → 在类别页里要匹配的路径结尾
  const AUC_CATS = {
    'ラバー': '卓球 > ラバー',
    'ラケット（シェーク）': '卓球 > ラケット > シェークハンド',
    'ラケット（ペン）': '卓球 > ラケット > ペンホルダー',
    'ボール': '卓球 > ボール',
    'バッグ、ケース': '卓球 > バッグ、ケース',
    'その他': '卓球 > その他',
  };
  const AUC_CAT_IDS = {
    'ラバー': '2084063073', 'ラケット（シェーク）': '2084286190', 'ラケット（ペン）': '2084286191',
    'ボール': '2084063072', 'バッグ、ケース': '2084286192', 'その他': '2084063076',
  };
  const AUC_SHIPS = {
    ship_delivery_n: 'ネコポス（210）',
    ship_delivery_yupacket_post_mini: 'ゆうパケットポストmini（160）',
    ship_delivery_yupacket: 'ゆうパケット（215）',
    ship_delivery_yupacket_plus: 'ゆうパケットプラス（410）',
    ship_delivery_s: '宅急便コンパクト（490）',
    ship_delivery_l: '宅急便 60〜160サイズ（750〜）',
    ship_delivery_xl: '宅急便 180〜200サイズ（2100〜）',
    ship_delivery_yupack: 'ゆうパック（750〜）',
  };
  const FLEA_SHIPS = { JAPAN_POST: 'おてがる配送（日本郵便）', YAMATO: 'おてがる配送（ヤマト運輸）' };
  function mapCategory(crumbs, title) {
    const leaf = crumbs[crumbs.length - 1] || '';
    const inTT = crumbs.includes('卓球');
    let flea = 'その他卓球用品';
    if (/ラバー/.test(leaf)) flea = 'ラバー';
    else if (/ラケット/.test(leaf)) flea = 'ラケット';
    else if (/ボール/.test(leaf)) flea = 'ボール';
    else if (/ウェア|ウエア/.test(leaf)) flea = 'ウエア';
    else if (/シューズ/.test(leaf)) flea = 'シューズ';
    else if (/バッグ|ケース/.test(leaf) || /ケース|バッグ/.test(title)) flea = 'バッグ、ケース';
    const ship = 'ship_delivery_yupacket';   // ヤフオク 一律默认ゆうパケット，需要的话在对话框里改
    const auc = flea === 'ラバー' ? 'ラバー'
      : flea === 'ラケット' ? (/ペン/.test(title) ? 'ラケット（ペン）' : 'ラケット（シェーク）')
      : flea === 'ボール' ? 'ボール' : flea === 'バッグ、ケース' ? 'バッグ、ケース' : 'その他';
    return { leaf, inTT, flea, ship, auc };
  }

  // 模拟人工修改：先改成别的值再改回来，让页面重新检查必填项
  const nativeSet = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  async function touchSet(el, v) {
    if (!el) return;
    el.focus();
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    nativeSet(el, String(v) + '9');
    await sleep(200);
    nativeSet(el, String(v));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.blur();
    await sleep(200);
  }
  // 更像真人：点进去 → 清空 → 一个字一个字敲 → 点到别处
  async function typeLikeHuman(el, v) {
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.focus();
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    nativeSet(el, '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    let cur = '';
    for (const ch of String(v)) {
      const k = { key: ch, code: /\d/.test(ch) ? 'Digit' + ch : '', bubbles: true };
      el.dispatchEvent(new KeyboardEvent('keydown', k));
      el.dispatchEvent(new KeyboardEvent('keypress', k));
      cur += ch;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, cur);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      el.dispatchEvent(new KeyboardEvent('keyup', k));
      await sleep(rand(60, 140));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.blur();
    // 点一下页面空白处
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(400);
  }
  // 找出没填的必填项：真正显示着「選択してください」的栏位（自制下拉框不会误判）
  function emptyRequired() {
    const shown = e => {
      if (!e || e.getBoundingClientRect().height <= 0) return false;
      for (let x = e; x && x !== document.body; x = x.parentElement) {
        const cs = getComputedStyle(x);
        if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') return false;
      }
      return true;
    };
    const out = [];
    document.querySelectorAll('p,span,div,option').forEach(e => {
      if (e.childElementCount !== 0 || !/^選択してください/.test(e.textContent.trim()) || !shown(e)) return;
      if (e.tagName === 'OPTION' && !e.selected) return;
      // 往上找这一栏的标题（带「必須」的那行）
      let box = e.parentElement, label = '';
      for (let up = 0; up < 6 && box && !label; up++, box = box.parentElement) {
        const lab = [...box.querySelectorAll('span,p,label')].find(x => x.childElementCount === 0 && x.textContent.trim().length > 1 && x.textContent.trim().length < 12 && !/選択|必須/.test(x.textContent));
        if (lab) label = lab.textContent.trim();
      }
      out.push(label || '某个下拉项');
    });
    return [...new Set(out)];
  }

  // 等页面被插件填好：签名连续 3 秒不变且条件满足
  async function waitFilled(sigFn, okFn, maxSec = 90) {
    let last = '', stable = 0;
    for (let t = 0; t < maxSec; t++) {
      await sleep(1000);
      const s = sigFn();
      if (okFn() && s === last) stable++; else stable = 0;
      last = s;
      toast(`等待插件填入内容… (${t}s)`);
      if (stable >= 3) return true;
    }
    return false;
  }

  // ============ 读原商品（商品页） ============
  function readSrc() {
    const id = idFromPath();
    const raw = (document.querySelector('h1') || {}).textContent?.trim() || '';
    const crumbs = [];                       // [スポーツ, 卓球, ラバー]
    for (const a of document.querySelectorAll('a[href*="category_id"]')) {
      const t = a.textContent.trim();
      if (!t || t.length > 30) continue;
      if (crumbs.includes(t)) break;
      crumbs.push(t);
    }
    const pe = document.querySelector('[data-testid="price"]');
    const price = parseInt(((pe?.textContent || '').match(/[\d,]+/) || ['0'])[0].replace(/,/g, ''), 10);
    const desc = (document.querySelector('[data-testid="description"]')?.innerText || '').replace(/\r/g, '').trim();
    const nImg = Math.max(1, document.querySelectorAll('[data-testid^="imageThumbnail-"]').length);
    const images = [...Array(nImg)].map((_, i) => `https://static.mercdn.net/item/detail/orig/photos/${id}_${i + 1}.jpg`);
    const info = document.body.innerText;
    const after = lab => ((info.match(new RegExp(lab + '\\n([^\\n]+)')) || [])[1] || '').trim();
    return { id, raw, crumbs, price, desc, images,
      cond: after('商品の状態'), payer: after('配送料の負担'), method: after('配送の方法'),
      area: after('発送元の地域'), days: after('発送までの日数') };
  }
  // 下载原图：用 GM_xmlhttpRequest，不受跨网站限制（Yahoo 页面也能下载煤炉的图片）
  function fetchImg(url) {
    return new Promise(res => {
      try {
        GM_xmlhttpRequest({ method: 'GET', url, responseType: 'blob',
          onload: r => res(r.status === 200 ? r.response : null), onerror: () => res(null), ontimeout: () => res(null) });
      } catch (e) { res(null); }
    });
  }
  async function downloadImages(src, say) {
    const files = [];
    for (let i = 0; i < src.images.length; i++) {
      const b = await fetchImg(src.images[i]);
      if (b) files.push(new File([b], `photo${i + 1}.jpg`, { type: b.type || 'image/jpeg' }));
      say(`下载图片 ${files.length}/${src.images.length}…`);
    }
    return files;
  }
  // ---- 从 Yahoo 商品页读原商品（统一成煤炉的格式）----
  const PREF_NAMES = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
  const PREF_CODES = ['HOKKAIDO','AOMORI','IWATE','MIYAGI','AKITA','YAMAGATA','FUKUSHIMA','IBARAKI','TOCHIGI','GUNMA','SAITAMA','CHIBA','TOKYO','KANAGAWA','NIIGATA','TOYAMA','ISHIKAWA','FUKUI','YAMANASHI','NAGANO','GIFU','SHIZUOKA','AICHI','MIE','SHIGA','KYOTO','OSAKA','HYOGO','NARA','WAKAYAMA','TOTTORI','SHIMANE','OKAYAMA','HIROSHIMA','YAMAGUCHI','TOKUSHIMA','KAGAWA','EHIME','KOCHI','FUKUOKA','SAGA','NAGASAKI','KUMAMOTO','OITA','MIYAZAKI','KAGOSHIMA','OKINAWA'];
  // Yahoo 的卓球子类别 → 煤炉的卓球子类别
  const toMercariTT = leaf => /ラバー/.test(leaf) ? 'ラバー' : /ラケット|シェーク|ペン/.test(leaf) ? 'ラケット' : /ボール/.test(leaf) ? 'ボール'
    : /ウエア|ウェア/.test(leaf) ? 'ウェア' : /バッグ|ケース/.test(leaf) ? 'バッグ・ケース' : 'その他';
  const condToMercari = c => (c === '未使用' ? '新品、未使用' : c);
  const daysToMercari = d => /1\s*[~〜～]\s*2/.test(d) ? '1~2日で発送' : /2\s*[~〜～]\s*3/.test(d) ? '2~3日で発送' : '4~7日で発送';
  function nextData() { try { return JSON.parse(document.getElementById('__NEXT_DATA__').textContent); } catch (e) { return null; } }
  function deepFind(o, test, d = 0) { if (!o || typeof o !== 'object' || d > 10) return null; if (test(o)) return o; for (const k in o) { const r = deepFind(o[k], test, d + 1); if (r) return r; } return null; }

  function readSrcFlea() {
    const it = deepFind(nextData(), o => o.title && o.description != null && Array.isArray(o.images) && o.categoryList);
    if (!it) return null;
    const cats = (it.categoryList || []).map(c => c.name);
    const inTT = cats.includes('卓球');
    const pi = PREF_CODES.indexOf(it.location);
    return { from: 'f', id: it.id, raw: it.title, price: it.price, desc: it.description || '',
      images: (it.images || []).map(x => x.url).filter(Boolean),
      crumbs: inTT ? ['スポーツ', '卓球', toMercariTT(cats[cats.length - 1])] : [],
      fleaLeaf: inTT ? cats[cats.length - 1] : '',
      cond: condToMercari(it.condition?.text || ''), payer: '送料込み(出品者負担)',
      method: it.deliveryMethod?.id === 'YAMATO' ? 'らくらくメルカリ便' : 'ゆうゆうメルカリ便',
      area: pi >= 0 ? PREF_NAMES[pi] : '', days: daysToMercari(it.deliverySchedule?.text || '') };
  }
  function readSrcAuc() {
    const it = deepFind(nextData(), o => o.auctionId && o.title && Array.isArray(o.img));
    if (!it) return null;
    const path = (it.category?.path || []).map(c => c.name);
    const ti = path.indexOf('卓球');
    const leaf = ti >= 0 ? path.slice(ti + 1).join(' > ') : '';
    const html = it.descriptionHtml || (Array.isArray(it.description) ? it.description.join('\n') : it.description || '');
    const desc = String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
    const m0 = (it.shipping?.methods || [])[0]?.id || '';
    const SHIP_ID = { JP_YUPACKET: 'ship_delivery_yupacket', JP_YUPACKET_PLUS: 'ship_delivery_yupacket_plus', JP_YUPACK: 'ship_delivery_yupack', JP_YUPACKET_POST_MINI: 'ship_delivery_yupacket_post_mini' };
    return { from: 'a', id: it.auctionId, raw: it.title, price: it.bidorbuy || it.price, desc,
      images: (it.img || []).map(x => x.image).filter(Boolean),
      crumbs: ti >= 0 ? ['スポーツ', '卓球', toMercariTT(leaf)] : [],
      aucCatId: (it.category?.path || []).slice(-1)[0]?.id || '', aucShip: SHIP_ID[m0] || '',
      cond: condToMercari(it.conditionName || ''), payer: it.chargeForShipping === 'buyer' ? '着払い(購入者負担)' : '送料込み(出品者負担)',
      method: /^JP_/.test(m0) ? 'ゆうゆうメルカリ便' : m0 ? 'らくらくメルカリ便' : 'ゆうゆうメルカリ便',
      area: it.seller?.location?.prefecture || it.location?.prefecture || '', days: daysToMercari(it.shipScheduleName || '') };
  }

  const CONDS = ['新品、未使用', '未使用に近い', '目立った傷や汚れなし', 'やや傷や汚れあり', '傷や汚れあり', '全体的に状態が悪い'];
  const M_SHIPS = ['ゆうゆうメルカリ便', 'らくらくメルカリ便', '梱包・発送たのメル便'];

  // ============ 煤炉出品页：自己填表（不靠插件） ============
  // 返回 null = 成功；返回字符串 = 出错原因
  async function mercariFill(src, t) {
    const say = s => toast(s, '#e33');
    const hrefA = h => [...document.querySelectorAll('a')].find(a => (a.getAttribute('href') || '') === h);
    const tap = el => (el.querySelector('button') || el).click();      // 类别等选项是「链接里套按钮」，点按钮才算选上
    const backToCreate = async () => { await waitFor(() => location.pathname === '/sell/create', 10000); await sleep(1200); };
    if (!await waitFor(() => document.querySelector('input[name="name"]'), 20000)) return '出品页没打开';

    // 1. 图片：下载原图 → 放进上传框 → 「次へ」
    say(`下载图片 0/${src.images.length}…`);
    const files = await downloadImages(src, say);
    if (!files.length) return '图片下载失败';
    const upl = document.querySelector('[data-testid="photo-upload"]');
    if (!upl) return '找不到上传框';
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    upl.files = dt.files;
    upl.dispatchEvent(new Event('change', { bubbles: true }));
    // 上传后可能弹出：①「AI出品サポート」→ 点「スキップ」，不让 AI 乱填；②「画像編集」→ 点「次へ」
    for (let k = 0; k < files.length + 4; k++) {
      const pick = () => {
        const btns = [...document.querySelectorAll('button,a')].filter(b => b.offsetParent);
        const ai = /AI出品サポート/.test(document.body.innerText) && btns.find(b => b.textContent.trim() === 'スキップ');
        if (ai) return ai;
        return btns.find(b => b.tagName === 'BUTTON' && b.textContent.trim() === '次へ' && !b.disabled);
      };
      const nx = await waitFor(pick, k ? 3000 : 8000);
      if (!nx) break;
      await sleep(rand(400, 900));
      nx.click();
      await sleep(1200);
    }
    // 预览图在 photo-thumbnail 里
    if (!await waitFor(() => document.querySelectorAll('[data-testid="photo-thumbnail"]').length >= files.length, 30000)) return '图片没传上去';

    // 2. 类别：一级一级点
    if (src.crumbs.length) {
      say('选类别…');
      const entry = await waitFor(() => hrefA('/sell/categories'), 8000);
      if (entry) {
        tap(entry);
        for (const name of src.crumbs) {
          // 煤炉可能已经按图片预选了类别，文字会变成「スポーツこのカテゴリーを選択しています」
          const a = await waitFor(() => [...document.querySelectorAll('a')].find(x => { const s = x.textContent.trim(); return s === name || s === name + 'このカテゴリーを選択しています'; }), 10000);
          if (!a) return `类别里找不到「${name}」`;
          await sleep(rand(300, 700));
          tap(a);
          await sleep(1200);
        }
        await backToCreate();
      }
    }

    // 3. 商品状态
    const cond = t.cond || src.cond;
    if (cond) {
      say('选商品状态…');
      const entry = await waitFor(() => hrefA('/sell/conditions'), 8000);
      if (entry) {
        tap(entry);
        const a = await waitFor(() => [...document.querySelectorAll('a')].find(x => x.textContent.trim().startsWith(cond)), 10000);
        if (!a) return `状态里找不到「${cond}」`;
        await sleep(rand(300, 700));
        tap(a);
        await backToCreate();
      }
    }

    // 4. 配送方式（らくらく / ゆうゆう / たのメル）
    const meth = t.mship || src.method;
    const curMeth = () => ((document.body.innerText.match(/配送の方法\n(?:変更する\n)?([^\n]+)/) || [])[1] || '').trim();
    if (meth && !curMeth().startsWith(meth)) {
      say('选配送方式…');
      const entry = await waitFor(() => hrefA('/sell/shipping_methods'), 8000);
      if (entry) {
        tap(entry);
        const r = await waitFor(() => [...document.querySelectorAll('input[type=radio][name="selectedShippingMethod"]')]
          .find(x => (x.closest('label') || x.parentElement).textContent.replace(/\s+/g, '').startsWith(meth)), 10000);
        if (r) {
          r.click();
          await sleep(600);
          const up = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '更新する');
          if (up) up.click();
        }
        await backToCreate();
      }
    }

    // 5. 运费负担 / 发货地 / 发货天数（按文字选下拉）
    const setSel = (name, txt) => {
      const el = document.querySelector(`select[name="${name}"]`);
      if (!el || !txt) return;
      const o = [...el.options].find(x => x.text.trim() === txt || x.text.trim().startsWith(txt));
      if (!o || el.value === o.value) return;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, o.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setSel('shippingPayer', src.payer);
    setSel('shippingFromArea', src.area);
    setSel('shippingDuration', src.days);

    // 6. 文字：标题、说明、价格（最后填，避免被跳页影响）
    say('填标题、说明、价格…');
    await touchSet(document.querySelector('input[name="name"]'), t.title);
    await touchSet(document.querySelector('textarea[name="description"]'), t.desc != null ? t.desc : src.desc);
    await touchSet(document.querySelector('[data-testid="price-text-input"]'), t.price || src.price);
    await sleep(800);

    // 7. 检查（状态被 AI 改掉就重选一次）
    const condNow = () => { const s = document.body.innerText; const i = s.indexOf('商品の状態'); return s.slice(i, i + 80); };
    if (cond && !condNow().includes(cond)) {
      const entry = hrefA('/sell/conditions');
      if (entry) {
        tap(entry);
        const a = await waitFor(() => [...document.querySelectorAll('a')].find(x => x.textContent.trim().startsWith(cond)), 10000);
        if (a) { tap(a); await backToCreate(); }
      }
      if (!condNow().includes(cond)) return `状态没选对（应为「${cond}」）`;
    }
    const det = (() => { const s = document.body.innerText; const i = s.indexOf('商品の詳細'); return s.slice(i, i + 200); })();
    if (/カテゴリーを選択する/.test(det)) return '类别没选上';
    if (document.querySelector('input[name="name"]').value !== t.title) return '标题没填上';
    return null;
  }

  function multiPlatformUI(itemId, readFn = readSrc) {
    // 每次打开商品页一个专属编号：只有点了「开始」的这一份负责派发。
    // 煤炉是单页应用，看过的旧商品留下的监听不会撤掉，靠这个编号让它们不重复派发。
    const TAB_ID = Math.random().toString(36).slice(2);
    const memKey = 'mbr_last_' + itemId;

    const waitBtn = setInterval(() => {
      // 按钮放在大图正下方（原来フリマアシスト那排链接的位置）
      if (document.getElementById('mbr-btn')) return;
      let clone = document.querySelector('[data-testid="image-0"]')?.closest('.slick-slider');
      if (!clone && readFn !== readSrc) {
        // Yahoo 商品页：找最大的那张主图，按钮放在主图区块下面
        if (!readFn()) return;
        const big = [...document.querySelectorAll('img')].filter(i => { const r = i.getBoundingClientRect(); return r.width > 200 && r.top < 1400; })
          .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
        if (!big) return;
        const h = big.getBoundingClientRect().height;
        clone = big;
        while (clone.parentElement && clone.parentElement.getBoundingClientRect().height < h + 160 && clone.parentElement !== document.body) clone = clone.parentElement;
      }
      if (!clone) return;
      clearInterval(waitBtn);
      const add = (id, text, bg, fn) => {
        const b = document.createElement('button');
        b.id = id; b.textContent = text; b.onclick = fn;
        b.style.cssText = `padding:8px 18px;border:none;border-radius:6px;color:#fff;background:${bg};cursor:pointer;font-size:15px;font-weight:bold`;
        const box = document.getElementById('mbr-btnbox') || (() => {
          const d = document.createElement('div'); d.id = 'mbr-btnbox';
          d.style.cssText = 'margin:10px 0 4px;display:flex;gap:8px';
          clone.insertAdjacentElement('afterend', d);
          return d;
        })();
        box.appendChild(b);
      };
      add('mbr-btn', '多平台出品', '#e33', openDialog);
      add('mbr-stop', '停止', '#555', () => { const m = getM(); if (m) setM({ ...m, phase: 'stopped' }); toast('已停止', '#555'); });
    }, 500);

    function openDialog() {
      if (document.getElementById('mbr-dlg')) return;
      const src = readFn();
      if (!src) return toast('读不到这件商品的信息', '#c00');
      const { raw, crumbs, price } = src;
      const cat = mapCategory(crumbs, raw);
      const last = GM_getValue(memKey, null);
      const m = raw.normalize('NFKC').match(/^(.*?)[\s　]*([A-Za-z]+)(\d+)\s*$/);   // 全角 Ｒ３ 也算
      let base = raw, prefix = 'Z', start = 1;
      if (m) { base = m[1]; prefix = m[2]; start = +m[3] + 1; }
      if (last) { prefix = last.prefix; start = last.next; }

      const wrap = document.createElement('div');
      wrap.id = 'mbr-dlg';
      wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99998;display:flex;align-items:center;justify-content:center';
      const inp = 'padding:6px 8px;border:1px solid #aaa;border-radius:6px;font-size:15px';
      wrap.innerHTML = `
        <div style="display:flex;gap:12px;align-items:stretch;max-height:90vh">
        <div style="background:#fff;border-radius:12px;padding:20px 24px;width:720px;max-height:90vh;overflow:auto;font-size:15px;line-height:1.6;color:#222">
          <div style="font-weight:bold;font-size:18px;margin-bottom:10px">多平台出品</div>
          <label style="display:block">标题（不含编号）<br><textarea id="mm-base" rows="2" style="${inp};width:100%;box-sizing:border-box;resize:vertical;line-height:1.5"></textarea></label>
          ${cat.flea === 'ラケット' ? `<div id="mm-racket" style="margin-top:6px;font-size:15px;background:#fff7e0;padding:4px 8px;border-radius:6px">底板类型：
            <label style="cursor:pointer"><input type="radio" name="mm-rk" value="shake" ${/ペン/.test(raw) ? '' : 'checked'}> シェーク（横拍）</label>
            <label style="cursor:pointer;margin-left:12px"><input type="radio" name="mm-rk" value="pen" ${/ペン/.test(raw) ? 'checked' : ''}> ペン（直拍）</label>
            <span style="color:#888;font-size:13px">（Yahoo!フリマ、ヤフオク 的类别跟着变；煤炉不分）</span></div>` : ''}
          <div style="margin-top:6px;font-size:15px">编号：
            <label style="cursor:pointer"><input type="radio" name="mm-mode" value="num"> 加编号</label>
            <label style="cursor:pointer;margin-left:12px"><input type="radio" name="mm-mode" value="none"> 不加编号（直接用原标题）</label></div>
          <div id="mm-numrow" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-top:6px">
            <label>编号前缀<br><input id="mm-pf" style="${inp};width:70px"></label>
            <label>起始编号<br><input id="mm-st" type="number" min="0" style="${inp};width:80px"></label>
            <button id="mm-gen" style="${inp};background:#06c;color:#fff;border:none;cursor:pointer">按编号生成全部标题</button>
          </div>
          <div style="font-size:13px;color:#666;margin-top:4px">编号在所选平台之间连续；前缀留空 = 不加编号。煤炉类别：${crumbs.join(' > ') || '（没读到）'} → Yahoo 类别：卓球 > ${cat.flea}</div>
          <div style="margin-top:8px;font-size:14px">上货间隔：<input id="mm-gmin" type="number" min="5" style="${inp};width:70px"> ～ <input id="mm-gmax" type="number" min="5" style="${inp};width:70px"> 秒
            <span style="color:#888;font-size:13px">（在范围内随机；两个一样 = 固定间隔。用于自动出品的件与件之间）</span></div>
          <div id="mm-plats" style="margin-top:12px"></div>
          <div id="mm-err" style="color:#c00;margin-top:6px;font-size:14px"></div>
          <div style="display:flex;align-items:center;margin-top:14px">
            <button id="mm-dry" style="${inp};background:#888;color:#fff;border:none;cursor:pointer">试运行（都不出品）</button>
            <span style="flex:1"></span>
            <button id="mm-cancel" style="${inp};margin-left:6px;cursor:pointer">取消</button>
            <button id="mm-go" style="${inp};margin-left:6px;background:#e33;color:#fff;border:none;cursor:pointer;font-weight:bold">开始</button>
          </div>
        </div>
        <div id="mm-side" style="display:none;background:#fff;border-radius:12px;padding:18px 20px;width:420px;max-height:90vh;overflow:auto;font-size:15px;line-height:1.6;color:#222"></div>
        </div>`;
      document.body.appendChild(wrap);
      const $ = id => wrap.querySelector('#' + id);
      $('mm-base').value = base; $('mm-pf').value = prefix; $('mm-st').value = start;
      const hasNo = !!m || !!last;
      wrap.querySelector(`input[name="mm-mode"][value="${hasNo ? 'num' : 'none'}"]`).checked = true;
      const numMode = () => wrap.querySelector('input[name="mm-mode"]:checked').value === 'num';
      const syncMode = () => {
        $('mm-numrow').style.display = numMode() ? 'flex' : 'none';
        if (!numMode()) $('mm-base').value = raw;          // 不加编号：用完整原标题
        else if ($('mm-base').value === raw && m) $('mm-base').value = base;
      };
      wrap.querySelectorAll('input[name="mm-mode"]').forEach(r => r.addEventListener('change', () => { syncMode(); gen(); }));
      const GAP = GM_getValue('mbr_gap', { min: 20, max: 60 });
      $('mm-gmin').value = GAP.min; $('mm-gmax').value = GAP.max;

      const P = {
        m: { on: true, n: 1, price, titles: [], ov: [], mship: 'ゆうゆうメルカリ便' },
        f: { on: false, n: 1, price, titles: [], ov: [], cat: cat.flea, fship: 'JAPAN_POST' },
        a: { on: false, n: 1, price, titles: [], ov: [], cat: cat.auc, ship: cat.ship },
      };
      const AUTO = GM_getValue('mbr_auto2', { f: true, a: true });   // 记住上次选的模式
      P.f.auto = !!AUTO.f; P.a.auto = !!AUTO.a;
      const autoBox = k => `<label style="cursor:pointer;color:${P[k].auto ? '#c00' : '#555'};font-weight:${P[k].auto ? 'bold' : 'normal'}"><input type="checkbox" data-au="${k}" ${P[k].auto ? 'checked' : ''} style="width:16px;height:16px;vertical-align:middle"> 全自动（检查无误就自己点出品，有问题退回半自动）</label>`;
      const sel = (attr, k, opts, val) => `<select data-${attr}="${k}" style="${inp}">${opts.map(([v, l]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`;

      function gen() {
        let n = parseInt($('mm-st').value, 10) || 0;
        const b = $('mm-base').value.replace(/\s*\n\s*/g, ' ').trim(), pf = $('mm-pf').value.trim();
        ['m', 'f', 'a'].forEach(k => {
          P[k].titles = [];
          P[k].ov = P[k].ov.slice(0, P[k].n);
          if (!P[k].on) return;
          for (let i = 0; i < P[k].n; i++) { P[k].titles.push(numMode() ? makeTitle(b, pf, n) : b); n++; }
        });
        draw();
      }
      function draw() {
        $('mm-plats').innerHTML = ['m', 'f', 'a'].map(k => {
          const p = P[k];
          const rows = p.on ? p.titles.map((t, i) => {
            const L = [...t].length, over = L > TITLE_LIMIT[k];
            return `<div style="display:flex;gap:6px;align-items:center;margin-top:6px">
              <span style="width:50px;font-size:13px;color:#666">标题${i + 1}</span>
              <textarea data-t="${k}:${i}" rows="${[...t].length > 30 ? 2 : 1}" style="${inp};flex:1;resize:vertical;line-height:1.5;font-family:inherit">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</textarea>
              <span style="width:60px;font-size:13px;text-align:right;color:${over ? '#c00' : '#666'}">${L}/${TITLE_LIMIT[k]}</span>
              <button data-d="${k}:${i}" style="${inp};padding:4px 10px;cursor:pointer;border:none;color:#fff;background:${p.ov[i] && Object.keys(p.ov[i]).length ? '#f60' : '#999'}">详情${p.ov[i] && Object.keys(p.ov[i]).length ? '✎' : ''}</button></div>`;
          }).join('') : '';
          return `<div style="border:1px solid ${p.on ? PLAT[k].color : '#ddd'};border-radius:10px;padding:10px 12px;margin-top:10px;background:${p.on ? '#fffaf5' : '#fafafa'}">
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
              <label style="font-weight:bold;font-size:16px;flex:1;cursor:pointer"><input type="checkbox" data-on="${k}" ${p.on ? 'checked' : ''} style="width:18px;height:18px;vertical-align:middle"> ${PLAT[k].name}${k === 'm' ? '' : ` <span style="font-weight:normal;font-size:13px;color:#888">（${p.auto ? '全自动' : '半自动：填好后等你确认点出品'}）</span>`}</label>
              <label>数量 <input type="number" min="1" max="20" data-n="${k}" value="${p.n}" style="${inp};width:70px"></label>
              <label>价格 <input type="number" data-p="${k}" value="${p.price}" style="${inp};width:110px"></label>
            </div>
            ${p.on && k === 'm' ? `<div style="margin-top:6px;display:flex;gap:16px;flex-wrap:wrap">
                <span style="background:#ffe3c2;padding:2px 6px;border-radius:4px;font-weight:bold">配送：${sel('ms', k, M_SHIPS.slice(0, 2).map(x => [x, x]), p.mship)}</span></div>` : ''}
            ${p.on && k === 'f' ? `<div style="margin-top:6px;display:flex;gap:16px;flex-wrap:wrap">
                <span>类别：スポーツ > 卓球 > ${sel('fc', k, FLEA_CATS.map(c => [c, c]), p.cat)}</span>
                <span style="background:#ffe3c2;padding:2px 6px;border-radius:4px;font-weight:bold">配送：${sel('fs', k, Object.entries(FLEA_SHIPS), p.fship)}</span>${autoBox('f')}</div>` : ''}
            ${p.on && k === 'a' ? `<div style="margin-top:6px;display:flex;gap:16px;flex-wrap:wrap">
                <span>类别：${sel('ac', k, Object.keys(AUC_CATS).map(c => [c, AUC_CATS[c]]), p.cat)}</span>
                <span style="background:#ffe3c2;padding:2px 6px;border-radius:4px;font-weight:bold">配送：${sel('as', k, Object.entries(AUC_SHIPS), p.ship)}</span>
                <span style="color:#888;font-size:13px">结束日期自动选最晚的一天</span>${autoBox('a')}</div>` : ''}
            ${rows}</div>`;
        }).join('');
        check();
      }
      // ---- 详情面板：只改这一件的文字 ----
      const sideEl = wrap.querySelector('#mm-side');
      const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
      function openSide(k, i) {
        const ov = P[k].ov[i] || {};
        const shipOpts = k === 'm' ? M_SHIPS.map(x => [x, x]) : k === 'f' ? Object.entries(FLEA_SHIPS) : Object.entries(AUC_SHIPS);
        const shipDef = k === 'm' ? P.m.mship : k === 'f' ? P.f.fship : P.a.ship;
        const tip = '';
        sideEl.style.display = 'block';
        sideEl.innerHTML = `
          <div style="font-weight:bold;font-size:17px;margin-bottom:8px">详情：${PLAT[k].name} 第 ${i + 1} 件</div>${tip}
          <label>标题<br><input id="sd-title" value="${esc(P[k].titles[i])}" style="${inp};width:100%"></label>
          <label style="display:block;margin-top:8px">价格 <input id="sd-price" type="number" value="${esc(ov.price ?? P[k].price)}" style="${inp};width:120px"></label>
          <label style="display:block;margin-top:8px">说明（厚度等在这里手动改）<br>
            <textarea id="sd-desc" style="${inp};width:100%;height:260px;font-size:14px">${esc(ov.desc ?? src.desc)}</textarea></label>
          <label style="display:block;margin-top:8px">商品状态 <select id="sd-cond" style="${inp}">${CONDS.map(c => `<option ${c === (ov.cond ?? src.cond) ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          <label style="display:block;margin-top:8px">配送 <select id="sd-ship" style="${inp}">${shipOpts.map(([v, l]) => `<option value="${esc(v)}" ${v === (ov.ship ?? shipDef) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <div style="text-align:right;margin-top:12px">
            <button id="sd-reset" style="${inp};cursor:pointer">恢复原样</button>
            <button id="sd-ok" style="${inp};margin-left:6px;background:#06c;color:#fff;border:none;cursor:pointer">完成</button>
          </div>`;
        const q = id => sideEl.querySelector('#' + id);
        q('sd-reset').onclick = () => { P[k].ov[i] = {}; sideEl.style.display = 'none'; draw(); };
        q('sd-ok').onclick = () => {
          const o = {};
          const pr = parseInt(q('sd-price').value, 10);
          if (pr && pr !== P[k].price) o.price = pr;
          if (q('sd-desc').value !== src.desc) o.desc = q('sd-desc').value;
          if (q('sd-cond').value !== src.cond) o.cond = q('sd-cond').value;
          if (q('sd-ship').value !== shipDef) o.ship = q('sd-ship').value;
          P[k].ov[i] = o;
          P[k].titles[i] = q('sd-title').value;
          sideEl.style.display = 'none';
          draw();
        };
      }
      $('mm-plats').addEventListener('click', e => {
        const d = e.target.closest('[data-d]');
        if (d) { const [k, i] = d.dataset.d.split(':'); openSide(k, +i); }
      });

      function check() {
        const errs = [];
        const any = ['m', 'f', 'a'].some(k => P[k].on);
        if (!any) errs.push('至少勾选一个平台');
        ['m', 'f', 'a'].forEach(k => {
          if (!P[k].on) return;
          if (!(P[k].price >= 300)) errs.push(`${PLAT[k].name} 价格不对`);
          P[k].titles.forEach((t, i) => { if (!t.trim()) errs.push(`${PLAT[k].name} 标题${i + 1} 是空的`); if ([...t].length > TITLE_LIMIT[k]) errs.push(`${PLAT[k].name} 标题${i + 1} 超过${TITLE_LIMIT[k]}字`); });
        });
        $('mm-err').textContent = errs.join('；');
        return errs.length === 0;
      }
      $('mm-plats').addEventListener('change', e => {
        const d = e.target.dataset;
        if (d.on) { P[d.on].on = e.target.checked; gen(); }
        if (d.fc) P.f.cat = e.target.value;
        if (d.fs) P.f.fship = e.target.value;
        if (d.ms) P.m.mship = e.target.value;
        if (d.au) { P[d.au].auto = e.target.checked; GM_setValue('mbr_auto2', { f: P.f.auto, a: P.a.auto }); draw(); }
        if (d.ac) P.a.cat = e.target.value;
        if (d.as) P.a.ship = e.target.value;
      });
      $('mm-plats').addEventListener('input', e => {
        const d = e.target.dataset;
        if (d.n) { P[d.n].n = Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)); gen(); }
        if (d.p) { P[d.p].price = parseInt(e.target.value, 10) || 0; check(); }
        if (d.t) {
          const [k, i] = d.t.split(':'); P[k].titles[i] = e.target.value.replace(/\s*\n\s*/g, ' ');
          const L = [...e.target.value].length, s = e.target.nextElementSibling;
          s.textContent = `${L}/${TITLE_LIMIT[k]}`; s.style.color = L > TITLE_LIMIT[k] ? '#c00' : '#666';
          check();
        }
      });
      ['mm-base', 'mm-pf', 'mm-st'].forEach(id => $(id).addEventListener('input', gen));
      $('mm-gen').onclick = gen;
      $('mm-cancel').onclick = () => wrap.remove();
      const startRun = dry => {
        if (!check()) return;
        const q = GM_getValue(QUEUE, null);
        if (P.m.on && q && q.running && q.op === 'relist' && Date.now() - GM_getValue('mbr_qhb', 0) < 60e3 &&
          !confirm('面板里的「批量再出品」正在运行。\n两边都要打开煤炉出品页，同时跑可能把商品填错。\n建议等它结束或先暂停。仍要开始吗？')) return;
        const shipLines = [P.m.on && '煤炉：' + P.m.mship, P.f.on && 'Yahoo!フリマ：' + FLEA_SHIPS[P.f.fship], P.a.on && 'ヤフオク：' + AUC_SHIPS[P.a.ship]].filter(Boolean);
        if (shipLines.length && !confirm('请核对配送方式：\n\n' + shipLines.join('\n') + '\n\n（详情里单独改过的以详情为准）\n没问题点「确定」开始。')) return;
        const tasks = [];
        ['m', 'f', 'a'].forEach(k => {
          if (!P[k].on) return;
          const titles = dry ? P[k].titles.slice(0, 1) : P[k].titles;
          titles.forEach((t, i) => {
            const ov = P[k].ov[i] || {};
            tasks.push({ plat: k, title: t.trim(), price: ov.price || P[k].price, cat: P[k].cat,
              fsub: k === 'f' && P.f.cat === 'ラケット' && racket() ? (racket() === 'pen' ? 'ペンホルダー' : 'シェークハンド') : undefined,
              ship: k === 'a' ? (ov.ship || P[k].ship) : P[k].ship,
              fship: k === 'f' ? (ov.ship || P[k].fship) : P[k].fship,
              mship: k === 'm' ? (ov.ship || P.m.mship) : undefined,
              desc: ov.desc, cond: ov.cond, auto: !!P[k].auto });
          });
        });
        let gmin = Math.max(5, parseInt($('mm-gmin').value, 10) || 20), gmax = Math.max(5, parseInt($('mm-gmax').value, 10) || 60);
        if (gmax < gmin) [gmin, gmax] = [gmax, gmin];
        GM_setValue('mbr_gap', { min: gmin, max: gmax });
        const pf = numMode() ? $('mm-pf').value.trim() : '';
        const used = parseInt($('mm-st').value, 10) + ['m', 'f', 'a'].reduce((s, k) => s + (P[k].on ? P[k].n : 0), 0);
        wrap.remove();
        setM({ tasks, i: 0, phase: 'run', runId: Date.now().toString(36), owner: TAB_ID, itemUrl: location.href, dry, cat, src, memKey, gap: { min: gmin, max: gmax }, nextNo: { prefix: pf, next: used }, msg: '' });
        fire();
      };
      $('mm-dry').onclick = () => startRun(true);
      $('mm-go').onclick = () => startRun(false);
      // 底板类型：同步到 Yahoo!フリマ 子类别和 ヤフオク 类别
      const racket = () => document.querySelector('input[name="mm-rk"]:checked')?.value || '';
      document.querySelectorAll('input[name="mm-rk"]').forEach(r => r.addEventListener('change', () => {
        if (/^ラケット/.test(P.a.cat)) P.a.cat = racket() === 'pen' ? 'ラケット（ペン）' : 'ラケット（シェーク）';
        draw();
      }));
      if (racket() && /^ラケット/.test(P.a.cat)) P.a.cat = racket() === 'pen' ? 'ラケット（ペン）' : 'ラケット（シェーク）';
      syncMode();
      gen();
    }

    function fire() {
      const m = getM();
      if (!m || m.itemUrl !== location.href || m.phase !== 'run' || (m.owner && m.owner !== TAB_ID)) return;
      const t = m.tasks[m.i];
      const fk = (m.runId || '') + ':' + m.i;
      if (m.fired === fk) { setM({ ...m, dupFire: (m.dupFire || 0) + 1, dupBy: TAB_ID.slice(0, 4) }); return; }   // 这件已经派发过，不再开页面
      m.fired = fk; m.firedBy = TAB_ID.slice(0, 4);
      toast(`${m.i + 1}/${m.tasks.length}：${PLAT[t.plat].name}「${t.title}」…`, PLAT[t.plat].color);
      if (t.plat === 'm') {
        setM({ ...m, ts: Date.now() });   // 时间戳：过期的任务不会被目标页面误用
        GM_openInTab(location.origin + '/sell/create', { active: true, insert: true });
        return;
      }
      setM({ ...m, ts: Date.now() });
      GM_openInTab(t.plat === 'f' ? 'https://paypayfleamarket-sec.yahoo.co.jp/item/add' : 'https://auctions.yahoo.co.jp/sell/jp/show/submit', { active: true, insert: true });
    }

    // 关掉（或刷新）发起出品的商品页 = 停止这次多平台出品，下次重新设置
    window.addEventListener('pagehide', () => {
      const m = getM();
      if (m && m.owner === TAB_ID && (m.phase === 'run' || m.phase === 'wait')) setM({ ...m, phase: 'stopped', msg: '商品页已关闭' });
    });
    let counting = false;
    GM_addValueChangeListener(MKEY, async (_k, _o, m) => {
      if (!m || m.itemUrl !== location.href || (m.owner && m.owner !== TAB_ID)) return;
      if (m.phase === 'error') return toast('出错停止：' + m.msg, '#c00');
      if (m.phase === 'stopped') return toast('已停止', '#555');
      if (m.phase === 'done') return toast(m.msg || '全部完成', '#090');
      if (m.phase === 'wait' && !counting) {
        counting = true;
        try {
          const prev = m.tasks[m.i];
          if (m.i + 1 >= m.tasks.length) {
            if (!m.dry && m.nextNo.prefix) GM_setValue(m.memKey, m.nextNo);
            setM({ ...m, phase: 'done', msg: m.dry ? '试运行完成（都没有出品）' : `全部完成，共 ${m.tasks.length} 件` });
            return;
          }
          const next = m.tasks[m.i + 1];
          // 煤炉连续出品之间隔 20-60 秒；换到 Yahoo 或 Yahoo 之间（你手动点的）只隔几秒
          // 自动出品（煤炉，或勾了全自动的 Yahoo）之间用你设的间隔；半自动 Yahoo 和试运行只隔几秒
          const autoNext = next.plat === 'm' || next.auto;
          const g = m.gap || { min: BATCH_GAP_MIN, max: BATCH_GAP_MAX };
          const gap = (autoNext && !m.dry) ? rand(g.min, g.max) : rand(3, 6);
          for (let s = gap; s > 0; s--) {
            const cur = getM(); if (!cur || cur.phase !== 'wait') return;
            toast(`第 ${m.i + 1} 件完成，${s} 秒后做下一件（${PLAT[next.plat].name}）…`);
            await sleep(1000);
          }
          setM({ ...getM(), i: m.i + 1, phase: 'run' });
          fire();
        } finally { counting = false; }
      }
    });
  }

  // 目标页面共用：取当前多平台任务
  function curTask(plat) {
    const m = getM();
    if (!m || m.phase !== 'run' || !m.ts) return null;
    const ttl = plat === 'm' ? 3 * 60e3 : 60 * 60e3;   // 煤炉 3 分钟内、Yahoo 60 分钟内有效
    if (Date.now() - m.ts > ttl) return null;
    const t = m.tasks[m.i];
    if (!t || t.plat !== plat) return null;
    // 先到先得：同一件任务只让第一个打开的页面处理（同一标签页里翻页不算重复）
    let me; try { me = sessionStorage.mbrTab || (sessionStorage.mbrTab = Math.random().toString(36).slice(2)); } catch (e) { me = 'x'; }
    const key = m.ts + ':' + m.i;
    if (m.claim && m.claim.key === key && m.claim.tab !== me) {
      setM({ ...m, dupPage: (m.dupPage || 0) + 1 });
      toast('这是重复打开的页面，任务已由另一个页面处理，本页关闭', '#c00');
      closeSoon();
      return null;
    }
    if (!m.claim || m.claim.key !== key) setM({ ...m, claim: { key, tab: me } });
    return { m: getM(), t };
  }
  const taskDone = msg => { const m = getM(); if (m && m.phase === 'run') setM({ ...m, phase: 'wait', msg }); };
  const taskFail = msg => { const m = getM(); if (m && m.phase === 'run') setM({ ...m, phase: 'error', msg }); toast('出错：' + msg, '#c00'); };

  // 半自动页面顶部的黄色提示条
  function banner(html, onSkip) {
    let b = document.getElementById('mbr-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'mbr-banner';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483646;background:#ffe066;color:#222;font-size:16px;padding:12px 20px;box-shadow:0 2px 8px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center';
      document.body.appendChild(b);
    }
    b.innerHTML = `<div style="flex:1">${html}</div>
      <button id="mbr-skip" style="padding:6px 12px;border:1px solid #888;border-radius:6px;background:#fff;cursor:pointer">跳过这件</button>
      <button id="mbr-stopall" style="padding:6px 12px;border:none;border-radius:6px;background:#555;color:#fff;cursor:pointer">停止全部</button>`;
    b.querySelector('#mbr-skip').onclick = () => { taskDone('跳过'); toast('已跳过，关闭这页'); closeSoon(); };
    b.querySelector('#mbr-stopall').onclick = () => { const m = getM(); if (m) setM({ ...m, phase: 'stopped' }); b.remove(); };
  }

  // ============ 煤炉出品页（多平台 / 再出品 共用）：自己填表 ============
  async function sellPage() {
    const j = getJob();
    const mt = curTask('m');
    const relist = !mt && j && j.op === 'relist' && j.phase === 'filling' && j.ts && Date.now() - j.ts < 3 * 60e3 && j.src ? j : null;
    if (!mt && !relist) return;

    const fail = msg => {
      if (mt) taskFail(msg + '。这页留着，你可以手动补完出品');
      else if (getJob()?.phase === 'filling') { finishJob(false, msg); toast('出错：' + msg, '#c00'); }
    };
    const priceEl = () => document.querySelector('[data-testid="price-text-input"]');

    let title;
    if (mt) {
      const src = mt.m.src;
      title = mt.t.title;
      const err = await mercariFill(src, { title, price: mt.t.price, desc: mt.t.desc, cond: mt.t.cond, mship: mt.t.mship });
      if (err) return fail(err);
      if (mt.m.dry) {
        toast(`试运行：已全部填好（标题「${title}」），没有点出品。检查后手动关掉这页。`, '#06c');
        taskDone('试运行');
        return;
      }
    } else {
      const src = relist.src;
      title = src.raw;
      trace('出品页：开始自己填表');
      const err = await mercariFill(src, { title, price: src.price });
      if (err) return fail(err);
    }
    await sleep(rand(1500, 3000));

    // 出品按钮灰着就再“碰”一次价格，最多 3 轮
    let btn = null;
    for (let round = 0; round < 3 && !btn; round++) {
      btn = await waitFor(() => {
        const b = document.querySelector('[data-testid="list-item-button"]');
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, 7000);
      if (!btn) await touchSet(priceEl(), priceEl()?.value || '');
    }
    if (!btn) {
      const empty = [];
      if (!priceEl()?.value) empty.push('价格');
      if (!document.querySelector('textarea[name="description"]')?.value) empty.push('说明');
      ['shippingPayer', 'shippingFromArea', 'shippingDuration'].forEach(n => {
        const s = document.querySelector(`select[name="${n}"]`);
        if (s && !s.value) empty.push({ shippingPayer: '运费负担', shippingFromArea: '发货地', shippingDuration: '发货天数' }[n]);
      });
      return fail('出品按钮一直不可用' + (empty.length ? '，空着的：' + empty.join('、') : '') + '。这页留着，你可以手动补完出品');
    }
    btn.click();
    toast(`已点出品「${title}」，等待完成…`);

    for (let t = 0; t < 60; t++) {
      await sleep(1000);
      if (!/\/sell\/create/.test(path())) {
        if (mt) taskDone('煤炉出品成功');
        else { trace('出品页：出品成功'); setJob({ ...getJob(), phase: 'stop' }); }
        toast(`「${title}」出品成功`, '#090');
        closeSoon();
        return;
      }
    }
    fail(`「${title}」点了出品但60秒没成功，可能有必填项报错，请看这页`);
  }

  // ============ Yahoo!フリマ 出品页（半自动） ============
  async function fleaPage() {
    const ct = curTask('f');
    if (!ct) return;
    const { m, t } = ct;
    const titleEl = () => document.querySelector('input[placeholder^="商品名"]');
    const priceEl = () => document.querySelector('input[type="tel"]');
    const descEl = () => document.querySelector('textarea');
    const photoCount = () => [...document.querySelectorAll('img')].filter(i => /blob:|data:image|\/item|upload|image\.paypayfleamarket|auctions\.c\.yimg|static\.mercdn/.test(i.src) && i.naturalWidth > 40).length;

    // ---- 自己填表（不靠插件）----
    const src = m.src;
    const sayF = x => toast(x, '#f60');
    const visF = e => { if (!e || e.getBoundingClientRect().height <= 0) return false; for (let x = e; x && x !== document.body; x = x.parentElement) { const cs = getComputedStyle(x); if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') return false; } return true; };
    if (!await waitFor(() => titleEl() && priceEl(), 30000)) return banner('<b style="color:#c00">Yahoo!フリマ 出品页没打开</b>');
    await sleep(1500);
    // 1. 图片：模拟把图片拖进拖放区
    if (photoCount() === 0) {
      sayF('下载图片…');
      const files = await downloadImages(src, sayF);
      if (!files.length) return banner('<b style="color:#c00">图片下载失败</b>，请手动加图片');
      const zone = [...document.querySelectorAll('div')].filter(e => /ドラッグ/.test(e.textContent)).sort((x, y) => x.textContent.length - y.textContent.length)[1];
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      for (const type of ['dragenter', 'dragover', 'drop']) { zone?.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })); await sleep(200); }
      sayF('上传图片…');
      await waitFor(() => photoCount() >= files.length, 40000);
    }
    // 2. 说明、发货天数、发货地
    await touchSet(descEl(), t.desc != null ? t.desc : src.desc);
    const setSelF = (name, val) => { const el = document.querySelector(`select[name="${name}"]`); if (!el || !val) return; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, val); el.dispatchEvent(new Event('change', { bubbles: true })); };
    setSelF('timeToShip', { '1': 'ONE_TO_TWO_DAYS', '2': 'TWO_TO_THREE_DAYS', '4': 'THREE_TO_SEVEN_DAYS' }[(src.days || '1')[0]] || 'ONE_TO_TWO_DAYS');
    { const el = document.querySelector('select[name="prefectures"]'); const o = el && [...el.options].find(x => x.text.trim() === src.area); if (o) setSelF('prefectures', o.value); }
    // 3. 商品状态（煤炉「新品、未使用」= 这边的「未使用」）
    const condF = (t.cond || src.cond || '') === '新品、未使用' ? '未使用' : (t.cond || src.cond || '');
    if (condF) {
      const lab = [...document.querySelectorAll('span,p')].find(e => e.textContent.trim() === '商品の状態' && visF(e));
      const entry = lab && [...document.querySelectorAll('p')].find(p => p.textContent.trim() === '選択してください（必須）' && visF(p) && (lab.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (entry) {
        entry.parentElement.click();
        const op = await waitFor(() => [...document.querySelectorAll('p')].find(x => visF(x) && x.textContent.trim() === condF), 10000);
        if (op) { (op.closest('div[class]') || op.parentElement).click(); await sleep(1200); }
      }
    }
    // 4. 标题、价格
    await touchSet(titleEl(), t.title);
    if (t.price) await touchSet(priceEl(), t.price);

    // 自动选类别：スポーツ > 卓球 > 子类别
    const fcat = t.cat || m.cat?.flea || '';
    // ラケット 下面还要再选一层：标题里有「ペン」就选ペンホルダー，否则シェークハンド（跟ヤフオク同一个规则）
    const fsub = fcat === 'ラケット' ? (t.fsub || null) ?? (/ペン/.test(t.title) ? 'ペンホルダー' : 'シェークハンド')
      // バッグ、ケース 下面也分一层：按标题里的字判断
      // ウエア 下面也分一层
      : fcat === 'ウエア' ? (/パンツ|ショーツ|短パン/.test(t.title) ? 'パンツ' : /ソックス|靴下/.test(t.title) ? 'ソックス' : /ジャージ|ウォームアップ|ジャケット|パーカー/.test(t.title) ? 'ウォームアップウエア' : 'シャツ')
      : fcat === 'バッグ、ケース' ? (/シューズ/.test(t.title) ? 'シューズケース' : /ボール/.test(t.title) ? 'ボールケース' : /ラケット/.test(t.title) ? 'ラケットケース' : 'その他バッグ、ケース')
      : '';
    const fleaf = fsub || fcat;
    const target = 'スポーツ > 卓球 > ' + fcat + (fsub ? ' > ' + fsub : '');
    // 选好后，类别栏会完整显示「スポーツ > 卓球 > ラバー」
    // 页面显示的是「スポーツ > 卓球 >ラバー」（最后一个 > 后没空格），所以比较时去掉所有空格
    const catIsSet = () => !!fcat && [...document.querySelectorAll('div,p,span,a,button')].some(e =>
      e.textContent.replace(/\s+/g, '') === target.replace(/\s+/g, '') && e.getBoundingClientRect().height > 0 && !e.closest('li'));
    // 真正显示出来才算：弹窗关着时仍在页面上，只是外层透明（opacity 0），所以要连外层一起看
    const vis = e => {
      if (!e || e.getBoundingClientRect().height <= 0) return false;
      for (let x = e; x && x !== document.body; x = x.parentElement) {
        const cs = getComputedStyle(x);
        if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') return false;
      }
      return true;
    };
    const visLi = name => [...document.querySelectorAll('li')].find(e => e.textContent.trim() === name && vis(e));
    const visBtn = name => [...document.querySelectorAll('button')].find(e => e.textContent.trim() === name && vis(e));
    const want = target.replace(/\s+/g, '');                       // スポーツ>卓球>ラバー
    // 选好后类别栏显示「スポーツ > 卓球 >ラバー」
    // 推荐弹窗（填完标题 Yahoo 会自己弹出来）里也有「スポーツ > 卓球 > ラバー」这行字，弹窗开着时不能算已选
    const sugRow = () => [...document.querySelectorAll('div')].find(e => vis(e) && e.textContent.replace(/\s+/g, '') === want + fleaf);
    const sugOpen = () => [...document.querySelectorAll('*')].some(e => e.childElementCount === 0 && vis(e) && e.textContent.trim() === 'カテゴリはこちらですか');
    const catIsSet2 = () => !!fcat && !sugOpen() && [...document.querySelectorAll('div,p')].some(e => vis(e) && e.textContent.replace(/\s+/g, '') === want);
    // 类别栏入口：显示「選択してください（必須）」的 p，点它的父元素（带点击事件）
    const catEntry = () => [...document.querySelectorAll('p,span,div')].find(e =>
      e.childElementCount === 0 && e.textContent.trim() === '選択してください（必須）' && vis(e));
    let catOk = catIsSet2();
    for (let attempt = 0; attempt < 3 && fcat && !catOk; attempt++) {
      try {
        toast(`选类别「${target}」…（第 ${attempt + 1} 次）`, '#f60');
        // 推荐弹窗已经自己弹出来了就直接处理，否则点类别栏打开
        if (!sugOpen()) {
          const f = catEntry();
          if (!f) break;
          f.parentElement.click();
        }
        // 标题已填时弹出「カテゴリはこちらですか」推荐列表；没有推荐时是分类树。最多等 15 秒
        const opened = await waitFor(() => sugRow() || sugOpen() || visLi('スポーツ') || visBtn('カテゴリ一覧'), 15000);
        if (!opened) throw new Error('类别弹窗没打开');
        if (sugRow() || sugOpen()) {
          const row = await waitFor(sugRow, 3000);
          if (row) {
            row.click();
            catOk = !!(await waitFor(catIsSet2, 8000));
            if (catOk) break;
          }
          const other = visBtn('他のカテゴリから選ぶ');
          if (!other) throw new Error('推荐里没有，也没找到「他のカテゴリから選ぶ」');
          other.click();
          await waitFor(() => visLi('スポーツ') || visBtn('カテゴリ一覧'), 15000);
        }
        if (!visLi('スポーツ') && visBtn('カテゴリ一覧')) { visBtn('カテゴリ一覧').click(); await waitFor(() => visLi('スポーツ'), 8000); }
        for (const name of ['スポーツ', '卓球', fcat, fsub].filter(Boolean)) {
          const li = await waitFor(() => visLi(name), 15000);
          if (!li) throw new Error('没找到类别 ' + name);
          li.click();
          await sleep(1500);
        }
        catOk = !!(await waitFor(catIsSet2, 8000));
      } catch (e) { catOk = false; await sleep(1000); }
    }

    // 像真人一样重新输入价格，让按钮重新判断
    const listBtn = () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '出品する');
    const btnOn = () => { const b = listBtn(); return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'; };
    for (let round = 0; round < (catOk ? 3 : 1) && !btnOn(); round++) {
      await typeLikeHuman(priceEl(), t.price || priceEl()?.value || '');
      await sleep(1000);
    }
    // 配送方法：点对应的选项（日本郵便 / ヤマト運輸）
    const fship = t.fship || 'JAPAN_POST';
    const setFleaShip = () => {
      const r = document.querySelector(`input[type=radio][name="${fship}"]`);
      if (r && !r.checked) r.click();
      return !!r && r.checked;
    };
    setFleaShip();
    await sleep(800);

    // 出提示前再核对一遍：标题、类别、配送被插件覆盖了就重新填
    if (titleEl() && titleEl().value !== t.title) { await touchSet(titleEl(), t.title); }
    const fshipOk = setFleaShip();
    if (fcat && !catIsSet2()) catOk = false;
    const emp = btnOn() ? [] : emptyRequired();

    let tip = m.dry
      ? `<b>试运行</b>（Yahoo!フリマ）：标题「${t.title}」价格 ${t.price}。检查完<b>不要出品</b>，点「跳过这件」继续。`
      : `<b>Yahoo!フリマ</b> ${m.i + 1}/${m.tasks.length}：标题、价格已填${catOk ? '，类别已选「卓球 > ' + fcat + (fsub ? ' > ' + fsub : '') + '」' + (fshipOk ? '，<b style="color:#c00">配送「' + FLEA_SHIPS[fship] + '」请核对</b>' : '') : '，<b style="color:#c00">类别没选上，请手动选（' + (fcat ? target : 'スポーツ > 卓球 > …') + '）</b>'}。
         ${btnOn() ? '请检查一下，没问题就点页面最下面的「<b>出品する</b>」。'
                   : `<b style="color:#c00">出品按钮还是灰的</b>${emp.length ? '，看起来没填：' + emp.join('、') : ''}。可以点「再试一次」，或手动改一下价格再点空白处。`}`;
    // 全自动：标题、类别、配送都对，按钮也亮，就自己点出品
    if (t.auto && !m.dry && btnOn() && catOk && fshipOk && titleEl()?.value === t.title) {
      banner(`<b>Yahoo!フリマ 全自动</b> ${m.i + 1}/${m.tasks.length}：检查无误，${'几秒后'}自动点「出品する」…`);
      await sleep(rand(2000, 4000));
      if (btnOn() && getM()?.phase === 'run') { listBtn().click(); toast('已自动点出品，等待完成…', '#090'); }
    } else {
      if (t.auto && !m.dry) tip = '<b style="color:#c00">全自动检查没通过，退回半自动。</b> ' + tip;
      banner(tip);
    }
    // 「再试一次」：重新像真人一样输入价格
    const bb = document.getElementById('mbr-banner');
    if (bb && !m.dry) {
      const retry = document.createElement('button');
      retry.textContent = '再试一次';
      retry.style.cssText = 'padding:6px 12px;border:none;border-radius:6px;background:#06c;color:#fff;cursor:pointer';
      retry.onclick = async () => {
        await typeLikeHuman(priceEl(), t.price || priceEl()?.value || '');
        await sleep(800);
        const e2 = btnOn() ? [] : emptyRequired();
        retry.textContent = btnOn() ? '按钮已亮 ✓' : '还是灰' + (e2.length ? '：' + e2.join('、') : '');
      };
      bb.insertBefore(retry, bb.querySelector('#mbr-skip'));
    }
    toast(catOk ? '已填好，等你确认出品' : '请选类别后出品', '#f60');

    // 等你点出品：离开 /item/add 视为成功
    const start = location.href;
    const done = await waitFor(() => location.href !== start || /出品が完了|出品しました/.test(document.body.innerText.slice(0, 3000)), 3600 * 1000, 1000);
    if (done) { taskDone('Yahoo!フリマ 出品成功'); document.getElementById('mbr-banner')?.remove(); toast('出品成功', '#090'); closeSoon(); }
  }

  // ============ ヤフオク 出品页（半自动） ============
  async function aucPage() {
    const ct = curTask('a');
    if (!ct) return;
    const { m, t } = ct;
    const p = location.pathname;
    const want = AUC_CATS[t.cat] || AUC_CATS[m.cat?.auc] || '';   // 例：'卓球 > ラバー'

    // 完成页
    if (/完了/.test(document.title) || /出品が完了|出品しました/.test(document.body.innerText.slice(0, 3000))) {
      taskDone('ヤフオク 出品成功');
      toast('ヤフオク 出品成功', '#090');
      closeSoon();
      return;
    }

    // 类别选择页：在单选列表里找到要的类别，勾上，点「このカテゴリに出品」
    if (/topsubmit|category/i.test(p + location.search) || /カテゴリ選択/.test(document.title)) {
      if (!want) return;
      const wantId = AUC_CAT_IDS[t.cat] || AUC_CAT_IDS[m.cat?.auc] || '';
      const rowText = r => { let el = r; while (el && el.textContent.replace(/\s+/g, '').length < 10) el = el.parentElement; return (el?.textContent || '').normalize('NFKC').replace(/\s+/g, ' ').trim(); };
      const findRadio = () => {
        const radios = [...document.querySelectorAll('input[type=radio][name="category"]')];
        // 先按类别编号找，找不到再按文字找
        return radios.find(r => wantId && r.value === wantId) || radios.find(r => {
          const row = rowText(r), i = row.indexOf(want);
          if (i < 0) return false;
          const after = row.slice(i + want.length).trim();
          return after === '' || after.startsWith('(');   // 防止匹配到更深一层
        });
      };
      let r = await waitFor(findRadio, 6000);
      if (!r) {
        // 搜索结果里没有，就去「履歴から選択する」
        const tab = [...document.querySelectorAll('a,li,span,div')].find(e => e.childElementCount === 0 && e.textContent.trim() === '履歴から選択する');
        if (tab) { (tab.closest('a,li') || tab).click(); await sleep(1500); r = await waitFor(findRadio, 8000); }
      }
      if (!r) { banner(`<b>ヤフオク 类别</b>：没自动找到「${want}」，请手动选，然后点「このカテゴリに出品」。`); return; }
      r.click();
      await sleep(rand(600, 1200));
      const go = await waitFor(() => [...document.querySelectorAll('input[type=submit],input[type=button],button,a')].find(b => /このカテゴリに出品/.test(b.value || b.textContent) && !b.disabled), 5000);
      if (go) { toast(`已选类别「${want}」`, '#090'); go.click(); }
      else banner(`<b>ヤフオク 类别</b>：已勾「${want}」，请点「このカテゴリに出品」。`);
      return;
    }

    // 确认页
    if (/確認/.test(document.title) && !/submit$/.test(p)) {
      if (t.auto && !m.dry) {
        banner(`<b>ヤフオク 全自动</b>（确认页）：自动点「出品する」…`);
        await sleep(rand(2000, 4000));
        const go = [...document.querySelectorAll('button,input[type=submit],input[type=button],a')]
          .find(b => /出品する/.test(b.value || b.textContent) && !/修正/.test(b.value || b.textContent) && !b.disabled);
        if (go && getM()?.phase === 'run') { go.click(); return; }
      }
      banner(m.dry
        ? '<b>试运行</b>（ヤフオク 确认页）：<b>不要点出品</b>，点「跳过这件」继续。'
        : '<b>ヤフオク 确认页</b>：内容没问题就点「<b>出品する</b>」。');
      return;   // 点了出品会跳到完成页，那边再处理
    }

    // 输入页
    if (!/\/sell\/jp\/show\/submit/.test(p)) return;
    const titleEl = () => document.getElementById('fleaTitleForm') || document.querySelector('input[name="Title"]');
    const priceEl = () => document.getElementById('auc_BidOrBuyPrice_buynow') || document.querySelector('input[name="BidOrBuyPrice"]');
    const catVal = () => document.querySelector('input[name="category"]')?.value;
    const imgCount = () => [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 40 && /auctions|yimg|blob:|data:image/.test(i.src) && i.closest('form')).length;

    if (!await waitFor(() => titleEl() && document.getElementById('acMdCateChange'), 30000)) return;
    await sleep(1500);

    // 先选类别（空白页直接去类别页，选完回来这个函数会再跑一次，再填内容）
    if ((!catVal() || catVal() === '0') && want && !sessionStorage.getItem('mbr_auc_cat_tried_' + m.ts)) {
      sessionStorage.setItem('mbr_auc_cat_tried_' + m.ts, '1');
      toast(`先去选类别「${want}」…`, '#c90');
      await sleep(800);
      document.getElementById('acMdCateChange').click();
      return;
    }

    // ---- 自己填表（不靠插件）----
    const src = m.src;
    const sayA = x => toast(x, '#c90');
    // 1. 图片：放进上传框
    if (!document.getElementById('auc_image_fullpath1')?.value) {
      sayA('下载图片…');
      const files = await downloadImages(src, sayA);
      const inp = document.getElementById('selectFileMultiple');
      if (files.length && inp) {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        sayA('上传图片…');
        await waitFor(() => document.getElementById('auc_image_fullpath' + files.length)?.value, 40000);
      }
    }
    // 2. 说明：写进编辑器（iframe），隐藏字段也写上
    {
      const text = t.desc != null ? t.desc : src.desc;
      const html = text.split('\n').map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>');
      const fr = document.getElementById('rteEditorComposition0');
      if (fr?.contentDocument?.body) {
        fr.contentDocument.body.innerHTML = html;
        fr.contentDocument.body.dispatchEvent(new Event('input', { bubbles: true }));
        fr.contentDocument.body.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      }
      const hid = document.querySelector('input[name="Description"]');
      if (hid) hid.value = html;
    }
    // 3. 状态、发货地、运费负担、发货天数
    const setSelA = (sel, val) => { const el = document.querySelector(sel); if (!el || val == null) return; el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); };
    const IST = { '新品、未使用': 'new', '未使用に近い': 'used10', '目立った傷や汚れなし': 'used20', 'やや傷や汚れあり': 'used40', '傷や汚れあり': 'used60', '全体的に状態が悪い': 'used80' };
    setSelA('select[name="istatus"]', IST[t.cond || src.cond] || 'new');
    { const el = document.querySelector('select[name="loc_cd"]'); const o = el && [...el.options].find(x => x.text.trim() === src.area); if (o) setSelA('select[name="loc_cd"]', o.value); }
    setSelA('#auc_shipping_who', /着払い/.test(src.payer || '') ? 'buyer' : 'seller');
    setSelA('select[name="shipschedule"]', { '1': '1', '2': '7', '4': '2' }[(src.days || '1')[0]] || '1');
    // 4. 标题、价格
    await touchSet(titleEl(), t.title);
    if (t.price && priceEl()) await touchSet(priceEl(), t.price);

    // 配送方法：按弹窗里选的勾上（其他已勾的保留）
    let shipTxt = '';
    const shipId = t.ship || m.cat?.ship;
    const cb = shipId && document.getElementById(shipId);
    if (cb) {
      if (!cb.checked) cb.click();
      shipTxt = (cb.closest('label,li,div')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    }

    // 结束日期：选最晚的一天，小时不动
    const ymd = document.getElementById('ClosingYMD') || document.querySelector('select[name="ClosingYMD"]');
    let endTxt = '';
    if (ymd && ymd.options.length) {
      const last = ymd.options[ymd.options.length - 1];
      if (ymd.value !== last.value) {
        ymd.value = last.value;
        ymd.dispatchEvent(new Event('change', { bubbles: true }));
      }
      endTxt = last.textContent.trim();
    }

    // 清空「メーカー・ブランド」（会被自动填上不对的品牌，而且填得很慢）
    const brandFilled = () => !!(document.getElementById('brand_line_text')?.value || document.getElementById('brand_line_id')?.value);
    const clearBrand = () => {
      ['brand_line_text', 'series_line_text_1'].forEach(id => { const e = document.getElementById(id); if (e && e.value) nativeSet(e, ''); });
      ['brand_line_id', 'brand_line_id_1', 'brand_line_id_2'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
    };
    toast('等品牌栏填完再清空…', '#c90');
    await waitFor(brandFilled, 8000);           // 最多等 8 秒让它填进来，没填就直接往下走
    let brandCleared = false;
    if (brandFilled()) {
      for (let k = 0; k < 3; k++) {             // 清完 3 秒后再看，又被填回来就再清
        if (brandFilled()) { clearBrand(); brandCleared = true; }
        await sleep(3000);
      }
    }

    // 插件填得慢，可能把前面勾的配送清掉：这里再确认一次
    const shipIds = Object.keys(AUC_SHIPS);
    if (shipId) {
      for (const id of shipIds) {
        const c = document.getElementById(id);
        if (!c) continue;
        if (id === shipId && !c.checked) c.click();
        if (id !== shipId && c.checked) c.click();
      }
      const c = document.getElementById(shipId);
      shipTxt = c && c.checked ? AUC_SHIPS[shipId] : '';
    }

    const catOk = catVal() && catVal() !== '0';
    banner(m.dry
      ? `<b>试运行</b>（ヤフオク）：标题「${t.title}」价格 ${t.price}。检查完<b>不要出品</b>，点「跳过这件」继续。`
      : `<b>ヤフオク</b> ${m.i + 1}/${m.tasks.length}：标题、价格已填${catOk ? '，类别已选' : '，<b style="color:#c00">类别没选上，请点「選択する」</b>'}${shipTxt ? '，<b style="color:#c00">配送「' + shipTxt + '」请核对</b>' : '，<b style="color:#c00">配送没勾上，请手动勾</b>'}${endTxt ? '，结束 ' + endTxt : ''}${brandCleared ? '，品牌已清空' : ''}。
         检查后点「<b>確認する</b>」，再在确认页点「<b>出品する</b>」。`);
    toast('等你确认', '#c90');
    // 全自动：类别、配送、标题都对，就点「確認する」
    if (t.auto && !m.dry && catOk && shipTxt && titleEl()?.value === t.title) {
      banner(`<b>ヤフオク 全自动</b> ${m.i + 1}/${m.tasks.length}：检查无误，自动点「確認する」…`);
      await sleep(rand(2000, 4000));
      const go = document.getElementById('submit_form_btn');
      if (go && getM()?.phase === 'run') go.click();
    } else if (t.auto && !m.dry) {
      toast('全自动检查没通过，退回半自动，请看提示条', '#c00');
    }
  }

  // ============ 管理面板 ============
  const DB = 'mbr_items';           // { items: [...], at: timestamp }
  const QUEUE = 'mbr_queue';        // { op, ids:[], i, running, log:[] }

  function ageDays(txt) {
    const dm = (txt || '').match(/(\d{4})[\/年.-](\d{1,2})[\/月.-](\d{1,2})/);
    if (dm) return Math.floor((Date.now() - new Date(+dm[1], dm[2] - 1, +dm[3])) / 864e5);
    if (/半年以上前/.test(txt || '')) return 180;   // 煤炉超过半年不再显示数字
    const m = (txt || '').match(/(\d+)\s*(分|時間|日|か月|ヶ月|年)(以上)?前/);
    if (!m) return null;
    const n = +m[1];
    return { '分': 0, '時間': 0, '日': n, 'か月': n * 30, 'ヶ月': n * 30, '年': n * 365 }[m[2]];
  }

  async function loadAllIn(url, onProgress, maxRows = Infinity) {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:-5000px;top:0;width:1200px;height:900px';
    f.src = url;
    document.body.appendChild(f);
    await new Promise(r => f.onload = r);
    const d = () => f.contentDocument;
    await waitFor(() => d().querySelector('a[href*="/item/"], a[href*="/transaction/"]'), 20000);
    let prev = -1, same = 0;
    for (let k = 0; k < 400; k++) {
      const n = d().querySelectorAll('a[href*="/item/"], a[href*="/transaction/"]').length;
      onProgress(n);
      const more = btnByText(/もっと見る/, d());
      if (more) { more.click(); same = 0; }
      if (n === prev) same++; else same = 0;
      prev = n;
      if (!more && same >= 3) break;
      if (n >= maxRows) break;
      await sleep(1200);
    }
    const links = [...d().querySelectorAll('a[href*="/item/"], a[href*="/transaction/"]')];
    const rows = links.map(a => {
      const lines = a.innerText.split('\n').map(s => s.trim()).filter(Boolean);
      const txt = lines.join(' ');
      const id = a.href.split('/').filter(Boolean).pop().split('?')[0];
      const nums = txt.match(/ (\d+) (\d+) (\d+) /) || [];
      const price = (txt.match(/¥\s*([\d,]+)/) || [])[1];
      const upd = (txt.match(/半年以上前|\d+\s*(分|時間|日|か月|ヶ月|年)(以上)?前|\d{4}[\/年.-]\d{1,2}[\/月.-]\d{1,2}日?/) || [''])[0];
      const img = a.querySelector('img');
      return {
        id, title: lines[0] || '',
        status: /\/transaction\//.test(a.href) ? 'sold' : (/公開停止中/.test(txt) ? 'stopped' : 'public'),
        likes: nums[1] ? +nums[1] : null, comments: nums[2] ? +nums[2] : null, views: nums[3] ? +nums[3] : null,
        price: price ? +price.replace(/,/g, '') : null,
        upd, days: ageDays(upd), thumb: img ? img.src : '',
      };
    });
    f.remove();
    return rows;
  }

  function openPanel() {
    if (document.getElementById('mbr-panel')) return;
    const P = document.createElement('div');
    P.id = 'mbr-panel';
    P.style.cssText = 'position:fixed;inset:0;z-index:2147483640;background:#fff;color:#222;font-size:16px;display:flex;flex-direction:column;font-family:sans-serif';
    const ip = 'padding:6px 8px;border:1px solid #bbb;border-radius:6px;font-size:16px';
    const bt = (bg = '#fff', fg = '#222') => `padding:7px 14px;border:1px solid #bbb;border-radius:6px;background:${bg};color:${fg};cursor:pointer;font-size:15px`;
    P.innerHTML = `
      <style>
        #mbr-panel input[type=checkbox]{width:20px;height:20px;vertical-align:middle;cursor:pointer}
        #mbr-panel label{cursor:pointer}
        #mbr-panel tbody tr{cursor:pointer}
        #mbr-panel tbody tr:hover{background:#f5f8ff}
        #mbr-panel tbody tr.on{background:#ffe9a8 !important;outline:2px solid #f0b400;outline-offset:-2px}
        #mbr-panel th.sort{cursor:pointer;user-select:none;color:#06c}
        #mbr-panel th{padding:8px;font-size:15px}
      </style>
      <div style="display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid #ddd;flex-wrap:wrap">
        <b style="font-size:15px">メルカリ助手</b>
        <button id="mp-quick" style="${bt('#06c', '#fff')}">快速刷新（最近300条）</button>
        <button id="mp-scan" style="${bt()}">全量抓取（约15-20分钟）</button>
        <span id="mp-at" style="color:#666"></span>
        <span id="mp-stale" style="display:none;background:#e00;color:#fff;font-weight:bold;padding:3px 10px;border-radius:4px"></span>
        <span style="flex:1"></span>
        <button id="mp-close" style="${bt()}">关闭</button>
      </div>
      <div style="display:flex;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid #eee;flex-wrap:wrap">
        <input id="mp-kw" placeholder="标题关键词" style="${ip};width:180px">
        <label><input type="checkbox" class="mp-st" value="public" checked> 出品中</label>
        <label><input type="checkbox" class="mp-st" value="stopped" checked> 停止中</label>
        <label><input type="checkbox" class="mp-st" value="sold"> 已售出</label>
        <label title="煤炉显示的最后更新时间，不是出品日期">最后更新 ≥ <input id="mp-days" type="number" min="0" style="${ip};width:60px"> 天前</label>
        <label><input type="checkbox" id="mp-dup"> 只看重复</label>
        <span id="mp-count" style="color:#666"></span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid #eee;flex-wrap:wrap">
        <label><input type="checkbox" id="mp-all"> 全选（当前筛选）</label> <button id="mp-add50" title="从最后勾选的那件的下一件开始，往下再勾 50 件" style="padding:3px 10px;border:1px solid #888;border-radius:4px;background:#fff;cursor:pointer">+50</button>
        <span id="mp-sel">已选 0</span>
        <button id="mp-relist" style="${bt('#e33', '#fff')}">批量再出品（停旧）</button>
        <button id="mp-delstop" style="${bt('#555', '#fff')}">删除停止中</button>
        <button id="mp-delsold" style="${bt('#555', '#fff')}">删除已售出</button>
        <span style="flex:1"></span>
        <span id="mp-q" style="color:#06c"></span>
        <button id="mp-qstop" style="${bt()}">暂停队列</button>
        <button id="mp-qgo" style="${bt()}">继续队列</button>
      </div>
      <div style="display:flex;flex:1;min-height:0">
        <div id="mp-list" style="flex:1;overflow:auto"></div>
        <div id="mp-log" style="width:340px;border-left:1px solid #ddd;overflow:auto;padding:8px 10px;font-size:14px;line-height:1.5;white-space:pre-wrap;background:#fafafa"></div>
      </div>`;
    document.body.appendChild(P);
    const $ = id => P.querySelector('#' + id);
    const selected = new Set();
    let view = [];
    let sortKey = null, sortDir = 1;   // null = 抓取顺序（更新新→旧）

    const data = () => GM_getValue(DB, { items: [], at: 0 });

    function render() {
      const { items, at } = data();
      const mins = at ? Math.floor((Date.now() - at) / 60e3) : 0;
      const st = $('mp-stale');
      if (at && mins >= 10) { st.style.display = ''; st.textContent = `⚠ 数据是 ${mins >= 120 ? Math.floor(mins / 60) + ' 小时' : mins + ' 分钟'}前的，建议重新抓取`; }
      else st.style.display = 'none';
      $('mp-at').textContent = at ? `共 ${items.length} 条（${new Date(at).toLocaleString()} 抓取）` : '还没有抓取';
      const kw = norm($('mp-kw').value).toLowerCase();
      const sts = [...P.querySelectorAll('.mp-st:checked')].map(c => c.value);
      const days = parseInt($('mp-days').value, 10);
      const groups = {};
      items.forEach(r => { const k = baseTitle(r.title); groups[k] = (groups[k] || 0) + 1; });
      view = items.filter(r =>
        sts.includes(r.status) &&
        (!kw || norm(r.title).toLowerCase().includes(kw)) &&
        (isNaN(days) || (r.days != null && r.days >= days)) &&
        (!$('mp-dup').checked || groups[baseTitle(r.title)] > 1));
      $('mp-count').textContent = `显示 ${view.length} 条`;
      if (sortKey) {
        const idx = new Map(items.map((r, i) => [r.id, i]));
        const val = r => sortKey === 'upd' ? (r.days ?? 99999) : r[sortKey];
        view = [...view].sort((a, b) => {
          const va = val(a), vb = val(b);
          if (va == null && vb == null) return idx.get(a.id) - idx.get(b.id);
          if (va == null) return 1;
          if (vb == null) return -1;
          return (va - vb) * sortDir || (idx.get(a.id) - idx.get(b.id)) * sortDir;
        });
      }
      const label = { public: '<span style="color:#090">出品中</span>', stopped: '<span style="color:#c60">停止中</span>', sold: '<span style="color:#888">已售出</span>' };
      const td = 'padding:8px 10px';
      const rowsHtml = view.slice(0, 3000).map(r => `
        <tr data-id="${r.id}" class="${selected.has(r.id) ? 'on' : ''}" style="border-bottom:1px solid #eee">
          <td style="${td}"><input type="checkbox" class="mp-ck" ${selected.has(r.id) ? 'checked' : ''}></td>
          <td style="padding:4px"><img src="https://static.mercdn.net/thumb/item/webp/${r.id}_1.jpg" loading="lazy" referrerpolicy="no-referrer" style="width:60px;height:60px;object-fit:cover;border-radius:6px;display:block"></td>
          <td style="${td}"><a href="/${r.status === 'sold' ? 'transaction' : 'item'}/${r.id}" target="_blank" style="color:#222;text-decoration:none">${r.title.replace(/</g, '&lt;')}</a></td>
          <td style="${td};white-space:nowrap;font-weight:bold">${label[r.status]}</td>
          <td style="${td};text-align:right">${r.price != null ? '¥' + r.price.toLocaleString() : ''}</td>
          <td style="${td};text-align:right">${r.views ?? ''}</td>
          <td style="${td};text-align:right">${r.likes ?? ''}</td>
          <td style="${td};white-space:nowrap;color:#555">${r.upd}</td>
        </tr>`).join('');
      const arrow = k => sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : ' ⇅';
      $('mp-list').innerHTML = `<table style="width:100%;border-collapse:collapse">
        <thead style="position:sticky;top:0;background:#f0f0f0;z-index:1"><tr>
          <th></th><th></th><th style="text-align:left">标题</th><th>状态</th>
          <th class="sort" data-k="price">价格${arrow('price')}</th>
          <th class="sort" data-k="views">浏览${arrow('views')}</th>
          <th class="sort" data-k="likes">赞${arrow('likes')}</th>
          <th class="sort" data-k="upd" title="煤炉显示的最后更新时间（改价、编辑、再出品都会刷新），不是出品日期">最后更新${sortKey === 'upd' ? (sortDir < 0 ? ' ▼ 旧→新' : ' ▲ 新→旧') : ' ⇅'}</th>
        </tr></thead><tbody>${rowsHtml}</tbody></table>`;
      updSel();
    }

    // 点表头排序：第一次升序（更新=最旧的在前），再点降序，第三次恢复原顺序
    $('mp-list').addEventListener('click', e => {
      const th = e.target.closest('th.sort');
      if (th) {
        const k = th.dataset.k;
        if (sortKey !== k) { sortKey = k; sortDir = k === 'upd' ? -1 : 1; }
        else if (sortDir === (k === 'upd' ? -1 : 1)) sortDir = -sortDir;
        else sortKey = null;
        render();
        return;
      }
      // 点整行任意位置 = 勾选/取消（点标题链接除外）
      const tr = e.target.closest('tbody tr');
      if (!tr || e.target.closest('a') || e.target.classList.contains('mp-ck')) return;
      const ck = tr.querySelector('.mp-ck');
      ck.checked = !ck.checked;
      ck.dispatchEvent(new Event('change', { bubbles: true }));
    });
    function updSel() { $('mp-sel').textContent = `已选 ${selected.size}`; }

    $('mp-list').addEventListener('change', e => {
      if (!e.target.classList.contains('mp-ck')) return;
      const id = e.target.closest('tr').dataset.id;
      e.target.checked ? selected.add(id) : selected.delete(id);
      e.target.closest('tr').classList.toggle('on', e.target.checked);
      updSel();
    });
    // +50：从当前列表里最后勾选的那件的下一件开始，往下勾 50 件
    $('mp-add50').onclick = () => {
      let last = -1;
      view.forEach((r, i) => { if (selected.has(r.id)) last = i; });
      view.slice(last + 1, last + 51).forEach(r => selected.add(r.id));
      render();
    };
    $('mp-all').onchange = e => { view.forEach(r => e.target.checked ? selected.add(r.id) : selected.delete(r.id)); render(); };
    ['mp-kw', 'mp-days'].forEach(i => $(i).addEventListener('input', render));
    // 切换状态时清空勾选，避免之前在别的状态下勾的商品被一起操作
    P.querySelectorAll('.mp-st').forEach(c => c.addEventListener('change', () => { selected.clear(); render(); }));
    $('mp-dup').addEventListener('change', render);
    $('mp-close').onclick = () => P.remove();

    async function scan(full) {
      $('mp-scan').disabled = $('mp-quick').disabled = true;
      const max = full ? Infinity : 300;
      try {
        const a = await loadAllIn('/mypage/listings', n => $('mp-at').textContent = `抓取出品中/停止中… ${n}`, max);
        const b = await loadAllIn('/mypage/listings/completed', n => $('mp-at').textContent = `抓取已售出… ${n}`, max);
        const fresh = new Map();
        [...a, ...b].forEach(r => { if (!fresh.has(r.id)) fresh.set(r.id, r); });
        let items;
        if (full) items = [...fresh.values()];
        else {
          // 合并：新抓到的覆盖旧的，放在前面
          const old = data().items.filter(r => !fresh.has(r.id));
          items = [...fresh.values(), ...old];
        }
        GM_setValue(DB, { items, at: Date.now() });
        const c = s => items.filter(r => r.status === s).length;
        log(`${full ? '全量抓取' : '快速刷新'}完成：出品中 ${c('public')}，停止中 ${c('stopped')}，已售出 ${c('sold')}`);
      } catch (e) { log('抓取出错：' + e.message); }
      $('mp-scan').disabled = $('mp-quick').disabled = false;
      render();
    }
    $('mp-scan').onclick = () => scan(true);
    $('mp-quick').onclick = () => scan(false);

    // ---- 队列 ----
    const getQ = () => GM_getValue(QUEUE, null);
    const setQ = q => GM_setValue(QUEUE, q);
    function log(s) {
      const el = $('mp-log');
      el.textContent = `${new Date().toLocaleTimeString()} ${s}\n` + el.textContent;
    }
    function showQ() {
      const q = getQ();
      $('mp-q').textContent = q ? `${q.label}：${q.i}/${q.ids.length}${q.running ? '（运行中）' : '（已暂停）'}` : '';
    }

    function enqueue(op, label, filterFn) {
      const { items } = data();
      const map = Object.fromEntries(items.map(r => [r.id, r]));
      const ids = [...selected].filter(id => map[id] && filterFn(map[id]));
      const skipped = selected.size - ids.length;
      if (!ids.length) return alert('选中的商品里没有可以执行这个操作的。');
      const cur = getQ();
      if (cur && cur.running) return alert('还有队列在运行，先暂停或等它结束。');
      if (op === 'relist') {
        const mm = GM_getValue(MKEY, null);
        const busy = mm && (mm.phase === 'run' || mm.phase === 'wait') && mm.ts && Date.now() - mm.ts < 60 * 60e3 &&
          mm.tasks.slice(mm.i).some(t => t.plat === 'm');
        if (busy && !confirm('「多平台出品」正在往煤炉出品。\n两边都要打开煤炉出品页，同时跑可能把商品填错。\n建议等它结束。仍要开始吗？')) return;
      }
      const warn = op === 'relist' ? '' : '\n删除后不能恢复。';
      if (!confirm(`${label}：${ids.length} 件${skipped ? `（${skipped} 件不符合条件已跳过）` : ''}。${warn}\n确定开始？`)) return;
      setQ({ op, label, ids, i: 0, running: true, ok: 0, ng: 0 });
      log(`开始 ${label}，共 ${ids.length} 件`);
      runQueue();
    }
    $('mp-relist').onclick = () => enqueue('relist', '批量再出品', r => r.status === 'public' || r.status === 'stopped');
    $('mp-delstop').onclick = () => enqueue('del-stopped', '删除停止中', r => r.status === 'stopped');
    $('mp-delsold').onclick = () => enqueue('del-sold', '删除已售出', r => r.status === 'sold');
    $('mp-qstop').onclick = () => { const q = getQ(); if (q) { setQ({ ...q, running: false }); log('已暂停'); showQ(); } };
    $('mp-qgo').onclick = () => { const q = getQ(); if (q && q.i < q.ids.length) { setQ({ ...q, running: true }); log('继续'); runQueue(); } };

    // 在隐藏 iframe 里打开编辑页，看是「出品を再開」（停止中）还是「一時停止」（出品中）
    async function checkStatus(id) {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-5000px;top:0;width:1000px;height:800px';
      f.src = '/sell/edit/' + id + '?mbrcheck=1';
      document.body.appendChild(f);
      await new Promise(r => f.onload = r);
      const st = await waitFor(() => {
        const d = f.contentDocument; if (!d) return null;
        if (btnByText(/出品を再開/, d)) return 'stopped';
        if (btnByText(/一時停止|出品を停止/, d)) return 'public';
        return null;
      }, 20000);
      f.remove();
      return st || 'unknown';
    }

    let busy = false;
    // 心跳：队列在这个标签页里跑着时，每 15 秒写一次时间，别的标签页据此判断「真的在跑」还是「上次关掉留下的」
    setInterval(() => { if (busy) GM_setValue('mbr_qhb', Date.now()); }, 15000);
    // 关掉这个标签页 = 放弃这次队列，下次回来重新设置
    window.addEventListener('pagehide', () => { if (busy) GM_setValue(QUEUE, null); });
    async function runQueue() {
      if (busy) return; busy = true;
      GM_setValue('mbr_qhb', Date.now());
      try {
        while (true) {
          const q = getQ(); showQ();
          if (!q || !q.running) break;
          if (q.i >= q.ids.length) {
            setQ({ ...q, running: false }); log(`${q.label} 完成：成功 ${q.ok}，失败/跳过 ${q.ng}`); showQ();
            break;
          }
          const id = q.ids[q.i];
          const token = Math.random().toString(36).slice(2);
          const first = { relist: 'clone', 'del-stopped': 'run', 'del-sold': 'run' }[q.op];
          setJob({ op: q.op, id, phase: first, token });
          const url = { relist: '/item/' + id, 'del-stopped': '/sell/edit/' + id, 'del-sold': '/transaction/' + id }[q.op];
          const tab = GM_openInTab(location.origin + url, { active: q.op === 'relist', insert: true });
          const limit = q.op === 'relist' ? 240 : 60;
          var res = null;
          for (let t = 0; t < limit; t++) {
            await sleep(1000);
            const jj = getJob();
            if (jj && jj.token === token && (jj.phase === 'done' || jj.phase === 'error')) { res = jj; break; }
            if (!getQ()?.running) break;
          }
          if (!res && !getQ()?.running) { try { tab.close(); } catch (e) {} break; }
          let ok = res && res.phase === 'done';
          if (!res) { try { tab.close(); } catch (e) {} }
          // 再出品报失败/超时时，直接核实旧商品是不是已经停止了；已停止就算成功，继续下一件
          if (!ok && q.op === 'relist') {
            log(`${id}：${res ? res.msg : '超时'}，核实实际状态…`);
            const st = await checkStatus(id);
            if (st === 'stopped') {
              ok = true;
              res = { ...(res || {}), phase: 'done', msg: '核实：旧的已停止，算成功' };
              try { tab.close(); } catch (e) {}
            } else {
              res = { ...(res || {}), phase: 'error', msg: `核实：旧的还是${st === 'public' ? '出品中' : '未知状态'}，请看那个标签页（没找到/没确认成功）` };
            }
          }
          log(`${id}：${res ? res.msg : '超时，跳过'}`);
          const tr = (res || getJob() || {}).trace;
          if (tr && tr.length) log('  步骤：\n  ' + tr.join('\n  '));
          // 更新本地数据
          const d = data();
          if (ok) {
            if (q.op === 'relist') d.items = d.items.map(r => r.id === id ? { ...r, status: 'stopped' } : r);
            else d.items = d.items.filter(r => r.id !== id);
            GM_setValue(DB, d);
            selected.delete(id);
          }
          const q2 = getQ();
          setQ({ ...q2, i: q2.i + 1, ok: q2.ok + (ok ? 1 : 0), ng: q2.ng + (ok ? 0 : 1) });
          if (!ok && res && /找不到|没确认|没变化|不可用|没成功|没有填好/.test(res.msg)) {
            setQ({ ...getQ(), running: false });
            log('⚠ 出现异常，队列已暂停。看一下那个标签页，处理后点「继续队列」。');
            break;
          }
          render();
          await sleep(rand(GAP_MIN, GAP_MAX) * 1000);
        }
      } finally { busy = false; showQ(); render(); }
    }

    render(); showQ();
    // 上次关掉时没做完的队列：不继续，直接清掉（另一个标签页正在跑的除外）
    const q = getQ();
    if (q) {
      if (q.running && Date.now() - GM_getValue('mbr_qhb', 0) < 60e3) log(`另一个标签页正在运行「${q.label}」（${q.i}/${q.ids.length}），这里不要再开`);
      else { setQ(null); if (q.i < q.ids.length) log(`上次的「${q.label}」做到 ${q.i}/${q.ids.length} 就关掉了，已清除，请重新勾选`); showQ(); }
    }
  }

  function addPanelButton() {
    if (document.getElementById('mbr-open')) return;
    const b = document.createElement('button');
    b.id = 'mbr-open';
    b.textContent = '助手面板';
    b.style.cssText = 'position:fixed;left:20px;bottom:80px;z-index:2147483600;padding:14px 26px;border:none;border-radius:28px;background:#e33;color:#fff;font-size:18px;font-weight:bold;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3)';
    b.onclick = openPanel;
    document.body.appendChild(b);
  }

  // ============ 路由（煤炉是单页应用，路径变化时重新判断） ============
  let lastPath = '';
  const ran = new Set();                 // 同一个标签页里，每个任务只执行一次
  const once = (key, fn) => { if (ran.has(key)) return; ran.add(key); fn(); };
  function route() {
    if (path() === lastPath) return;
    lastPath = path();
    if (window.top !== window.self) return;   // 抓取用的 iframe 里不运行
    const p = path();
    if (location.hostname === 'paypayfleamarket.yahoo.co.jp') { const id = (p.match(/^\/item\/([^/?#]+)/) || [])[1]; if (id) once('fsrc:' + id, () => multiPlatformUI(id, readSrcFlea)); return; }
    if (/^(page\.)?auctions\.yahoo\.co\.jp$/.test(location.hostname) && /^\/jp\/auction\//.test(p)) { const id = p.split('/')[3]; if (id) once('asrc:' + id, () => multiPlatformUI(id, readSrcAuc)); return; }
    if (/yahoo\.co\.jp$/.test(location.hostname)) {
      // 状态提示：方便判断脚本有没有加载、任务对不对
      const m = getM();
      const ver = (typeof GM_info !== 'undefined' && GM_info.script.version) || '';
      const t = m && m.tasks ? m.tasks[m.i] : null;
      toast(`助手 ${ver} 已加载｜${m ? `任务 ${m.i + 1}/${m.tasks?.length} ${t ? PLAT[t.plat].name : '?'}｜状态 ${m.phase}｜${m.ts ? Math.round((Date.now() - m.ts) / 1000) + ' 秒前派发' : '没有派发时间'}｜派发者 ${m.firedBy || '?'}${m.dupFire ? `｜拦下重复派发 ${m.dupFire} 次(${m.dupBy})` : ''}${m.dupPage ? `｜关掉重复页面 ${m.dupPage} 个` : ''}` : '没有任务'}`, '#777');
    }
    if (location.hostname === 'paypayfleamarket-sec.yahoo.co.jp') { if (/^\/item\/add/.test(p)) once('flea', fleaPage); return; }
    if (location.hostname === 'auctions.yahoo.co.jp') { once('auc:' + p, aucPage); return; }
    if (/^\/mypage\/listings/.test(p)) addPanelButton();
    else document.getElementById('mbr-open')?.remove();
    if (/^\/item\//.test(p)) once('item:' + idFromPath(), itemPage);
    else if (/^\/sell\/create/.test(p)) once('sell', sellPage);
    else if (/^\/sell\/edit\//.test(p)) once('edit:' + idFromPath(), editPageWorker);
    else if (/^\/transaction\//.test(p)) once('tx:' + idFromPath(), transactionPageWorker);
  }
  route();
  setInterval(route, 1000);
})();
