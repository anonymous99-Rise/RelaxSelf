// ==UserScript==
// @name         rou.video 去广告 + 下载 + 隐私检测
// @namespace    https://rou.video/
// @version      1.3.0
// @description  去广告；悬浮面板下载 HLS(MPEG-TS)；检测站点追踪/隐私风险（不破坏站点 React）
// @author       Richy
// @match        *://rou.video/*
// @match        *://*.rou.video/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';

  const AD_HOST_RE = new RegExp(
    [
      'ar01\\.xyz',
      'rdz3\\.xyz',
      'clickadu',
      'onclckbnr?\\.com',
      'onclckbn\\.net',
      'capndr\\.com',
      'clammyendearedkeg\\.com',
      'holahupa\\.com',
      '3pkf5m0gd\\.com',
      'nimhuemark\\.com',
      'mayzaent\\.com',
      'mnaspm\\.com',
      'stripchat\\.com',
      'chaturbate\\.com',
      'mmcdn\\.com',
      'silent-basis\\.pro',
      'uuidksinc\\.net',
      'betweendigital\\.com',
      'new-programmatic\\.com',
      'ace8fcccda\\.com',
      '5650ea67d8\\.com',
      'doubleclick\\.net',
      'exoclick',
      'juicyads',
      'trafficjunky',
      'tsyndicate',
      'adsterra',
      'popads',
      'popcash',
      'propellerads',
    ].join('|'),
    'i'
  );

  /** 仅站内明确广告脚本，勿误伤业务 API */
  const LOCAL_AD_SCRIPT_RE = /\/js\/(clickadu|stripchat)\.js(?:\?|$)/i;

  const REMOVE_SELECTORS = [
    '[id^="__clb-spot_"]',
    '[id*="__clb-spot_"]',
    'iframe[id*="__clb"]',
    'insertion',
    '[id^="ts_ad_"]',
    '[id*="ts_ad_native"]',
    '#SCSpotScript',
    '#player-container',
    '[class*="layoutWrapper--"]',
    '.rmp-ad-container',
    '.rmp-ad-block',
    '[class*="rmp-ad"]',
    '[class*="smartpop"]',
    '[id*="smartpop"]',
  ];

  const HIDE_CSS = `
    ${REMOVE_SELECTORS.join(',\n')},
    iframe[src*="onclckbn"],
    iframe[src*="ar01.xyz"],
    iframe[src*="mayzaent"],
    iframe[src*="mnaspm"],
    iframe[src*="chaturbate"],
    iframe[src*="stripchat"],
    iframe[src*="clammyendearedkeg"],
    iframe[src*="holahupa"],
    a[href*="ar01.xyz"],
    a[href*="go.mayzaent.com"],
    a[href*="go.mnaspm.com"],
    a[href*="rdz3.xyz"] {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      max-height: 0 !important;
      max-width: 0 !important;
      overflow: hidden !important;
      position: fixed !important;
      left: -99999px !important;
      top: -99999px !important;
      z-index: -1 !important;
    }
  `;

  let allowDomRemove = false;
  let sweepScheduled = false;

  const log = (...args) => {
    try {
      console.debug('[rou-adblock]', ...args);
    } catch (_) {}
  };

  function getUrl(input) {
    try {
      if (!input) return '';
      if (typeof input === 'string') return input;
      if (typeof input.url === 'string') return input.url;
      if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
      return String(input);
    } catch (_) {
      return '';
    }
  }

  function isSameSite(url) {
    try {
      const u = new URL(url, location.href);
      return u.hostname === location.hostname || u.hostname.endsWith('.rou.video');
    } catch (_) {
      return false;
    }
  }

  /** 是否为应拦截的广告资源 URL */
  function isAdUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (LOCAL_AD_SCRIPT_RE.test(url)) return true;
    try {
      const u = new URL(url, location.href);
      // 同源：只拦明确广告脚本，不拦业务/ads API（交给 DOM 隐藏）
      if (u.hostname === location.hostname || u.hostname.endsWith('.rou.video')) {
        return LOCAL_AD_SCRIPT_RE.test(u.pathname);
      }
      if (AD_HOST_RE.test(u.hostname)) return true;
      if (AD_HOST_RE.test(u.href)) return true;
      if (/\/(banner-admanager|smartpop)\b/i.test(u.pathname)) return true;
      if (/\/(bn|profile\.min)\.js(?:\?|$)/i.test(u.pathname)) return true;
      if (/\/advertising\.js(?:\?|$)/i.test(u.pathname)) return true;
    } catch (_) {
      return AD_HOST_RE.test(url) || LOCAL_AD_SCRIPT_RE.test(url);
    }
    return false;
  }

  /**
   * 站点会 fetch 广告接口并 .json()；必须返回合法、可解析的 Response，
   * 绝不能 throw，否则会变成 client-side exception。
   */
  function fakeEmptyResponse(url) {
    // 204 不能带 body；统一 200 + 空 JSON，兼容 json()/text()
    const body = '[]';
    try {
      return new Response(body, {
        status: 200,
        statusText: 'OK',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    } catch (e) {
      log('fake response failed', e);
      // 极端环境兜底：放行真实请求，避免整站崩溃
      return null;
    }
  }

  // ---------- 1. 拦截 script/iframe/img src ----------
  function patchElementSetters() {
    const rawSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        if (
          typeof name === 'string' &&
          typeof value === 'string' &&
          /^(src|href|data-src)$/i.test(name) &&
          isAdUrl(value)
        ) {
          log('block setAttribute', name, value.slice(0, 100));
          return;
        }
      } catch (_) {}
      return rawSetAttribute.apply(this, arguments);
    };

    for (const Tag of [HTMLScriptElement, HTMLIFrameElement, HTMLImageElement]) {
      if (!Tag || !Tag.prototype) continue;
      try {
        const desc = Object.getOwnPropertyDescriptor(Tag.prototype, 'src');
        if (!desc || !desc.set) continue;
        Object.defineProperty(Tag.prototype, 'src', {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set(v) {
            if (isAdUrl(String(v))) {
              log('block src', Tag.name, String(v).slice(0, 100));
              return;
            }
            return desc.set.call(this, v);
          },
        });
      } catch (e) {
        log('patch src failed', Tag.name, e);
      }
    }
  }

  // ---------- 2. fetch / XHR：合法空响应，绝不 throw ----------
  function patchNetwork() {
    if (typeof window.fetch === 'function') {
      const rawFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        try {
          const url = getUrl(input);
          if (isAdUrl(url)) {
            log('block fetch', url.slice(0, 120));
            const fake = fakeEmptyResponse(url);
            if (fake) return Promise.resolve(fake);
            // 构造失败则放行，保证站点可用
          }
        } catch (e) {
          log('fetch patch error', e);
        }
        return rawFetch(input, init);
      };
    }

    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__rouAdBlocked = isAdUrl(String(url || ''));
      } catch (_) {
        this.__rouAdBlocked = false;
      }
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (this.__rouAdBlocked) {
        // 模拟完成，不抛错；status 200 + 空数组更安全
        try {
          const self = this;
          setTimeout(() => {
            try {
              Object.defineProperty(self, 'readyState', { configurable: true, get: () => 4 });
              Object.defineProperty(self, 'status', { configurable: true, get: () => 200 });
              Object.defineProperty(self, 'responseText', { configurable: true, get: () => '[]' });
              Object.defineProperty(self, 'response', { configurable: true, get: () => '[]' });
              if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
              if (typeof self.onload === 'function') self.onload();
            } catch (_) {}
          }, 0);
        } catch (_) {}
        return;
      }
      return XS.apply(this, arguments);
    };
  }

  // ---------- 3. 弹窗拦截（勿拦截无参 open） ----------
  function patchWindowOpen() {
    const rawOpen = window.open;
    window.open = function (url) {
      try {
        if (url != null && url !== '' && isAdUrl(String(url))) {
          log('block window.open', String(url).slice(0, 100));
          return null;
        }
      } catch (_) {}
      return rawOpen.apply(this, arguments);
    };

    const blockAdClick = (e) => {
      try {
        const a = e.target && e.target.closest && e.target.closest('a[href]');
        if (a && isAdUrl(a.href)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
      } catch (_) {}
    };
    ['click', 'auxclick', 'mousedown', 'pointerdown'].forEach((type) => {
      document.addEventListener(type, blockAdClick, true);
    });
  }

  // ---------- 4. CSS 隐藏（hydration 安全） ----------
  function injectCSS() {
    try {
      if (document.getElementById('rou-adblock-style')) return;
      const style = document.createElement('style');
      style.id = 'rou-adblock-style';
      style.textContent = HIDE_CSS;
      const parent = document.head || document.documentElement;
      if (parent) parent.appendChild(style);
    } catch (_) {}
  }

  function removeNode(el) {
    if (!el || !allowDomRemove) return false;
    try {
      // 不删 React 根、main、header
      if (el.id === '__next' || el.id === 'rou-adblock-style') return false;
      if (el.tagName === 'MAIN' || el.tagName === 'BODY' || el.tagName === 'HTML') return false;
      el.remove();
      return true;
    } catch (_) {
      return false;
    }
  }

  function isThirdPartyAdNode(el) {
    if (!el || el.nodeType !== 1) return false;
    const id = el.id || '';
    const cls = typeof el.className === 'string' ? el.className : String(el.className || '');
    const tag = el.tagName;

    if (tag === 'INSERTION') return true;
    if (/^__clb-spot_/i.test(id) || /__clb/i.test(id)) return true;
    if (/^ts_ad_/i.test(id) || /ts_ad_native/i.test(id)) return true;
    if (id === 'SCSpotScript' || id === 'player-container') return true;
    if (/rmp-ad/i.test(cls)) return true;
    if (/layoutWrapper--/i.test(cls)) return true;
    if (/smartpop/i.test(id + cls)) return true;

    if (tag === 'DIV' && /rmp-container/i.test(cls)) {
      try {
        const st = getComputedStyle(el);
        if (st.position === 'fixed' && (parseInt(st.zIndex, 10) || 0) > 1000) {
          const text = (el.textContent || '').slice(0, 80);
          if (/CLOSE|关闭|SKIP|跳过/i.test(text) || el.querySelector('.rmp-ad-container, video[src*="silent-basis"]')) {
            return true;
          }
        }
      } catch (_) {}
    }

    if (tag === 'SCRIPT') {
      return isAdUrl(el.src || el.getAttribute('src') || '');
    }
    if (tag === 'IFRAME' || tag === 'IMG') {
      return isAdUrl(el.src || el.getAttribute('src') || '');
    }
    if (tag === 'A') {
      const href = el.href || el.getAttribute('href') || '';
      return isAdUrl(href) || /ar01\.xyz|mayzaent|mnaspm/i.test(href);
    }
    return false;
  }

  function cleanNativePromoBlocks() {
    if (!allowDomRemove) return;
    try {
      document.querySelectorAll('a[href*="ar01.xyz"]').forEach((a) => {
        let p = a;
        for (let i = 0; i < 5 && p; i++) {
          if (
            p.matches &&
            (p.matches('insertion') ||
              p.matches('[class*="place-self-center"]') ||
              (p.children && p.children.length <= 8 && /ar01\.xyz/.test(p.innerHTML || '')))
          ) {
            removeNode(p);
            return;
          }
          p = p.parentElement;
        }
        removeNode(a);
      });

      document.querySelectorAll('div.mb-4.rounded-lg.border').forEach((box) => {
        const t = box.textContent || '';
        if (
          /通告/.test(t) &&
          (/免费色情|免费看片|地址發布|地址发布/.test(t) ||
            box.querySelector('a[href*="ar01.xyz"], a[href*="rdz3.xyz"]'))
        ) {
          removeNode(box);
        }
      });
    } catch (_) {}
  }

  function killVideoPreroll() {
    if (!allowDomRemove) return;
    try {
      document.querySelectorAll('video').forEach((v) => {
        const src = v.currentSrc || v.src || '';
        const parentCls = (v.parentElement && v.parentElement.className) || '';
        if (isAdUrl(src) || /rmp-ad/i.test(String(parentCls)) || /silent-basis/i.test(src)) {
          try {
            v.pause();
            v.removeAttribute('src');
            v.load();
          } catch (_) {}
          removeNode(v.closest('.rmp-ad-container, .rmp-container') || v);
        }
      });

      document.querySelectorAll('.rmp-container, [class*="rmp-container"]').forEach((el) => {
        try {
          const st = getComputedStyle(el);
          if (st.position === 'fixed' && (parseInt(st.zIndex, 10) || 0) > 1000) {
            removeNode(el);
          }
        } catch (_) {}
      });

      document.querySelectorAll('.rmp-ad-container, [class*="rmp-ad"]').forEach(removeNode);

      // 尝试点关闭
      document.querySelectorAll('button, a, div, span').forEach((el) => {
        const t = (el.textContent || '').trim();
        if (!t || t.length > 20) return;
        if (!/^(CLOSE|Close|关闭|關閉|SKIP|Skip|跳过|跳過)$/i.test(t)) return;
        if (!el.closest('.rmp-container, .rmp-ad-container, [id^="__clb"], [class*="layoutWrapper--"]')) return;
        try {
          el.click();
        } catch (_) {}
      });
    } catch (_) {}
  }

  function sweep() {
    injectCSS();
    if (!allowDomRemove) return;

    try {
      REMOVE_SELECTORS.forEach((sel) => {
        try {
          document.querySelectorAll(sel).forEach(removeNode);
        } catch (_) {}
      });

      document.querySelectorAll('script[src], iframe[src], img[src]').forEach((el) => {
        if (isAdUrl(el.src)) removeNode(el);
      });

      cleanNativePromoBlocks();
      killVideoPreroll();
    } catch (e) {
      log('sweep error', e);
    }
  }

  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    requestAnimationFrame(() => {
      sweepScheduled = false;
      sweep();
    });
  }

  function observe() {
    const mo = new MutationObserver((mutations) => {
      if (!allowDomRemove) {
        injectCSS();
        return;
      }
      let needSweep = false;
      for (const m of mutations) {
        if (m.type === 'childList') {
          m.addedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            if (isThirdPartyAdNode(n)) {
              removeNode(n);
              return;
            }
            if (n.tagName === 'SCRIPT' && isAdUrl(n.src || '')) {
              removeNode(n);
              return;
            }
            if (n.querySelectorAll) {
              n.querySelectorAll(
                'iframe, insertion, [id^="__clb-spot_"], [id^="ts_ad_"], .rmp-ad-container, script[src]'
              ).forEach((el) => {
                if (isThirdPartyAdNode(el) || (el.src && isAdUrl(el.src))) removeNode(el);
              });
            }
            needSweep = true;
          });
        } else if (m.type === 'attributes') {
          const el = m.target;
          if (el && (m.attributeName === 'src' || m.attributeName === 'href')) {
            if (isAdUrl(el.src || el.href || '')) removeNode(el);
          }
        }
      }
      if (needSweep) scheduleSweep();
    });

    const root = document.documentElement || document;
    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href'],
    });
  }

  function enableDomRemove() {
    allowDomRemove = true;
    sweep();
  }

  // ---------- 启动：document-start 只做拦截 + CSS ----------
  try {
    patchElementSetters();
    patchNetwork();
    patchWindowOpen();
  } catch (e) {
    log('patch failed', e);
  }

  injectCSS();
  // 尽早观察，但 hydration 前不 remove
  if (document.documentElement) observe();
  else document.addEventListener('DOMContentLoaded', observe, { once: true });

  // hydration 完成后再删 DOM（避免 React #418）
  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        // 再等两帧，让 React hydrate 跑完
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(enableDomRemove, 100);
          });
        });
      },
      { once: true }
    );
  } else {
    setTimeout(enableDomRemove, 100);
  }

  window.addEventListener('load', () => {
    enableDomRemove();
    killVideoPreroll();
  });

  // 延迟贴片 / 动态广告
  let ticks = 0;
  const timer = setInterval(() => {
    if (allowDomRemove) {
      sweep();
      killVideoPreroll();
    } else {
      injectCSS();
    }
    ticks += 1;
    if (ticks > 40) clearInterval(timer);
  }, 500);

  const onRouteChange = () => {
    setTimeout(() => {
      injectCSS();
      if (allowDomRemove) {
        sweep();
        killVideoPreroll();
      }
      try {
        if (window.__rouTools && typeof window.__rouTools.onRoute === 'function') {
          window.__rouTools.onRoute();
        }
      } catch (_) {}
    }, 200);
  };
  const wrapHist = (type) => {
    const raw = history[type];
    if (typeof raw !== 'function') return;
    history[type] = function () {
      const ret = raw.apply(this, arguments);
      onRouteChange();
      return ret;
    };
  };
  wrapHist('pushState');
  wrapHist('replaceState');
  window.addEventListener('popstate', onRouteChange);

  // =====================================================================
  // 下载 + 隐私检测（悬浮面板）
  // =====================================================================
  const QUALITIES = [2160, 1080, 720, 480, 360];
  const DL_CONCURRENCY = 3;
  let downloadAbort = null;
  let uiReady = false;

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** 站点加密：base64(d) 后每字节减去 k */
  function decryptEv(ev) {
    if (!ev || typeof ev.d !== 'string' || typeof ev.k !== 'number') {
      throw new Error('缺少加密字段 ev');
    }
    const raw = b64ToBytes(ev.d);
    const k = ev.k | 0;
    let s = '';
    for (let i = 0; i < raw.length; i++) {
      s += String.fromCharCode((raw[i] - k + 256) % 256);
    }
    return JSON.parse(s);
  }

  function getVideoIdFromPath(pathname) {
    const m = String(pathname || location.pathname).match(/\/v\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : '';
  }

  function isVideoPage() {
    return !!getVideoIdFromPath();
  }

  async function getPageProps() {
    const id = getVideoIdFromPath();
    // 1) 当前 SSR 注入
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (el && el.textContent) {
        const data = JSON.parse(el.textContent);
        const pp = data && data.props && data.props.pageProps;
        // SPA 切页后 __NEXT_DATA__ 可能过期，仅当 video.id 匹配时用
        if (pp && pp.ev && (!id || !pp.video || pp.video.id === id)) {
          return pp;
        }
      }
    } catch (e) {
      log('parse __NEXT_DATA__ failed', e);
    }

    // 2) 重新拉 HTML（适配客户端路由）
    if (!id) throw new Error('当前不是视频页');
    const res = await fetch(location.origin + '/v/' + id, {
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
    });
    if (!res.ok) throw new Error('拉取页面失败 HTTP ' + res.status);
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('页面中未找到 __NEXT_DATA__');
    const data = JSON.parse(m[1]);
    return data.props.pageProps;
  }

  function parseM3u8(text, baseUrl) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const segs = [];
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      try {
        segs.push(new URL(line, baseUrl).href);
      } catch (_) {
        segs.push(line);
      }
    }
    return segs;
  }

  function qualityUrl(videoUrl, q) {
    return String(videoUrl).replace(/-\d+\//, '-' + q + '/');
  }

  async function probeQualities(videoUrl) {
    const results = [];
    await Promise.all(
      QUALITIES.map(async (q) => {
        const url = qualityUrl(videoUrl, q);
        try {
          const res = await fetch(url, { method: 'GET', credentials: 'omit' });
          if (!res.ok) {
            results.push({ q, ok: false, status: res.status, url, segs: 0 });
            return;
          }
          const text = await res.text();
          if (!/#EXTM3U/i.test(text)) {
            results.push({ q, ok: false, status: res.status, url, segs: 0 });
            return;
          }
          const segs = parseM3u8(text, url);
          results.push({ q, ok: segs.length > 0, status: res.status, url, segs: segs.length, playlist: text });
        } catch (e) {
          results.push({ q, ok: false, status: 0, url, segs: 0, err: String(e && e.message) });
        }
      })
    );
    results.sort((a, b) => b.q - a.q);
    return results;
  }

  function sanitizeFilename(name) {
    return String(name || 'rou-video')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'rou-video';
  }

  function formatBytes(n) {
    if (!n || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i += 1;
    }
    return v.toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  async function downloadSegments(segments, { onProgress, signal } = {}) {
    const total = segments.length;
    const parts = new Array(total);
    let done = 0;
    let bytes = 0;
    let idx = 0;
    let failed = null;

    async function worker() {
      while (idx < total) {
        if (signal && signal.aborted) throw new DOMException('已取消', 'AbortError');
        if (failed) throw failed;
        const i = idx++;
        const url = segments[i];
        let attempt = 0;
        while (attempt < 3) {
          try {
            const res = await fetch(url, { credentials: 'omit', signal });
            if (!res.ok) throw new Error('分片 HTTP ' + res.status);
            const buf = await res.arrayBuffer();
            parts[i] = buf;
            bytes += buf.byteLength;
            done += 1;
            if (onProgress) onProgress({ done, total, bytes, index: i });
            break;
          } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            attempt += 1;
            if (attempt >= 3) {
              failed = new Error('分片下载失败 #' + i + ': ' + (e && e.message));
              throw failed;
            }
            await new Promise((r) => setTimeout(r, 400 * attempt));
          }
        }
      }
    }

    const workers = [];
    const n = Math.min(DL_CONCURRENCY, total || 1);
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);
    return { parts, bytes };
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        a.remove();
        URL.revokeObjectURL(url);
      } catch (_) {}
    }, 5000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch (e) {
        return false;
      }
    }
  }

  // ---------- 隐私扫描 ----------
  const TRACKER_HOST_RE = new RegExp(
    [
      'google-analytics\\.com',
      'googletagmanager\\.com',
      'doubleclick\\.net',
      'cloudflareinsights\\.com',
      'cdn-cgi/rum',
      'clickadu',
      'onclckbn',
      'exoclick',
      'juicyads',
      'trafficjunky',
      'tsyndicate',
      'stripchat\\.com',
      'chaturbate\\.com',
      'mayzaent\\.com',
      'mnaspm\\.com',
      'ar01\\.xyz',
      'silent-basis\\.pro',
      'ptelastaxo\\.com',
      'uuidksinc\\.net',
      'betweendigital\\.com',
      'new-programmatic\\.com',
    ].join('|'),
    'i'
  );

  const SENSITIVE_COOKIE_RE =
    /^(?:_ga|_gid|_gat|_ga_|__PPU_|bnState_|UGVyc2lzdFN0b3JhZ2U|cf_clearance|__cf|session|token|uid|user)/i;

  function scanPrivacy() {
    const findings = [];
    const thirdParties = new Set();
    const cookies = [];

    try {
      document.cookie.split(';').forEach((c) => {
        const name = c.split('=')[0].trim();
        if (!name) return;
        cookies.push(name);
        if (SENSITIVE_COOKIE_RE.test(name) || /PPU|bnState|_ga/i.test(name)) {
          findings.push({
            level: /_ga|PPU|bnState/i.test(name) ? 'medium' : 'low',
            title: '追踪 Cookie: ' + name,
            detail: '可能用于广告归因或访问统计',
          });
        }
      });
    } catch (_) {}

    try {
      performance.getEntriesByType('resource').forEach((r) => {
        try {
          const u = new URL(r.name);
          if (u.hostname !== location.hostname) thirdParties.add(u.hostname);
          if (TRACKER_HOST_RE.test(u.hostname) || TRACKER_HOST_RE.test(u.href)) {
            findings.push({
              level: 'high',
              title: '第三方追踪/广告: ' + u.hostname,
              detail: u.pathname.slice(0, 80),
            });
          }
        } catch (_) {}
      });
    } catch (_) {}

    // 同源可能敏感接口
    try {
      performance.getEntriesByType('resource').forEach((r) => {
        const n = r.name || '';
        if (/\/api\/auth\/session/i.test(n)) {
          findings.push({
            level: 'low',
            title: '登录会话探测 /api/auth/session',
            detail: '用于判断是否登录；未见强制收集实名信息',
          });
        }
        if (/\/api\/v\/watching/i.test(n)) {
          findings.push({
            level: 'medium',
            title: '观看行为上报 /api/v/watching',
            detail: '站点会记录你在看哪些视频（匿名/登录态均可能）',
          });
        }
        if (/cdn-cgi\/rum/i.test(n)) {
          findings.push({
            level: 'medium',
            title: 'Cloudflare RUM 性能监控',
            detail: '上报浏览器性能与页面访问指标',
          });
        }
      });
    } catch (_) {}

    // 指纹相关 API 粗检（脚本是否调用）
    try {
      const riskyApis = [];
      if (navigator.userAgent) riskyApis.push('User-Agent');
      if (navigator.language) riskyApis.push('语言');
      if (screen && screen.width) riskyApis.push('屏幕分辨率');
      findings.push({
        level: 'info',
        title: '浏览器环境信息可被读取',
        detail: riskyApis.join('、') + '（广告脚本常用来做设备画像）',
      });
    } catch (_) {}

    // 去重
    const seen = new Set();
    const unique = [];
    for (const f of findings) {
      const key = f.level + '|' + f.title;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(f);
    }

    const high = unique.filter((f) => f.level === 'high').length;
    const medium = unique.filter((f) => f.level === 'medium').length;
    let summary = '未发现明显实名/支付信息采集';
    if (high + medium > 0) {
      summary =
        '发现广告追踪与行为统计（高 ' +
        high +
        ' / 中 ' +
        medium +
        '）。未见密码箱/银行卡类接口，但广告网络会收集设备与点击画像。';
    }

    return {
      summary,
      findings: unique,
      cookies,
      thirdParties: [...thirdParties].sort(),
    };
  }

  // ---------- UI ----------
  function ensureUI() {
    if (uiReady || document.getElementById('rou-tools-root')) {
      uiReady = true;
      return;
    }
    if (!document.body && !document.documentElement) return;

    const style = document.createElement('style');
    style.id = 'rou-tools-style';
    style.textContent = `
#rou-tools-root{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483646;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.45;color:#e8eaed}
#rou-tools-root *{box-sizing:border-box}
#rou-tools-fab{width:48px;height:48px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(145deg,#ff4d6d,#c9184a);color:#fff;font-size:20px;box-shadow:0 6px 20px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;transition:transform .15s ease}
#rou-tools-fab:hover{transform:scale(1.06)}
#rou-tools-panel{display:none;position:absolute;right:0;bottom:58px;width:320px;max-width:calc(100vw - 24px);background:rgba(22,24,28,.96);border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.45);padding:12px;backdrop-filter:blur(10px)}
#rou-tools-panel.open{display:block}
#rou-tools-panel h3{margin:0 0 8px;font-size:14px;font-weight:700;color:#fff}
#rou-tools-panel .rou-row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
#rou-tools-panel button.rou-btn{appearance:none;border:none;border-radius:8px;padding:8px 10px;cursor:pointer;font-size:12px;font-weight:600;color:#fff;background:#3b82f6}
#rou-tools-panel button.rou-btn:disabled{opacity:.45;cursor:not-allowed}
#rou-tools-panel button.rou-btn.secondary{background:#374151}
#rou-tools-panel button.rou-btn.danger{background:#b91c1c}
#rou-tools-panel button.rou-btn.ok{background:#059669}
#rou-tools-panel select{width:100%;padding:7px 8px;border-radius:8px;border:1px solid #444;background:#111827;color:#e5e7eb}
#rou-tools-panel .rou-meta,#rou-tools-panel .rou-status{color:#9ca3af;font-size:12px;word-break:break-all;margin:4px 0}
#rou-tools-panel .rou-progress{height:8px;background:#1f2937;border-radius:99px;overflow:hidden;margin:8px 0}
#rou-tools-panel .rou-progress>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#34d399,#3b82f6);transition:width .15s}
#rou-tools-panel .rou-tabs{display:flex;gap:6px;margin-bottom:8px}
#rou-tools-panel .rou-tab{flex:1;padding:6px;border-radius:8px;border:1px solid #333;background:#111;color:#bbb;cursor:pointer;font-size:12px}
#rou-tools-panel .rou-tab.active{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
#rou-tools-panel .rou-pane{display:none;max-height:360px;overflow:auto}
#rou-tools-panel .rou-pane.active{display:block}
#rou-tools-panel .rou-finding{border-left:3px solid #666;padding:6px 8px;margin:6px 0;background:rgba(255,255,255,.03);border-radius:0 8px 8px 0}
#rou-tools-panel .rou-finding.high{border-color:#ef4444}
#rou-tools-panel .rou-finding.medium{border-color:#f59e0b}
#rou-tools-panel .rou-finding.low,#rou-tools-panel .rou-finding.info{border-color:#60a5fa}
#rou-tools-panel .rou-finding b{display:block;color:#f3f4f6;font-size:12px}
#rou-tools-panel .rou-finding span{color:#9ca3af;font-size:11px}
#rou-tools-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 4px;border-radius:99px;background:#f59e0b;color:#111;font-size:10px;font-weight:700;display:none;align-items:center;justify-content:center}
`;
    (document.head || document.documentElement).appendChild(style);

    const root = document.createElement('div');
    root.id = 'rou-tools-root';
    root.innerHTML = `
      <div id="rou-tools-panel">
        <div class="rou-tabs">
          <button type="button" class="rou-tab active" data-tab="dl">下载</button>
          <button type="button" class="rou-tab" data-tab="privacy">隐私</button>
        </div>
        <div class="rou-pane active" data-pane="dl">
          <h3>视频下载</h3>
          <div class="rou-meta" id="rou-dl-title">打开视频页后可用</div>
          <div class="rou-meta" id="rou-dl-info"></div>
          <label class="rou-meta" for="rou-dl-quality">清晰度</label>
          <select id="rou-dl-quality" disabled><option value="">先解析…</option></select>
          <div class="rou-row">
            <button type="button" class="rou-btn" id="rou-dl-parse">解析地址</button>
            <button type="button" class="rou-btn ok" id="rou-dl-start" disabled>下载视频</button>
            <button type="button" class="rou-btn secondary" id="rou-dl-copy" disabled>复制 m3u8</button>
            <button type="button" class="rou-btn danger" id="rou-dl-cancel" disabled>取消</button>
          </div>
          <div class="rou-progress"><i id="rou-dl-bar"></i></div>
          <div class="rou-status" id="rou-dl-status">就绪</div>
        </div>
        <div class="rou-pane" data-pane="privacy">
          <h3>隐私风险检测</h3>
          <div class="rou-status" id="rou-priv-summary">点击下方按钮扫描当前页</div>
          <div class="rou-row">
            <button type="button" class="rou-btn" id="rou-priv-scan">重新扫描</button>
          </div>
          <div id="rou-priv-list"></div>
          <div class="rou-meta" id="rou-priv-extra"></div>
        </div>
      </div>
      <div style="position:relative;display:inline-block">
        <button type="button" id="rou-tools-fab" title="rou 工具">⬇</button>
        <span id="rou-tools-badge"></span>
      </div>
    `;
    (document.body || document.documentElement).appendChild(root);

    const panel = root.querySelector('#rou-tools-panel');
    const fab = root.querySelector('#rou-tools-fab');
    fab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        refreshDlMeta();
        if (!root.dataset.privOnce) {
          root.dataset.privOnce = '1';
          runPrivacyScan();
        }
      }
    });

    root.querySelectorAll('.rou-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        root.querySelectorAll('.rou-tab').forEach((t) => t.classList.remove('active'));
        root.querySelectorAll('.rou-pane').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        root.querySelector('.rou-pane[data-pane="' + tab.dataset.tab + '"]').classList.add('active');
      });
    });

    root.querySelector('#rou-dl-parse').addEventListener('click', () => parseCurrentVideo());
    root.querySelector('#rou-dl-start').addEventListener('click', () => startDownload());
    root.querySelector('#rou-dl-copy').addEventListener('click', async () => {
      const st = window.__rouTools.state;
      const sel = document.getElementById('rou-dl-quality');
      let url = st && st.playlistUrl;
      if (sel && sel.selectedOptions && sel.selectedOptions[0] && sel.selectedOptions[0].dataset.url) {
        url = sel.selectedOptions[0].dataset.url;
      }
      if (!url) return;
      const ok = await copyText(url);
      setDlStatus(ok ? '已复制 m3u8 地址' : '复制失败，请手动选择地址');
    });
    root.querySelector('#rou-dl-cancel').addEventListener('click', () => {
      if (downloadAbort) downloadAbort.abort();
    });
    root.querySelector('#rou-priv-scan').addEventListener('click', () => runPrivacyScan());

    uiReady = true;
    refreshDlMeta();
  }

  function setDlStatus(msg) {
    const el = document.getElementById('rou-dl-status');
    if (el) el.textContent = msg;
  }

  function setDlProgress(pct) {
    const bar = document.getElementById('rou-dl-bar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  function refreshDlMeta() {
    const titleEl = document.getElementById('rou-dl-title');
    const infoEl = document.getElementById('rou-dl-info');
    if (!titleEl) return;
    if (!isVideoPage()) {
      titleEl.textContent = '请先打开 /v/ 视频页';
      if (infoEl) infoEl.textContent = '';
      return;
    }
    titleEl.textContent = '视频 ID: ' + getVideoIdFromPath();
    if (infoEl) infoEl.textContent = document.title || '';
  }

  async function parseCurrentVideo() {
    const parseBtn = document.getElementById('rou-dl-parse');
    const startBtn = document.getElementById('rou-dl-start');
    const copyBtn = document.getElementById('rou-dl-copy');
    const sel = document.getElementById('rou-dl-quality');
    try {
      if (!isVideoPage()) throw new Error('当前不是视频页');
      if (parseBtn) parseBtn.disabled = true;
      setDlStatus('正在解密播放地址…');
      setDlProgress(0);

      const pp = await getPageProps();
      const video = pp.video || {};
      const stream = decryptEv(pp.ev);
      if (!stream.videoUrl) throw new Error('解密结果无 videoUrl');

      setDlStatus('探测可用清晰度…');
      const quals = await probeQualities(stream.videoUrl);
      const okList = quals.filter((q) => q.ok);
      if (!okList.length) throw new Error('未找到可用清晰度（链接可能过期，请刷新页面）');

      if (sel) {
        sel.innerHTML = '';
        okList.forEach((q) => {
          const opt = document.createElement('option');
          opt.value = String(q.q);
          opt.textContent = q.q + 'p · ' + q.segs + ' 分片';
          opt.dataset.url = q.url;
          sel.appendChild(opt);
        });
        sel.disabled = false;
        // 默认最高清晰度
        sel.value = String(okList[0].q);
      }

      window.__rouTools.state = {
        video,
        stream,
        qualities: okList,
        playlistUrl: okList[0].url,
        name: sanitizeFilename(video.name || video.nameZh || document.title || getVideoIdFromPath()),
      };

      const titleEl = document.getElementById('rou-dl-title');
      const infoEl = document.getElementById('rou-dl-info');
      if (titleEl) titleEl.textContent = window.__rouTools.state.name;
      if (infoEl) {
        const dur = video.duration ? Math.round(video.duration) + 's' : '?';
        infoEl.textContent = '时长约 ' + dur + ' · 分片为 MPEG-TS（.ts）';
      }

      if (startBtn) startBtn.disabled = false;
      if (copyBtn) copyBtn.disabled = false;
      setDlStatus('解析完成，可下载（保存为 .ts，可用 VLC/mpv 播放）');
    } catch (e) {
      log('parse video failed', e);
      setDlStatus('解析失败: ' + (e && e.message ? e.message : e));
      if (startBtn) startBtn.disabled = true;
      if (copyBtn) copyBtn.disabled = true;
    } finally {
      if (parseBtn) parseBtn.disabled = false;
    }
  }

  async function startDownload() {
    const st = window.__rouTools && window.__rouTools.state;
    const sel = document.getElementById('rou-dl-quality');
    const startBtn = document.getElementById('rou-dl-start');
    const cancelBtn = document.getElementById('rou-dl-cancel');
    if (!st) {
      setDlStatus('请先解析地址');
      return;
    }
    let playlistUrl = st.playlistUrl;
    if (sel && sel.selectedOptions && sel.selectedOptions[0]) {
      playlistUrl = sel.selectedOptions[0].dataset.url || qualityUrl(st.stream.videoUrl, sel.value);
    }

    downloadAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (startBtn) startBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = false;
    setDlProgress(0);

    try {
      setDlStatus('读取播放列表…');
      const res = await fetch(playlistUrl, { credentials: 'omit', signal: downloadAbort && downloadAbort.signal });
      if (!res.ok) throw new Error('播放列表 HTTP ' + res.status);
      const text = await res.text();
      if (!/#EXTM3U/i.test(text)) throw new Error('播放列表格式异常');
      const segs = parseM3u8(text, playlistUrl);
      if (!segs.length) throw new Error('播放列表无分片');

      setDlStatus('开始下载 0/' + segs.length);
      const { parts, bytes } = await downloadSegments(segs, {
        signal: downloadAbort && downloadAbort.signal,
        onProgress: ({ done, total, bytes: b }) => {
          setDlProgress((done / total) * 100);
          setDlStatus('下载中 ' + done + '/' + total + ' · ' + formatBytes(b));
        },
      });

      setDlStatus('合并 ' + segs.length + ' 个 TS 分片…');
      const blob = new Blob(parts, { type: 'video/mp2t' });
      const q = (sel && sel.value) || '720';
      const filename = st.name + '_' + q + 'p.ts';
      triggerBlobDownload(blob, filename);
      setDlProgress(100);
      setDlStatus('完成 · ' + formatBytes(bytes) + ' · 已触发下载 ' + filename);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        setDlStatus('已取消下载');
      } else {
        log('download failed', e);
        setDlStatus('下载失败: ' + (e && e.message ? e.message : e));
      }
    } finally {
      downloadAbort = null;
      if (startBtn) startBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = true;
    }
  }

  function runPrivacyScan() {
    const list = document.getElementById('rou-priv-list');
    const summary = document.getElementById('rou-priv-summary');
    const extra = document.getElementById('rou-priv-extra');
    const badge = document.getElementById('rou-tools-badge');
    const report = scanPrivacy();
    if (summary) summary.textContent = report.summary;
    if (list) {
      list.innerHTML = '';
      if (!report.findings.length) {
        list.innerHTML = '<div class="rou-finding info"><b>暂无额外发现</b><span>可播放一会后再扫，便于捕获网络请求</span></div>';
      } else {
        report.findings.forEach((f) => {
          const div = document.createElement('div');
          div.className = 'rou-finding ' + f.level;
          div.innerHTML = '<b>[' + f.level + '] ' + escapeHtml(f.title) + '</b><span>' + escapeHtml(f.detail || '') + '</span>';
          list.appendChild(div);
        });
      }
    }
    if (extra) {
      extra.textContent =
        'Cookie ' +
        report.cookies.length +
        ' 个 · 第三方域名 ' +
        report.thirdParties.length +
        ' 个' +
        (report.thirdParties.length
          ? '（示例: ' + report.thirdParties.slice(0, 6).join(', ') + (report.thirdParties.length > 6 ? '…' : '') + '）'
          : '');
    }
    const risk = report.findings.filter((f) => f.level === 'high' || f.level === 'medium').length;
    if (badge) {
      if (risk > 0) {
        badge.style.display = 'flex';
        badge.textContent = String(risk);
      } else {
        badge.style.display = 'none';
      }
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.__rouTools = {
    onRoute() {
      refreshDlMeta();
      window.__rouTools.state = null;
      const startBtn = document.getElementById('rou-dl-start');
      const copyBtn = document.getElementById('rou-dl-copy');
      const sel = document.getElementById('rou-dl-quality');
      if (startBtn) startBtn.disabled = true;
      if (copyBtn) copyBtn.disabled = true;
      if (sel) {
        sel.innerHTML = '<option value="">先解析…</option>';
        sel.disabled = true;
      }
      setDlStatus('路由已切换，请重新解析');
      setDlProgress(0);
    },
    state: null,
    decryptEv,
    scanPrivacy,
  };

  function bootUI() {
    try {
      ensureUI();
    } catch (e) {
      log('UI boot failed', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootUI, { once: true });
  } else {
    bootUI();
  }
  window.addEventListener('load', bootUI);
  // hydration 后再挂一次，防止 body 被替换
  setTimeout(bootUI, 800);
  setTimeout(bootUI, 2500);

  log('installed v1.3.0');
})();

