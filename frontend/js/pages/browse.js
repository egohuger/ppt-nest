/**
 * Browse Page - 素材浏览
 */
const BrowsePage = {
    currentCategory: null,     // null=all, 'uncategorized', 'cat_<id>'
    currentCollection: null,   // null or collection id (number)
    currentFile: null,         // null or file id (number)
    searchQuery: null,         // null or search keyword string
    currentPage: 1,
    includeHidden: false,
    pageSize: 20,
    // available page size options
    PAGE_SIZES: [20, 50, 100],

    async render() {
        const slides = await this._loadSlides();

        let html = '<div class="page-header">';
        html += '<h1 class="page-title">分类浏览</h1>';
        html += '</div>';

        // Controls bar: page size + hidden toggle
        html += '<div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap;">';
        html += '<span style="font-size:12px;color:var(--text-tertiary);">每页</span>';
        html += '<select class="form-select" style="width:auto;padding:4px 8px;font-size:12px;" onchange="BrowsePage.setPageSize(this.value)">';
        for (const sz of this.PAGE_SIZES) {
            html += `<option value="${sz}"${this.pageSize === sz ? ' selected' : ''}>${sz}</option>`;
        }
        html += '</select>';
        html += '<span style="font-size:12px;color:var(--text-tertiary);">条</span>';
        html += `<label class="checkbox-label"><input type="checkbox" ${this.includeHidden ? 'checked' : ''} onchange="BrowsePage.toggleHidden(this.checked)">显示已隐藏副本</label>`;
        html += '</div>';

        // Top paginator
        html += '<div id="browse-paginator-top"></div>';

        // Slide count
        html += `<div style="margin-bottom:12px;font-size:13px;color:var(--text-secondary);">共 ${slides.total} 个页面</div>`;

        // Grid
        if (slides.items.length === 0) {
            html += '<div class="alert alert-info">没有找到页面。请先到「扫描处理」导入 PPT 文件。</div>';
        } else {
            html += '<div class="slide-grid">';
            for (const s of slides.items) {
                html += SlideCard.render(s, { showActions: true });
            }
            html += '</div>';

            // Bottom paginator
            html += '<div id="browse-paginator"></div>';
        }

        // Render paginators after DOM update
        const self = this;
        const total = slides.total;
        setTimeout(() => {
            if (total > self.pageSize) {
                const topEl = document.getElementById('browse-paginator-top');
                if (topEl) {
                    topEl.innerHTML = Paginator.render(
                        total, self.pageSize, self.currentPage,
                        (p) => { self.currentPage = p; App.navigate('browse'); },
                        'browse-paginator-top'
                    );
                }
                const botEl = document.getElementById('browse-paginator');
                if (botEl) {
                    botEl.innerHTML = Paginator.render(
                        total, self.pageSize, self.currentPage,
                        (p) => { self.currentPage = p; App.navigate('browse'); },
                        'browse-paginator'
                    );
                }
            }
        }, 0);

        return html;
    },

    async _loadSlides() {
        const params = {
            page: this.currentPage,
            page_size: this.pageSize,
            include_hidden: this.includeHidden,
        };

        // Text search
        if (this.searchQuery) params.q = this.searchQuery;

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
