// ==UserScript==
// @name         Richy
// @namespace    defense-regression
// @version      1.5.0
// @description  列表广告安全隐藏 + VIP preview升级 + 原播放位叠层播放。兼容桌面/手机常见油猴扩展。
// @author       Richy
// @homepageURL  https://h5.xxoo473.org/
// @supportURL   https://h5.xxoo473.org/
// @match        *://h5.xxoo473.org/*
// @match        *://*.xxoo473.org/*
// @match        *://xxoo473.org/*
// @include      *://*xxoo473.org/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @sandbox      raw
// @noframes     false
// @compatible   chrome Tampermonkey / Violentmonkey / ScriptCat
// @compatible   firefox Violentmonkey / FireMonkey / Tampermonkey
// @compatible   edge Tampermonkey / Violentmonkey
// @compatible   safari Userscripts / Stay / Tampermonkey
// @compatible   ios Userscripts / Stay / Quantumult X(有限) / Shadowrocket(有限)
// @compatible   android Kiwi/Via/Yandex + TM/VM, Firefox Nightly + TM, X浏览器, 狐猴
// ==/UserScript==

(function () {
  'use strict';

  /** 页面真实 window（兼容沙箱扩展 / 手机 Userscript） */
  const PAGE = (function () {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.document) {
        return unsafeWindow;
      }
    } catch (_) {}
    try {
      // 部分扩展把 sandbox window 与 page 分开
      if (window.rawWindow && window.rawWindow.document) return window.rawWindow;
    } catch (_) {}
    try {
      if (window.wrappedJSObject && window.wrappedJSObject.document) {
        return window.wrappedJSObject;
      }
    } catch (_) {}
    return window;
  })();

  // 同 window 防重复（document-start + SPA 回前 + 扩展二次注入）
  try {
    if (PAGE.__DEFENSE_BOOT__) {
      console.info('[SUITE]', 'skip duplicate inject', PAGE.__DEFENSE_BOOT__);
      return;
    }
    PAGE.__DEFENSE_BOOT__ = '1.5.0';
  } catch (_) {}

  const CFG = {
    /** 列表横幅去广告（安全）。若仍异常可改 false */
    ad: true,
    vipEsc: true,
    /** 泄漏后自动灌进站内播放器 / 原位叠层 */
    autoPlay: true,
    /** 右下角调试浮层（默认关） */
    floatPanel: false,
    /**
     * 改写 /api/init 广告配置 —— 默认关！
     * 清空广告可能导致播放器/任务流不触发 finish
     */
    stripInitAds: false,
    forceEscalateAll: false,
    /** 桌面快捷键；手机无键盘可忽略 */
    probeHotkey: true,
    /** SPA 路由变化后自动重挂播放器 */
    routeWatch: true,
    /**
     * 仅列表横幅。禁止写 player-ad / popup（会卡播放）
     */
    adSelectors: [
      'div.ad',
      'div.ad2'
    ],
    /**
     * 仅在 escalate 成功后隐藏（unlockPlayerUI）
     * 不要在页面加载时全局隐藏 player-ad
     */
    unlockSelectors: [
      'div.player-ad',
      'div.buy-popup',
      '.buy-popup'
    ]
  };

  const API_BASE = PAGE.location?.origin || location.origin;
  const IS_MOBILE = (function () {
    try {
      const ua = navigator.userAgent || '';
      return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|HarmonyOS|MiuiBrowser/i.test(
        ua
      ) || (Math.min(screen.width, screen.height) > 0 && Math.min(screen.width, screen.height) <= 820);
    } catch (_) {
      return false;
    }
  })();

  const SUITE = (PAGE.__DEFENSE__ = {
    version: '1.5.0',
    config: CFG,
    env: {
      mobile: IS_MOBILE,
      href: String(PAGE.location?.href || location.href || ''),
      engine: detectEngine()
    },
    lastDetail: null,
    lastFullM3u8: null,
    lastMediaM3u8: null,
    lastKey: null,
    lastProbe: null,
    lastEscPreview: null,
    events: []
  });

  // 同步到当前注入窗（部分扩展只暴露 sandbox window）
  try {
    window.__DEFENSE__ = SUITE;
  } catch (_) {}

  function detectEngine() {
    try {
      if (typeof GM_info !== 'undefined' && GM_info?.scriptHandler) {
        return String(GM_info.scriptHandler) + (GM_info.version ? '@' + GM_info.version : '');
      }
    } catch (_) {}
    try {
      if (typeof GM !== 'undefined' && GM?.info?.scriptHandler) {
        return String(GM.info.scriptHandler);
      }
    } catch (_) {}
    return IS_MOBILE ? 'mobile-userscript' : 'userscript';
  }

  const log = (tag, ...a) => {
    try {
      console.info(`[${tag}]`, ...a);
    } catch (_) {}
  };
  const note = (tag, ev, data) => {
    try {
      SUITE.events.push({ t: Date.now(), tag, ev, data });
      if (SUITE.events.length > 200) SUITE.events.splice(0, SUITE.events.length - 200);
    } catch (_) {}
    log(tag, ev, data);
  };

  /** 遍历顶层 + 同源 iframe 的 window（PC 壳 iframe.pc / 手机直出） */
  function eachWindow(fn) {
    const list = [];
    const add = (w) => {
      if (!w || list.indexOf(w) >= 0) return;
      list.push(w);
    };
    add(PAGE);
    add(window);
    try {
      add(PAGE.top);
    } catch (_) {}
    try {
      add(PAGE.parent);
    } catch (_) {}
    const scanDoc = (doc) => {
      if (!doc) return;
      try {
        doc.querySelectorAll('iframe').forEach((f) => {
          try {
            if (f.contentWindow) add(f.contentWindow);
          } catch (_) {}
        });
      } catch (_) {}
    };
    try {
      scanDoc(PAGE.document);
    } catch (_) {}
    try {
      scanDoc(document);
    } catch (_) {}
    list.forEach((w) => {
      try {
        fn(w);
      } catch (_) {}
    });
  }

  function currentVodId(win) {
    try {
      const w = win || PAGE;
      const hash = w.location?.hash || '';
      const path = w.location?.pathname || '';
      const href = w.location?.href || '';
      const m =
        hash.match(/#\/(?:video|vod|play)\/(\d+)/i) ||
        path.match(/\/(?:video|vod|play)\/(\d+)/i) ||
        href.match(/[?#&/](?:video|vod|play)[=\/](\d+)/i);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  }

  function prepareVideoEl(video) {
    if (!video) return;
    try {
      video.controls = true;
      video.setAttribute('controls', 'true');
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.setAttribute('x5-playsinline', 'true');
      video.setAttribute('x5-video-player-type', 'h5');
      video.setAttribute('x5-video-player-fullscreen', 'true');
      video.setAttribute('x5-video-orientation', 'portraint');
      video.playsInline = true;
      video.preload = 'auto';
      // 部分 WebView 需要，不强制静音（用户可点控件开声）
      video.setAttribute('controlslist', 'nodownload');
    } catch (_) {}
  }

  // ════════════════════════════════════
  //  preview → master / media
  // ════════════════════════════════════
  function escalateFromPreviewM3U8(text, base) {
    const keyMatch = text.match(/#EXT-X-KEY:[^\n]*URI="([^"]+)"/i);
    if (!keyMatch) return { ok: false, reason: 'no_key_uri' };
    const keyUri = keyMatch[1];
    let abs;
    try {
      abs = keyUri.startsWith('http') ? keyUri : new URL(keyUri, base || API_BASE).href;
    } catch (e) {
      return { ok: false, reason: String(e), keyUri };
    }
    let master;
    try {
      const u = new URL(abs);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 4) {
        master = `${u.protocol}//${u.host}/${parts[0]}/${parts[1]}/index.m3u8`;
      } else {
        master = abs
          .replace(/\/\d+kb\/hls\/key\.key.*$/i, '/index.m3u8')
          .replace(/\/hls\/key\.key.*$/i, '/index.m3u8')
          .replace(/\/key\.key.*$/i, '/index.m3u8');
      }
    } catch (e) {
      return { ok: false, reason: String(e), keyUri: abs };
    }
    return { ok: true, keyUri: abs, master };
  }

  /** master → 最高码率 media 地址（拖进度更稳） */
  async function resolveMediaFromMaster(masterUrl) {
    try {
      const r = await fetch(masterUrl, { credentials: 'omit' });
      if (!r.ok) return { media: masterUrl, masterText: '' };
      const text = await r.text();
      if (!/#EXT-X-STREAM-INF/i.test(text)) {
        return { media: masterUrl, masterText: text };
      }
      const lines = text.split(/\r?\n/);
      let bestBw = -1;
      let bestUrl = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/#EXT-X-STREAM-INF/i.test(line)) {
          const m = line.match(/BANDWIDTH=(\d+)/i);
          const bw = m ? parseInt(m[1], 10) : 0;
          let next = lines[i + 1] || '';
          while (next.startsWith('#') && i + 1 < lines.length) {
            i++;
            next = lines[i + 1] || '';
          }
          if (next && !next.startsWith('#') && bw >= bestBw) {
            bestBw = bw;
            bestUrl = next.startsWith('http')
              ? next
              : new URL(next, masterUrl).href;
          }
        }
      }
      return { media: bestUrl || masterUrl, masterText: text, bandwidth: bestBw };
    } catch (_) {
      return { media: masterUrl, masterText: '' };
    }
  }

  async function tryEscalate(previewUrl, meta = {}) {
    note('VIP-ESC', 'escalate:start', { previewUrl, meta });
    let body;
    try {
      const pr = await fetch(previewUrl, { credentials: 'omit' });
      if (!pr.ok) {
        note('VIP-ESC', 'escalate:preview-fail', { status: pr.status });
        return { leak: false, reason: 'preview_http_' + pr.status };
      }
      body = await pr.text();
    } catch (e) {
      note('VIP-ESC', 'escalate:preview-error', String(e));
      return { leak: false, reason: String(e) };
    }

    const esc = escalateFromPreviewM3U8(body, previewUrl);
    if (!esc.ok) {
      note('VIP-ESC', 'escalate:parse-fail', esc);
      return { leak: false, ...esc };
    }
    SUITE.lastKey = esc.keyUri;

    let masterStatus = 0;
    let masterHead = '';
    try {
      const mr = await fetch(esc.master, { credentials: 'omit' });
      masterStatus = mr.status;
      masterHead = (await mr.text()).slice(0, 400);
    } catch (e) {
      note('VIP-ESC', 'escalate:master-error', { master: esc.master, err: String(e) });
      return { leak: false, ...esc, err: String(e) };
    }

    const leak =
      masterStatus === 200 &&
      /#EXTM3U/i.test(masterHead) &&
      /EXT-X-STREAM-INF|#EXTINF/i.test(masterHead);

    SUITE.lastFullM3u8 = leak ? esc.master : null;
    note('VIP-ESC', leak ? 'escalate:LEAK_CONFIRMED' : 'escalate:blocked', {
      keyUri: esc.keyUri,
      master: esc.master,
      masterStatus,
      masterHead
    });

    if (leak) {
      const resolved = await resolveMediaFromMaster(esc.master);
      SUITE.lastMediaM3u8 = resolved.media;
      const detail = {
        vodid: meta.vodid,
        fullM3u8: esc.master,
        mediaM3u8: resolved.media,
        keyUri: esc.keyUri,
        previewUrl
      };
      try {
        PAGE.dispatchEvent(new CustomEvent('vip-esc-ready', { detail }));
      } catch (_) {
        try {
          window.dispatchEvent(new CustomEvent('vip-esc-ready', { detail }));
        } catch (__) {}
      }
      if (CFG.autoPlay) {
        // 原播放位叠层 + 尝试灌进站内 videojs
        const u = resolved.media || esc.master;
        playInPlace(u, detail);
        seamlessPlay(u, detail);
      }
    }
    return { leak, ...esc, masterStatus, masterHead };
  }

  // ════════════════════════════════════
  //  01 去广告 —— 只藏不删，不伤列表
  // ════════════════════════════════════
  function installAdWipe() {
    if (!CFG.ad) return;

    // 注意：不要在全局 CSS 里藏 player-ad，站点会等贴片 countdown 结束才播
    const listSel = (CFG.adSelectors && CFG.adSelectors.length)
      ? CFG.adSelectors.join(',\n')
      : 'div.ad, div.ad2';
    const css = `
/* 仅列表横幅广告，绝不碰 player-ad / popup */
${listSel} {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
  height: 0 !important;
  max-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  opacity: 0 !important;
  border: 0 !important;
}
/* 成功接管播放后由 JS 加 class 再藏遮罩 */
body.defense-unlocked div.player-ad,
body.defense-unlocked div.buy-popup,
body.defense-unlocked .buy-popup {
  display: none !important;
  pointer-events: none !important;
}
/* 接管后保证控制条可拖 */
body.defense-unlocked .video-js .vjs-control-bar {
  display: flex !important;
  opacity: 1 !important;
  visibility: visible !important;
}
body.defense-unlocked .video-js.hide-controls .vjs-control-bar {
  display: flex !important;
}
body.defense-unlocked .video-js .vjs-progress-control,
body.defense-unlocked .video-js .vjs-progress-holder {
  pointer-events: auto !important;
}
`.trim();

    function injectStyle(doc) {
      if (!doc || !doc.documentElement) return;
      if (doc.getElementById('defense-test-adwipe-css')) return;
      const style = doc.createElement('style');
      style.id = 'defense-test-adwipe-css';
      style.textContent = css;
      (doc.head || doc.documentElement).appendChild(style);
    }

    injectStyle(document);
    // iframe 延迟注入
    const boot = () => {
      injectStyle(document);
      document.querySelectorAll('iframe').forEach((f) => {
        try {
          injectStyle(f.contentDocument);
          f.addEventListener('load', () => {
            try {
              injectStyle(f.contentDocument);
            } catch (_) {}
          });
        } catch (_) {}
      });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else boot();
    setInterval(boot, 2000); // 路由切换后补样式，仍不删节点

    function stripAdsFromInit(json) {
      if (!CFG.stripInitAds) return json;
      try {
        const data = json?.data || json;
        const g = data?.globalData || data;
        if (!g || typeof g !== 'object') return json;
        // 保留对象结构，只清空数组，避免前端 forEach 空引用
        ['adgroups', 'iOS_adgroups', 'Android_adgroups'].forEach((k) => {
          if (g[k] && typeof g[k] === 'object') {
            Object.keys(g[k]).forEach((gk) => {
              if (Array.isArray(g[k][gk])) g[k][gk] = [];
            });
          }
        });
        if (Array.isArray(g.adrows)) g.adrows = [];
        if ('splashimage' in g) g.splashimage = '';
        if ('skipAds' in g) g.skipAds = 9999;
        log('AD-WIPE', 'stripped ad arrays (structure kept)');
      } catch (e) {
        log('AD-WIPE', 'strip failed', e);
      }
      return json;
    }
    SUITE.__stripAdsFromInit = stripAdsFromInit;
    log('AD-WIPE', 'armed (CSS-only, no DOM remove)');
  }

  // ════════════════════════════════════
  //  站内无缝播放（可拖进度）
  // ════════════════════════════════════
  /** 仅在已拿到完整流、准备接管播放时调用 */
  function unlockPlayerUI(doc) {
    try {
      if (!doc) return;
      doc.documentElement?.classList?.add('defense-unlocked');
      doc.body?.classList?.add('defense-unlocked');
      (CFG.unlockSelectors || []).forEach((sel) => {
        doc.querySelectorAll(sel).forEach((el) => {
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('pointer-events', 'none', 'important');
        });
      });
      // 文案型 VIP 遮罩（窄文本 + 绝对定位才动）
      doc.querySelectorAll('div,section').forEach((el) => {
        const t = (el.innerText || '').trim();
        if (!t || t.length > 60) return;
        if (/VIP独享|请升级|提升会员|开通会员|立即升级|今日观看次数已用完/.test(t)) {
          const st = doc.defaultView?.getComputedStyle?.(el);
          if (st && (st.position === 'absolute' || st.position === 'fixed')) {
            el.style.setProperty('display', 'none', 'important');
          }
        }
      });
    } catch (_) {}
  }

  // 兼容旧名
  function hidePlayOverlays(doc) {
    unlockPlayerUI(doc);
  }

  function applyToVideoJsPlayer(player, url) {
    if (!player || !url) return false;
    try {
      // 解锁控制条 / 进度
      try {
        player.controls(true);
      } catch (_) {}
      try {
        player.options_ && (player.options_.controls = true);
      } catch (_) {}
      try {
        player.removeClass?.('hide-controls');
        player.removeClass?.('vjs-error');
      } catch (_) {}
      try {
        const el = player.el?.();
        if (el) {
          el.classList.remove('hide-controls', 'vjs-error');
          const bar = el.querySelector('.vjs-control-bar');
          if (bar) {
            bar.style.display = 'flex';
            bar.style.opacity = '1';
          }
          const tech = el.querySelector('video');
          if (tech) {
            tech.setAttribute('controls', 'true');
            tech.controls = true;
          }
        }
      } catch (_) {}

      player.src({ src: url, type: 'application/x-mpegURL' });
      // 部分站点用 srcs 数组
      try {
        if (player.srcs) player.srcs([url]);
      } catch (_) {}

      const tryPlay = () => {
        try {
          const p = player.play();
          if (p && p.catch) p.catch(() => {});
        } catch (_) {}
      };
      player.ready(() => {
        tryPlay();
        // 再亮一次控制条
        try {
          player.controls(true);
          player.userActive(true);
        } catch (_) {}
      });
      setTimeout(tryPlay, 200);
      setTimeout(tryPlay, 800);
      note('PLAYER-INJ', 'videojs:src', { url });
      return true;
    } catch (e) {
      note('PLAYER-INJ', 'videojs:error', String(e));
      return false;
    }
  }

  function findPlayersIn(win) {
    const found = [];
    try {
      const vjs = win.videojs;
      if (vjs) {
        if (vjs.players) {
          Object.keys(vjs.players).forEach((id) => {
            if (vjs.players[id]) found.push(vjs.players[id]);
          });
        }
        if (vjs.getAllPlayers) {
          vjs.getAllPlayers().forEach((p) => found.push(p));
        }
      }
      win.document?.querySelectorAll?.('video')?.forEach((v) => {
        if (v.player) found.push(v.player);
        // 裸 video 也收
        found.push({ __rawVideo: v });
      });
    } catch (_) {}
    return found;
  }

  let seamlessTimer = null;
  function seamlessPlay(url, meta = {}) {
    if (!url) return;
    SUITE.lastMediaM3u8 = url;
    note('PLAYER-INJ', 'seamless:start', { url, meta });

    let tries = 0;
    const maxTries = 40; // ~20s
    if (seamlessTimer) clearInterval(seamlessTimer);

    const tick = () => {
      tries++;
      let ok = false;
      eachWindow((w) => {
        try {
          hidePlayOverlays(w.document);
        } catch (_) {}
        const players = findPlayersIn(w);
        players.forEach((p) => {
          if (p && p.__rawVideo) {
            const v = p.__rawVideo;
            // 已有 videojs 实例则走 player
            if (v.player) {
              ok = applyToVideoJsPlayer(v.player, url) || ok;
            } else {
              try {
                v.controls = true;
                v.setAttribute('controls', 'true');
                // 原生 HLS (Safari) 或等 hls
                if (v.canPlayType('application/vnd.apple.mpegurl')) {
                  v.src = url;
                  v.play?.().catch(() => {});
                  ok = true;
                } else if (w.Hls && w.Hls.isSupported()) {
                  if (v.__hls) {
                    try {
                      v.__hls.destroy();
                    } catch (_) {}
                  }
                  const hls = new w.Hls();
                  v.__hls = hls;
                  hls.loadSource(url);
                  hls.attachMedia(v);
                  hls.on(w.Hls.Events.MANIFEST_PARSED, () => v.play?.().catch(() => {}));
                  ok = true;
                } else if (w.videojs) {
                  try {
                    const player = w.videojs(v, { controls: true, autoplay: true });
                    ok = applyToVideoJsPlayer(player, url) || ok;
                  } catch (_) {
                    v.src = url;
                  }
                } else {
                  v.src = url;
                }
              } catch (_) {}
            }
          } else if (p && typeof p.src === 'function') {
            ok = applyToVideoJsPlayer(p, url) || ok;
          }
        });
      });

      if (ok) {
        note('PLAYER-INJ', 'seamless:ok', { tries, url });
        // 再扫几次遮罩，防止 VIP 弹层晚出来
        setTimeout(() => eachWindow((w) => hidePlayOverlays(w.document)), 500);
        setTimeout(() => eachWindow((w) => hidePlayOverlays(w.document)), 1500);
        setTimeout(() => eachWindow((w) => hidePlayOverlays(w.document)), 3000);
        clearInterval(seamlessTimer);
        seamlessTimer = null;
      } else if (tries >= maxTries) {
        note('PLAYER-INJ', 'seamless:timeout-fallback-inplace', { url });
        clearInterval(seamlessTimer);
        seamlessTimer = null;
        playInPlace(url, meta);
      }
    };

    tick();
    seamlessTimer = setInterval(tick, 500);
  }

  // ════════════════════════════════════
  //  原播放位叠层播放器（优先覆盖 .player）
  // ════════════════════════════════════
  /** 在顶层 / 同源 iframe 中找站点原播放容器 */
  function findNativePlayerHost() {
    const selectors = [
      'div.player',
      '.video-js',
      '.player-box',
      '.play-box',
      '.video-box',
      '#player',
      '[class*="player-container"]'
    ];
    let best = null;
    let bestArea = 0;
    eachWindow((w) => {
      try {
        const doc = w.document;
        if (!doc) return;
        for (const sel of selectors) {
          doc.querySelectorAll(sel).forEach((el) => {
            const r = el.getBoundingClientRect();
            const area = Math.max(0, r.width) * Math.max(0, r.height);
            // 过滤不可见 / 过小节点
            if (area < 80 * 60) return;
            if (r.bottom < 0 || r.right < 0) return;
            // 优先明确 class=player，其次面积更大
            const score =
              area +
              (el.classList?.contains('player') ? 1e7 : 0) +
              (el.classList?.contains('video-js') ? 5e6 : 0);
            if (score > bestArea) {
              bestArea = score;
              best = { el, doc, win: w, rect: r, sel };
            }
          });
        }
        // 没有容器时，用已有 video 父节点
        if (!best) {
          doc.querySelectorAll('video').forEach((v) => {
            const host = v.closest('.video-js, .player, .player-box') || v.parentElement;
            if (!host) return;
            const r = host.getBoundingClientRect();
            const area = Math.max(0, r.width) * Math.max(0, r.height);
            if (area > bestArea) {
              bestArea = area;
              best = { el: host, doc, win: w, rect: r, sel: 'video-parent' };
            }
          });
        }
      } catch (_) {}
    });
    return best;
  }

  function ensureInPlaceStyle(doc) {
    if (!doc || doc.getElementById('defense-test-inplace-css')) return;
    const style = doc.createElement('style');
    style.id = 'defense-test-inplace-css';
    style.textContent = `
/* 原播放位叠层：盖住 VIP 遮罩，不改站内布局流 */
.player.defense-host-rel,
.video-js.defense-host-rel,
.player-box.defense-host-rel,
.play-box.defense-host-rel,
.video-box.defense-host-rel,
.defense-host-rel {
  position: relative !important;
}
#defense-test-player-panel.defense-inplace {
  position: absolute !important;
  inset: 0 !important;
  left: 0 !important;
  top: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
  max-height: none !important;
  z-index: 2147483000 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: #000 !important;
  box-shadow: none !important;
  overflow: hidden !important;
  display: block !important;
}
/* 原位播放不显示调试信息，只留视频 */
#defense-test-player-panel.defense-inplace #dtp-chrome,
#defense-test-player-panel.defense-inplace #dtp-meta,
#defense-test-player-panel.defense-inplace #dtp-status {
  display: none !important;
}
#defense-test-player-panel.defense-inplace #dtp-video {
  width: 100% !important;
  height: 100% !important;
  max-height: none !important;
  object-fit: contain;
  background: #000;
  display: block;
}
/* 兜底：找不到原播放位时用右下角（仍隐藏信息条） */
#defense-test-player-panel.defense-float {
  position: fixed !important;
  right: 12px !important;
  bottom: 12px !important;
  left: auto !important;
  top: auto !important;
  z-index: 2147483647 !important;
  width: 420px !important;
  max-width: 95vw !important;
  height: auto !important;
  background: #000 !important;
  color: #eee;
  border: 0 !important;
  border-radius: 8px !important;
  padding: 0 !important;
  box-shadow: 0 8px 30px rgba(0,0,0,.45) !important;
  overflow: hidden !important;
}
#defense-test-player-panel.defense-float #dtp-chrome,
#defense-test-player-panel.defense-float #dtp-meta,
#defense-test-player-panel.defense-float #dtp-status {
  display: none !important;
}
#defense-test-player-panel.defense-float #dtp-video {
  width: 100%;
  background: #000;
  max-height: 240px;
  display: block;
}
`.trim();
    (doc.head || doc.documentElement).appendChild(style);
  }

  /**
   * 创建/复用叠层面板。
   * 优先挂到原 .player 内 absolute 覆盖；找不到再退回顶层 fixed 右下角。
   */
  function ensurePanel(preferInPlace = true) {
    const hostInfo = preferInPlace ? findNativePlayerHost() : null;
    const targetDoc = hostInfo?.doc || document;
    const targetBody = targetDoc.body || targetDoc.documentElement;
    if (!targetBody) return null;

    ensureInPlaceStyle(targetDoc);
    // 若已在别的 document，先移除
    eachWindow((w) => {
      try {
        const old = w.document?.getElementById('defense-test-player-panel');
        if (old && old.ownerDocument !== targetDoc) old.remove();
      } catch (_) {}
    });

    function buildPanelEl(doc) {
      const el = doc.createElement('div');
      el.id = 'defense-test-player-panel';
      // 只保留 video，不渲染标题/URL/状态文案
      el.innerHTML =
        `<video id="dtp-video" controls playsinline webkit-playsinline ` +
        `x5-playsinline x5-video-player-type="h5" preload="auto"></video>`;
      prepareVideoEl(el.querySelector('#dtp-video'));
      return el;
    }

    let panel = targetDoc.getElementById('defense-test-player-panel');
    if (!panel) {
      panel = buildPanelEl(targetDoc);
    } else {
      // 兼容旧版面板 DOM：去掉信息条
      panel.querySelectorAll('#dtp-chrome, #dtp-meta, #dtp-status, #dtp-close').forEach((n) => n.remove());
      if (!panel.querySelector('#dtp-video')) {
        panel.innerHTML =
          `<video id="dtp-video" controls playsinline webkit-playsinline ` +
          `x5-playsinline x5-video-player-type="h5" preload="auto"></video>`;
      }
      prepareVideoEl(panel.querySelector('#dtp-video'));
    }

    if (preferInPlace && hostInfo?.el) {
      const host = hostInfo.el;
      host.classList.add('defense-host-rel');
      // 盖住 VIP error2 / 遮罩
      try {
        host.querySelectorAll('.error2, .error, .buy-popup, .player-ad').forEach((n) => {
          n.style.setProperty('display', 'none', 'important');
          n.style.setProperty('pointer-events', 'none', 'important');
        });
      } catch (_) {}
      if (panel.parentElement !== host) host.appendChild(panel);
      panel.classList.remove('defense-float');
      panel.classList.add('defense-inplace');
      panel.dataset.host = hostInfo.sel || 'player';
      note('PLAYER-INJ', 'panel:inplace', {
        sel: hostInfo.sel,
        w: Math.round(hostInfo.rect.width),
        h: Math.round(hostInfo.rect.height)
      });
    } else {
      // 调试浮层或找不到宿主：挂到顶层 body 右下角
      const topBody = document.body || document.documentElement;
      if (panel.ownerDocument !== document) {
        // 跨 document 不能直接 move，重建在顶层
        try {
          panel.remove();
        } catch (_) {}
        panel = buildPanelEl(document);
        ensureInPlaceStyle(document);
      }
      if (topBody && panel.parentElement !== topBody) topBody.appendChild(panel);
      panel.classList.remove('defense-inplace');
      panel.classList.add('defense-float');
      panel.dataset.host = preferInPlace ? 'float-fallback' : 'float-debug';
      note('PLAYER-INJ', 'panel:float', { reason: preferInPlace ? 'no-host' : 'debug' });
    }
    return panel;
  }

  const HLS_CDN_LIST = [
    'https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js',
    'https://unpkg.com/hls.js@1.5.7/dist/hls.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.7/hls.min.js'
  ];

  async function loadHlsLib(win) {
    const w = win || PAGE;
    if (w.Hls) return w.Hls;
    // 已在别窗加载过则复用引用
    try {
      if (PAGE.Hls) {
        w.Hls = PAGE.Hls;
        return w.Hls;
      }
    } catch (_) {}
    const doc = w.document || document;
    for (const src of HLS_CDN_LIST) {
      // 已有同 src script
      try {
        const existed = doc.querySelector(`script[src="${src}"]`);
        if (existed && w.Hls) return w.Hls;
      } catch (_) {}
      const ok = await new Promise((resolve) => {
        try {
          const s = doc.createElement('script');
          s.src = src;
          s.async = true;
          s.onload = () => resolve(true);
          s.onerror = () => resolve(false);
          (doc.head || doc.documentElement).appendChild(s);
        } catch (_) {
          resolve(false);
        }
      });
      if (ok && w.Hls) return w.Hls;
      // 等一拍：部分 WebView onload 早于全局挂载
      await new Promise((r) => setTimeout(r, 50));
      if (w.Hls) return w.Hls;
    }
    return w.Hls || null;
  }

  async function playFloat(url, meta = {}) {
    // 兼容旧名：现在默认原播放位叠层
    return playInPlace(url, meta);
  }

  async function playInPlace(url, meta = {}) {
    if (!url) return;
    if (!document.body) {
      await new Promise((r) => {
        document.addEventListener('DOMContentLoaded', r, { once: true });
        setTimeout(r, 1500);
      });
    }

    // 等路由/详情渲染出 .player
    let panel = null;
    for (let i = 0; i < 20 && !panel; i++) {
      panel = ensurePanel(true);
      if (panel?.classList?.contains('defense-inplace')) break;
      if (i < 19) await new Promise((r) => setTimeout(r, 250));
      panel = ensurePanel(true);
    }
    if (!panel) return;

    const doc = panel.ownerDocument;
    const win = doc.defaultView || PAGE;
    const video = panel.querySelector('#dtp-video');
    if (!video) return;
    prepareVideoEl(video);

    // 解锁同文档遮罩
    try {
      unlockPlayerUI(doc);
    } catch (_) {}

    const HlsLib = await loadHlsLib(win);
    if (video.__hls) {
      try {
        video.__hls.destroy();
      } catch (_) {}
      video.__hls = null;
    }

    const tryPlay = () => {
      try {
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      } catch (_) {}
    };

    // iOS Safari / 部分 WebView：原生 HLS 优先（hls.js MSE 不稳或禁用）
    const canNative =
      !!video.canPlayType &&
      (!!video.canPlayType('application/vnd.apple.mpegurl') ||
        !!video.canPlayType('application/x-mpegURL'));

    if (canNative && (IS_MOBILE || !HlsLib || !HlsLib.isSupported?.())) {
      video.src = url;
      tryPlay();
      // 用户手势后再点一次（iOS 策略）
      const once = () => tryPlay();
      doc.addEventListener('touchend', once, { once: true, passive: true });
      doc.addEventListener('click', once, { once: true });
    } else if (HlsLib && HlsLib.isSupported()) {
      const hls = new HlsLib({
        enableWorker: true,
        // 手机省内存
        maxBufferLength: IS_MOBILE ? 20 : 30
      });
      video.__hls = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(HlsLib.Events.MANIFEST_PARSED, () => tryPlay());
      hls.on(HlsLib.Events.ERROR, (_, d) => {
        note('PLAYER-INJ', 'inplace:hls-error', {
          details: d?.details || d?.type || ''
        });
        // 致命错误时尝试原生兜底
        if (d?.fatal && canNative) {
          try {
            hls.destroy();
          } catch (_) {}
          video.__hls = null;
          video.src = url;
          tryPlay();
        }
      });
    } else {
      video.src = url;
      tryPlay();
    }
    note('PLAYER-INJ', 'inplace:start', {
      url,
      host: panel.dataset.host,
      vodid: meta.vodid,
      mobile: IS_MOBILE
    });
  }

  function playM3u8(url, meta) {
    // 立刻盖在原 .player 上；同时尝试灌站内 videojs
    playInPlace(url, meta || {});
    seamlessPlay(url, meta || {});
  }

  // ════════════════════════════════════
  //  CDN 探测
  // ════════════════════════════════════
  function authHeaders() {
    let token = '';
    try {
      token = localStorage.getItem('xxx_api_auth') || '';
    } catch (_) {}
    return {
      Accept: 'application/json',
      'X-Cookie-Auth': token,
      'x-channel': 'h5',
      'x-system': 'H5',
      'x-version': '1.0.0'
    };
  }

  async function getText(url) {
    try {
      const r = await fetch(url, { credentials: 'omit' });
      const text = await r.text();
      return { status: r.status, text, len: text.length };
    } catch (e) {
      return { status: -1, error: String(e), text: '', len: 0 };
    }
  }

  async function probeVod(vodid) {
    const report = {
      vodid,
      ts: new Date().toISOString(),
      steps: [],
      leak: false,
      hardeningHints: [],
      ok: true
    };
    const showUrl = `${API_BASE}/api/vod/show/${vodid}`;
    let showJson;
    try {
      const showRes = await fetch(showUrl, {
        headers: authHeaders(),
        credentials: 'include'
      });
      showJson = await showRes.json();
    } catch (e) {
      report.ok = false;
      report.error = String(e);
      SUITE.lastProbe = report;
      return report;
    }
    const row = showJson?.data?.vodrow || {};
    report.steps.push({
      step: 'detail',
      isvip: row.isvip,
      play_url: row.play_url,
      preview_url: row.preview_url
    });
    if (!row.preview_url) {
      report.hardeningHints.push('无 preview_url');
      SUITE.lastProbe = report;
      return report;
    }

    const playPath = row.play_url || `/vod/reqplay/${vodid}`;
    const reqUrl = `${API_BASE}/api${playPath.startsWith('/') ? playPath : '/' + playPath}`;
    try {
      const reqJson = await (
        await fetch(reqUrl, { headers: authHeaders(), credentials: 'include' })
      ).json();
      report.steps.push({
        step: 'reqplay',
        retcode: reqJson.retcode,
        errmsg: reqJson.errmsg,
        httpurl: reqJson?.data?.httpurl || null
      });
    } catch (e) {
      report.steps.push({ step: 'reqplay', error: String(e) });
    }

    const prev = await getText(row.preview_url);
    report.steps.push({
      step: 'preview',
      status: prev.status,
      hasKey: /#EXT-X-KEY/i.test(prev.text || '')
    });
    const esc = escalateFromPreviewM3U8(prev.text || '', row.preview_url);
    report.steps.push({ step: 'parse', ...esc });
    if (!esc.ok) {
      SUITE.lastProbe = report;
      return report;
    }

    const master = await getText(esc.master);
    const key = await getText(esc.keyUri);
    const masterIsFull =
      master.status === 200 &&
      /#EXTM3U/i.test(master.text || '') &&
      (/EXT-X-STREAM-INF/i.test(master.text || '') || /#EXTINF/i.test(master.text || ''));

    let mediaLines = 0;
    let mediaUrl = esc.master;
    if (masterIsFull) {
      const resolved = await resolveMediaFromMaster(esc.master);
      mediaUrl = resolved.media;
      const media = await getText(mediaUrl);
      mediaLines = (media.text || '').split('\n').length;
      report.steps.push({ step: 'media', url: mediaUrl, status: media.status, lines: mediaLines });
    }
    report.steps.push({ step: 'master', url: esc.master, status: master.status });
    report.steps.push({ step: 'key', url: esc.keyUri, status: key.status, len: key.len });

    const previewLines = (prev.text || '').split('\n').length;
    report.leak =
      masterIsFull &&
      key.status === 200 &&
      (mediaLines === 0 || mediaLines > Math.max(previewLines * 2, 200));
    report.metrics = { previewLines, mediaLines, masterIsFull };
    report.ok = !report.leak;
    report.hardeningHints.push(
      report.leak
        ? 'CRITICAL: 可匿名上溯完整正片'
        : '未检测到完整正片匿名泄漏'
    );

    if (report.leak) {
      SUITE.lastFullM3u8 = esc.master;
      SUITE.lastMediaM3u8 = mediaUrl;
      SUITE.lastKey = esc.keyUri;
      if (CFG.autoPlay) {
        const detail = { vodid, fullM3u8: esc.master };
        playInPlace(mediaUrl, detail);
        seamlessPlay(mediaUrl, detail);
      }
    }
    SUITE.lastProbe = report;
    note('CDN-PROBE', report.leak ? 'LEAK' : 'OK', report);
    console.log('%c[CDN-PROBE]', 'color:#f05f96;font-weight:bold', report);
    return report;
  }

  // ════════════════════════════════════
  //  网络 hook
  // ════════════════════════════════════
  async function onShowPayload(data) {
    const row = data?.vodrow || data?.data?.vodrow || data;
    if (!row || !row.preview_url) return;
    SUITE.lastDetail = {
      vodid: row.vodid,
      isvip: row.isvip,
      need_buy: row.need_buy,
      play_url: row.play_url,
      preview_url: row.preview_url
    };
    note('VIP-ESC', 'detail:captured', SUITE.lastDetail);
    if (!CFG.vipEsc) return;
    if (
      CFG.forceEscalateAll ||
      String(row.isvip) === '1' ||
      Number(row.need_buy) === 1
    ) {
      await tryEscalate(row.preview_url, { vodid: row.vodid, isvip: row.isvip });
    }
  }

  function hookFetchOn(win) {
    if (!win || win.__DEFENSE_FETCH_HOOKED__) return;
    const _fetch = win.fetch;
    if (typeof _fetch !== 'function') return;
    win.__DEFENSE_FETCH_HOOKED__ = true;
    win.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input?.url || '';
      const res = await _fetch.apply(this, arguments);

      if (CFG.ad && CFG.stripInitAds && /\/api\/init\b/.test(url) && SUITE.__stripAdsFromInit) {
        try {
          const data = SUITE.__stripAdsFromInit(await res.clone().json());
          return new win.Response(JSON.stringify(data), {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers
          });
        } catch (_) {
          return res;
        }
      }

      if (CFG.vipEsc) {
        try {
          if (/\/(?:api\/)?(?:v2\/)?vod\/show\//.test(url)) {
            const json = await res.clone().json();
            onShowPayload(json?.data || json);
          }
          if (/reqplay\//.test(url)) {
            const json = await res.clone().json();
            if (json && json.retcode && json.retcode !== 0) {
              note('VIP-ESC', 'reqplay:denied', {
                retcode: json.retcode,
                errmsg: json.errmsg
              });
              if (SUITE.lastDetail?.preview_url) {
                await tryEscalate(SUITE.lastDetail.preview_url, SUITE.lastDetail);
              }
            } else if (json?.data?.httpurl) {
              note('VIP-ESC', 'reqplay:ok', { httpurl: json.data.httpurl });
              if (CFG.forceEscalateAll && SUITE.lastDetail?.preview_url) {
                await tryEscalate(SUITE.lastDetail.preview_url, SUITE.lastDetail);
              }
            }
          }
        } catch (_) {}
      }
      return res;
    };
  }

  function hookXhrOn(win) {
    if (!win || win.__DEFENSE_XHR_HOOKED__) return;
    const XHR = win.XMLHttpRequest;
    if (!XHR || !XHR.prototype) return;
    win.__DEFENSE_XHR_HOOKED__ = true;
    const XO = XHR.prototype.open;
    const XS = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__def_url = url;
      return XO.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      const url = this.__def_url || '';
      if (CFG.ad && CFG.stripInitAds && /\/api\/init\b/.test(url) && SUITE.__stripAdsFromInit) {
        this.addEventListener('readystatechange', function () {
          if (this.readyState === 4 && this.responseText) {
            try {
              const data = SUITE.__stripAdsFromInit(JSON.parse(this.responseText));
              const text = JSON.stringify(data);
              Object.defineProperty(this, 'responseText', { get: () => text });
              Object.defineProperty(this, 'response', { get: () => text });
            } catch (_) {}
          }
        });
      }
      if (CFG.vipEsc) {
        this.addEventListener('load', function () {
          try {
            if (!this.responseText) return;
            const json = JSON.parse(this.responseText);
            if (/vod\/show\//.test(url)) onShowPayload(json?.data || json);
            if (/reqplay\//.test(url) && json?.retcode && json.retcode !== 0) {
              if (SUITE.lastDetail?.preview_url) {
                tryEscalate(SUITE.lastDetail.preview_url, SUITE.lastDetail);
              }
            }
          } catch (_) {}
        });
      }
      return XS.apply(this, arguments);
    };
  }

  function installNetworkHooks() {
    // 页面窗 + 同源 iframe 都 hook（PC 壳 / 手机直出）
    const apply = () => {
      eachWindow((w) => {
        try {
          hookFetchOn(w);
          hookXhrOn(w);
        } catch (_) {}
      });
    };
    apply();
    // iframe 晚创建时补 hook
    setInterval(apply, 2000);
  }

  function reportSummary() {
    const r = {
      version: SUITE.version,
      config: { ...CFG },
      env: { ...SUITE.env, href: String(PAGE.location?.href || '') },
      lastDetail: SUITE.lastDetail,
      lastFullM3u8: SUITE.lastFullM3u8,
      lastMediaM3u8: SUITE.lastMediaM3u8,
      lastKey: SUITE.lastKey,
      lastProbeLeak: SUITE.lastProbe?.leak,
      recent: SUITE.events.slice(-20)
    };
    try {
      console.log('%c[SUITE] report', 'color:#0f0;font-weight:bold', r);
    } catch (_) {
      log('SUITE', 'report', r);
    }
    return r;
  }

  function installHotkeys() {
    if (!CFG.probeHotkey) return;
    const onKey = (e) => {
      if (e.altKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        probeVod(SUITE.lastDetail?.vodid || currentVodId() || '82617');
      }
      if (e.altKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
        e.preventDefault();
        reportSummary();
      }
    };
    try {
      PAGE.addEventListener('keydown', onKey, true);
    } catch (_) {}
    try {
      window.addEventListener('keydown', onKey, true);
    } catch (_) {}
  }

  /** SPA / 手机 hash 路由：换片后重挂叠层 */
  function installRouteWatch() {
    if (!CFG.routeWatch) return;
    let lastSig = '';
    const tick = () => {
      try {
        const vod = currentVodId(PAGE) || currentVodId(window) || '';
        const href = String(PAGE.location?.href || location.href || '');
        const sig = vod + '|' + (PAGE.location?.hash || location.hash || '');
        if (sig && sig !== lastSig) {
          const prev = lastSig;
          lastSig = sig;
          SUITE.env.href = href;
          note('ROUTE', 'change', { from: prev, to: sig, vod: vod || null });
          // 已有完整流：换到同站新片时清掉旧叠层，等新 show 接口
          if (prev && vod && String(SUITE.lastDetail?.vodid || '') !== String(vod)) {
            eachWindow((w) => {
              try {
                w.document
                  ?.getElementById?.('defense-test-player-panel')
                  ?.remove();
              } catch (_) {}
            });
          }
          // 若当前页已有完整流缓存且 vod 对得上，补挂
          if (
            CFG.autoPlay &&
            SUITE.lastMediaM3u8 &&
            (!vod || String(SUITE.lastDetail?.vodid || '') === String(vod))
          ) {
            playInPlace(SUITE.lastMediaM3u8, SUITE.lastDetail || { vodid: vod });
          }
        }
        // 详情页 .player 晚渲染：有流但面板丢了就补
        if (CFG.autoPlay && SUITE.lastMediaM3u8) {
          let hasPanel = false;
          eachWindow((w) => {
            try {
              if (w.document?.getElementById('defense-test-player-panel')) hasPanel = true;
            } catch (_) {}
          });
          if (!hasPanel && /#\/(?:video|vod|play)\//i.test(href)) {
            playInPlace(SUITE.lastMediaM3u8, SUITE.lastDetail || {});
          }
        }
      } catch (_) {}
    };
    const bind = (w) => {
      try {
        w.addEventListener('hashchange', tick);
        w.addEventListener('popstate', tick);
        w.addEventListener('pageshow', tick);
      } catch (_) {}
    };
    bind(PAGE);
    bind(window);
    // Vue/history 路由不一定触发 hashchange
    setInterval(tick, 1200);
    // 首次
    setTimeout(tick, 300);
  }

  function exportApi(target) {
    if (!target) return;
    try {
      target.__DEFENSE__ = SUITE;
      target.__VIP_ESC__ = SUITE;
      target.__playFullM3u8__ = playM3u8;
      target.probeVod = probeVod;
    } catch (_) {}
  }

  SUITE.probe = (u) => tryEscalate(u || SUITE.lastDetail?.preview_url, { manual: true });
  SUITE.probeVod = probeVod;
  SUITE.play = playM3u8;
  SUITE.seamless = seamlessPlay;
  SUITE.playInPlace = playInPlace;
  SUITE.report = reportSummary;
  SUITE.escalate = escalateFromPreviewM3U8;
  SUITE.currentVodId = currentVodId;

  exportApi(PAGE);
  exportApi(window);
  try {
    if (PAGE.top && PAGE.top !== PAGE) exportApi(PAGE.top);
  } catch (_) {}

  installAdWipe();
  installNetworkHooks();
  installHotkeys();
  installRouteWatch();

  try {
    PAGE.addEventListener('vip-esc-ready', (ev) => {
      const d = ev.detail || {};
      if ((d.mediaM3u8 || d.fullM3u8) && CFG.autoPlay) {
        playInPlace(d.mediaM3u8 || d.fullM3u8, d);
      }
    });
  } catch (_) {}

  log(
    'SUITE',
    `ALL-IN-ONE v${SUITE.version} | eng=${SUITE.env.engine} mobile=${IS_MOBILE} listAd=${CFG.ad} vipEsc=${CFG.vipEsc} autoPlay=${CFG.autoPlay}`
  );
  log(
    'SUITE',
    'API: __DEFENSE__.probeVod(id) | .play(m3u8) | .playInPlace(m3u8) | .report()'
  );
  log(
    'SUITE',
    'Managers: Tampermonkey/Violentmonkey/ScriptCat/Userscripts/Stay | 手机开 index.html 或 pc.html 均可'
  );
})();
