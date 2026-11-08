// ==UserScript==
// @name         Bilibili Search Fix
// @namespace    https://github.com/NEPHERAovo/bilibili-search-fix
// @version      1.0.0
// @description  强制B站搜索结果仅显示与关键词相关的视频！底层API拦截，零配置开箱即用，支持直接过滤与模糊展示双模式，支持强相关与弱关联双档强度。
// @author       NEPHERAovo & Antigravity
// @license      MIT
// @match        *://search.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/NEPHERAovo/bilibili-search-fix/main/bilibili-search-fix.user.js
// @updateURL    https://raw.githubusercontent.com/NEPHERAovo/bilibili-search-fix/main/bilibili-search-fix.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const pageContext = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const STORAGE_MODE_KEY = 'bili_purify_display_mode';
    const STORAGE_STRENGTH_KEY = 'bili_purify_filter_strength';

    const MODE_FILTER = 'filter', MODE_BLUR = 'blur';
    const STRENGTH_STRONG = 'strong', STRENGTH_WEAK = 'weak';

    const relevantBvids = new Set(), irrelevantBvids = new Set();
    const relevantAids = new Set(), irrelevantAids = new Set();
    const relevantTitleSet = new Set(), irrelevantTitleSet = new Set();
    const globalTagPool = new Set(), loggedBvids = new Set(), loggedKeptBvids = new Set();
    let currentActiveKeyword = '';

    function resetContextIfKeywordChanged(keyword) {
        if (!keyword || typeof keyword !== 'string') return;
        const normalized = keyword.trim().toLowerCase();
        if (currentActiveKeyword && currentActiveKeyword !== normalized) {
            relevantBvids.clear(); irrelevantBvids.clear();
            relevantAids.clear(); irrelevantAids.clear();
            relevantTitleSet.clear(); irrelevantTitleSet.clear();
            globalTagPool.clear(); loggedBvids.clear(); loggedKeptBvids.clear();
        }
        currentActiveKeyword = normalized;
    }

    function getStorage(k, def) {
        try {
            if (typeof GM_getValue !== 'undefined') return GM_getValue(k, def);
            if (typeof localStorage !== 'undefined') return localStorage.getItem(k) || def;
        } catch (e) {}
        return def;
    }

    function setStorage(k, v) {
        try {
            if (typeof GM_setValue !== 'undefined') GM_setValue(k, v);
            else if (typeof localStorage !== 'undefined') localStorage.setItem(k, v);
        } catch (e) {}
    }

    const getDisplayMode = () => getStorage(STORAGE_MODE_KEY, MODE_FILTER);
    const setDisplayMode = (m) => setStorage(STORAGE_MODE_KEY, m);
    const getFilterStrength = () => getStorage(STORAGE_STRENGTH_KEY, STRENGTH_STRONG);
    const setFilterStrength = (s) => setStorage(STORAGE_STRENGTH_KEY, s);

    function registerTampermonkeyMenu() {
        if (typeof GM_registerMenuCommand === 'undefined') return;

        const curMode = getDisplayMode();
        const nextMode = curMode === MODE_FILTER ? MODE_BLUR : MODE_FILTER;
        const modeLabel = curMode === MODE_FILTER
            ? '直接过滤 - 点击切换为模糊展示'
            : '模糊展示 - 点击切换为直接过滤';

        GM_registerMenuCommand(modeLabel, () => {
            setDisplayMode(nextMode);
            if (typeof alert !== 'undefined') alert(`已切换为【${nextMode === MODE_FILTER ? '直接过滤' : '模糊展示'}】模式`);
            if (typeof location !== 'undefined' && location.reload) location.reload();
        });

        const curStrength = getFilterStrength();
        const nextStrength = curStrength === STRENGTH_STRONG ? STRENGTH_WEAK : STRENGTH_STRONG;
        const strengthLabel = curStrength === STRENGTH_STRONG
            ? '强关联（严格包含） - 点击切换为弱关联'
            : '弱关联（包含相关标签） - 点击切换为强关联';

        GM_registerMenuCommand(strengthLabel, () => {
            setFilterStrength(nextStrength);
            if (typeof alert !== 'undefined') alert(`已切换为【${nextStrength === STRENGTH_STRONG ? '强关联（严格包含）' : '弱关联（包含相关标签）'}】强度`);
            if (typeof location !== 'undefined' && location.reload) location.reload();
        });
    }

    function stripHtml(html) {
        return html ? String(html).replace(/<[^>]+>/g, '').trim() : '';
    }

    function tokenizeSearchKeyword(keyword) {
        if (!keyword || typeof keyword !== 'string') return [];
        const norm = keyword.replace(/[+_,，/\\|]+/g, ' ');
        const tokenSet = new Set();

        norm.split(/\s+/).forEach(t => {
            const tr = t.trim().toLowerCase();
            if (tr) tokenSet.add(tr);
        });

        const segments = norm.match(/[\u4e00-\u9fa5]+|[a-z0-9]+/gi) || [];
        for (const seg of segments) {
            const lower = seg.toLowerCase();
            if (lower.length >= 2 || /^[a-z0-9]$/i.test(lower)) tokenSet.add(lower);

            if (/[\u4e00-\u9fa5]/.test(seg)) {
                if (seg.length >= 4) {
                    const mid = Math.floor(seg.length / 2);
                    tokenSet.add(seg.slice(0, mid));
                    tokenSet.add(seg.slice(mid));
                    for (let i = 0; i <= seg.length - 2; i += 2) tokenSet.add(seg.slice(i, i + 2));
                } else if (seg.length === 3) {
                    tokenSet.add(seg.slice(0, 2));
                    tokenSet.add(seg.slice(1, 3));
                }
            } else {
                const sub = seg.match(/[a-z]+|\d+/gi);
                if (sub && sub.length > 1) {
                    sub.forEach(s => { if (s.length >= 2) tokenSet.add(s.toLowerCase()); });
                }
            }
        }
        return Array.from(tokenSet);
    }

    function hasOfficialKeywordHighlight(item) {
        if (!item) return false;
        const rawTitle = item.title || '', rawDesc = item.description || item.desc || '';
        return /<em\s+class=["']keyword["']>.*?<\/em>/i.test(rawTitle) || /<em\s+class=["']keyword["']>.*?<\/em>/i.test(rawDesc);
    }

    function extractItemTags(item) {
        if (!item) return [];
        const rawTag = item.tag || '';
        const rawTags = Array.isArray(item.tags)
            ? item.tags.map(t => typeof t === 'string' ? t : (t.tag_name || t.name || '')).join(',')
            : (typeof item.tags === 'string' ? item.tags : '');
        const rawRec = Array.isArray(item.new_rec_tags) ? item.new_rec_tags.map(t => t.tag_name || '').join(',') : '';
        return `${rawTag},${rawTags},${rawRec}`
            .split(/[,，、\s+]+/)
            .map(t => t.trim().toLowerCase())
            .filter(t => t.length >= 2);
    }

    function isItemStronglyRelevant(item, searchKeyword) {
        if (!item) return false;
        if (item.type && item.type !== 'video') return false;
        if (!searchKeyword) return true;

        if (hasOfficialKeywordHighlight(item)) return true;
        if (Array.isArray(item.hit_columns) && item.hit_columns.length > 0) return true;

        const tokens = tokenizeSearchKeyword(searchKeyword);
        if (tokens.length === 0) return true;

        const cleanTitle = stripHtml(item.title).toLowerCase();
        const cleanTag = stripHtml(item.tag).toLowerCase();
        const cleanAuthor = stripHtml(item.author || item.uname).toLowerCase();
        const cleanDesc = stripHtml(item.description || item.desc).toLowerCase();
        const itemTags = extractItemTags(item);

        return tokens.some(token =>
            cleanTitle.includes(token) ||
            cleanTag.includes(token) ||
            cleanAuthor.includes(token) ||
            cleanDesc.includes(token) ||
            itemTags.some(t => t.includes(token) || token.includes(t))
        );
    }

    function isItemWeaklyRelevant(item, searchKeyword, tagPool) {
        if (isItemStronglyRelevant(item, searchKeyword)) return true;
        if (!item || (item.type && item.type !== 'video')) return false;

        const pool = tagPool || globalTagPool;
        if (!pool || pool.size === 0) return false;

        const itemTags = extractItemTags(item);
        return itemTags.some(tag => pool.has(tag));
    }

    function recordItemVerdict(item, isRelevant) {
        if (item.bvid) (isRelevant ? relevantBvids : irrelevantBvids).add(item.bvid);
        if (item.aid || item.id) {
            const idStr = String(item.aid || item.id);
            (isRelevant ? relevantAids : irrelevantAids).add(idStr);
        }
        const clean = stripHtml(item.title).toLowerCase();
        if (clean) (isRelevant ? relevantTitleSet : irrelevantTitleSet).add(clean);
    }

    function getMatchReason(item, searchKeyword, matchedTag) {
        if (matchedTag) return `弱关联标签[${matchedTag}]`;
        if (hasOfficialKeywordHighlight(item)) return '官方高亮';
        if (Array.isArray(item.hit_columns) && item.hit_columns.length > 0) {
            return `官方命中[${item.hit_columns.join(',')}]`;
        }
        const tokens = tokenizeSearchKeyword(searchKeyword);
        const title = stripHtml(item.title).toLowerCase();
        const tag = stripHtml(item.tag).toLowerCase();
        const author = stripHtml(item.author || item.uname).toLowerCase();
        const desc = stripHtml(item.description || item.desc).toLowerCase();
        for (const t of tokens) {
            if (title.includes(t)) return `标题命中[${t}]`;
            if (tag.includes(t)) return `标签命中[${t}]`;
            if (author.includes(t)) return `作者命中[${t}]`;
            if (desc.includes(t)) return `简介命中[${t}]`;
        }
        const itemTags = extractItemTags(item);
        for (const it of itemTags) {
            for (const t of tokens) {
                if (it.includes(t) || t.includes(it)) return `标签命中[${it}]`;
            }
        }
        return '关键词相关';
    }

    function logBatchSummary(keptItems, filteredItems, source = 'Data') {
        const mode = getDisplayMode(), strength = getFilterStrength();
        if (keptItems && keptItems.length > 0) {
            console.log(`[BiliSearchFix 放行汇总] 共放行 ${keptItems.length} 条相关内容 [${source}] (强度:${strength})`, keptItems);
        }
        if (filteredItems && filteredItems.length > 0) {
            console.log(`[BiliSearchFix 过滤汇总] 共过滤 ${filteredItems.length} 条不相关内容 [${source}] (模式:${mode}, 强度:${strength})`, filteredItems);
        }
    }

    function cleanVideoList(videos, searchKeyword) {
        if (!Array.isArray(videos)) return videos;

        const currentMode = getDisplayMode(), currentStrength = getFilterStrength();

        videos.forEach(item => {
            if (item && isItemStronglyRelevant(item, searchKeyword)) {
                extractItemTags(item).forEach(t => {
                    if (t.length >= 2) globalTagPool.add(t);
                });
            }
        });

        const kept = [], filteredBatch = [], keptBatch = [];

        videos.forEach(item => {
            if (!item) return;
            const isStrong = isItemStronglyRelevant(item, searchKeyword);
            let isRel = isStrong, reason = '', matchedTag = '';

            if (isStrong) {
                isRel = true;
            } else if (currentStrength === STRENGTH_WEAK) {
                const itemTags = extractItemTags(item);
                matchedTag = itemTags.find(t => globalTagPool.has(t)) || '';
                if (matchedTag) isRel = true;
                else { isRel = false; reason = '弱关联模式下未匹配强相关标签池'; }
            } else {
                isRel = false;
                reason = '强相关模式下未命中关键词或标签';
            }

            recordItemVerdict(item, isRel);

            const idKey = item.bvid || (item.aid ? String(item.aid) : stripHtml(item.title));
            const itemTitle = stripHtml(item.title) || '[无标题/广告]';
            const itemTags = item.tag || (Array.isArray(item.tags) ? item.tags.join(',') : '');

            if (isRel) {
                kept.push(item);
                if (idKey && !loggedKeptBvids.has(idKey)) {
                    loggedKeptBvids.add(idKey);
                    keptBatch.push({
                        bvid: item.bvid || 'N/A',
                        aid: item.aid || item.id || 'N/A',
                        title: itemTitle,
                        tag: itemTags,
                        matchedBy: getMatchReason(item, searchKeyword, matchedTag)
                    });
                }
            } else {
                if (idKey && !loggedBvids.has(idKey)) {
                    loggedBvids.add(idKey);
                    filteredBatch.push({
                        bvid: item.bvid || 'N/A',
                        aid: item.aid || item.id || 'N/A',
                        title: itemTitle,
                        tag: itemTags,
                        hit_columns: item.hit_columns || [],
                        typename: item.typename || '',
                        author: item.author || item.uname || '',
                        reason
                    });
                }
                if (currentMode === MODE_BLUR) kept.push(item);
            }
        });

        if (keptBatch.length > 0 || filteredBatch.length > 0) {
            logBatchSummary(keptBatch, filteredBatch, 'API');
        }

        return kept;
    }

    function cleanSearchDataPayload(container, searchKeyword) {
        if (!container || typeof container !== 'object') return container;

        resetContextIfKeywordChanged(searchKeyword);

        if (container.data && typeof container.data === 'object') {
            cleanSearchDataPayload(container.data, searchKeyword);
            return container;
        }
        if (container.searchResponse && container.searchResponse.searchAllResponse) {
            cleanSearchDataPayload(container.searchResponse.searchAllResponse, searchKeyword);
        }
        if (container.searchTypeResponse && container.searchTypeResponse.searchTypeResponse) {
            cleanSearchDataPayload(container.searchTypeResponse.searchTypeResponse, searchKeyword);
        }

        if (Array.isArray(container.result)) {
            const isSectionList = container.result.some(r => r && (r.result_type || Array.isArray(r.data)));
            if (isSectionList) {
                container.result = container.result.filter(section => {
                    if (!section || section.result_type === 'brand_ad' || section.result_type === 'tips') return false;
                    if (section.result_type === 'video' && Array.isArray(section.data)) {
                        section.data = cleanVideoList(section.data, searchKeyword);
                    }
                    return true;
                });
            } else {
                container.result = cleanVideoList(container.result, searchKeyword);
            }
        }
        return container;
    }

    function getPageSearchKeyword() {
        try {
            const kw = new URLSearchParams(pageContext.location.search).get('keyword');
            if (kw) return decodeURIComponent(kw).trim();
        } catch (e) {}
        const el = document.querySelector('input.search-input-el, .nav-search-input, input[type="search"]');
        return el && el.value ? el.value.trim() : '';
    }

    function extractKeywordFromUrl(url) {
        try {
            const kw = new URL(url, pageContext.location.origin).searchParams.get('keyword');
            if (kw) return decodeURIComponent(kw).trim();
        } catch (e) {}
        return getPageSearchKeyword();
    }

    const isSearchApiUrl = (url) => typeof url === 'string' && (
        url.includes('/search/all') ||
        url.includes('/search/type') ||
        url.includes('/x/web-interface/wbi/search/') ||
        url.includes('/x/web-interface/search/')
    );

    function installFetchHook() {
        const originalFetch = pageContext.fetch;
        if (typeof originalFetch !== 'function') return;

        pageContext.fetch = async function(...args) {
            const requestUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
            if (!isSearchApiUrl(requestUrl)) return originalFetch.apply(this, args);

            const response = await originalFetch.apply(this, args);
            try {
                const cloned = response.clone();
                const json = await cloned.json();
                const keyword = extractKeywordFromUrl(requestUrl);
                const cleanedJson = cleanSearchDataPayload(json, keyword);
                return new Response(JSON.stringify(cleanedJson), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
            } catch (err) {
                return response;
            }
        };
    }

    function installXhrHook() {
        if (!pageContext.XMLHttpRequest || !pageContext.XMLHttpRequest.prototype) return;
        const originalOpen = pageContext.XMLHttpRequest.prototype.open;
        const originalSend = pageContext.XMLHttpRequest.prototype.send;

        pageContext.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this._bp_url = url;
            return originalOpen.apply(this, [method, url, ...rest]);
        };

        pageContext.XMLHttpRequest.prototype.send = function(...args) {
            if (isSearchApiUrl(this._bp_url)) {
                const keyword = extractKeywordFromUrl(this._bp_url);
                this.addEventListener('readystatechange', function() {
                    if (this.readyState === 4 && this.status === 200) {
                        try {
                            const parsed = JSON.parse(this.responseText);
                            const cleaned = cleanSearchDataPayload(parsed, keyword);
                            Object.defineProperty(this, 'responseText', { value: JSON.stringify(cleaned) });
                            Object.defineProperty(this, 'response', { value: cleaned });
                        } catch (e) {}
                    }
                });
            }
            return originalSend.apply(this, args);
        };
    }

    function installPiniaHook() {
        let p = pageContext.__pinia;
        if (p) cleanSearchDataPayload(p, getPageSearchKeyword());
        try {
            Object.defineProperty(pageContext, '__pinia', {
                configurable: true, enumerable: true,
                get: () => p,
                set: (v) => { p = cleanSearchDataPayload(v, getPageSearchKeyword()); }
            });
        } catch (e) {}
    }

    function installSsrHook() {
        try {
            let s = pageContext.__INITIAL_STATE__;
            if (s) pageContext.__INITIAL_STATE__ = cleanSearchDataPayload(s, getPageSearchKeyword());
            else {
                Object.defineProperty(pageContext, '__INITIAL_STATE__', {
                    configurable: true, enumerable: true,
                    get: () => s,
                    set: (v) => { s = cleanSearchDataPayload(v, getPageSearchKeyword()); }
                });
            }
        } catch (e) {}
    }

    function injectMinimalStyles() {
        if (typeof document === 'undefined' || document.getElementById('bili-purify-css')) return;
        const style = document.createElement('style');
        style.id = 'bili-purify-css';
        style.textContent = '.bili-purify-blurred{position:relative!important;cursor:pointer!important;user-select:none!important}.bili-purify-blurred:not(.bili-purify-unblurred)>*{filter:blur(8px) grayscale(40%)!important;opacity:.35!important;transition:filter .25s ease,opacity .25s ease!important;pointer-events:none!important}.bili-purify-blurred:not(.bili-purify-unblurred):hover>*{filter:blur(4px) grayscale(20%)!important;opacity:.6!important}.bili-purify-blurred.bili-purify-unblurred>*{filter:none!important;opacity:1!important;pointer-events:auto!important}.bili-purify-blurred:not(.bili-purify-unblurred)::after{content:"弱相关内容";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.85);color:#fff;padding:7px 14px;border-radius:8px;font-size:13px;font-weight:500;pointer-events:none;z-index:100;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.2)}';
        (document.head || document.documentElement).appendChild(style);
    }

    function isCardIrrelevant(card, keyword) {
        const link = card.querySelector('a[href*="/video/"]');
        const href = link ? (link.getAttribute('href') || '') : '';
        const bvidMatch = href.match(/BV[a-zA-Z0-9]+/i);
        const bvid = bvidMatch ? bvidMatch[0] : '';
        const aidMatch = href.match(/\/video\/av(\d+)/i);
        const aid = aidMatch ? aidMatch[1] : '';

        if (bvid && relevantBvids.has(bvid)) return false;
        if (bvid && irrelevantBvids.has(bvid)) return true;
        if (aid && relevantAids.has(aid)) return false;
        if (aid && irrelevantAids.has(aid)) return true;

        const titleEl = card.querySelector('.bili-video-card__info--tit, h3');
        const rawTitle = titleEl ? titleEl.innerHTML : '';
        const titleText = titleEl ? (titleEl.getAttribute('title') || titleEl.innerText || '').trim().toLowerCase() : '';

        if (titleText && relevantTitleSet.has(titleText)) return false;
        if (titleText && irrelevantTitleSet.has(titleText)) return true;

        if (/<em\s+class=["']keyword["']>.*?<\/em>/i.test(rawTitle) || /<em\s+class=["']keyword["']>.*?<\/em>/i.test(card.innerHTML)) {
            return false;
        }

        const authorEl = card.querySelector('.bili-video-card__info--author, .bili-video-card__author');
        const authorText = authorEl ? (authorEl.innerText || '').trim() : '';

        if (keyword && (titleText || authorText)) {
            return !isItemStronglyRelevant({ type: 'video', title: rawTitle || titleText, author: authorText }, keyword);
        }

        return false;
    }

    function applyCardInteraction(card) {
        if (card.dataset.biliPurifyBound) return;
        card.dataset.biliPurifyBound = '1';

        card.addEventListener('click', (e) => {
            if (card.classList.contains('bili-purify-blurred') && !card.classList.contains('bili-purify-unblurred')) {
                e.preventDefault();
                e.stopPropagation();
                card.classList.add('bili-purify-unblurred');
            }
        }, true);
    }

    function syncStateFromPage() {
        const keyword = getPageSearchKeyword();
        if (!keyword) return;
        if (pageContext.__pinia && pageContext.__pinia.__bp_cleaned_kw !== keyword) {
            pageContext.__pinia.__bp_cleaned_kw = keyword;
            cleanSearchDataPayload(pageContext.__pinia, keyword);
        }
        if (pageContext.__INITIAL_STATE__ && pageContext.__INITIAL_STATE__.__bp_cleaned_kw !== keyword) {
            pageContext.__INITIAL_STATE__.__bp_cleaned_kw = keyword;
            cleanSearchDataPayload(pageContext.__INITIAL_STATE__, keyword);
        }
    }

    function applyDomInspection() {
        if (typeof document === 'undefined') return;

        const keyword = getPageSearchKeyword();
        resetContextIfKeywordChanged(keyword);
        syncStateFromPage();

        const currentMode = getDisplayMode();
        document.querySelectorAll('.bili-video-card').forEach(card => {
            applyCardInteraction(card);
            const irrelevant = isCardIrrelevant(card, keyword);
            const col = card.closest('[class*="col_3"], [class*="col_xs_"], .video-list-item');

            if (irrelevant) {
                if (currentMode === MODE_FILTER) {
                    if (col) col.style.display = 'none';
                    else card.style.display = 'none';
                } else card.classList.add('bili-purify-blurred');
            } else {
                card.classList.remove('bili-purify-blurred');
                if (col && col.style.display === 'none') col.style.display = '';
                if (card.style.display === 'none') card.style.display = '';
            }
        });
    }

    function init() {
        installFetchHook();
        installXhrHook();
        installPiniaHook();
        installSsrHook();
        registerTampermonkeyMenu();
        pageContext.__bili_purify_inspect = applyDomInspection;

        if (typeof document !== 'undefined') {
            const onReady = () => { injectMinimalStyles(); applyDomInspection(); };
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
            else onReady();

            let scheduled = false;
            const observer = new MutationObserver(() => {
                if (!scheduled) {
                    scheduled = true;
                    requestAnimationFrame(() => {
                        applyDomInspection();
                        scheduled = false;
                    });
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }
    }

    init();
})();
