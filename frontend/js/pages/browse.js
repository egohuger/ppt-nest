/**
 * Browse Page - 素材浏览
 */
const BrowsePage = {
    currentCategory: null,     // null=all, 'uncategorized', 'cat_<id>'
    currentCollection: null,   // null or collection id (number)
    currentFile: null,         // null or file id (number)
    searchQuery: null,         // 旧字段，保留兼容；侧栏搜索已不再写它
    pageChips: [],             // 二级搜索：已确认的关键词卡片（多个词 = AND）
    pageDraft: '',             // 二级搜索：输入框里还没确认的那一段
    currentPage: 1,
    includeHidden: false,
    pageSize: 20,
    _searchTimer: null,
    // available page size options
    PAGE_SIZES: [20, 50, 100],

    async render() {
        const slides = await this._loadSlides();

        // 选中了某个文件时，标题显示文件名（「文件浏览」和「分类浏览」唯一能看出
        // 当前在看哪份文件的地方）。删除入口只在左侧面板的【管理】模式里，避免误触。
        let title = '分类浏览';
        let subtitle = '';
        if (this.currentFile !== null) {
            const f = await this._currentFileInfo();
            title = f ? f.file_name : '文件浏览';
            subtitle = f ? `${slides.total} 页 · ${this._fmtBytes(f.file_size)}` : `${slides.total} 页`;
        } else if (this.currentCollection !== null) {
            // 收藏夹：页面收藏夹显示夹内页数，文件收藏夹补一句「N 个文件」
            const cname = (App._collectionNames || {})[this.currentCollection];
            const ckind = (App._collectionKinds || {})[this.currentCollection] || 'slide';
            title = cname || '收藏夹';
            subtitle = `${slides.total} 页`;
            // 优先用最近一次拉到的收藏夹（_fileCollections 是刷面板时更新的，_catData 可能是旧的）
            const all = (App._fileCollections && App._fileCollections.length)
                ? App._fileCollections
                : ((App._catData || {}).collections || []);
            const c = all.find(x => x.id === this.currentCollection);
            if (c && ckind === 'file') subtitle += ` · ${c.file_count || 0} 个文件`;
            if (c && ckind === 'category') subtitle += ` · ${c.category_count || 0} 个分类`;
        }

        let html = '<div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">';
        html += '<div style="min-width:0;">';
        html += `<h1 class="page-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(title)}</h1>`;
        if (subtitle) html += `<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">${escapeHtml(subtitle)}</div>`;
        html += '</div>';
        html += '</div>';

        // Controls bar：每页 N 条 + 隐藏副本（左）／页面搜索（靠右，同一行）
        html += '<div class="grid-controls">';
        html += '<span style="font-size:12px;color:var(--text-tertiary);">每页</span>';
        html += '<select class="form-select" style="width:auto;padding:4px 8px;font-size:12px;" onchange="BrowsePage.setPageSize(this.value)">';
        for (const sz of this.PAGE_SIZES) {
            html += `<option value="${sz}"${this.pageSize === sz ? ' selected' : ''}>${sz}</option>`;
        }
        html += '</select>';
        html += '<span style="font-size:12px;color:var(--text-tertiary);">条</span>';
        html += `<label class="checkbox-label"><input type="checkbox" ${this.includeHidden ? 'checked' : ''} onchange="BrowsePage.toggleHidden(this.checked)">显示已隐藏副本</label>`;

        // ── 二级搜索：在当前范围（分类/收藏夹/文件）里搜页面；每个关键词一张卡片，可单独删 ──
        html += '<div class="grid-search">';
        html += '<div class="chips-box" onclick="BrowsePage._focusChipsInput(event)">';
        html += `<span id="page-chips" class="chips">${this._chipsHtml()}</span>`;
        html += `<input type="text" id="page-search-input" class="chips-input" placeholder="搜索页面，空格分隔多个词" value="${escapeHtml(this.pageDraft || '')}" `;
        html += `oninput="BrowsePage._onChipsInput(this.value)" onkeydown="BrowsePage._onChipsKey(event)" `;
        html += `data-tip="输入关键词后按空格或回车变成卡片；卡片上的 ✕ 可单独删；Esc 清空" aria-label="搜索页面">`;
        html += `<button id="page-chips-clear" class="chips-clear" onclick="event.stopPropagation();BrowsePage.clearPageSearch()" data-tip="清空全部关键词" aria-label="清空全部关键词">${icon('x', 11)}</button>`;
        html += '</div>';
        html += `<button class="btn btn-sm btn-primary grid-search-btn" onclick="BrowsePage.applyPageSearch()" data-tip="搜索" aria-label="搜索">${icon('search', 13)}</button>`;
        html += '</div>';
        html += '</div>';

        // 网格单独一层容器：搜页面时只换这里，输入框不会失焦
        html += `<div id="grid-box">${this._gridHtml(slides)}</div>`;

        setTimeout(() => { this._mountPaginators(slides.total); this._syncChipsUI(); }, 0);
        return html;
    },

    _gridHtml(slides) {
        const q = this._effectiveQuery();
        let html = '<div id="browse-paginator-top"></div>';
        html += '<div id="grid-count" style="margin:12px 0;font-size:13px;color:var(--text-secondary);">';
        html += q
            ? `「${escapeHtml(q)}」匹配 <strong>${slides.total}</strong> 个页面`
            : `共 ${slides.total} 个页面`;
        html += '</div>';

        if (!slides.items.length) {
            html += q
                ? '<div class="alert alert-info">没有匹配的页面。</div>'
                : '<div class="alert alert-info">没有找到页面。进入【素材入库】导入 PPT 文件。</div>';
        } else {
            html += '<div class="slide-grid">';
            for (const s of slides.items) {
                html += SlideCard.render(s, { showActions: true });
            }
            html += '</div>';
            html += '<div id="browse-paginator"></div>';
        }
        return html;
    },

    _mountPaginators(total) {
        if (!(total > this.pageSize)) return;
        const self = this;
        for (const id of ['browse-paginator-top', 'browse-paginator']) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.innerHTML = Paginator.render(
                total, this.pageSize, this.currentPage,
                (p) => { self.currentPage = p; App.navigate(App.currentPage); },
                id
            );
        }
    },

    // ── 二级搜索（页面级）：关键词卡片 ──

    _effectiveQuery() {
        const terms = [...(this.pageChips || [])];
        const draft = (this.pageDraft || '').trim();
        if (draft) terms.push(draft);
        return terms.join(' ').trim();
    },

    _chipsHtml() {
        return (this.pageChips || []).map((t, i) => {
            const safe = escapeHtml(t);
            return `<span class="chip" data-tip="${safe}">${safe}`
                + `<button class="chip-x" onclick="event.stopPropagation();BrowsePage.removeChip(${i})" `
                + `aria-label="移除关键词 ${safe}">${icon('x', 9)}</button></span>`;
        }).join('');
    },

    // 只刷新卡片区/输入框/清空按钮，不动输入焦点
    _syncChipsUI() {
        const chipsEl = document.getElementById('page-chips');
        if (chipsEl) chipsEl.innerHTML = this._chipsHtml();
        const input = document.getElementById('page-search-input');
        if (input) {
            if (input.value !== (this.pageDraft || '')) input.value = this.pageDraft || '';
            input.placeholder = (this.pageChips || []).length ? '' : '搜索页面，空格分隔多个词';
        }
        const clear = document.getElementById('page-chips-clear');
        if (clear) {
            const has = (this.pageChips || []).length > 0 || !!(this.pageDraft || '').trim();
            clear.style.display = has ? '' : 'none';
        }
    },

    _focusChipsInput(e) {
        if (e && e.target && e.target.closest && e.target.closest('.chip-x')) return;
        const input = document.getElementById('page-search-input');
        if (input) input.focus();
    },

    _addChips(words) {
        if (!this.pageChips) this.pageChips = [];
        for (const w of words || []) {
            const word = (w || '').trim();
            if (!word) continue;
            const low = word.toLowerCase();
            if (this.pageChips.some(c => c.toLowerCase() === low)) continue;
            this.pageChips.push(word);
        }
    },

    _onChipsInput(val) {
        // 输入里出现空白（空格/全角空格/粘贴的多个词）→ 前面的词变成卡片
        if (/\s/.test(val)) {
            const endsWithSpace = /\s$/.test(val);
            const parts = val.split(/\s+/).filter(Boolean);
            this._addChips(endsWithSpace ? parts : parts.slice(0, -1));
            this.pageDraft = endsWithSpace ? '' : (parts[parts.length - 1] || '');
        } else {
            this.pageDraft = val;
        }
        this.currentPage = 1;
        this._syncChipsUI();
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => this._refreshGrid(), 300);
    },

    _onChipsKey(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            this._addChips([this.pageDraft]);
            this.pageDraft = '';
            this.currentPage = 1;
            this._syncChipsUI();
            clearTimeout(this._searchTimer);
            this._refreshGrid();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this.clearPageSearch();
        } else if (e.key === 'Backspace' && !(this.pageDraft || '')) {
            if ((this.pageChips || []).length) {
                e.preventDefault();
                this.pageChips.pop();
                this.currentPage = 1;
                this._syncChipsUI();
                clearTimeout(this._searchTimer);
                this._refreshGrid();
            }
        }
    },

    // 删掉单张卡片（用户点卡片上的 ✕）
    removeChip(i) {
        if (!this.pageChips || i < 0 || i >= this.pageChips.length) return;
        this.pageChips.splice(i, 1);
        this.currentPage = 1;
        this._syncChipsUI();
        clearTimeout(this._searchTimer);
        this._refreshGrid();
        const input = document.getElementById('page-search-input');
        if (input) input.focus();
    },

    applyPageSearch() {
        this._addChips([this.pageDraft]);
        this.pageDraft = '';
        this.currentPage = 1;
        this._syncChipsUI();
        clearTimeout(this._searchTimer);
        this._refreshGrid();
    },

    clearPageSearch() {
        this.pageChips = [];
        this.pageDraft = '';
        this.currentPage = 1;
        this._syncChipsUI();
        const input = document.getElementById('page-search-input');
        if (input) input.focus();
        clearTimeout(this._searchTimer);
        this._refreshGrid();
    },

    async _refreshGrid() {
        if (!document.getElementById('grid-box')) return;
        try {
            const slides = await this._loadSlides();
            const box = document.getElementById('grid-box');
            if (!box) return;
            box.innerHTML = this._gridHtml(slides);
            this._mountPaginators(slides.total);
        } catch (e) {
            Toast.error(`搜索失败：${e.message}`);
        }
    },

    async _loadSlides() {
        const params = {
            page: this.currentPage,
            page_size: this.pageSize,
            include_hidden: this.includeHidden,
        };

        // 二级搜索：只筛页面，范围仍由分类/收藏夹/文件决定
        const q = this._effectiveQuery();
        if (q) params.q = q;
        // 记住「这次真正生效的查询串」：放大预览要用它定位，而不是用可能已经变了、
        // 但网格还没刷新的输入框草稿（否则防抖窗口里点放大会定位失败、点了没反应）
        this._appliedQ = q || '';

        // File query
        if (this.currentFile !== null) {
            params.file_id = this.currentFile;
        }
        // Collection query
        else if (this.currentCollection !== null) {
            params.collection_id = this.currentCollection;
        }
        // Category query (only if no collection selected)
        else if (this.currentCategory) {
            if (this.currentCategory === 'uncategorized') {
                params.category_id = -1;
            } else if (this.currentCategory.startsWith('cat_')) {
                params.category_id = parseInt(this.currentCategory.replace('cat_', ''));
                // Sidebar shows cumulative counts — include children to match
                params.include_children = true;
            }
        }

        return API.getSlides(params);
    },

    async _currentFileInfo() {
        const id = this.currentFile;
        if (id === null || id === undefined) return null;
        const cached = (App._cachedFiles || []).find(f => f.id === id);
        if (cached) return cached;
        try {
            const files = await API.getFiles();
            App._cachedFiles = files.filter(f => f.slide_count > 0);
            return files.find(f => f.id === id) || null;
        } catch (e) {
            return null;
        }
    },

    _fmtBytes(n) {
        if (!n) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0, v = n;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
    },

    selectCategory(cat) {
        this.currentCategory = cat;
        this.currentCollection = null;
        this.currentFile = null;
        this.currentPage = 1;
        App.navigate('browse');
    },

    selectCollection(colId) {
        this.currentCategory = null;
        this.currentCollection = colId;
        this.currentFile = null;
        this.currentPage = 1;
        App.navigate('browse');
    },

    setPageSize(val) {
        this.pageSize = parseInt(val);
        this.currentPage = 1;
        App.navigate('browse');
    },

    toggleHidden(val) {
        this.includeHidden = val;
        this.currentPage = 1;
        App.navigate('browse');
    },
};
