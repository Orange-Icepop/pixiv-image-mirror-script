// ==UserScript==
// @name         Pixiv 当前页面图片批量保存 (ZIP / PDF / 逐个下载)
// @name:en      Pixiv Page Images Batch Save (ZIP / PDF / one by one)
// @namespace    https://github.com/Orange-Icepop/pixiv-image-mirror-script
// @version      1.4.0
// @description  抓取当前 pixiv 作品的图片（含镜像/代理域名），默认用页面上已缓存的尺寸，可选原图；内置 ZIP 写入器（无 JSZip），可打包 ZIP 或合成 PDF。
// @author       Orange-Icepop DeepSeek
// @match        https://www.pixiv.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      i.pixiv.cat
// @connect      i.pximg.net
// @connect      *.pximg.net
// @connect      pixiv.net
// @require      https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    /* ================= 可配置项 ================= */

    // 你的镜像/反代域名（多个用逗号分隔）。换域名时记得同步改 @connect。
    var PROXY_HOSTS = ['i.pixiv.cat'];

    var MIN_SIDE = 200;        // 最长边小于该值的图（头像、图标）跳过
    var CONCURRENCY = 3;       // 并发抓取数，代理站压力大就调成 2
    var PDF_MAX_SIDE = 2200;   // 生成 PDF 时单张图最长边（像素），越小越省内存
    var PDF_QUALITY = 0.92;    // PDF 内 JPEG 质量
    var FETCH_TIMEOUT = 60000; // 单张超时（毫秒）

    /* ================= 基础工具 ================= */

    var state = { items: [], busy: false, pageOk: null, channel: 'auto' };   // pageOk: null 未知 / true 可读 / false CORS 被拒
    var stat = { page: 0, gm: 0, fail: 0 };

    function now() {
        return (window.performance && performance.now) ? performance.now() : Date.now();
    }
    var ui = {};

    function setStatus(text) {
        if (ui.status) ui.status.textContent = text;
        console.log('[pixiv-save]', text);
    }

    function sleep(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    function pageNo(url) {
        var m = /_p(\d+)/.exec(url);
        return m ? parseInt(m[1], 10) : 0;
    }

    function currentPid() {
        var m = /\/artworks\/(\d+)/.exec(location.pathname);
        if (m) return m[1];
        m = /\/i\/(\d+)/.exec(location.pathname);
        if (m) return m[1];
        m = /[?&](?:illust_id|id)=(\d+)/.exec(location.search);
        if (m) return m[1];
        return '';
    }

    // 图片文件名形如 68377968_p0_master1200.jpg / 68377968_ugoira1234.zip，
    // 用它判断这张图是否属于当前作品。头像、推荐位、广告的 ID 都对不上。
    // 同一页图在页面上常有多份地址（/c/540x540_70/... 缩略图、/img-master/... 主图），
    // 统一归并成 "作品ID_p页码" 这一个键，只保留清晰度最高的那条。
    function workKey(raw) {
        var p;
        try { p = new URL(raw, location.href).pathname; } catch (e) { return ''; }
        var m = /\/(\d+)_(?:p(\d+)|ugoira)/.exec(p);
        if (!m) return '';
        return m[1] + '_' + (m[2] !== undefined ? 'p' + m[2] : 'ugoira');
    }

    function urlRank(pathname) {
        if (pathname.indexOf('/img-original/') !== -1) return 3;
        if (pathname.indexOf('/img-master/') !== -1) return 2;
        return 1;
    }

    function isOwnWork(raw, pid) {
        if (!pid) return true;
        var p;
        try { p = new URL(raw, location.href).pathname; } catch (e) { return false; }
        return new RegExp('(?:^|/)' + pid + '_(?:p\\d+|ugoira)').test(p);
    }

    function illustId() {
        return currentPid() || 'page';
    }

    function isPixivImage(u) {
        var host = u.hostname.toLowerCase();
        var ok = /(^|\.)pximg\.net$/.test(host);
        for (var i = 0; i < PROXY_HOSTS.length && !ok; i++) {
            var h = PROXY_HOSTS[i].toLowerCase();
            if (host === h || host.slice(-(h.length + 1)) === '.' + h) ok = true;
        }
        if (!ok) return false;
        if (u.pathname.indexOf('/user-profile/') !== -1) return false;
        return true;
    }

    // 把缩略图/master1200 地址升级为 img-original 地址；无法升级时返回 null
    function toOriginal(raw) {
        var u;
        try { u = new URL(raw); } catch (e) { return null; }
        var p = u.pathname;
        p = p.replace(/^\/c\/\d+x\d+(?:_[a-z0-9]+)*\//, '/');
        p = p.replace('/img-master/', '/img-original/');
        p = p.replace(/_(master|square|thumb)\d+(?=\.\w+$)/, '');
        if (p === u.pathname) return null;
        u.pathname = p;
        u.search = '';
        u.hash = '';
        return u.href;
    }

    function extOf(blob, fallbackUrl) {
        var t = (blob && blob.type ? blob.type : '').toLowerCase();
        if (t.indexOf('png') !== -1) return 'png';
        if (t.indexOf('webp') !== -1) return 'webp';
        if (t.indexOf('gif') !== -1) return 'gif';
        if (t.indexOf('jpeg') !== -1 || t.indexOf('jpg') !== -1) return 'jpg';
        var m = /\.(\w{2,4})(?:\?|$)/.exec(fallbackUrl || '');
        return m ? m[1].toLowerCase() : 'jpg';
    }

    function uniqueName(url, blob, used) {
        var base;
        try {
            base = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image');
        } catch (e) {
            base = 'image';
        }
        base = base.replace(/_(master|square|thumb)\d+(?=\.\w+$)/, '');
        base = base.replace(/\.\w+$/, '');
        var ext = extOf(blob, url);
        var name = base + '.' + ext;
        var n = 2;
        while (used.has(name)) {
            name = base + '_' + n + '.' + ext;
            n++;
        }
        used.add(name);
        return name;
    }

    function saveBlob(blob, name) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            URL.revokeObjectURL(a.href);
            a.remove();
        }, 4000);
    }

    /* ================= 轻量 ZIP 写入（STORE，替代 JSZip） ================= */
    // JSZip 在油猴沙箱里会挂在 setImmediate 的 postMessage 轮询上，永远算不完。
    // 我们只需要不压缩打包，自己写 zip 结构即可：几十行，同步可控，还省掉一个 @require。

    var CRC_TABLE = (function () {
        var t = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(u8) {
        var c = 0xFFFFFFFF;
        for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function dosDateTime(d) {
        return {
            time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31),
            date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
        };
    }

    async function buildZip(entries, onProgress) {
        var parts = [], central = [], offset = 0, dt = dosDateTime(new Date()), i, j;

        for (i = 0; i < entries.length; i++) {
            var e = entries[i];
            var buf = new Uint8Array(await e.blob.arrayBuffer());
            var crc = crc32(buf);
            var nameBytes = new TextEncoder().encode(e.name);
            var lh = new Uint8Array(30 + nameBytes.length);
            var dv = new DataView(lh.buffer);
            dv.setUint32(0, 0x04034b50, true);
            dv.setUint16(4, 20, true);          // version needed
            dv.setUint16(6, 0x0800, true);      // flags: UTF-8 文件名
            dv.setUint16(8, 0, true);           // method: store
            dv.setUint16(10, dt.time, true);
            dv.setUint16(12, dt.date, true);
            dv.setUint32(14, crc, true);
            dv.setUint32(18, buf.length, true);
            dv.setUint32(22, buf.length, true);
            dv.setUint16(26, nameBytes.length, true);
            dv.setUint16(28, 0, true);
            lh.set(nameBytes, 30);
            parts.push(lh, e.blob);             // 图片字节直接引用原 Blob，不复制
            central.push({ nameBytes: nameBytes, crc: crc, size: buf.length, offset: offset });
            offset += lh.length + buf.length;
            buf = null;
            if (onProgress) onProgress(i + 1, entries.length);
        }

        var cdParts = [], cdSize = 0;
        for (j = 0; j < central.length; j++) {
            var c = central[j];
            var rec = new Uint8Array(46 + c.nameBytes.length);
            var d = new DataView(rec.buffer);
            d.setUint32(0, 0x02014b50, true);
            d.setUint16(4, 20, true);
            d.setUint16(6, 20, true);
            d.setUint16(8, 0x0800, true);
            d.setUint16(10, 0, true);
            d.setUint16(12, dt.time, true);
            d.setUint16(14, dt.date, true);
            d.setUint32(16, c.crc, true);
            d.setUint32(20, c.size, true);
            d.setUint32(24, c.size, true);
            d.setUint16(28, c.nameBytes.length, true);
            d.setUint16(30, 0, true);
            d.setUint16(32, 0, true);
            d.setUint16(34, 0, true);
            d.setUint16(36, 0, true);
            d.setUint32(38, 0, true);
            d.setUint32(42, c.offset, true);
            rec.set(c.nameBytes, 46);
            cdParts.push(rec);
            cdSize += rec.length;
        }

        var eocd = new Uint8Array(22);
        var ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(8, central.length, true);
        ev.setUint16(10, central.length, true);
        ev.setUint32(12, cdSize, true);
        ev.setUint32(16, offset, true);
        return new Blob(parts.concat(cdParts, [eocd]), { type: 'application/zip' });
    }

    // 限定并发的 map
    function mapLimit(list, limit, worker) {
        var i = 0;
        var runners = [];
        function next() {
            if (i >= list.length) return Promise.resolve();
            var idx = i++;
            return Promise.resolve(worker(list[idx], idx)).then(next, next);
        }
        for (var k = 0; k < Math.min(limit, list.length); k++) runners.push(next());
        return Promise.all(runners);
    }

    /* ================= 从 DOM 抓 URL ================= */

    function collect() {
        var map = new Map();

        function add(raw) {
            if (!raw || typeof raw !== 'string') return;
            if (raw.indexOf('data:') === 0 || raw.indexOf('blob:') === 0) return;
            var u;
            try { u = new URL(raw, location.href); } catch (e) { return; }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
            if (!isPixivImage(u)) return;
            var key = workKey(u.href) || (u.hostname + u.pathname);  // 忽略 query
            var rank = urlRank(u.pathname);
            var old = map.get(key);
            if (!old || rank > old.rank) map.set(key, { key: key, url: u.href, rank: rank });
        }

        var imgs = document.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            var nw = img.naturalWidth || 0;
            var nh = img.naturalHeight || 0;
            if (nw && nh && Math.max(nw, nh) < MIN_SIDE) continue;
            add(img.currentSrc || img.src);            // 你重写后的代理 URL 就藏在 src 里
            add(img.getAttribute('data-src'));         // 懒加载原地址（如果还有）
            add(img.getAttribute('data-original'));
        }

        var links = document.querySelectorAll('a[href]');
        for (var j = 0; j < links.length; j++) add(links[j].href);

        var list = Array.from(map.values());
        var pid = currentPid();
        if (pid && (!ui.onlyWork || ui.onlyWork.checked)) {
            list = list.filter(function (x) { return isOwnWork(x.url, pid); });
        }
        list.sort(function (a, b) {
            return pageNo(a.url) - pageNo(b.url) || a.key.localeCompare(b.key);
        });
        return list;
    }

    /* ================= 用登录态补齐全部页（可选） ================= */

    // 把官方直链换成你的代理域；PROXY_HOSTS 为空则原样返回
    function rewriteHost(raw) {
        if (!PROXY_HOSTS.length) return raw;
        try {
            var u = new URL(raw);
            if (!/(^|\.)pximg\.net$/.test(u.hostname)) return raw;
            u.hostname = PROXY_HOSTS[0];
            return u.href;
        } catch (e) {
            return raw;
        }
    }

    // 同源 fetch 自带登录 cookie，所以这里能拿到“需要账号”的原图直链；
    // 只替换域名，不改变路径，代理侧才能正常回源。
    async function expandByApi() {
        var m = /\/artworks\/(\d+)/.exec(location.pathname);
        if (!m) return [];
        var api = '/ajax/illust/' + m[1] + '/pages';
        var json;
        try {
            var res = await fetch(api, {
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' }
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            json = await res.json();
        } catch (e) {
            console.warn('[pixiv-save] pages 接口失败，回退 DOM 模式', e);
            setStatus('接口不可用，已回退到 DOM 模式');
            return [];
        }

        var body = json && json.body;
        if (!Array.isArray(body) || !body.length) return [];

        var pid = currentPid();
        var out = [];
        for (var i = 0; i < body.length; i++) {
            var p = body[i] || {};
            var urls = p.urls || {};
            var raw = (ui.original && ui.original.checked ? urls.original : urls.regular) || urls.original;
            if (!raw) continue;
            if (pid && !isOwnWork(raw, pid)) continue;
            var u = rewriteHost(raw);
            var key = workKey(u);
            if (!key) { try { key = new URL(u).hostname + new URL(u).pathname; } catch (e) { continue; } }
            out.push({ key: key, url: u, rank: urlRank(new URL(u).pathname), page: i, w: p.width, h: p.height });
        }
        return out;
    }

    async function collectAll() {
        var list = [];
        if (ui.useApi && ui.useApi.checked) {
            setStatus('用登录态获取全部页直链…');
            list = await expandByApi();
        }
        var dom = collect();
        if (!list.length) return dom;
        // 接口结果先占位，DOM 里已经存在同一页时：清晰度相同就用 DOM 的那条，
        // 因为只有它一定在浏览器缓存里；DOM 更糊（/c/ 缩略图）才保留接口的地址。
        var merged = list.slice();
        var index = new Map();
        for (var k = 0; k < merged.length; k++) index.set(merged[k].key, k);
        for (var i = 0; i < dom.length; i++) {
            var d = dom[i];
            var at = index.get(d.key);
            if (at === undefined) { index.set(d.key, merged.length); merged.push(d); }
            else if ((d.rank || 1) >= (merged[at].rank || 1)) merged[at] = d;
        }
        merged.sort(function (a, b) {
            return pageNo(a.url) - pageNo(b.url);
        });
        return merged;
    }

    /* ================= 抓取 ================= */

    // 首选：页面内 fetch。Referer 由浏览器按 strict-origin-when-cross-origin 自动写成
    // “https://www.pixiv.net/”，恰好就是这类反代要检查的东西；能读 body 说明代理给了
    // Access-Control-Allow-Origin。拿不到（CORS/CORP/401）再退回 GM_xmlhttpRequest。
    async function pageFetch(url) {
        // force-cache：只要 HTTP 缓存里有（哪怕已过期）就直接用，不再回源；
        // 没有才发网络请求。图片内容不可变，用过期副本是安全的。
        var res = await fetch(url, { credentials: 'omit', mode: 'cors', cache: 'force-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct && ct.indexOf('image/') !== 0) throw new Error('非图片：' + ct);
        var blob = await res.blob();
        if (!blob.size) throw new Error('空响应');
        return blob;
    }

    function gmFetch(url) {
        return new Promise(function (resolve, reject) {
            var done = false;
            function fail(e) { if (!done) { done = true; reject(e); } }
            function ok(blob) { if (!done) { done = true; resolve(blob); } }

            var opt = {
                method: 'GET',
                url: url,
                responseType: 'blob',
                timeout: FETCH_TIMEOUT,
                headers: { 'Referer': location.href },
                onload: function (r) {
                    if (r.status >= 200 && r.status < 300) {
                        var b = r.response;
                        if (b && b.size > 0) ok(b);
                        else fail(new Error('空响应'));
                    } else {
                        fail(new Error('HTTP ' + r.status));
                    }
                },
                onerror: function () { fail(new Error('网络错误')); },
                ontimeout: function () { fail(new Error('超时')); }
            };

            try {
                GM_xmlhttpRequest(opt);
            } catch (e) {
                // 某些管理器不允许自定义 Referer，去掉头再试一次
                try {
                    delete opt.headers;
                    GM_xmlhttpRequest(opt);
                } catch (e2) { fail(e2); }
            }
        });
    }

    // 单张取流。auto 模式下第一次 CORS 失败就把 pageOk 置 false，
    // 之后的图直接走 GM，避免"页面先白下一遍、GM 再下一遍"的双倍流量。
    async function fetchVia(url) {
        var mode = state.channel;
        if (mode === 'gm') return { blob: await gmFetch(url), src: 'gm' };
        if (mode === 'auto' && state.pageOk === false) return { blob: await gmFetch(url), src: 'gm' };
        try {
            return { blob: await pageFetch(url), src: 'page' };
        } catch (e1) {
            if (mode === 'page') throw e1;
            if (e1 && e1.name === 'TypeError') state.pageOk = false;
            return { blob: await gmFetch(url), src: 'gm' };
        }
    }

    async function fetchOne(item, wantOriginal) {
        var urls = [item.url];
        if (wantOriginal) {
            var o = toOriginal(item.url);
            if (o && o !== item.url) urls.unshift(o);   // 先试原图，失败回落到页面上的地址
        }
        var lastErr = null;
        for (var i = 0; i < urls.length; i++) {
            var t0 = now();
            try {
                var got = await fetchVia(urls[i]);
                var t = (got.blob.type || '').toLowerCase();
                if (t && t.indexOf('image/') !== 0) throw new Error('非图片：' + t);
                got.ms = Math.round(now() - t0);
                got.url = urls[i];
                return got;
            } catch (e) {
                e.ms = Math.round(now() - t0);
                lastErr = e;
            }
        }
        throw lastErr || new Error('抓取失败');
    }

    /* ================= 三种输出 ================= */

    function ensureItems() {
        if (!state.items.length) {
            setStatus('先点「抓取本页图片」');
            return false;
        }
        return true;
    }

    function setBusy(v) {
        state.busy = v;
        ['btnCollect', 'btnZip', 'btnPdf', 'btnOne'].forEach(function (k) {
            if (ui[k]) ui[k].disabled = v;
        });
        if (ui.channel) ui.channel.disabled = v;
    }

    async function saveZip() {
        if (state.busy || !ensureItems()) return;
        setBusy(true);

        var entries = [];
        var used = new Set();
        var ok = 0, fail = 0;
        var total = state.items.length;
        var tStart = now();
        stat = { page: 0, gm: 0, fail: 0 };

        await mapLimit(state.items, CONCURRENCY, async function (item) {
            try {
                var r = await fetchOne(item, ui.original.checked);
                var name = uniqueName(r.url, r.blob, used);
                entries.push({ name: name, blob: r.blob });
                ok++;
                stat[r.src]++;
                console.log('[pixiv-save] ' + r.src + ' ' + r.ms + 'ms ' +
                    (r.blob.size / 1024).toFixed(0) + 'KB ' + name);
            } catch (e) {
                fail++;
                stat.fail++;
                console.warn('[pixiv-save] 失败(' + (e && e.ms) + 'ms) ' + item.url, e);
            }
            setStatus('抓取中 ' + (ok + fail) + '/' + total +
                '（页面 ' + stat.page + ' / GM ' + stat.gm + ' / 失败 ' + stat.fail + '）');
        });

        if (!ok) { setBusy(false); setStatus('全部失败（' + fail + ' 张）'); return; }

        setStatus('打包中… 0/' + entries.length);
        var out = await buildZip(entries, function (n, t) {
            setStatus('打包中… ' + n + '/' + t);
        });
        var tEnd = now();
        saveBlob(out, 'pixiv_' + illustId() + '_' + Date.now() + '.zip');
        setBusy(false);
        setStatus('完成：' + ok + ' 张（页面 ' + stat.page + ' / GM ' + stat.gm + '）' +
            '，失败 ' + fail + '，用时 ' + ((tEnd - tStart) / 1000).toFixed(1) + 's');
        console.log('[pixiv-save] 总计 ' + ((tEnd - tStart) / 1000).toFixed(1) + 's',
            { page: stat.page, gm: stat.gm, fail: stat.fail, pageOk: state.pageOk });
    }

    function blobToJpeg(blob) {
        return new Promise(function (resolve, reject) {
            var src = URL.createObjectURL(blob);
            var img = new Image();
            img.onload = function () {
                try {
                    var w0 = img.naturalWidth, h0 = img.naturalHeight;
                    if (!w0 || !h0) throw new Error('图片尺寸为 0');
                    var k = Math.min(1, PDF_MAX_SIDE / Math.max(w0, h0));
                    var w = Math.max(1, Math.round(w0 * k));
                    var h = Math.max(1, Math.round(h0 * k));
                    var canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    var ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, w, h);
                    ctx.drawImage(img, 0, 0, w, h);
                    var dataUrl = canvas.toDataURL('image/jpeg', PDF_QUALITY);
                    canvas.width = canvas.height = 0;
                    resolve({ dataUrl: dataUrl, w: w, h: h });
                } catch (e) {
                    reject(e);
                } finally {
                    URL.revokeObjectURL(src);
                }
            };
            img.onerror = function () {
                URL.revokeObjectURL(src);
                reject(new Error('解码失败'));
            };
            img.src = src;
        });
    }

    async function savePdf() {
        if (state.busy || !ensureItems()) return;
        var JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
        if (!JsPDF) { setStatus('jsPDF 未加载（检查网络或管理器设置）'); return; }
        setBusy(true);

        var pages = [];
        var fail = 0;
        var total = state.items.length;
        stat = { page: 0, gm: 0, fail: 0 };

        await mapLimit(state.items, CONCURRENCY, async function (item, idx) {
            try {
                var r = await fetchOne(item, ui.original.checked);
                stat[r.src]++;
                var conv = await blobToJpeg(r.blob);
                conv.idx = idx;
                pages.push(conv);
                console.log('[pixiv-save] ' + r.src + ' ' + r.ms + 'ms ' +
                    (r.blob.size / 1024).toFixed(0) + 'KB p' + idx);
            } catch (e) {
                fail++;
                stat.fail++;
                console.warn('[pixiv-save] 失败(' + (e && e.ms) + 'ms) ' + item.url, e);
            }
            setStatus('处理中 ' + (pages.length + fail) + '/' + total +
                '（页面 ' + stat.page + ' / GM ' + stat.gm + ' / 失败 ' + stat.fail + '）');
        });

        if (!pages.length) { setBusy(false); setStatus('全部失败（' + fail + ' 张）'); return; }
        pages.sort(function (a, b) { return a.idx - b.idx; });

        var A4W = 595.28, A4H = 841.89, M = 16;
        var first = pages[0];
        var portrait0 = first.h >= first.w;
        var doc = new JsPDF({
            unit: 'pt',
            format: portrait0 ? [A4W, A4H] : [A4H, A4W],
            orientation: portrait0 ? 'p' : 'l'
        });

        for (var i = 0; i < pages.length; i++) {
            var pg = pages[i];
            var portrait = pg.h >= pg.w;
            var pw = portrait ? A4W : A4H;
            var ph = portrait ? A4H : A4W;
            if (i > 0) doc.addPage('a4', portrait ? 'p' : 'l');
            var k = Math.min((pw - M * 2) / pg.w, (ph - M * 2) / pg.h);
            var w = pg.w * k, h = pg.h * k;
            doc.addImage(pg.dataUrl, 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h);
            setStatus('生成 PDF ' + (i + 1) + '/' + pages.length);
        }

        doc.save('pixiv_' + illustId() + '_' + Date.now() + '.pdf');
        setBusy(false);
        setStatus('PDF 完成：' + pages.length + ' 页，失败 ' + fail + ' 张');
    }

    async function saveOneByOne() {
        if (state.busy || !ensureItems()) return;
        setBusy(true);
        var used = new Set();
        var i, total = state.items.length;
        for (i = 0; i < total; i++) {
            var item = state.items[i];
            var name = uniqueName(item.url, null, used);
            setStatus('交给浏览器下载 ' + (i + 1) + '/' + total);
            await new Promise(function (resolve) {
                try {
                    GM_download({
                        url: item.url,          // 原样使用页面上的（代理）地址，cookie / 缓存最保真
                        name: name,
                        saveAs: false,
                        onload: resolve,
                        onerror: function () { resolve(); },
                        ontimeout: function () { resolve(); }
                    });
                } catch (e) {
                    console.warn('[pixiv-save] GM_download 失败', item.url, e);
                    resolve();
                }
            });
            await sleep(350);
        }
        setBusy(false);
        setStatus('已提交 ' + total + ' 个下载（Chrome 可能提示“允许多个下载”）');
    }

    /* ================= UI ================= */

    function buildUI() {
        var style = document.createElement('style');
        style.textContent = [
            '#pxsv-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:248px;',
            'background:rgba(24,26,32,.94);color:#eaeaea;border-radius:10px;',
            'box-shadow:0 6px 24px rgba(0,0,0,.35);font:12px/1.6 -apple-system,"Segoe UI",sans-serif;',
            'padding:10px 12px 12px;backdrop-filter:blur(6px)}',
            '#pxsv-panel .h{display:flex;align-items:center;justify-content:space-between;',
            'font-weight:600;font-size:13px;margin-bottom:6px;cursor:move;user-select:none}',
            '#pxsv-panel .x{cursor:pointer;opacity:.6;padding:0 4px}',
            '#pxsv-panel .x:hover{opacity:1}',
            '#pxsv-panel button{display:block;width:100%;margin-top:6px;padding:6px 8px;',
            'border:0;border-radius:6px;background:#3a3f4b;color:#fff;cursor:pointer;font-size:12px}',
            '#pxsv-panel button:hover:not(:disabled){background:#4b5262}',
            '#pxsv-panel button:disabled{opacity:.45;cursor:not-allowed}',
            '#pxsv-panel #btnZip{background:#2e7d5b}#pxsv-panel #btnZip:hover:not(:disabled){background:#379a6e}',
            '#pxsv-panel #btnPdf{background:#7a4a2e}#pxsv-panel #btnPdf:hover:not(:disabled){background:#965a37}',
            '#pxsv-panel label{display:flex;align-items:center;gap:6px;margin-top:8px;opacity:.85}',
            '#pxsv-panel .st{margin-top:8px;font-size:11px;opacity:.75;word-break:break-all;min-height:16px}',
            '#pxsv-panel .mini{margin-top:6px;font-size:11px;opacity:.55}'
        ].join('');
        document.head.appendChild(style);

        var panel = document.createElement('div');
        panel.id = 'pxsv-panel';

        var head = document.createElement('div');
        head.className = 'h';
        var title = document.createElement('span');
        title.textContent = 'Pixiv 批量保存';
        var close = document.createElement('span');
        close.className = 'x';
        close.textContent = '×';
        close.title = '关闭面板';
        close.onclick = function () { panel.style.display = 'none'; };
        head.appendChild(title);
        head.appendChild(close);

        var btnCollect = document.createElement('button');
        btnCollect.id = 'btnCollect';
        btnCollect.textContent = '① 抓取本页图片';
        btnCollect.onclick = function () {
            if (state.busy) return;
            setBusy(true);
            setStatus('抓取中…');
            collectAll().then(function (list) {
                state.items = list;
                setStatus('共 ' + list.length + ' 个 URL（含接口补齐）');
            }).catch(function (e) {
                console.warn('[pixiv-save]', e);
                setStatus('抓取失败：' + e.message);
            }).then(function () {
                setBusy(false);
            });
        };

        var btnZip = document.createElement('button');
        btnZip.id = 'btnZip';
        btnZip.textContent = '② 打包 ZIP';
        btnZip.onclick = saveZip;

        var btnPdf = document.createElement('button');
        btnPdf.id = 'btnPdf';
        btnPdf.textContent = '③ 合成 PDF';
        btnPdf.onclick = savePdf;

        var btnOne = document.createElement('button');
        btnOne.id = 'btnOne';
        btnOne.textContent = '④ 逐个交给浏览器下载';
        btnOne.title = '走浏览器下载栈，可能命中缓存，但请求通常不带 Referer；对只查 Referer 的反代会 403，优先用②';
        btnOne.onclick = saveOneByOne;

        var sel = document.createElement('select');
        sel.style.cssText = 'width:100%;margin-top:8px;padding:3px;border-radius:5px;' +
            'border:1px solid #4b5262;background:#2a2e37;color:#eaeaea;font-size:11px';
        sel.innerHTML = '<option value="auto">通道：自动（先页面，CORS 失败转 GM）</option>' +
            '<option value="page">通道：仅页面 fetch（缓存优先）</option>' +
            '<option value="gm">通道：仅 GM 请求（不走缓存）</option>';
        sel.onchange = function () {
            state.channel = sel.value;
            state.pageOk = null;
            setStatus('通道已切换为 ' + sel.value);
        };

        var labWork = document.createElement('label');
        var chkWork = document.createElement('input');
        chkWork.type = 'checkbox';
        chkWork.checked = true;
        var labWorkText = document.createElement('span');
        labWorkText.textContent = '仅当前作品（不含头像/推荐）';
        labWork.appendChild(chkWork);
        labWork.appendChild(labWorkText);

        var labApi = document.createElement('label');
        var chkApi = document.createElement('input');
        chkApi.type = 'checkbox';
        chkApi.checked = true;
        var labApiText = document.createElement('span');
        labApiText.textContent = '用登录态补齐全部页（作品页）';
        labApi.appendChild(chkApi);
        labApi.appendChild(labApiText);

        var lab = document.createElement('label');
        var chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = false;                 // 默认用页面上的缩略图/master1200，缓存命中率最高
        chk.id = 'pxsv-orig';
        var labText = document.createElement('span');
        labText.textContent = '保存原图 img-original（通常无缓存，慢）';
        lab.appendChild(chk);
        lab.appendChild(labText);

        var status = document.createElement('div');
        status.className = 'st';
        status.textContent = '待命';

        var mini = document.createElement('div');
        mini.className = 'mini';
        mini.textContent = '②③ 先试页面 fetch，再退 GM 请求';

        panel.appendChild(head);
        panel.appendChild(btnCollect);
        panel.appendChild(btnZip);
        panel.appendChild(btnPdf);
        panel.appendChild(btnOne);
        panel.appendChild(sel);
        panel.appendChild(labWork);
        panel.appendChild(labApi);
        panel.appendChild(lab);
        panel.appendChild(status);
        panel.appendChild(mini);
        document.body.appendChild(panel);

        ui = {
            panel: panel,
            btnCollect: btnCollect,
            btnZip: btnZip,
            btnPdf: btnPdf,
            btnOne: btnOne,
            original: chk,
            useApi: chkApi,
            onlyWork: chkWork,
            channel: sel,
            status: status
        };
    }

    function main() {
        if (!document.body) { setTimeout(main, 300); return; }
        buildUI();
        state.items = collect();
        setStatus('已抓 ' + state.items.length + ' 个 DOM 图，点①可补齐全部页');
    }

    main();
})();
