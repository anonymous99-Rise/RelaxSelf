// ==UserScript==
// @name         糖心Vlog 浏览器下载 (tangxinvlog.pro)
// @namespace    local.txvlog.dl
// @version      2.3.0
// @description  浏览器内直接下载 HLS 影片（AES-128 解密，边下边写 .ts）
// @match        https://tangxinvlog.pro/*
// @match        http://tangxinvlog.pro/*
// @connect      t.5gcdn.xyz
// @connect      5gcdn.xyz
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const REFERER = 'https://tangxinvlog.pro/';
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
  /** 并发下载数；浏览器里再高收益有限，且易触发限速 */
  const CONCURRENCY = 12;
  /** 内存中最多缓存多少个「已下未写」的分片，防止长视频 OOM */
  const MAX_BUFFERED = 36;

  const state = { abort: false, running: false };

  function gmXhr() {
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
    if (typeof GM !== 'undefined' && GM.xmlHttpRequest) return GM.xmlHttpRequest;
    return null;
  }

  function gmRequest(opts) {
    const req = gmXhr();
    if (!req) {
      return Promise.reject(
        new Error('需要 Tampermonkey / Violentmonkey（GM_xmlhttpRequest）')
      );
    }
    return new Promise((resolve, reject) => {
      req({
        method: opts.method || 'GET',
        url: opts.url,
        headers: Object.assign(
          { Referer: REFERER, 'User-Agent': UA, Accept: '*/*' },
          opts.headers || {}
        ),
        responseType: opts.responseType || 'arraybuffer',
        timeout: opts.timeout || 120000,
        onload(res) {
          if (res.status >= 200 && res.status < 300) resolve(res);
          else reject(new Error(`HTTP ${res.status}`));
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  async function gmGetText(url) {
    const res = await gmRequest({ url, responseType: 'text' });
    return typeof res.response === 'string'
      ? res.response
      : new TextDecoder('utf-8').decode(res.response);
  }

  async function gmGetBuffer(url) {
    const res = await gmRequest({ url, responseType: 'arraybuffer' });
    return res.response;
  }

  function getM3u8() {
    const v = document.getElementById('player');
    if (v) {
      return (
        v.dataset.src ||
        v.getAttribute('data-src') ||
        v.currentSrc ||
        v.src ||
        ''
      );
    }
    const m = document.documentElement.innerHTML.match(
      /https?:\/\/[^"'\\\s>]+\.m3u8[^"'\\\s>]*/i
    );
    return m ? m[0] : '';
  }

  function getTitle() {
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent.trim()) return h1.textContent.trim();
    return (document.title || 'video').split(/[·|]/)[0].trim();
  }

  function safeName(name) {
    return (
      (name || 'video')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'video'
    );
  }

  function absUrl(base, rel) {
    try {
      return new URL(rel, base).href;
    } catch {
      return rel;
    }
  }

  function parseM3u8(text, baseUrl) {
    let keyUri = null;
    let ivHex = null;
    const segs = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-KEY:')) {
        const um = line.match(/URI="([^"]+)"/);
        const im = line.match(/IV=0x([0-9A-Fa-f]+)/i);
        if (um) keyUri = absUrl(baseUrl, um[1]);
        if (im) ivHex = im[1];
      } else if (!line.startsWith('#')) {
        segs.push(absUrl(baseUrl, line));
      }
    }
    return { keyUri, ivHex, segs };
  }

  function hexToBytes(hex) {
    const clean = hex.replace(/^0x/i, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
  }

  async function importAesKey(rawKey) {
    return crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, [
      'decrypt',
    ]);
  }

  async function decryptSegment(buf, cryptoKey, iv) {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv },
      cryptoKey,
      buf
    );
    return new Uint8Array(plain);
  }

  function copyText(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text);
      return Promise.resolve();
    }
    return navigator.clipboard.writeText(text);
  }

  function notify(title, text) {
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title, text, timeout: 4500 });
      }
    } catch (_) {}
  }

  function setStatus(ui, msg, pct) {
    if (ui.status) ui.status.textContent = msg;
    if (ui.bar && typeof pct === 'number') {
      const p = Math.max(0, Math.min(100, pct));
      ui.bar.style.width = p + '%';
      ui.pct.textContent = Math.floor(p) + '%';
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 油猴沙箱里要用页面 window，否则 showSaveFilePicker 会 Illegal invocation */
  function pageWindow() {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow;
    } catch (_) {}
    return window;
  }

  /**
   * 正确绑定 this 调用 File System Access API。
   * 失败返回 null（调用方走 Blob 回退）；用户取消选文件则抛 AbortError。
   */
  async function tryShowSaveFilePicker(filename) {
    const w = pageWindow();
    const pick = w.showSaveFilePicker;
    if (typeof pick !== 'function') return null;

    try {
      // 必须 .call(w)，不能 window.showSaveFilePicker(...) 在沙箱里裸调
      return await pick.call(w, {
        suggestedName: filename,
        types: [
          {
            description: 'MPEG-TS Video',
            accept: {
              'video/mp2t': ['.ts'],
              'application/octet-stream': ['.ts'],
            },
          },
        ],
      });
    } catch (e) {
      // 用户关闭「另存为」对话框
      if (e && e.name === 'AbortError') throw e;
      // Illegal invocation / 跨沙箱 / 权限等 → 回退 Blob
      console.warn('[txvlog-dl] showSaveFilePicker 不可用，改用 Blob 下载:', e);
      return null;
    }
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      const doc = pageWindow().document || document;
      const a = doc.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      a.style.display = 'none';
      (doc.body || doc.documentElement).appendChild(a);
      // 部分环境 click() 无效，用 MouseEvent
      a.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: pageWindow() })
      );
      setTimeout(() => {
        try {
          a.remove();
        } catch (_) {}
        URL.revokeObjectURL(url);
      }, 60_000);
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }

  /**
   * 边下边写：多线程下载解密，按序号写入文件，控制内存中未写入分片数量。
   */
  async function downloadPipeline(segs, cryptoKey, iv, writable, onProgress) {
    const total = segs.length;
    const buffer = new Map(); // idx -> Uint8Array
    let nextWrite = 0;
    let nextFetch = 0;
    let finished = 0;
    let active = 0;
    let writeChain = Promise.resolve();
    let fatal = null;

    function checkAbort() {
      if (state.abort) throw new Error('已取消');
      if (fatal) throw fatal;
    }

    async function writeLoopPump() {
      // 串行写，保证顺序
      while (nextWrite < total && buffer.has(nextWrite)) {
        checkAbort();
        const data = buffer.get(nextWrite);
        buffer.delete(nextWrite);
        await writable.write(data);
        nextWrite++;
        finished++;
        onProgress(finished, total, buffer.size, active);
      }
    }

    function scheduleWrite() {
      writeChain = writeChain.then(writeLoopPump).catch((e) => {
        fatal = e;
      });
      return writeChain;
    }

    async function fetchOne(idx) {
      checkAbort();
      const url = segs[idx];
      let buf = await gmGetBuffer(url);
      if (cryptoKey) {
        buf = await decryptSegment(buf, cryptoKey, iv);
      } else {
        buf = new Uint8Array(buf);
      }
      buffer.set(idx, buf);
      await scheduleWrite();
    }

    async function worker() {
      while (true) {
        checkAbort();
        // 背压：缓冲太多时等待写入
        while (buffer.size >= MAX_BUFFERED) {
          checkAbort();
          await scheduleWrite();
          await sleep(30);
        }
        if (nextFetch >= total) return;
        const idx = nextFetch++;
        active++;
        try {
          await fetchOne(idx);
        } finally {
          active--;
        }
        onProgress(finished, total, buffer.size, active);
      }
    }

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, total) },
      () => worker()
    );
    await Promise.all(workers);
    await scheduleWrite();
    checkAbort();

    if (nextWrite !== total) {
      throw new Error(`写入未完成 ${nextWrite}/${total}`);
    }
  }

  /** 无 FS API 时：仍用管道逻辑，最后拼 Blob（可能较吃内存） */
  async function downloadToBlob(segs, cryptoKey, iv, onProgress) {
    const total = segs.length;
    const parts = new Array(total);
    let done = 0;
    let i = 0;

    async function worker() {
      while (true) {
        if (state.abort) throw new Error('已取消');
        const idx = i++;
        if (idx >= total) return;
        let buf = await gmGetBuffer(segs[idx]);
        if (cryptoKey) buf = await decryptSegment(buf, cryptoKey, iv);
        else buf = new Uint8Array(buf);
        parts[idx] = buf;
        done++;
        onProgress(done, total, 0, 0);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker())
    );
    return new Blob(parts, { type: 'video/mp2t' });
  }

  async function downloadVideo(ui) {
    if (state.running) return;
    state.running = true;
    state.abort = false;
    ui.btnDl.disabled = true;
    ui.btnCancel.disabled = false;

    try {
      if (!gmXhr()) {
        throw new Error('请用 Tampermonkey 安装本脚本（需要跨域权限）');
      }

      const m3u8Url = getM3u8();
      if (!m3u8Url) throw new Error('未找到 m3u8，请打开具体视频页');

      const title = safeName(getTitle());
      const filename = `${title}.ts`;
      setStatus(ui, '拉取播放列表…', 0);

      const playlist = await gmGetText(m3u8Url);
      const { keyUri, ivHex, segs } = parseM3u8(playlist, m3u8Url);
      if (!segs.length) throw new Error('播放列表没有分片');

      let cryptoKey = null;
      let iv = null;
      if (keyUri) {
        setStatus(ui, '下载解密密钥…', 1);
        const keyBuf = await gmGetBuffer(keyUri);
        cryptoKey = await importAesKey(keyBuf);
        iv = ivHex ? hexToBytes(ivHex) : new Uint8Array(16);
      }

      const t0 = Date.now();
      const onProgress = (finished, total) => {
        const pct = 3 + (finished / total) * 95;
        const elapsed = (Date.now() - t0) / 1000;
        const rate = finished > 0 ? (finished / elapsed).toFixed(1) : '0';
        setStatus(
          ui,
          `下载中 ${finished}/${total}（${rate} 片/秒）· 可取消`,
          pct
        );
      };

      // 1) 尝试「另存为」边下边写（省内存）
      // 2) 失败（含 Illegal invocation）自动回退 Blob 下载
      setStatus(ui, '尝试打开保存对话框…', 2);
      let handle = null;
      try {
        handle = await tryShowSaveFilePicker(filename);
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        handle = null;
      }

      if (handle) {
        const writable = await handle.createWritable();
        try {
          setStatus(ui, `边下边写 ${segs.length} 个分片…`, 3);
          await downloadPipeline(segs, cryptoKey, iv, writable, onProgress);
          await writable.close();
        } catch (e) {
          try {
            await writable.abort();
          } catch (_) {}
          throw e;
        }
      } else {
        setStatus(
          ui,
          `Blob 模式下载 ${segs.length} 片（完成后自动弹出保存）…`,
          3
        );
        const blob = await downloadToBlob(segs, cryptoKey, iv, onProgress);
        setStatus(ui, '触发浏览器保存…', 99);
        triggerBlobDownload(blob, filename);
      }

      setStatus(ui, `完成：${filename}`, 100);
      notify('下载完成', filename);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      // 用户取消选文件
      if (e && e.name === 'AbortError') {
        setStatus(ui, '已取消保存对话框', 0);
      } else {
        setStatus(ui, `失败：${msg}`, 0);
        if (msg !== '已取消') {
          console.error('[txvlog-dl]', e);
          notify('下载失败', msg);
        }
      }
    } finally {
      state.running = false;
      ui.btnDl.disabled = false;
      ui.btnCancel.disabled = true;
    }
  }

  function buildPanel(m3u8) {
    if (document.getElementById('txvlog-dl-panel')) return;

    const style = document.createElement('style');
    style.textContent = `
      #txvlog-dl-panel{
        position:fixed;right:12px;bottom:12px;z-index:2147483646;
        width:330px;padding:12px;border-radius:12px;
        background:rgba(18,18,24,.96);color:#f3f3f3;
        border:1px solid #4a4a58;font:12px/1.45 system-ui,sans-serif;
        box-shadow:0 10px 30px rgba(0,0,0,.4);
      }
      #txvlog-dl-panel .txh{font-weight:700;color:#ffb4c8;margin-bottom:6px;font-size:13px}
      #txvlog-dl-panel .txu{font-size:10px;opacity:.8;word-break:break-all;max-height:40px;overflow:auto;margin-bottom:8px}
      #txvlog-dl-panel .bar-wrap{height:8px;background:#2a2a34;border-radius:99px;overflow:hidden;margin:8px 0 4px}
      #txvlog-dl-panel .bar{height:100%;width:0;background:linear-gradient(90deg,#ff6b9d,#c44dff);transition:width .12s}
      #txvlog-dl-panel .row{display:flex;justify-content:space-between;opacity:.9;margin-bottom:8px}
      #txvlog-dl-panel .status{min-height:34px;opacity:.92;margin-bottom:6px}
      #txvlog-dl-panel button{
        display:inline-block;margin:3px 3px 0 0;padding:7px 10px;border:0;border-radius:8px;
        background:#3a3a48;color:#fff;cursor:pointer;font-size:12px
      }
      #txvlog-dl-panel button.primary{background:#c43b6e}
      #txvlog-dl-panel button:hover{filter:brightness(1.08)}
      #txvlog-dl-panel button:disabled{opacity:.45;cursor:not-allowed}
      #txvlog-dl-panel .hint{font-size:10px;opacity:.68;margin-top:8px}
    `;
    document.documentElement.appendChild(style);

    const box = document.createElement('div');
    box.id = 'txvlog-dl-panel';
    box.innerHTML = `
      <div class="txh">TX 浏览器下载</div>
      <div class="txu"></div>
      <div class="status">就绪 · 点「下载影片」即可在浏览器内保存</div>
      <div class="bar-wrap"><div class="bar"></div></div>
      <div class="row"><span class="pct">0%</span><span></span></div>
      <div>
        <button class="primary btn-dl">下载影片</button>
        <button class="btn-cancel" disabled>取消</button>
        <button class="btn-copy-m3u8">复制 m3u8</button>
      </div>
      <div class="hint">
        推荐 Chrome / Edge：会弹出「另存为」（边下边写，省内存）。<br>
        保存为 <b>.ts</b>，用 VLC / PotPlayer 打开即可。<br>
        首次运行若弹跨域权限，请点「始终允许」。
      </div>
    `;
    document.documentElement.appendChild(box);
    box.querySelector('.txu').textContent = m3u8;

    const ui = {
      status: box.querySelector('.status'),
      bar: box.querySelector('.bar'),
      pct: box.querySelector('.pct'),
      btnDl: box.querySelector('.btn-dl'),
      btnCancel: box.querySelector('.btn-cancel'),
    };

    box.querySelector('.btn-copy-m3u8').onclick = async (e) => {
      await copyText(m3u8);
      const t = e.currentTarget;
      t.textContent = '已复制';
      setTimeout(() => (t.textContent = '复制 m3u8'), 1000);
    };
    ui.btnCancel.onclick = () => {
      state.abort = true;
      setStatus(ui, '正在取消…');
    };
    ui.btnDl.onclick = () => downloadVideo(ui);
  }

  function boot() {
    const m3u8 = getM3u8();
    if (!m3u8) return false;
    buildPanel(m3u8);
    return true;
  }

  if (!boot()) {
    const t = setInterval(() => {
      if (boot()) clearInterval(t);
    }, 600);
    setTimeout(() => clearInterval(t), 20000);
  }
})();
