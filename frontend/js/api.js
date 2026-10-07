/**
 * PPT Nest - API Client
 * Handles all communication with the Python backend
 */

const API = (() => {
    let BASE_URL = 'http://127.0.0.1:18501';

    // Initialize from Electron IPC
    async function init() {
        if (window.electronAPI) {
            BASE_URL = await window.electronAPI.getBackendUrl();
        }
    }

    async function request(method, path, body = null, params = null, timeoutMs = 30000) {
        let url = BASE_URL + path;
        if (params) {
            const sp = new URLSearchParams();
            for (const [k, v] of Object.entries(params)) {
                if (v !== null && v !== undefined && v !== '') sp.append(k, v);
            }
            const qs = sp.toString();
            if (qs) url += '?' + qs;
        }

        const opts = { method, headers: {} };
        if (body && method !== 'GET') {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }

        // Timeout via AbortController
        const controller = new AbortController();
        opts.signal = controller.signal;
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(url, opts);
            clearTimeout(timer);
            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: res.statusText }));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            return res.json();
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') throw new Error('请求超时，后端可能正忙');
            throw e;
        }
    }

    return {
        init,

        // Stats
        getStats: () => request('GET', '/api/stats'),

        // Files
        getFiles: () => request('GET', '/api/files'),

        // Slides
        getSlides: (params = {}) => request('GET', '/api/slides', null, params),
        getSlide: (id) => request('GET', `/api/slides/${id}`),
        updateSlideCategory: (id, categoryId) =>
            request('PUT', `/api/slides/${id}/category`, { category_id: categoryId }),
        deleteSlide: (id) => request('DELETE', `/api/slides/${id}`),

        // Search
        search: (params = {}) => request('GET', '/api/search', null, params),

        // Categories
        getCategories: () => request('GET', '/api/categories'),
        createCategory: (name, parentId, keywords) =>
            request('POST', '/api/categories', { name, parent_id: parentId, keywords }),
        updateCategory: (id, name, keywords) =>
            request('PUT', `/api/categories/${id}`, { name, keywords }),
        deleteCategory: (id) => request('DELETE', `/api/categories/${id}`),
        importCategories: (categories) =>
            request('POST', '/api/categories/import', { categories }),
        exportCategories: () => request('GET', '/api/categories/export'),
        resetCategories: () => request('POST', '/api/categories/reset'),

        // Collections
        getCollections: () => request('GET', '/api/collections'),
        createCollection: (name) => request('POST', '/api/collections', { name }),
        renameCollection: (id, name) => request('PUT', `/api/collections/${id}`, { name }),
        deleteCollection: (id) => request('DELETE', `/api/collections/${id}`),
        addToCollection: (colId, slideId) =>
            request('POST', `/api/collections/${colId}/slides`, { slide_id: slideId }),
        removeFromCollection: (colId, slideId) =>
            request('DELETE', `/api/collections/${colId}/slides/${slideId}`),

        // Scan
        scanCheck: () => request('GET', '/api/scan/check'),
        scanProcess: () => request('POST', '/api/scan/process', null, null, 300000),
        scanProgress: () => request('GET', '/api/scan/progress'),
        scanCancel: () => request('POST', '/api/scan/cancel'),
        scanCleanup: () => request('POST', '/api/scan/cleanup'),
        updateScanSettings: (s) => request('PUT', '/api/scan/settings', null, s),

        // Dedup
        dedupRun: (incremental = false) =>
            request('POST', '/api/dedup/run', null, { incremental }, 300000),
        dedupGroups: (page = 1, pageSize = 10) =>
            request('GET', '/api/dedup/groups', null, { page, page_size: pageSize }),
        dedupSetPrimary: (groupId, slideId) =>
            request('POST', `/api/dedup/groups/${groupId}/primary`, null, { slide_id: slideId }),
        dedupRemoveMember: (memberId) =>
            request('DELETE', `/api/dedup/members/${memberId}`),
        dedupHideAll: () => request('POST', '/api/dedup/hide-all'),
        dedupUnhideAll: () => request('POST', '/api/dedup/unhide-all'),
        dedupProgress: () => request('GET', '/api/dedup/progress'),
        dedupPendingCount: () => request('GET', '/api/dedup/pending-count'),
        dedupUnhide: (slideId) => request('POST', `/api/dedup/unhide/${slideId}`),
        dedupHidden: () => request('GET', '/api/dedup/hidden'),

        // Settings
        getSettings: () => request('GET', '/api/settings'),
        updateSettings: (settings) => request('PUT', '/api/settings', settings),

        // LLM
        llmClassify: () => request('POST', '/api/llm/classify'),
        llmAbsorbKeywords: () => request('POST', '/api/llm/absorb-keywords'),

        // Actions
        reclassifyAll: () => request('POST', '/api/reclassify', null, null, 300000),
        reclassifyProgress: () => request('GET', '/api/reclassify/progress'),
        clearAll: () => request('POST', '/api/clear-all'),
        fixThumbnails: () => request('POST', '/api/fix-thumbnails'),
        openFile: (path) => request('POST', '/api/open-file', null, { path }),
        firstRun: () => request('GET', '/api/first-run'),

        // Thumbnail URL helper
        thumbUrl: (relPath) => relPath ? `${BASE_URL}/api/thumbnail/${relPath}` : null,

        get baseUrl() { return BASE_URL; },
    };
})();
