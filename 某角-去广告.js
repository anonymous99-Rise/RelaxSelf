// ==UserScript==
// @name        m3u8提取+去广告-原位替换终极播放版(强力注入)
// @namespace   haijiao-analyst
// @version     3.0
// @author      Richy
// @description 1.自动屏蔽广告 2.捕获m3u8 3.内置HLS引擎+强力播放器节点注入兜底
// @license     MIT
// @match       *://*.haijiao.com/*
// @match       *://*/post/details*
// @grant       GM_addStyle
// @grant       unsafeWindow
// @run-at      document-start
// ==/UserScript==

(function() {
    'use strict';

    let capturedM3u8Url = '';
    const btnId = 'hj-play-btn-mobile';

    // ==========================================
    // 模块一：强力去广告 (静态数据清洗)
    // ==========================================
    const adStyles = `
        [class*="guanggao"], [class*="ads"], [id*="ads"],
        [class*="banner"], [id*="banner"],
        .float-box, .float-window, .couplet,
        .top-ad, .bottom-ad, .sidebar,
        .ad-container, .gg-box,
        iframe:not([src*="m3u8"]):not([src*="player"]):not([id*="play"]),
        .ad-box img, a[href*="bocai"]
        {
            display: none !important;
            visibility: hidden !important;
            height: 0 !important;
            width: 0 !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
        body { overflow-x: hidden; }
    `;
    GM_addStyle(adStyles);

    function cleanUpAds() {
        document.querySelectorAll('div[style*="z-index: 999"]').forEach(div => div.remove());
        document.querySelectorAll('div[style*="position: fixed"]').forEach(div => {
            if (div.id !== btnId && div.id !== 'hj-toast-mobile') {
                if(div.querySelector('iframe') || div.querySelector('img')) {
                    div.style.display = 'none';
                }
            }
        });
    }
    setInterval(cleanUpAds, 2000);

    // ==========================================
    // 模块二：数据下行拦截 (拦截真实 M3U8 地址)
    // ==========================================
    GM_addStyle(`
        #${btnId} {
            position: fixed;
            bottom: 80px;
            right: 15px;
            width: 55px;
            height: 55px;
            border-radius: 50%;
            background-color: rgba(30, 60, 114, 0.95);
            color: white;
            border: 2px solid rgba(255,255,255,0.3);
            z-index: 999999;
            font-size: 24px;
            text-align: center;
            line-height: 51px;
            user-select: none;
            -webkit-tap-highlight-color: transparent;
            display: none;
            box-shadow: 0 4px 10px rgba(0,0,0,0.4);
            transition: transform 0.2s, background-color 0.3s;
        }
        #${btnId}.show { display: block; }
        #${btnId}.active { transform: scale(0.9); }
        #${btnId}.played { background-color: rgba(46, 139, 87, 0.95); }

        #hj-toast-mobile {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0,0,0,0.8);
            color: #fff;
            padding: 12px 24px;
            border-radius: 8px;
            z-index: 1000000;
            font-size: 15px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.3s;
        }
    `);

    const getRealVideoSrc = (content, requestUrl) => {
        if (!content) return "";
        try {
            if (content.includes("#EXTM3U")) {
                const baseUrl = requestUrl.substring(0, requestUrl.lastIndexOf('/') + 1);
                const filenameMatch = content.match(/([\w_]+_?)[\d]+\.ts/);
                if (filenameMatch) return baseUrl + filenameMatch[1] + ".m3u8";
            } else {
                const lines = content.split("\n");
                const tsLine = lines.find(line => line.includes('.ts'));
                if (tsLine) {
                    let reg = tsLine.match(/([\w_]+_?)[\d]+\.ts/);
                    if (reg) return tsLine.replace(reg[0], reg[1] + ".m3u8").trim();
                }
            }
        } catch (e) { }
        return "";
    };

    const bareDecode = (text) => { try { return JSON.parse(atob(atob(atob(text)))); } catch(e) { return null; } };
    const decodeEncryptString = (text) => {
        let data = text;
        try {
            if (typeof text === 'string') {
                let tmpDataObj = null;
                try { tmpDataObj = JSON.parse(text); } catch(e){}
                if (tmpDataObj) {
                    if (tmpDataObj.data && typeof tmpDataObj.data === 'object') {
                        data = tmpDataObj.data;
                    } else if (tmpDataObj.data && typeof tmpDataObj.data === 'string') {
                        data = bareDecode(tmpDataObj.data);
                    }
                }
            }
        } catch (error) { }
        return data;
    };

    const originalXHR = unsafeWindow.XMLHttpRequest;
    unsafeWindow.XMLHttpRequest = function() {
        const xhr = new originalXHR();
        const originalOpen = xhr.open;
        const originalSend = xhr.send;
        let requestUrl = '';
        xhr.open = function(method, url) {
            requestUrl = url || '';
            return originalOpen.apply(this, arguments);
        };
        xhr.send = function() {
            if (requestUrl.includes("/api/address/") || requestUrl.includes("/api/topic/")) {
                xhr.addEventListener('load', function() {
                    setTimeout(() => handleXhrLoad(xhr, requestUrl), 0);
                });
            }
            return originalSend.apply(this, arguments);
        };
        return xhr;
    };

    async function handleXhrLoad(xhr, url) {
        try {
            if (url.includes("/api/address/")) {
                const videoSrc = getRealVideoSrc(xhr.responseText, url);
                if (videoSrc) updateState(videoSrc);
            }
            else if (/\/api\/topic\/\d+/.test(url)) {
                const data = decodeEncryptString(xhr.responseText);
                if (data?.attachments) {
                    for (const element of data.attachments) {
                        if (element.category === "video" && element.remoteUrl) {
                            fetch(element.remoteUrl)
                                .then(res => res.text())
                                .then(content => {
                                    const videoSrc = getRealVideoSrc(content, element.remoteUrl);
                                    if (videoSrc) updateState(videoSrc);
                                }).catch(() => {});
                        }
                    }
                }
            }
        } catch (e) { }
    }

    function updateState(src) {
        if (!src || src === capturedM3u8Url) return;
        capturedM3u8Url = src;
        const btn = document.getElementById(btnId);
        if (btn) {
            btn.classList.add('show');
            btn.classList.remove('played');
            btn.textContent = '▶️';
            showToast('已捕获完整 M3U8 索引，点击解析播放');
        }
    }

    function showToast(msg) {
        let toast = document.getElementById('hj-toast-mobile');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'hj-toast-mobile';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.style.opacity = '1';
        setTimeout(() => { toast.style.opacity = '0'; }, 3000);
    }

    // ==========================================
    // 模块三：高级解析节点注入与 M3U8 流媒体接管
    // ==========================================
    function replaceAndPlayVideo(btn) {
        showToast('开始启动数据管线与播放器构筑...');
        
        // 【1】暴力清洗阶段：寻址页面现有的全部正在播放的原生媒体，将其静音并断肠式销毁
        document.querySelectorAll('video').forEach(v => {
            v.pause();
            v.removeAttribute('src'); 
            v.load(); 
            const potentialParent = v.closest('.video-div') || v.closest('.dplayer') || v.parentElement;
            if (potentialParent) potentialParent.innerHTML = ''; // 清空它原来的播放外壳
        });

        // 隐藏那些“付费提示”或“只有30秒预览”等脏数据文案
        document.querySelectorAll('.sell_line1, .sell_line2, .preview-title').forEach(el => {
            el.style.display = 'none';
        });

        // 【2】模糊寻址阶段：采用多维度的探针去锁定可能作为注入地点的容器
        // 选择器兼容：原始特征、ID特征、购买容器特征
        let videoContainers = document.querySelectorAll('.video-div, .dplayer, [id^="video_"], .sell-btn, .post-details');
        
        let targetContainer = null;

        if(videoContainers.length > 0) {
            targetContainer = videoContainers[0]; // 抓住锁定的第一个点位
            console.log("【数据洞察】常规寻址成功");
        } else {
            // 【3】主动兜底机制 (Proactive Fallback)：节点异形变幻到无法寻址？
            // 我们直接凭空生造一个 div 插入在最前面！
            console.log("【数据洞察】常规寻址脱靶，触发降级注入策略！");
            showToast('启用兜底注入模式，强制渲染播放器');
            
            targetContainer = document.createElement('div');
            targetContainer.style.margin = '15px 0';
            let anchorNode = document.querySelector('body'); 
            
            // 尝试挂载到内容顶部附近
            let contentBody = document.querySelector('.post-content') || document.querySelector('.article-content') || document.body;
            contentBody.insertBefore(targetContainer, contentBody.firstChild);
        }

        // 初始化容器 (如果是老的Dplayer容器，就把里面的脏DOM连根拔起)
        targetContainer.innerHTML = '';
        const newPlayerId = 'clean-core-player-' + Date.now();
        
        // 挂载全新的展示区
        targetContainer.innerHTML = `
            <div style="color:#00e676; padding: 10px; font-weight: bold; background:#222; border-radius:8px 8px 0 0; text-align:center;">
                (Analytics 探针) 💡 广告/限制已解除，全时段 M3U8 解码接入中...
            </div>
            <video 
                id="${newPlayerId}" 
                controls 
                playsinline 
                webkit-playsinline 
                style="width: 100%; max-height: 80vh; background-color: #000; border-radius: 0 0 8px 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.5);">
            </video>
        `;
        
        const newVideoTag = targetContainer.querySelector(`#${newPlayerId}`);
        const targetM3u8 = capturedM3u8Url;

        // 【4】M3U8 智能解析路由
        if (newVideoTag.canPlayType('application/vnd.apple.mpegurl')) {
            // 场景 1: 原生硬解 (iOS)
            newVideoTag.src = targetM3u8;
            newVideoTag.play().catch(e => console.log('浏览器安全拦截自动硬解: ', e));
            showToast('启动 iOS 原生硬解播放');
        } else {
            // 场景 2: 软解加载 (Android / PC)
            const GlobalHls = unsafeWindow.Hls || window.Hls;
            
            if (GlobalHls && GlobalHls.isSupported()) {
                let hls = new GlobalHls();
                hls.loadSource(targetM3u8);
                hls.attachMedia(newVideoTag);
                hls.on(GlobalHls.Events.MANIFEST_PARSED, function() {
                    newVideoTag.play().catch(e => console.log('浏览器安全拦截自动软解: ', e));
                });
                showToast('复用系统级 HLS 引擎解码成功');
            } else {
                showToast('主动下载边缘节点 M3U8 解析器...');
                let script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
                script.onload = () => {
                    const InjectedHls = unsafeWindow.Hls || window.Hls;
                    if(InjectedHls && InjectedHls.isSupported()){
                        let hls = new InjectedHls();
                        hls.loadSource(targetM3u8);
                        hls.attachMedia(newVideoTag);
                        hls.on(InjectedHls.Events.MANIFEST_PARSED, () => {
                            newVideoTag.play().catch(e => console.log(e));
                            showToast('外置引擎挂载完毕，M3U8 解析播放中！');
                        });
                    } else {
                        showToast('您的设备底层解码器版本不兼容。');
                    }
                };
                document.head.appendChild(script);
            }
        }

        btn.classList.add('played');
        btn.textContent = '✔️';
    }

    function init() {
        if (document.getElementById(btnId)) return;
        const btn = document.createElement('div');
        btn.id = btnId;
        btn.textContent = '▶️';

        btn.onclick = function() {
            btn.classList.add('active');
            setTimeout(() => btn.classList.remove('active'), 100);

            if (capturedM3u8Url) {
                replaceAndPlayVideo(btn);
            } else {
                showToast('后台尚未捕获到完整数据的索引参数，请等待刷新或播放原视频探寻。');
            }
        };
        document.body.appendChild(btn);
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.addEventListener('popstate', () => {
         capturedM3u8Url = '';
         const btn = document.getElementById(btnId);
         if(btn) {
             btn.classList.remove('show');
             btn.classList.remove('played');
             btn.textContent = '▶️';
         }
         setTimeout(cleanUpAds, 500);
    });

})();
