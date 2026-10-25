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
                const e = new Error(err.detail || `HTTP ${res.status}`);
                e.status = res.status;
                throw e;
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
        filesImpact: (fileIds) => request('POST', '/api/files/impact', { file_ids: fileIds }),
        filesDelete: (fileIds) => request('POST', '/api/files/delete', { file_ids: fileIds }),

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
        createCollection: (name, kind = 'slide') => request('POST', '/api/collections', { name, kind }),
        renameCollection: (id, name) => request('PUT', `/api/collections/${id}`, { name }),
        deleteCollection: (id) => request('DELETE', `/api/collections/${id}`),
        addToCollection: (colId, slideId) =>
            request('POST', `/api/collections/${colId}/slides`, { slide_id: slideId }),
        removeFromCollection: (colId, slideId) =>
            request('DELETE', `/api/collections/${colId}/slides/${slideId}`),

        // 文件级收藏（文件收藏夹）
        getCollectionFiles: (colId) => request('GET', `/api/collections/${colId}/files`),
        addFileToCollection: (colId, fileId) =>
            request('POST', `/api/collections/${colId}/files`, { file_id: fileId }),
        removeFileFromCollection: (colId, fileId) =>
            request('DELETE', `/api/collections/${colId}/files/${fileId}`),
        getFileCollections: (fileId) => request('GET', `/api/files/${fileId}/collections`),

        // 类别级收藏（类别收藏夹）
        getCollectionCategories: (colId) => request('GET', `/api/collections/${colId}/categories`),
        addCategoryToCollection: (colId, categoryId) =>
            request('POST', `/api/collections/${colId}/categories`, { category_id: categoryId }),
        removeCategoryFromCollection: (colId, categoryId) =>
            request('DELETE', `/api/collections/${colId}/categories/${categoryId}`),
        getCategoryCollections: (categoryId) => request('GET', `/api/categories/${categoryId}/collections`),

        // Scan
        scanCheck: () => request('GET', '/api/scan/check'),
        scanDiscover: (roots = null) => request('POST', '/api/scan/discover', roots ? { roots } : {}),
        scanProcess: (paths = null) => request('POST', '/api/scan/process', paths ? { paths } : {}, null, 300000),
        scanProgress: () => request('GET', '/api/scan/progress'),
        // 右键「打开方式」带进来的文件：先 check 再按需导入
        importCheck: (paths) => request('POST', '/api/import/check', { paths }),
        importFiles: (paths, classify = false) =>
            request('POST', '/api/import/files', { paths, classify }, null, 600000),
        scanCancel: () => request('POST', '/api/scan/cancel'),
        scanCleanup: (paths = null) => request('POST', '/api/scan/cleanup', paths ? { paths } : {}),
        updateScanRoots: (roots) => request('PUT', '/api/scan/roots', { roots }),
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

        // 组稿（手动拼页）
        composeList: () => request('GET', '/api/compose'),
        composeCreate: (name) => request('POST', '/api/compose', { name }),
        composeGet: (id) => request('GET', `/api/compose/${id}`),
        composeRename: (id, name) => request('PUT', `/api/compose/${id}`, { name }),
        composeDelete: (id) => request('DELETE', `/api/compose/${id}`),
        composeAddItem: (id, slideId, afterIndex = null) =>
            request('POST', `/api/compose/${id}/items`, { slide_id: slideId, after_index: afterIndex }),
        composeReorder: (id, ids) => request('PUT', `/api/compose/${id}/items/order`, { ids }),
        composeRemoveItem: (id, itemId) => request('DELETE', `/api/compose/${id}/items/${itemId}`),
        composeExport: (id, outputPath, replacements = null) =>
            request('POST', `/api/compose/${id}/export`,
                { output_path: outputPath, replacements: replacements || [] }, null, 60000),
        composePreflight: (id) => request('GET', `/api/compose/${id}/preflight`),
        composeTemplates: () => request('GET', '/api/compose/templates'),
        composeFromTemplate: (templateId, name = null) =>
            request('POST', '/api/compose/templates/from', { template_id: templateId, name }, null, 120000),
        composeMarkTemplate: (id, isTemplate = true) =>
            request('POST', `/api/compose/${id}/template`, { is_template: !!isTemplate }),
        composeExportProgress: () => request('GET', '/api/compose/export/progress'),

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
        completeOnboarding: () => request('POST', '/api/onboarding/complete'),
        resetOnboarding: () => request('POST', '/api/onboarding/reset'),

        // Thumbnail URL helper
        thumbUrl: (relPath) => relPath ? `${BASE_URL}/api/thumbnail/${relPath}` : null,

        get baseUrl() { return BASE_URL; },
    };
})();
