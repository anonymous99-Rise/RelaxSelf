// ==UserScript==
// @name         SKBJ VIP/付费解锁 POC (蓝队)
// @namespace    local.skbj.unlock
// @version      1.2.0
// @description  Gallery path oracle：视频多扩展名；图片/GIF/WebP 去 blur 网格弹窗；主站 VIP playback 探测
// @author       blue-team
// @match        https://skbj.tv/*
// @match        https://*.skbj.tv/*
// @run-at       document-start
// @grant        none
// @icon         https://www.google.com/s2/favicons?sz=64&domain=skbj.tv
// ==/UserScript==

(function () {
  "use strict";

  const NAME = "SKBJ Unlock";
  const VER = "1.2.0";
  const log = (...a) => console.log(`[${NAME}]`, ...a);
  const warn = (...a) => console.warn(`[${NAME}]`, ...a);

  // 真视频容器（不含 gif 伴生 -vid.mp4）
  const VIDEO_EXTS = [".mp4", ".mov", ".mkv", ".m4v", ".webm", ".MP4", ".MOV", ".MKV"];
  const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".JPG", ".PNG", ".GIF", ".WEBP"];

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function toast(msg, ms = 3500) {
    let t = document.getElementById("skbj-unlock-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "skbj-unlock-toast";
      t.style.cssText =
        "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;background:#111;color:#fbbf24;border:1px solid #f59e0b;padding:8px 14px;border-radius:999px;font:12px system-ui;max-width:92vw;box-shadow:0 8px 24px rgba(0,0,0,.4)";
      document.documentElement.appendChild(t);
    }
    t.textContent = msg;
    clearTimeout(t._tm);
    t._tm = setTimeout(() => t.remove(), ms);
  }

  function galleryBaseFromThumb(thumbUrl) {
    if (!thumbUrl || typeof thumbUrl !== "string") return null;
    if (!/skbj\.b-cdn\.net\/gallery\//i.test(thumbUrl)) return null;
    const u = thumbUrl.split("?")[0];
    // 标准 snapshot：…-0_s1.webp
    let m = u.match(/^(https?:\/\/skbj\.b-cdn\.net\/gallery\/.+?)_s\d+\.(webp|jpg|jpeg|png)$/i);
    if (m) return m[1];
    // 不要用 poster_thumb 当视频 stem（会误探）
    if (/poster_thumb|[-_]thumb\./i.test(u)) return null;
    return null;
  }

  function unblurBase(url) {
    if (!url || typeof url !== "string") return null;
    const u = url.split("?")[0];
    if (!/_blur\./i.test(u)) return null;
    return u.replace(/_blur\.(webp|jpg|jpeg|png)$/i, "");
  }

  function isBlurUrl(url) {
    return /_blur\./i.test(url || "");
  }

  /** 真视频：mp4/mov/mkv… 但排除站内 gif 伴生 *-vid.mp4 */
  function isRealVideoUrl(url) {
    if (!url) return false;
    if (/-vid\.mp4(\?|$)/i.test(url)) return false;
    return /\.(mp4|mov|mkv|m4v|webm)(\?|$)/i.test(url);
  }

  function isGifCompanionMp4(url) {
    return /-vid\.mp4(\?|$)/i.test(url || "");
  }

  function isImageLikeUrl(url) {
    return /\.(gif|webp|jpe?g|png)(\?|$)/i.test(url || "");
  }

  /** visual = 用网格展示（图/GIF/webp/伴生短 mp4） */
  function isVisualHit(h) {
    const url = h?.url || "";
    if (isImageLikeUrl(url) || isGifCompanionMp4(url)) return true;
    if (h.kind === "image" || h.kind === "gif" || h.kind === "gif-mp4") return true;
    if (h.kind === "video" && isRealVideoUrl(url)) return false;
    return !isRealVideoUrl(url);
  }

  function probeMedia(url, timeoutMs = 5000) {
    return new Promise((resolve) => {
      // 伴生 -vid.mp4 与真视频都用 video 探测；图/gif/webp 用 Image
      const useVideo = isRealVideoUrl(url) || isGifCompanionMp4(url);
      if (useVideo) {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.muted = true;
        v.playsInline = true;
        const t = setTimeout(() => {
          cleanup();
          resolve({ ok: false, timeout: true, url });
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(t);
          v.removeAttribute("src");
          try {
            v.load();
          } catch (_) {}
        };
        v.onloadedmetadata = () => {
          const kind = isGifCompanionMp4(url) ? "gif-mp4" : "video";
          const info = {
            ok: true,
            url,
            kind,
            duration: v.duration,
            w: v.videoWidth,
            h: v.videoHeight,
          };
          cleanup();
          resolve(info);
        };
        v.onerror = () => {
          cleanup();
          resolve({ ok: false, error: v.error?.code || true, url });
        };
        v.src = url;
        return;
      }
      const img = new Image();
      const t = setTimeout(() => {
        img.src = "";
        resolve({ ok: false, timeout: true, url });
      }, timeoutMs);
      img.onload = () => {
        clearTimeout(t);
        const kind = /\.gif(\?|$)/i.test(url) ? "gif" : "image";
        resolve({ ok: true, url, kind, w: img.naturalWidth, h: img.naturalHeight });
      };
      img.onerror = () => {
        clearTimeout(t);
        resolve({ ok: false, error: true, url });
      };
      img.src = url;
    });
  }

  async function probeFirstHit(urls, timeoutMs = 4500) {
    for (const url of urls) {
      const p = await probeMedia(url, timeoutMs);
      if (p.ok) return p;
    }
    return null;
  }

  function isGalleryVideoPost(item) {
    const t = String(item?.type || "").toLowerCase();
    if (t === "video") return true;
    if (t === "image" || t === "gif" || t === "photo") return false;
    const types = item?.mediaTypes || [];
    if (types.includes("video") && !types.includes("image") && !types.includes("gif")) return true;
    // media 全是 video 且 url null
    const media = item?.media || [];
    if (media.length && media.every((m) => m?.type === "video")) return true;
    return false;
  }

  function buildCandidates(item) {
    const list = [];
    const media = Array.isArray(item?.media) ? item.media : [];
    const snaps = Array.isArray(item?.snapshots) ? item.snapshots : [];
    const videoPost = isGalleryVideoPost(item);

    // 1) 免费/已解锁直链
    media.forEach((m, i) => {
      if (m?.url && !isBlurUrl(m.url) && !m.locked) {
        const kind =
          m.type === "gif" || /\.gif(\?|$)/i.test(m.url)
            ? "gif"
            : m.type === "video" || isRealVideoUrl(m.url)
              ? "video"
              : "image";
        list.push({ url: m.url, label: "free-media", index: i, locked: false, kind });
      }
      // gif 伴生 mp4：标 gif-mp4，不当真视频独占 UI
      if (m?.videoUrl) {
        list.push({
          url: m.videoUrl,
          label: "gif-vid",
          index: i,
          locked: !!m.locked,
          kind: "gif-mp4",
        });
      }
    });

    // 2) 付费项去 blur
    media.forEach((m, i) => {
      if (!m?.locked || !m.url) return;
      const base = unblurBase(m.url);
      if (!base) return;

      let prefer;
      if (m.type === "gif") {
        // 先 gif/webp，再伴生 -vid.mp4，最后静态图
        prefer = [".gif", ".webp", "-vid.mp4", ".jpg", ".png", ".mp4"];
      } else if (m.type === "video") {
        prefer = VIDEO_EXTS.map((e) => e);
      } else {
        prefer = [".jpg", ".png", ".webp", ".gif", ".jpeg"];
      }

      for (const ext of prefer) {
        const url = ext.startsWith("-") ? base + ext : base + ext;
        const kind =
          m.type === "gif"
            ? ext.includes("mp4")
              ? "gif-mp4"
              : "gif"
            : m.type === "video"
              ? "video"
              : "image";
        list.push({ url, label: "unblur", index: i, locked: true, kind });
      }
    });

    // 3) 仅「真视频帖」才做 snapshot 多扩展 oracle（避免 gif 帖 poster 误探）
    if (videoPost) {
      const thumbs = [];
      if (item?.thumbnailUrl) thumbs.push(item.thumbnailUrl);
      snaps.forEach((s) => typeof s === "string" && thumbs.push(s));
      const bases = new Set();
      for (const t of thumbs) {
        const b = galleryBaseFromThumb(t);
        if (b) bases.add(b);
      }
      for (const base of bases) {
        for (const ext of VIDEO_EXTS) {
          list.push({ url: base + ext, label: "video-oracle", locked: true, kind: "video" });
        }
      }
    }

    const seen = new Set();
    const out = [];
    for (const it of list) {
      if (!it.url || seen.has(it.url)) continue;
      if (isBlurUrl(it.url) && it.label !== "free-media") continue;
      seen.add(it.url);
      out.push(it);
    }
    return out;
  }

  function ensurePanel() {
    let box = document.getElementById("skbj-unlock-player");
    if (box) return box;
    box = document.createElement("div");
    box.id = "skbj-unlock-player";
    box.style.cssText = [
      "position:fixed",
      "right:12px",
      "bottom:12px",
      "z-index:2147483646",
      "width:min(560px,96vw)",
      "max-height:88vh",
      "overflow:auto",
      "background:#111",
      "border:1px solid #f59e0b",
      "border-radius:12px",
      "box-shadow:0 12px 40px rgba(0,0,0,.55)",
      "font:13px/1.4 system-ui,sans-serif",
      "color:#fff",
    ].join(";");
    document.documentElement.appendChild(box);
    return box;
  }

  function cellHtml(h, idx) {
    const url = h.url;
    const title = `#${h.index ?? idx} ${h.kind || h.label || ""}`;
    if (isGifCompanionMp4(url) || (isRealVideoUrl(url) && h.kind === "gif-mp4")) {
      return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}" style="display:block;position:relative">
        <video src="${esc(url)}" muted loop playsinline autoplay
          style="width:100%;height:120px;object-fit:cover;border-radius:6px;background:#222"></video>
        <span style="position:absolute;left:4px;bottom:4px;font-size:10px;background:#000a;padding:1px 4px;border-radius:4px">gif-mp4</span>
      </a>`;
    }
    if (isImageLikeUrl(url) || h.kind === "image" || h.kind === "gif") {
      return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}" style="display:block">
        <img src="${esc(url)}" alt="" style="width:100%;height:120px;object-fit:cover;border-radius:6px;background:#222" loading="lazy"/>
      </a>`;
    }
    // 其它
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="font-size:11px;color:#93c5fd;word-break:break-all">${esc(url)}</a>`;
  }

  function renderResults(title, hits, note, postType) {
    const box = ensurePanel();
    const visuals = hits.filter(isVisualHit);
    const realVideos = hits.filter((h) => isRealVideoUrl(h.url) && h.kind !== "gif-mp4" && !isGifCompanionMp4(h.url));

    // 图库/GIF 帖：优先网格；真视频帖：可同时有大播放器
    const preferGrid =
      postType === "gif" ||
      postType === "image" ||
      visuals.length > 0;

    let mediaHtml = "";
    if (preferGrid && visuals.length) {
      mediaHtml += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px;padding:8px;max-height:52vh;overflow:auto">
        ${visuals.map((h, i) => cellHtml(h, i)).join("")}
      </div>`;
    }
    if (realVideos.length) {
      const primary = realVideos[0];
      mediaHtml += `<video id="skbj-unlock-video" controls playsinline muted preload="metadata"
        style="width:100%;max-height:42vh;background:#000;display:block"
        src="${esc(primary.url)}"></video>`;
    }
    if (!mediaHtml) {
      mediaHtml = `<div style="padding:12px;opacity:.75;font-size:12px">无预览（见下方链接）</div>`;
    }

    const listHtml = hits
      .map((h, i) => {
        const tag = h.kind || h.label || "";
        const dim = h.w && h.h ? `${h.w}x${h.h}` : h.duration ? `${Math.round(h.duration)}s` : "";
        return `<div style="padding:4px 0;border-bottom:1px solid #222;word-break:break-all;font-size:11px">
          <span style="color:#fbbf24">#${i + 1}</span>
          <span style="opacity:.7"> [${esc(tag)}${dim ? " · " + dim : ""}]</span>
          <a href="${esc(h.url)}" target="_blank" rel="noopener noreferrer" style="color:#93c5fd">${esc(h.url)}</a>
        </div>`;
      })
      .join("");

    const openUrl = (visuals[0] || realVideos[0] || hits[0])?.url;

    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#1a1a1a;gap:8px;position:sticky;top:0;z-index:1">
        <div style="font-weight:700;color:#fbbf24;white-space:nowrap">🔓 ${NAME} v${VER}</div>
        <div style="opacity:.9;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(title || "")}</div>
        <button id="skbj-unlock-close" style="background:#333;color:#fff;border:0;border-radius:6px;padding:4px 8px;cursor:pointer">✕</button>
      </div>
      ${mediaHtml}
      <div style="display:flex;gap:8px;padding:8px 10px;background:#151515;flex-wrap:wrap">
        <button id="skbj-unlock-open" style="background:#f59e0b;color:#111;border:0;border-radius:6px;padding:6px 10px;font-weight:700;cursor:pointer">打开首个</button>
        <button id="skbj-unlock-copy" style="background:#333;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer">复制全部</button>
        <span id="skbj-unlock-status" style="font-size:11px;opacity:.9;align-self:center">${esc(note || `命中 ${hits.length}`)}</span>
      </div>
      <div style="padding:0 10px 10px;background:#151515">${listHtml || "<div style='opacity:.7;font-size:12px'>无命中</div>"}</div>
    `;

    box.querySelector("#skbj-unlock-close")?.addEventListener("click", () => box.remove());
    box.querySelector("#skbj-unlock-open")?.addEventListener("click", () => {
      if (openUrl) window.open(openUrl, "_blank", "noopener,noreferrer");
    });
    box.querySelector("#skbj-unlock-copy")?.addEventListener("click", async () => {
      const text = hits.map((h) => h.url).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        toast("已复制 " + hits.length + " 条");
      } catch {
        prompt("复制:", text);
      }
    });

    const v = box.querySelector("#skbj-unlock-video");
    if (v) {
      v.addEventListener(
        "loadedmetadata",
        () => {
          const st = box.querySelector("#skbj-unlock-status");
          if (st) st.textContent = `视频 · ${Math.round(v.duration)}s · ${v.videoWidth}x${v.videoHeight} · 共 ${hits.length}`;
          v.play?.().catch(() => {});
        },
        { once: true }
      );
      v.addEventListener(
        "error",
        () => {
          const st = box.querySelector("#skbj-unlock-status");
          if (st) st.textContent = "真视频页内失败 → 点打开/复制（大文件常见）";
        },
        { once: true }
      );
    }

    // 网格内 gif-mp4 尝试播放
    box.querySelectorAll("video[autoplay]").forEach((el) => {
      el.play?.().catch(() => {});
    });

    return box;
  }

  async function unlockGalleryItem(item, meta = {}) {
    const cands = buildCandidates(item);
    const videoPost = isGalleryVideoPost(item);
    log("type", item?.type, "videoPost", videoPost, "candidates", cands.length);

    toast(`探测中… ${cands.length} 候选`);
    const hits = [];

    // 免费直链：直接收录（gif/图用 Image 再确认可选，直链一般可用）
    for (const c of cands) {
      if (c.label === "free-media" || c.label === "gif-vid") {
        // 轻量确认，避免挂死链
        const p = await probeMedia(c.url, 4000);
        if (p.ok) {
          hits.push({ ...p, label: c.label, index: c.index, kind: p.kind || c.kind });
        } else if (c.label === "free-media" && isImageLikeUrl(c.url)) {
          // 个别 gif 探测超时仍加入（浏览器 img 常能显）
          hits.push({ ok: true, url: c.url, label: c.label, index: c.index, kind: c.kind || "image" });
        }
      }
    }

    // 真视频 oracle（仅视频帖）
    if (videoPost) {
      const videoGroups = new Map();
      for (const c of cands) {
        if (c.label !== "video-oracle") continue;
        const base = c.url.replace(/\.[^.]+$/, "");
        if (!videoGroups.has(base)) videoGroups.set(base, []);
        videoGroups.get(base).push(c.url);
      }
      for (const [, urls] of videoGroups) {
        const hit = await probeFirstHit(urls, 6000);
        if (hit) {
          hits.push({ ...hit, label: "video-oracle", kind: "video" });
          log("video hit", hit.url);
          break;
        }
      }
    }

    // 付费 unblur：每 index 一条
    const imgIndexes = [...new Set(cands.filter((c) => c.label === "unblur").map((c) => c.index))];
    let done = 0;
    for (const idx of imgIndexes) {
      const group = cands.filter((c) => c.label === "unblur" && c.index === idx);
      const urls = group.map((c) => c.url);
      const hit = await probeFirstHit(urls, 3500);
      done++;
      if (hit) {
        const kindHint = group.find((g) => g.url === hit.url)?.kind;
        hits.push({
          ...hit,
          label: "unblur",
          index: idx,
          kind: hit.kind || kindHint || "image",
        });
        log("unblur hit", idx, hit.url);
      }
      if (done % 8 === 0) toast(`探测中… ${done}/${imgIndexes.length}`);
    }

    const seen = new Set();
    const uniq = [];
    for (const h of hits) {
      if (!h?.url || seen.has(h.url)) continue;
      seen.add(h.url);
      uniq.push(h);
    }

    // 排序：按 index，无 index 靠后
    uniq.sort((a, b) => {
      const ia = a.index ?? 9999;
      const ib = b.index ?? 9999;
      return ia - ib;
    });

    if (!uniq.length) {
      toast("未命中", 4000);
      renderResults(meta.title || item?._id || "unlock", [], "0 hit", item?.type);
      return null;
    }

    const nVis = uniq.filter(isVisualHit).length;
    const nVid = uniq.filter((h) => isRealVideoUrl(h.url) && !isGifCompanionMp4(h.url)).length;
    const note = `命中 ${uniq.length}（预览 ${nVis} / 真视频 ${nVid}）`;
    renderResults(item?.caption || meta.title || item?._id || "gallery", uniq, note, item?.type);
    toast(`解锁成功 · ${uniq.length}`);
    return uniq;
  }

  async function runGalleryUnlock(id) {
    toast("拉取 gallery 详情…");
    const res = await fetch(`/api/gallery/${id}?preview=1`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      toast("详情 API " + res.status);
      return;
    }
    const data = await res.json();
    const item = data.item || data;
    log("access", item.access, "type", item.type, "media", (item.media || []).length);
    await unlockGalleryItem(item, { title: item.caption || id });
  }

  function getVideoSlug() {
    const m = location.pathname.match(/\/videos\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function tryMainPlayback(slug) {
    if (!slug) return null;
    let token = null;
    try {
      token = JSON.parse(localStorage.getItem("auth-storage") || "{}")?.state?.token || null;
    } catch (_) {}
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const dr = await fetch(`/api/videos/${encodeURIComponent(slug)}`, {
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    const detail = await dr.json();
    log("detail access", detail?.access);

    const pr = await fetch(`/api/videos/${encodeURIComponent(slug)}/playback`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const body = await pr.json().catch(() => ({}));
    log("playback", pr.status, body);

    if (pr.ok && body?.sources?.[0]?.url) {
      renderResults(
        detail?.video?.name || slug,
        [{ url: body.sources[0].url, kind: "video", label: "playback" }],
        "playback 200",
        "video"
      );
      toast("playback 200");
      return body.sources[0].url;
    }

    toast(`主站 VIP 门在 /playback (${body?.reason || pr.status})`, 4500);
    return null;
  }

  async function runUnlock() {
    const path = location.pathname;
    const gm = path.match(/\/gallery\/([a-f0-9]{20,})/i);
    if (gm) {
      await runGalleryUnlock(gm[1]);
      return;
    }
    const slug = getVideoSlug();
    if (slug && !/^(trending|weekly-likes)$/i.test(slug)) {
      await tryMainPlayback(slug);
      return;
    }
    toast("请打开 /gallery/{id} 或 /videos/{slug}");
  }

  function ensureFab() {
    if (document.getElementById("skbj-unlock-fab")) return;
    const btn = document.createElement("button");
    btn.id = "skbj-unlock-fab";
    btn.textContent = "🔓 Unlock";
    btn.style.cssText =
      "position:fixed;left:12px;bottom:12px;z-index:2147483647;background:linear-gradient(90deg,#f59e0b,#f97316);color:#111;border:0;border-radius:999px;padding:10px 14px;font:700 13px system-ui;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      try {
        await runUnlock();
      } catch (e) {
        warn(e);
        toast(String(e.message || e));
      } finally {
        btn.disabled = false;
        btn.textContent = "🔓 Unlock";
      }
    });
    document.documentElement.appendChild(btn);
  }

  const boot = () => {
    ensureFab();
    if (/\/gallery\/[a-f0-9]{20,}/i.test(location.pathname)) {
      setTimeout(() => runUnlock().catch(warn), 700);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  let last = location.href;
  setInterval(() => {
    if (location.href !== last) {
      last = location.href;
      ensureFab();
      if (/\/gallery\/[a-f0-9]{20,}/i.test(location.pathname)) {
        setTimeout(() => runUnlock().catch(warn), 600);
      }
    }
  }, 800);

  log("loaded", VER);
})();
