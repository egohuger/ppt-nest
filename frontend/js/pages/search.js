/**
 * Search Page - 关键词搜索，支持按分类筛选
 */
const SearchPage = {
    query: '',
    categoryId: 0,        // 0 = all, -1 = uncategorized, >0 = specific category
    currentPage: 1,
    includeHidden: false,
    pageSize: 20,

    async render() {
        // Fetch categories for dropdown
        let categories = [];
        try { categories = await API.getCategories(); } catch (e) {}

        let html = '<div class="page-header">';
        html += '<h1 class="page-title">搜索页面</h1>';
        html += '<p class="page-subtitle">输入关键词，可选限定分类范围</p>';
        html += '</div>';

        // Search bar + category filter
        html += '<div class="card" style="margin-bottom:20px;">';
        html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
        html += `<input type="text" class="form-input" id="search-input" value="${escapeHtml(this.query)}" placeholder="输入关键词…" style="flex:1;min-width:200px;">`;

        // Category dropdown
        let catOpts = '<option value="0">全部类别</option>';
        catOpts += '<option value="-1"' + (this.categoryId === -1 ? ' selected' : '') + '>未分类</option>';
        function buildCatOpts(list, depth = 0) {
            for (const c of list) {
                const prefix = '\xA0 '.repeat(depth);
                const sel = c.id === this.categoryId ? ' selected' : '';
                catOpts += `<option value="${c.id}"${sel}>${prefix}${c.name}</option>`;
                if (c.children) buildCatOpts(c.children, depth + 1);
            }
        }
        buildCatOpts.call(this, categories);
        html += `<select class="form-select" id="search-category" style="width:auto;min-width:140px;padding:8px 12px;">${catOpts}</select>`;

        html += '<button class="btn btn-primary" onclick="SearchPage.doSearch()">搜索</button>';
        html += '</div>';
        html += `<label class="checkbox-label" style="margin-top:8px;display:inline-block;"><input type="checkbox" ${this.includeHidden ? 'checked' : ''} onchange="SearchPage.includeHidden=this.checked;SearchPage.doSearch();">显示已隐藏副本</label>`;
        html += '</div>';

        // Results
        let results = null;
        if (this.query) {
            results = await this._loadResults();

            const scopeLabel = this.categoryId === 0 ? '全部' : this.categoryId === -1 ? '未分类' : '指定分类';
            html += `<div style="margin-bottom:12px;font-size:13px;color:var(--text-secondary);">找到 ${results.total} 个结果（${scopeLabel}）</div>`;

            if (results.items.length === 0) {
                html += '<div class="alert alert-info">没有找到匹配的页面</div>';
            } else {
                html += '<div class="slide-grid">';
                for (const s of results.items) {
                    html += SlideCard.render(s, { showActions: true });
                }
                html += '</div>';
                html += '<div id="search-paginator"></div>';
            }
        } else {
            html += '<div class="alert alert-info">输入关键词开始搜索</div>';
        }

        // Bind enter key and paginator (reuse existing result, no second API call)
        const savedResults = results;
        setTimeout(() => {
            const inp = document.getElementById('search-input');
            if (inp) {
                inp.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') SearchPage.doSearch();
                });
                inp.focus();
            }
            if (savedResults && savedResults.total > this.pageSize) {
                const container = document.getElementById('search-paginator');
                if (container) {
                    container.innerHTML = Paginator.render(
                        savedResults.total, this.pageSize, this.currentPage,
                        (p) => { this.currentPage = p; App.navigate('search'); }
                    );
                }
            }
        }, 0);

        return html;
    },

    async _loadResults() {
        const params = {
            page: this.currentPage,
            page_size: this.pageSize,
            include_hidden: this.includeHidden,
            q: this.query,
        };
        if (this.categoryId === -1) {
            params.category_id = -1;
        } else if (this.categoryId > 0) {
            params.category_id = this.categoryId;
        }
        return API.getSlides(params);
    },

    doSearch() {
        const inp = document.getElementById('search-input');
        const sel = document.getElementById('search-category');
        if (inp) this.query = inp.value.trim();
        if (sel) this.categoryId = parseInt(sel.value) || 0;
        this.currentPage = 1;
        App.navigate('search');
    },
};
