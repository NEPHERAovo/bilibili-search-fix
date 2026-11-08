// ==UserScript==
// @name         Bilibili Search Fix
// @namespace    https://github.com/NEPHERAovo/bilibili-search-fix
// @version      1.0.1
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
    const globalTagPool = new Map(), loggedBvids = new Set(), loggedKeptBvids = new Set();
    const tagStatsMap = new Map(), tagAnalyzedVideos = new Set();
    const GENERIC_TAGS = new Set(['游戏', '单机游戏', '网络游戏', '手机游戏', '娱乐', '搞笑', '日常', '生活', '二创', '自制', '搬运', '视频', '原创', '新人', '推荐']);
    let currentActiveKeyword = '';

    function resetContextIfKeywordChanged(keyword) {
        if (!keyword || typeof keyword !== 'string') return;
        const normalized = keyword.trim().toLowerCase();
        if (currentActiveKeyword && currentActiveKeyword !== normalized) {
            [relevantBvids, irrelevantBvids, relevantAids, irrelevantAids, relevantTitleSet, irrelevantTitleSet, globalTagPool, loggedBvids, loggedKeptBvids, tagAnalyzedVideos].forEach(s => s.clear());
            tagStatsMap.clear();
        }
        currentActiveKeyword = normalized;
    }

    const getStorage = (k, def) => {
        try { return typeof GM_getValue !== 'undefined' ? (GM_getValue(k, def) ?? def) : (typeof localStorage !== 'undefined' ? (localStorage.getItem(k) || def) : def); } catch (e) { return def; }
    };
    const setStorage = (k, v) => {
        try { if (typeof GM_setValue !== 'undefined') GM_setValue(k, v); else if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch (e) {}
    };

    const getDisplayMode = () => getStorage(STORAGE_MODE_KEY, MODE_BLUR);
    const setDisplayMode = (m) => setStorage(STORAGE_MODE_KEY, m);
    const getFilterStrength = () => getStorage(STORAGE_STRENGTH_KEY, STRENGTH_WEAK);
    const setFilterStrength = (s) => setStorage(STORAGE_STRENGTH_KEY, s);

    function registerTampermonkeyMenu() {
        if (typeof GM_registerMenuCommand === 'undefined') return;
        const curMode = getDisplayMode(), curStrength = getFilterStrength();
        const nextMode = curMode === MODE_FILTER ? MODE_BLUR : MODE_FILTER;
        const nextStrength = curStrength === STRENGTH_STRONG ? STRENGTH_WEAK : STRENGTH_STRONG;
        const switchMenu = (title, fn) => GM_registerMenuCommand(title, () => { fn(); typeof location !== 'undefined' && location.reload(); });
        switchMenu(curMode === MODE_FILTER ? '直接过滤 - 点击切换为模糊展示' : '模糊展示 - 点击切换为直接过滤', () => {
            setDisplayMode(nextMode);
            if (typeof alert !== 'undefined') alert(`已切换为【${nextMode === MODE_FILTER ? '直接过滤' : '模糊展示'}】模式`);
        });
        switchMenu(curStrength === STRENGTH_STRONG ? '强关联（严格包含） - 点击切换为弱关联' : '弱关联（包含相关标签） - 点击切换为强关联', () => {
            setFilterStrength(nextStrength);
            if (typeof alert !== 'undefined') alert(`已切换为【${nextStrength === STRENGTH_STRONG ? '强关联（严格包含）' : '弱关联（包含相关标签）'}】强度`);
        });
    }

    function stripHtml(html) {
        return html ? String(html).replace(/<[^>]+>/g, '').trim() : '';
    }

    function tokenizeSearchKeyword(keyword) {
        if (!keyword || typeof keyword !== 'string') return [];
        const norm = keyword.replace(/[+_,，/\\|]+/g, ' ').toLowerCase(), tokenSet = new Set();
        norm.split(/\s+/).forEach(t => t && tokenSet.add(t));
        for (const seg of norm.match(/[\u4e00-\u9fa5]+|[a-z0-9]+/gi) || []) {
            if (seg.length >= 2 || /^[a-z0-9]$/.test(seg)) tokenSet.add(seg);
            if (/[\u4e00-\u9fa5]/.test(seg)) {
                if (seg.length >= 4) {
                    const m = Math.floor(seg.length / 2);
                    tokenSet.add(seg.slice(0, m)); tokenSet.add(seg.slice(m));
                    for (let i = 0; i <= seg.length - 2; i += 2) tokenSet.add(seg.slice(i, i + 2));
                } else if (seg.length === 3) {
                    tokenSet.add(seg.slice(0, 2)); tokenSet.add(seg.slice(1, 3));
                }
            } else {
                (seg.match(/[a-z]+|\d+/gi) || []).forEach(s => { if (s.length >= 2) tokenSet.add(s); });
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
        const t1 = item.tag || '', t2 = Array.isArray(item.tags) ? item.tags.map(t => typeof t === 'string' ? t : (t.tag_name || t.name || '')).join(',') : (item.tags || '');
        const t3 = Array.isArray(item.new_rec_tags) ? item.new_rec_tags.map(t => t.tag_name || '').join(',') : '';
        return `${t1},${t2},${t3}`.split(/[,，、/\\|;；\s+]+/).map(t => t.replace(/^[#＃@]+|[#＃@]+$/g, '').trim().toLowerCase()).filter(t => t.length >= 2);
    }

    function isItemStronglyRelevant(item, searchKeyword) {
        if (!item || (item.type && item.type !== 'video')) return false;
        if (!searchKeyword) return true;
        if (hasOfficialKeywordHighlight(item) || (Array.isArray(item.hit_columns) && item.hit_columns.length > 0)) return true;

        const tokens = tokenizeSearchKeyword(searchKeyword);
        if (tokens.length === 0) return true;

        const title = stripHtml(item.title).toLowerCase(), tag = stripHtml(item.tag).toLowerCase();
        const author = stripHtml(item.author || item.uname).toLowerCase(), desc = stripHtml(item.description || item.desc).toLowerCase();
        const itemTags = extractItemTags(item);

        return tokens.some(t =>
            title.includes(t) || tag.includes(t) || author.includes(t) || desc.includes(t) ||
            itemTags.some(it => it.includes(t) || t.includes(it))
        );
    }


    function recordItemVerdict(item, isRelevant) {
        if (item.bvid) (isRelevant ? relevantBvids : irrelevantBvids).add(item.bvid);
        const id = item.aid || item.id;
        if (id) (isRelevant ? relevantAids : irrelevantAids).add(String(id));
        const clean = stripHtml(item.title).toLowerCase();
        if (clean) (isRelevant ? relevantTitleSet : irrelevantTitleSet).add(clean);
    }

    function getMatchReason(item, searchKeyword, matchedTag) {
        if (matchedTag) return matchedTag;
        if (hasOfficialKeywordHighlight(item)) return '官方高亮';
        if (Array.isArray(item.hit_columns) && item.hit_columns.length) return `官方命中[${item.hit_columns.join(',')}]`;
        const tokens = tokenizeSearchKeyword(searchKeyword);
        const fields = [[stripHtml(item.title).toLowerCase(), '标题'], [stripHtml(item.tag).toLowerCase(), '标签'], [stripHtml(item.author || item.uname).toLowerCase(), '作者'], [stripHtml(item.description || item.desc).toLowerCase(), '简介']];
        for (const [val, label] of fields) for (const t of tokens) if (val.includes(t)) return `${label}命中[${t}]`;
        for (const it of extractItemTags(item)) for (const t of tokens) if (it.includes(t) || t.includes(it)) return `标签命中[${it}]`;
        return '关键词相关';
    }

    function logBatchSummary(kept, filtered, source = 'Data') {
        const mode = getDisplayMode(), strength = getFilterStrength();
        if (strength === STRENGTH_WEAK && globalTagPool.size > 0) {
            const preview = Array.from(globalTagPool.entries()).slice(0, 10).map(([t, info]) => `${t}(#${info.rank}, 权${info.score})`).join(', ');
            console.log(`[BiliSearchFix 弱关联高权池] Top ${globalTagPool.size}: ${preview}`);
        }
        if (kept && kept.length) console.log(`[BiliSearchFix 放行汇总] 共放行 ${kept.length} 条相关内容 [${source}] (强度:${strength})`, kept);
        if (filtered && filtered.length) console.log(`[BiliSearchFix 过滤汇总] 共过滤 ${filtered.length} 条不相关内容 [${source}] (模式:${mode}, 强度:${strength})`, filtered);
    }

    function updateWeightedTagPool(videos, searchKeyword) {
        if (!Array.isArray(videos)) return;
        const tokens = tokenizeSearchKeyword(searchKeyword);
        videos.forEach(item => {
            if (!item || !isItemStronglyRelevant(item, searchKeyword)) return;
            const vid = item.bvid || (item.aid ? String(item.aid) : stripHtml(item.title));
            if (vid && tagAnalyzedVideos.has(vid)) return;
            if (vid) tagAnalyzedVideos.add(vid);
            const tags = Array.from(new Set(extractItemTags(item))).filter(t => !GENERIC_TAGS.has(t));
            if (!tags.length) return;
            const discount = 1 / Math.sqrt(tags.length);
            tags.forEach(t => {
                const s = tagStatsMap.get(t) || { score: 0 };
                s.score += discount;
                tagStatsMap.set(t, s);
            });
        });

        const list = [];
        tagStatsMap.forEach((s, tag) => {
            const hasTok = tokens.some(tok => tag.includes(tok) || tok.includes(tag));
            const score = s.score + (hasTok ? 1 : 0);
            if (score >= 0.35) list.push({ tag, score: Math.round(score * 100) / 100 });
        });
        list.sort((a, b) => b.score - a.score);
        globalTagPool.clear();
        list.slice(0, 25).forEach((item, idx) => globalTagPool.set(item.tag, { rank: idx + 1, score: item.score }));
    }

    function cleanVideoList(videos, searchKeyword) {
        if (!Array.isArray(videos)) return videos;

        const currentMode = getDisplayMode(), currentStrength = getFilterStrength();
        updateWeightedTagPool(videos, searchKeyword);

        const kept = [], filteredBatch = [], keptBatch = [];

        videos.forEach(item => {
            if (!item) return;
            const isStrong = isItemStronglyRelevant(item, searchKeyword);
            let isRel = isStrong, reason = '', matchedTag = '';

            if (isStrong) {
                isRel = true;
            } else if (currentStrength === STRENGTH_WEAK) {
                const itemTags = extractItemTags(item);
                const hit = itemTags.find(t => globalTagPool.has(t));
                if (hit) {
                    const info = globalTagPool.get(hit);
                    matchedTag = `弱关联标签[${hit}] (排名#${info.rank}, 权重${info.score})`;
                    isRel = true;
                } else {
                    const cleanTitle = stripHtml(item.title).toLowerCase();
                    const found = Array.from(globalTagPool.keys()).find(t => t.length >= 2 && cleanTitle.includes(t));
                    if (found) {
                        const info = globalTagPool.get(found);
                        matchedTag = `弱关联标题命中[${found}] (排名#${info.rank}, 权重${info.score})`;
                        isRel = true;
                    } else {
                        isRel = false;
                        const tagStr = itemTags.slice(0, 5).join(',');
                        reason = tagStr
                            ? `弱关联未命中：视频标签[${tagStr}]未进入高权池(Top${globalTagPool.size})`
                            : `弱关联未命中：无有效标签且标题未命中高权词(Top${globalTagPool.size})`;
                    }
                }
            } else {
                isRel = false;
                reason = `强相关未命中：标题与标签均未包含关键词[${searchKeyword}]`;
            }

            recordItemVerdict(item, isRel);

            const idKey = item.bvid || (item.aid ? String(item.aid) : stripHtml(item.title));
            const itemTitle = stripHtml(item.title) || '[无标题/广告]';
            const itemTags = item.tag || (Array.isArray(item.tags) ? item.tags.join(',') : '');

            if (isRel) {
                kept.push(item);
                if (idKey && !loggedKeptBvids.has(idKey)) {
                    loggedKeptBvids.add(idKey);
                    keptBatch.push({ bvid: item.bvid || 'N/A', aid: item.aid || item.id || 'N/A', title: itemTitle, tag: itemTags, matchedBy: getMatchReason(item, searchKeyword, matchedTag) });
                }
            } else {
                if (idKey && !loggedBvids.has(idKey)) {
                    loggedBvids.add(idKey);
                    filteredBatch.push({ bvid: item.bvid || 'N/A', aid: item.aid || item.id || 'N/A', title: itemTitle, tag: itemTags, hit_columns: item.hit_columns || [], typename: item.typename || '', author: item.author || item.uname || '', reason });
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
        if (container.searchResponse?.searchAllResponse) cleanSearchDataPayload(container.searchResponse.searchAllResponse, searchKeyword);
        if (container.searchTypeResponse?.searchTypeResponse) cleanSearchDataPayload(container.searchTypeResponse.searchTypeResponse, searchKeyword);

        if (Array.isArray(container.result)) {
            const isSectionList = container.result.some(r => r && (r.result_type || Array.isArray(r.data)));
            if (isSectionList) {
                container.result = container.result.filter(sec => {
                    if (!sec || sec.result_type === 'brand_ad' || sec.result_type === 'tips') return false;
                    if (sec.result_type === 'video' && Array.isArray(sec.data)) sec.data = cleanVideoList(sec.data, searchKeyword);
                    if ((sec.result_type === 'bili_user' || sec.result_type === 'user') && Array.isArray(sec.data)) {
                        sec.data.forEach(u => u?.res?.forEach?.(item => recordItemVerdict(item, true)));
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
        return document.querySelector('input.search-input-el, .nav-search-input, input[type="search"]')?.value?.trim() || '';
    }

    function extractKeywordFromUrl(url) {
        try {
            const kw = new URL(url, pageContext.location.origin).searchParams.get('keyword');
            if (kw) return decodeURIComponent(kw).trim();
        } catch (e) {}
        return getPageSearchKeyword();
    }

    const isSearchApiUrl = (url) => typeof url === 'string' && (url.includes('/search/all') || url.includes('/search/type') || url.includes('/wbi/search/'));

    function installFetchHook() {
        const originalFetch = pageContext.fetch;
        if (typeof originalFetch !== 'function') return;

        pageContext.fetch = async function(...args) {
            const requestUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (!isSearchApiUrl(requestUrl)) return originalFetch.apply(this, args);

            const response = await originalFetch.apply(this, args);
            try {
                const json = await response.clone().json();
                const cleanedJson = cleanSearchDataPayload(json, extractKeywordFromUrl(requestUrl));
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
        const proto = pageContext.XMLHttpRequest?.prototype;
        if (!proto) return;
        const origOpen = proto.open, origSend = proto.send;

        proto.open = function(m, url, ...rest) { this._bp_url = url; return origOpen.apply(this, [m, url, ...rest]); };
        proto.send = function(...args) {
            if (isSearchApiUrl(this._bp_url)) {
                const kw = extractKeywordFromUrl(this._bp_url);
                this.addEventListener('readystatechange', function() {
                    if (this.readyState === 4 && this.status === 200) {
                        try {
                            const cleaned = cleanSearchDataPayload(JSON.parse(this.responseText), kw);
                            Object.defineProperty(this, 'responseText', { value: JSON.stringify(cleaned) });
                            Object.defineProperty(this, 'response', { value: cleaned });
                        } catch (e) {}
                    }
                });
            }
            return origSend.apply(this, args);
        };
    }

    function hookGlobalObject(prop) {
        try {
            let val = pageContext[prop];
            if (val) cleanSearchDataPayload(val, getPageSearchKeyword());
            Object.defineProperty(pageContext, prop, {
                configurable: true, enumerable: true,
                get: () => val,
                set: (nv) => { val = cleanSearchDataPayload(nv, getPageSearchKeyword()); }
            });
        } catch (e) {}
    }

    function injectMinimalStyles() {
        if (typeof document === 'undefined' || document.getElementById('bili-purify-css')) return;
        const style = document.createElement('style');
        style.id = 'bili-purify-css';
        style.textContent = '.bili-purify-blurred{position:relative!important;cursor:pointer!important}.bili-purify-blurred>*{filter:blur(8px) grayscale(40%)!important;opacity:.35!important;transition:filter .2s ease,opacity .2s ease!important}.bili-purify-blurred:hover>*{filter:none!important;opacity:1!important}.bili-purify-blurred::after{content:"弱相关内容";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.85);color:#fff;padding:6px 12px;border-radius:8px;font-size:13px;pointer-events:none;z-index:100;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.4);transition:opacity .2s ease,visibility .2s ease!important}.bili-purify-blurred:hover::after{opacity:0!important;visibility:hidden!important}';
        (document.head || document.documentElement).appendChild(style);
    }

    function isCardIrrelevant(card, keyword) {
        if (card.closest('.b-user-video-card, .user-video-info, .user-list, .search-user-card, [class*="user-card"], [class*="user-video"], .user-info')) return false;

        const link = card.querySelector('a[href*="/video/"]');
        const href = link?.getAttribute?.('href') || link?.href || '';
        const bvid = href.match(/BV[a-zA-Z0-9]+/i)?.[0];
        const aid = href.match(/\/video\/av(\d+)/i)?.[1];

        if (bvid && relevantBvids.has(bvid)) return false;
        if (bvid && irrelevantBvids.has(bvid)) return true;
        if (aid && relevantAids.has(aid)) return false;
        if (aid && irrelevantAids.has(aid)) return true;

        const titleEl = card.querySelector('.bili-video-card__info--tit, h3');
        const rawTitle = titleEl ? titleEl.innerHTML : '';
        const titleText = (titleEl?.getAttribute?.('title') || titleEl?.innerText || '').trim().toLowerCase();

        if (titleText && relevantTitleSet.has(titleText)) return false;
        if (titleText && irrelevantTitleSet.has(titleText)) return true;

        if (/<em\s+class=["']keyword["']>.*?<\/em>/i.test(rawTitle) || /<em\s+class=["']keyword["']>.*?<\/em>/i.test(card.innerHTML)) return false;

        const authorEl = card.querySelector('.bili-video-card__info--author, .bili-video-card__author');
        const authorText = (authorEl?.innerText || '').trim();

        if (keyword && (titleText || authorText)) {
            if (isItemStronglyRelevant({ type: 'video', title: rawTitle || titleText, author: authorText }, keyword)) return false;
            if (getFilterStrength() === STRENGTH_WEAK) {
                for (const [tag] of globalTagPool) if (tag.length >= 2 && titleText.includes(tag)) return false;
            }
            return true;
        }
        return false;
    }

    function applyCardInteraction(card) {
        if (card.dataset.biliPurifyBound) return;
        card.dataset.biliPurifyBound = '1';
        card.addEventListener('click', (e) => {
            if (!card.classList.contains('bili-purify-blurred') || e?.target?.closest('a')) return;
            const a = card.querySelector('a[href*="/video/"]');
            if (!a) return;
            if (typeof a.click === 'function') a.click();
            else if (typeof window !== 'undefined' && typeof window.open === 'function') {
                window.open(a.getAttribute?.('href') || a.href, a.target || '_blank');
            }
        });
    }

    function syncStateFromPage() {
        const keyword = getPageSearchKeyword();
        if (!keyword) return;
        const p = pageContext.__pinia;
        const syncTarget = (obj) => {
            if (obj && obj.__bp_cleaned_kw !== keyword) {
                obj.__bp_cleaned_kw = keyword;
                cleanSearchDataPayload(obj, keyword);
            }
        };
        if (p) {
            syncTarget(p.searchResponse?.searchAllResponse);
            syncTarget(p.searchTypeResponse?.searchTypeResponse);
        }
        syncTarget(pageContext.__INITIAL_STATE__);
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
        hookGlobalObject('__pinia');
        hookGlobalObject('__INITIAL_STATE__');
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
