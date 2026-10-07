/**
 * PPT Nest - Main Application
 * Router, navigation, global event handling
 */

const App = {
    currentPage: 'browse',
    expandedCategories: new Set(),
    subSidebarWidth: 160, // default, overridden by localStorage
    _collectionNames: {}, // {id: name} cache

    pageMap: {
        onboarding: OnboardingPage,
        browse: BrowsePage,
        files: FilesPage,
        search: SearchPage,
        scan: ScanPage,
        dedup: DedupPage,
        categories: CategoriesPage,
        settings: SettingsPage,
    },

    pageTitles: {
        onboarding: '欢迎',
        browse: '分类浏览',
        files: '文件浏览',
        search: '搜索',
        scan: '扫描处理',
        dedup: '重复检测',
        categories: '类别管理',
        settings: '设置',
    },

    // “即将上线”功能（画饼）：{ icon, name, desc }——均为基于现有能力可落地的功能
    comingSoonFeatures: {
        aigc: {
            icon: '✨',
            name: 'AI 智能组稿',
            desc: '只需描述你的方案需求（主题、客户行业、篇幅），AI 就会从你的素材库中自动挑选合适的页面，组合成一份结构完整的 PPT 初稿。',
        },
        export: {
            icon: '📤',
            name: '导出合集为 PPT',
            desc: '把收藏夹里的页面一键导出成一份全新的 PPT 文件，挑好的素材秒变成品，直接交付。',
        },
        similar: {
            icon: '🔍',
            name: '相似页推荐',
            desc: '看到一页好素材？一键找出库里风格、内容相近的更多页面，一次收集齐。',
        },
        backup: {
            icon: '💾',
            name: '一键备份还原',
            desc: '一键打包你的素材库、分类体系和收藏，换电脑或重装系统也不怕丢。',
        },
    },

    async init() {
        await API.init();
        console.log('[PPTNest] API initialized, backend:', API.baseUrl);

        // Bind primary sidebar navigation
        document.querySelectorAll('#sidebar .nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const page = item.dataset.page;
                if (page) this.navigate(page);
            });
        });

        // Bind "coming soon" locked nav items
        document.querySelectorAll('#sidebar .nav-locked').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const key = item.dataset.feature;
                if (key) this.showComingSoon(key);
            });
        });

        // Bind sidebar collapse toggle
        document.getElementById('sidebar-collapse-btn').addEventListener('click', () => {
            this.toggleSidebar();
        });

        // Bind sidebar expand toggle (visible when collapsed)
        document.getElementById('sidebar-expand-btn').addEventListener('click', () => {
            this.toggleSidebar();
        });

        // Bind browse chevron to toggle sub-sidebar
        document.getElementById('browse-chevron').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleSubSidebar();
        });

        // Bind files chevron to toggle sub-sidebar
        document.getElementById('files-chevron').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleSubSidebar();
        });

        // Init sub-sidebar resize handle
        this.initResizeHandle();

        // Check first-run status
        let startPage = 'browse';
        try {
            const status = await API.firstRun();
            if (status.is_first_run) {
                startPage = 'onboarding';
                await OnboardingPage.init();
            }
        } catch (e) {
            console.warn('first-run check failed, defaulting to browse:', e.message);
        }

        // Load initial page
        await this.navigate(startPage);

        // Update stats periodically
        this.updateStats();
        setInterval(() => this.updateStats(), 30000);
    },

    // “即将上线”功能弹窗：介绍功能 + 引导关注公众号 / 加微信群
    showComingSoon(key) {
        const f = this.comingSoonFeatures[key];
        if (!f) return;

        let html = '';
        html += '<div style="text-align:center;padding:6px 0 2px;">';
        html += `<div style="font-size:40px;margin-bottom:6px;">${f.icon}</div>`;
        html += `<div style="font-size:16px;font-weight:700;">${escapeHtml(f.name)}</div>`;
        html += '<div style="display:inline-block;margin:8px 0 12px;padding:3px 12px;border-radius:999px;background:rgba(245,158,11,0.15);color:#d97706;font-size:12px;font-weight:600;">🔒 即将上线 · 敬请期待</div>';
        html += `<p style="font-size:13px;color:var(--text-secondary);line-height:1.7;text-align:left;">${escapeHtml(f.desc)}</p>`;
        html += '</div>';

        html += '<div style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px;">';
        html += '<div style="font-size:13px;font-weight:600;margin-bottom:10px;">想第一时间体验？两种方式：</div>';
        html += '<div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;">';

        // 公众号（永久有效）
        html += '<div style="text-align:center;">';
        html += '<img src="wechat-qrcode.png" alt="公众号二维码" style="width:130px;height:130px;border-radius:8px;border:1px solid var(--border);object-fit:cover;">';
        html += '<div style="margin-top:6px;font-size:12px;color:var(--text-secondary);">关注公众号「岱森LIVE」<br>上线第一时间通知你</div>';
        html += '</div>';

        // 用户群（引导加个人微信，避免群二维码 7 天失效）
        html += '<div style="flex:1;min-width:180px;font-size:13px;color:var(--text-secondary);line-height:1.8;">';
        html += '<div style="font-weight:600;color:var(--text-primary);margin-bottom:4px;">💬 加入用户群</div>';
        html += '添加微信 <span style="user-select:all;color:var(--accent);">egohughu</span>，备注「<strong>进群</strong>」，即可加入 PPT Nest 用户群，获取内测资格与上线通知。';
        html += '</div>';

        html += '</div>';
        html += '</div>';

        Modal.show(`${f.icon} ${f.name}`, html, [
            { label: '我知道了', key: 'ok', primary: true },
        ]);
    },

    async navigate(page) {
        const prevPage = this.currentPage;
        this.currentPage = page;

        // Update sidebar active
        document.querySelectorAll('#sidebar .nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.page === page);
        });

        // Show sub-sidebar for browse/files, hide for others
        const subSidebar = document.getElementById('sub-sidebar');
        const resizeHandle = document.getElementById('sub-sidebar-resize-handle');
        const subTitle = document.getElementById('sub-sidebar-title');
        if (page === 'browse' || page === 'files') {
            subSidebar.classList.add('visible');
            resizeHandle.classList.add('visible');
            if (subTitle) subTitle.textContent = page === 'browse' ? '分类浏览' : '文件浏览';
            if (page === 'browse') {
                this.loadSubNav();
            } else {
                this.loadFileSubNav();
            }
        } else {
            subSidebar.classList.remove('visible');
            resizeHandle.classList.remove('visible');
        }

        // Render page -- delay spinner: only show if render takes >200ms
        const container = document.getElementById('page-container');
        let spinnerTimer = null;
        if (page !== prevPage) {
            spinnerTimer = setTimeout(() => {
                container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>加载中...</p></div>';
            }, 200);
        }

        try {
            const pageModule = this.pageMap[page];
            if (!pageModule) {
                clearTimeout(spinnerTimer);
                container.innerHTML = '<div class="alert alert-danger">页面未找到</div>';
                return;
            }

            const html = await pageModule.render();
            clearTimeout(spinnerTimer);
            container.innerHTML = html;
        } catch (e) {
            clearTimeout(spinnerTimer);
            console.error('Page render error:', e);
            container.innerHTML = `<div class="alert alert-danger">加载失败：${escapeHtml(e.message)}</div>`;
        }
    },

    async loadSubNav() {
        try {
            const [categories, collections, stats] = await Promise.all([
                API.getCategories(),
                API.getCollections(),
                API.getStats(),
            ]);

            // Cache collection names for display on cards
            this._collectionNames = {};
            for (const c of collections) {
                this._collectionNames[c.id] = c.name;
            }

            const el = document.getElementById('sub-categories');
            const catKey = BrowsePage.currentCategory;
            const colId = BrowsePage.currentCollection;

            let html = '';

            // ── Search bar ──
            html += '<div style="padding:6px 12px 4px;">';
            html += '<div style="display:flex;gap:4px;">';
            html += '<input type="text" id="sub-search-input" class="form-input" ';
            html += 'style="flex:1;padding:5px 8px;font-size:12px;background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.1);color:var(--text-inverse);" ';
            html += `placeholder="输入关键词搜索，支持按分类" value="${escapeHtml(BrowsePage.searchQuery || '')}" `;
            html += 'onkeydown="if(event.key===\'Enter\')App._doSubSearch()">';
            html += '<button class="btn btn-sm btn-primary" style="height:28px;font-size:11px;padding:0 10px;" ';
            html += 'onclick="App._doSubSearch()">搜索</button>';
            html += '</div></div>';

            // ── Category section header ──
            // Single toggle button: shows open folder when everything is
            // expanded (click → collapse all), closed folder otherwise.
            const expandableIds = this._collectExpandableIds(categories);
            const allExpanded = expandableIds.length > 0 &&
                expandableIds.every(id => this.expandedCategories.has(id));
            const folderIcon = allExpanded
                ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>'
                : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

            html += '<div class="sub-section-header" style="display:flex;justify-content:space-between;align-items:center;">';
            html += '<span>分类</span>';
            html += '<span class="sub-section-actions">';
            html += `<button class="sub-action-btn" onclick="App.toggleAllCategories()" title="${allExpanded ? '全部折叠' : '全部展开'}">${folderIcon}</button>`;
            html += '</span>';
            html += '</div>';

            // "All slides" item
            const isAllActive = catKey === null && colId === null;
            html += `<div class="sub-nav-item${isAllActive ? ' active' : ''}" onclick="App.subSelectCategory(null)">`;
            html += `<span class="sub-nav-icon">📋</span>`;
            html += `<span class="sub-nav-name">全部页面</span>`;
            html += `<span class="sub-count">${stats.visible_slides}</span>`;
            html += `</div>`;

            // "Uncategorized" item
            html += `<div class="sub-nav-item${catKey === 'uncategorized' ? ' active' : ''}" onclick="App.subSelectCategory('uncategorized')">`;
            html += `<span class="sub-nav-icon">📭</span>`;
            html += `<span class="sub-nav-name">未分类</span>`;
            html += `<span class="sub-count">${stats.uncategorized_slides}</span>`;
            html += `</div>`;

            html += '<div class="sub-nav-sep"></div>';

            // Recursive category tree — N levels
            function renderTree(nodes, depth) {
                let out = '';
                for (const cat of nodes) {
                    const nodeKey = 'cat_' + cat.id;
                    const hasKids = cat.children && cat.children.length > 0;
                    const isActive = catKey === nodeKey;
                    const isExpanded = App.expandedCategories.has(cat.id);
                    const indent = 8 + depth * 14;

                    out += `<div class="sub-nav-item${isActive ? ' active' : ''}" style="cursor:pointer;padding-left:${indent}px;">`;
                    if (hasKids) {
                        out += `<span class="sub-expand-toggle${isExpanded ? ' expanded' : ''}" onclick="event.stopPropagation(); App.toggleCategoryExpand(${cat.id})">`;
                        out += `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
                        out += `</span>`;
                    }
                    out += `<span class="sub-nav-icon">📁</span>`;
                    out += `<span class="sub-nav-name" onclick="App.subSelectCategory('${nodeKey}')" title="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</span>`;
                    out += `<span class="sub-count">${cat.slide_count}</span>`;
                    out += `</div>`;

                    if (hasKids) {
                        out += `<div class="sub-cat-children" style="display:${isExpanded ? 'block' : 'none'};">`;
                        out += renderTree(cat.children, depth + 1);
                        out += `</div>`;
                    }
                }
                return out;
            }

            html += renderTree(categories, 0);

            // ── Collections section ──
            html += '<div class="sub-nav-sep"></div>';
            html += '<div class="sub-section-header" style="display:flex;justify-content:space-between;align-items:center;">';
            html += '<span>⭐ 收藏夹</span>';
            html += '<button class="sub-add-btn" onclick="App._showAddColInput()" title="新建收藏夹">+</button>';
            html += '</div>';
            html += '<div id="sub-col-add-row" style="display:none;padding:4px 14px;">';
            html += '<div style="display:flex;gap:4px;"><input type="text" id="sub-col-add-input" class="form-input" style="flex:1;padding:3px 8px;font-size:12px;height:26px;" placeholder="收藏夹名称" onkeydown="if(event.key===\'Enter\')App._doAddCollection();if(event.key===\'Escape\')App._hideAddColInput();">';
            html += '<button class="btn btn-sm btn-primary" style="height:26px;font-size:11px;padding:0 8px;" onclick="App._doAddCollection()">✓</button>';
            html += '<button class="btn btn-sm btn-ghost" style="height:26px;font-size:11px;padding:0 8px;" onclick="App._hideAddColInput()">✗</button>';
            html += '</div></div>';

            for (const c of collections) {
                const isColActive = colId === c.id;
                const safeName = c.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                html += `<div class="sub-nav-item sub-col-item${isColActive ? ' active' : ''}" onclick="App.subSelectCollection(${c.id})">`;
                html += `<span class="sub-nav-name sub-col-name" data-col-id="${c.id}" title="${escapeHtml(c.name)}">⭐ ${escapeHtml(c.name)}</span>`;
                html += `<input type="text" class="sub-col-edit-input" id="sub-col-edit-${c.id}" style="display:none;flex:1;min-width:0;padding:2px 6px;font-size:12px;height:22px;background:rgba(255,255,255,0.08);border:1px solid var(--accent);border-radius:3px;color:var(--text-inverse);" value="${escapeHtml(c.name)}" onkeydown="if(event.key==='Enter')App._doRenameCollection(${c.id});if(event.key==='Escape')App._cancelRenameCollection(${c.id});" onblur="App._doRenameCollection(${c.id})">`;
                html += `<span class="sub-col-actions">`;
                html += `<button class="sub-col-btn" onclick="event.stopPropagation();App._startRenameCollection(${c.id})" title="重命名">✏️</button>`;
                html += `<button class="sub-col-btn sub-col-del" onclick="event.stopPropagation();App.deleteCollection(${c.id},'${safeName}')" title="删除">×</button>`;
                html += `</span>`;
                html += `<span class="sub-count">${c.slide_count}</span>`;
                html += `</div>`;
            }

            if (collections.length === 0) {
                html += '<div style="padding:8px 16px;font-size:11px;color:var(--text-tertiary);font-style:italic;">暂无收藏夹，点击 + 新建</div>';
            }

            el.innerHTML = html;

            // Update slide count
            document.getElementById('sub-slide-count').textContent =
                '共 ' + stats.visible_slides + ' 个页面';

        } catch (e) {
            console.error('Sub-nav load error:', e);
            document.getElementById('sub-categories').innerHTML =
                '<div class="alert alert-warning" style="margin:12px;">加载分类失败</div>';
        }
    },

    async loadFileSubNav() {
        try {
            const el = document.getElementById('sub-categories');
            const fId = BrowsePage.currentFile;

            let html = '';

            // Search input
            html += '<div style="padding:8px 12px;">';
            html += '<input type="text" id="file-search-input" class="form-input" ';
            html += 'style="padding:6px 10px;font-size:12px;background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.1);color:var(--text-inverse);" ';
            html += 'placeholder="搜索文件名..." ';
            html += 'oninput="App._filterFileList()" autofocus>';
            html += '</div>';

            // File list container
            html += '<div id="file-list-container" style="flex:1;overflow-y:auto;">';
            html += '<div class="loading-spinner sub-loading"><div class="spinner"></div></div>';
            html += '</div>';

            el.innerHTML = html;

            // Load files and render
            const files = await API.getFiles();
            this._cachedFiles = files.filter(f => f.slide_count > 0);
            this._renderFileList(this._cachedFiles);

            // Update footer
            document.getElementById('sub-slide-count').textContent =
                '共 ' + this._cachedFiles.length + ' 个文件';

        } catch (e) {
            console.error('File sub-nav load error:', e);
            document.getElementById('sub-categories').innerHTML =
                '<div class="alert alert-warning" style="margin:12px;">加载文件列表失败</div>';
        }
    },

    _renderFileList(files) {
        const container = document.getElementById('file-list-container');
        if (!container) return;
        const fId = BrowsePage.currentFile;

        if (files.length === 0) {
            container.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--text-tertiary);text-align:center;">无匹配文件</div>';
            return;
        }

        let html = '';
        // Show file count at top
        html += '<div style="padding:4px 14px;font-size:11px;color:var(--text-tertiary);">' + files.length + ' 个文件</div>';
        for (const f of files) {
            const isFileActive = fId === f.id;
            html += `<div class="sub-nav-item${isFileActive ? ' active' : ''}" onclick="App._onFileClick(${f.id})">`;
            html += `<span class="sub-nav-icon">📄</span>`;
            html += `<span class="sub-nav-name" title="${escapeHtml(f.file_name)}">${escapeHtml(f.file_name)}</span>`;
            html += `<span class="sub-count">${f.slide_count}</span>`;
            html += `</div>`;
        }
        container.innerHTML = html;
    },

    _filterFileList() {
        const input = document.getElementById('file-search-input');
        const q = input ? input.value.trim().toLowerCase() : '';
        const files = this._cachedFiles || [];
        const filtered = q ? files.filter(f => f.file_name.toLowerCase().includes(q)) : files;
        this._renderFileList(filtered);
    },

    _onFileClick(fileId) {
        BrowsePage.currentCategory = null;
        BrowsePage.currentCollection = null;
        BrowsePage.currentFile = fileId;
        BrowsePage.currentPage = 1;
        this.navigate('files');
    },

    toggleCategoryExpand(catId) {
        if (this.expandedCategories.has(catId)) {
            this.expandedCategories.delete(catId);
        } else {
            this.expandedCategories.add(catId);
        }
        // Local DOM toggle instead of full reload — avoids API round-trip
        const toggle = document.querySelector(`.sub-expand-toggle[onclick*="toggleCategoryExpand(${catId})"]`);
        if (toggle) {
            toggle.classList.toggle('expanded');
            const children = toggle.closest('.sub-nav-item').nextElementSibling;
            if (children && children.classList.contains('sub-cat-children')) {
                children.style.display = children.style.display === 'none' ? 'block' : 'none';
            }
        }
    },

    _collectExpandableIds(nodes) {
        const ids = [];
        for (const cat of nodes) {
            if (cat.children && cat.children.length > 0) {
                ids.push(cat.id);
                ids.push(...this._collectExpandableIds(cat.children));
            }
        }
        return ids;
    },

    async toggleAllCategories() {
        // Single toggle: if all expandable nodes are open → collapse all,
        // otherwise expand all.
        try {
            const categories = await API.getCategories();
            const allIds = this._collectExpandableIds(categories);
            const allExpanded = allIds.length > 0 &&
                allIds.every(id => this.expandedCategories.has(id));
            this.expandedCategories = allExpanded ? new Set() : new Set(allIds);
            this.loadSubNav();
        } catch (e) {
            console.error('toggleAllCategories error:', e);
        }
    },

    subSelectCategory(catKey) {
        BrowsePage.currentCategory = catKey;
        BrowsePage.currentCollection = null;
        BrowsePage.currentFile = null;
        BrowsePage.searchQuery = null;
        BrowsePage.currentPage = 1;
        if (catKey && catKey.startsWith('cat_')) {
            this.expandedCategories.add(parseInt(catKey.replace('cat_', '')));
        }
        this.navigate('browse');
    },

    subSelectCollection(colId) {
        BrowsePage.currentCategory = null;
        BrowsePage.currentCollection = colId;
        BrowsePage.currentFile = null;
        BrowsePage.searchQuery = null;
        BrowsePage.currentPage = 1;
        this.navigate('browse');
    },

    subSelectFile(fileId) {
        this._onFileClick(fileId);
    },

    // ── Collection CRUD from sub-sidebar ──

    _showAddColInput() {
        const row = document.getElementById('sub-col-add-row');
        if (row) row.style.display = 'block';
        const inp = document.getElementById('sub-col-add-input');
        if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
    },

    _hideAddColInput() {
        const row = document.getElementById('sub-col-add-row');
        if (row) row.style.display = 'none';
    },

    async _doAddCollection() {
        const inp = document.getElementById('sub-col-add-input');
        if (!inp) return;
        const name = inp.value.trim();
        if (!name) { Toast.error('请输入名称'); return; }
        try {
            await API.createCollection(name);
            Toast.success(`已创建：${name}`);
            this._hideAddColInput();
            this.loadSubNav();
        } catch (e) {
            Toast.error(`创建失败：${e.message}`);
        }
    },

    _startRenameCollection(colId) {
        // Hide name span, show edit input
        const nameSpan = document.querySelector(`.sub-col-name[data-col-id="${colId}"]`);
        const editInput = document.getElementById(`sub-col-edit-${colId}`);
        if (nameSpan) nameSpan.style.display = 'none';
        if (editInput) {
            editInput.style.display = 'block';
            editInput.focus();
            editInput.select();
        }
    },

    async _doRenameCollection(colId) {
        const editInput = document.getElementById(`sub-col-edit-${colId}`);
        if (!editInput || editInput.style.display === 'none') return;
        const newName = editInput.value.trim();
        const oldName = editInput.defaultValue || '';

        // Hide input, show name span
        editInput.style.display = 'none';
        const nameSpan = document.querySelector(`.sub-col-name[data-col-id="${colId}"]`);
        if (nameSpan) nameSpan.style.display = '';

        if (!newName || newName === oldName) return;

        try {
            await API.renameCollection(colId, newName);
            this._collectionNames[colId] = newName;
            Toast.success('已重命名');
            this.loadSubNav();  // full refresh so the new name appears
        } catch (e) {
            Toast.error(`重命名失败：${e.message}`);
        }
    },

    _cancelRenameCollection(colId) {
        const editInput = document.getElementById(`sub-col-edit-${colId}`);
        if (editInput) {
            editInput.value = editInput.defaultValue;
            editInput.style.display = 'none';
        }
        const nameSpan = document.querySelector(`.sub-col-name[data-col-id="${colId}"]`);
        if (nameSpan) nameSpan.style.display = '';
    },

    _doSubSearch() {
        const input = document.getElementById('sub-search-input');
        const q = input ? input.value.trim() : '';
        BrowsePage.searchQuery = q || null;
        BrowsePage.currentPage = 1;
        this.navigate('browse');
    },

    async deleteCollection(colId, name) {
        Modal.confirm('🗑️ 删除收藏夹', `确定要删除「${name}」吗？收藏的页面不会被删除，只是移出收藏夹。`, async () => {
            try {
                await API.deleteCollection(colId);
                delete this._collectionNames[colId];
                if (BrowsePage.currentCollection === colId) {
                    BrowsePage.currentCollection = null;
                }
                Toast.success(`已删除：${name}`);
                this.loadSubNav();
            } catch (e) {
                Toast.error(`删除失败：${e.message}`);
            }
        });
    },

    // ── Collection Picker Modal ──

    async showCollectionPicker(slideId) {
        try {
            const [collections, slide] = await Promise.all([
                API.getCollections(),
                API.getSlide(slideId),
            ]);
            const currentCols = new Set(slide.collection_ids || []);

            let itemsHtml = '';
            for (const c of collections) {
                const checked = currentCols.has(c.id);
                itemsHtml += `
                    <label class="col-picker-item">
                        <input type="checkbox" value="${c.id}" ${checked ? 'checked' : ''}>
                        <span>⭐ ${escapeHtml(c.name)}</span>
                        <span style="color:var(--text-tertiary);font-size:11px;">${c.slide_count}页</span>
                    </label>`;
            }

            if (collections.length === 0) {
                itemsHtml = '<p style="color:var(--text-tertiary);font-size:13px;">暂无收藏夹，请先在侧栏创建</p>';
            }

            const content = `
                <div style="max-height:300px;overflow-y:auto;margin-bottom:12px;">
                    ${itemsHtml}
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <input type="text" id="picker-new-col-name" class="form-input" placeholder="新建收藏夹名称" style="flex:1;">
                    <button class="btn btn-sm btn-ghost" onclick="App._createAndCollect(${slideId})">➕ 新建并收藏</button>
                </div>
            `;

            Modal.show('⭐ 收藏到', content, [
                { label: '取消', key: 'cancel' },
                {
                    label: '💾 保存',
                    key: 'save',
                    primary: true,
                    onClick: async () => {
                        // Build desired set from checkboxes
                        const desired = new Set();
                        document.querySelectorAll('.col-picker-item input[type="checkbox"]:checked').forEach(cb => {
                            desired.add(parseInt(cb.value));
                        });

                        // Add missing
                        for (const cid of desired) {
                            if (!currentCols.has(cid)) {
                                await API.addToCollection(cid, slideId);
                            }
                        }
                        // Remove deselected
                        for (const cid of currentCols) {
                            if (!desired.has(cid)) {
                                await API.removeFromCollection(cid, slideId);
                            }
                        }
                        Toast.success('已更新收藏');
                        App.navigate(App.currentPage);
                    }
                },
            ]);
        } catch (e) {
            Toast.error(`加载收藏夹失败：${e.message}`);
        }
    },

    async _createAndCollect(slideId) {
        const nameEl = document.getElementById('picker-new-col-name');
        const name = (nameEl ? nameEl.value : '').trim();
        if (!name) { Toast.error('请输入名称'); return; }
        try {
            const result = await API.createCollection(name);
            await API.addToCollection(result.id, slideId);
            Toast.success(`已创建并收藏：${name}`);
            Modal.hide();
            App.navigate(App.currentPage);
        } catch (e) {
            Toast.error(`操作失败：${e.message}`);
        }
    },

    async updateStats() {
        try {
            const stats = await API.getStats();
            const el = document.getElementById('sidebar-stats');
            if (el) {
                el.innerHTML = `<span class="stat-dot"></span><span>文件 ${stats.total_files} · 可见 ${stats.visible_slides}/${stats.total_slides} · 已归类 ${stats.categorized_slides}</span>`;
            }
        } catch (e) {
            const el = document.getElementById('sidebar-stats');
            if (el) {
                el.innerHTML = `<span class="stat-dot offline"></span><span>后端未连接</span>`;
            }
        }
    },

    // ── Slide Editor Modal ──

    async showSlideEditor(slideId) {
        try {
            const slide = await API.getSlide(slideId);
            const categories = await API.getCategories();

            // Build category select with explicit level labels
            let catsHtml = '<option value="0">-- 移除分类 --</option>';
            const LEVEL_LABELS = ['', '二级', '三级', '四级', '五级'];
            function addCats(list, depth = 0) {
                for (const c of list) {
                    const sel = c.id === slide.category_id ? 'selected' : '';
                    let prefix = '';
                    if (depth > 0) {
                        prefix = '\xA0 '.repeat(depth) + '[' + (LEVEL_LABELS[depth] || depth + '级') + '] ';
                    }
                    catsHtml += `<option value="${c.id}" ${sel}>${prefix}${escapeHtml(c.name)}</option>`;
                    if (c.children) addCats(c.children, depth + 1);
                }
            }
            addCats(categories, 0);

            // Build collection checkboxes
            const collections = await API.getCollections();
            const slideCols = new Set(slide.collection_ids || []);
            let colCheckboxes = '';
            for (const c of collections) {
                colCheckboxes += `<label class="col-picker-item" style="padding:4px 0;">
                    <input type="checkbox" value="${c.id}" ${slideCols.has(c.id) ? 'checked' : ''}>
                    <span>⭐ ${escapeHtml(c.name)}</span>
                </label>`;
            }

            const content = `
                <div class="form-group">
                    <label class="form-label">📋 归类</label>
                    <select class="form-select" id="edit-category">${catsHtml}</select>
                </div>
                <div class="form-group">
                    <label class="form-label">⭐ 收藏夹</label>
                    <div style="max-height:150px;overflow-y:auto;">${colCheckboxes}</div>
                </div>
                <div style="font-size:12px;color:var(--text-tertiary);">
                    📄 ${escapeHtml(slide.file_name || '')} · 第${slide.slide_number}页
                </div>
            `;

            Modal.show(`编辑 - ${escapeHtml(slide.title || `第${slide.slide_number}页`)}`, content, [
                { label: '取消', key: 'cancel' },
                {
                    label: '💾 保存',
                    key: 'save',
                    primary: true,
                    onClick: async () => {
                        const catId = parseInt(document.getElementById('edit-category').value) || 0;
                        await API.updateSlideCategory(slideId, catId);

                        // Update collections
                        const currentColSet = new Set(slide.collection_ids || []);
                        const desiredColSet = new Set();
                        document.querySelectorAll('.col-picker-item input[type="checkbox"]:checked').forEach(cb => {
                            desiredColSet.add(parseInt(cb.value));
                        });
                        for (const cid of desiredColSet) {
                            if (!currentColSet.has(cid)) await API.addToCollection(cid, slideId);
                        }
                        for (const cid of currentColSet) {
                            if (!desiredColSet.has(cid)) await API.removeFromCollection(cid, slideId);
                        }

                        Toast.success('已保存');
                        this.navigate(this.currentPage);
                    }
                },
            ]);
        } catch (e) {
            Toast.error(`加载失败：${e.message}`);
        }
    },

    // ── Delete Confirmation ──

    confirmDeleteSlide(slideId) {
        Modal.confirm('🗑️ 删除此页', '确定要永久删除此页面吗？缩略图和数据库记录将被删除。', async () => {
            try {
                const result = await API.deleteSlide(slideId);
                Toast.success(result.message || '已删除');
                this.navigate(this.currentPage);
            } catch (e) {
                Toast.error(`删除失败：${e.message}`);
            }
        });
    },

    // ── Open Source File ──

    async openSourceFile(filePath) {
        if (!filePath) return;
        try {
            await API.openFile(filePath);
        } catch (e) {
            if (window.electronAPI) {
                await window.electronAPI.openExternal(filePath);
            } else {
                Toast.error('无法打开文件');
            }
        }
    },

    // ── Zoom / Enlarge Thumbnail ──

    async zoomThumbnail(slideId) {
        // Build filter params matching the current browse view
        const params = { page_size: 9999, include_hidden: BrowsePage.includeHidden };
        if (BrowsePage.currentFile !== null) {
            params.file_id = BrowsePage.currentFile;
        } else if (BrowsePage.currentCollection !== null) {
            params.collection_id = BrowsePage.currentCollection;
        } else if (BrowsePage.currentCategory === 'uncategorized') {
            params.category_id = -1;
        } else if (BrowsePage.currentCategory && BrowsePage.currentCategory.startsWith('cat_')) {
            params.category_id = parseInt(BrowsePage.currentCategory.replace('cat_', ''));
            // Match BrowsePage behavior: sidebar counts are cumulative
            params.include_children = true;
        }

        try {
            const result = await API.getSlides(params);
            this._zoomOrder = result.items.map(s => s.id);
            // Cache full item data so we can show slides beyond the current page
            this._zoomCache = {};
            for (const s of result.items) {
                this._zoomCache[s.id] = s;
            }
        } catch (e) {
            // Fallback to DOM scan if API fails
            const cards = document.querySelectorAll('.slide-card');
            const order = [];
            cards.forEach(c => {
                const sid = parseInt(c.getAttribute('data-slide-id'));
                if (!isNaN(sid)) order.push(sid);
            });
            this._zoomOrder = order;
            this._zoomCache = null;
        }

        const curIdx = this._zoomOrder.indexOf(slideId);
        if (curIdx < 0) return;
        this._showZoomSlide(curIdx);
    },

    _getZoomInfo(slideId) {
        // Try registry first (rendered slides on current page)
        let info = SlideCard._registry && SlideCard._registry[slideId];
        if (info) return info;
        // Fallback to API cache for slides beyond current page
        const item = this._zoomCache && this._zoomCache[slideId];
        if (!item) return null;
        return {
            thumbUrl: API.baseUrl + (item.thumbnail_url || ''),
            file_path: item.file_path || '',
            title: item.title || '',
            slide_number: item.slide_number,
            file_name: item.file_name || '',
        };
    },

    _showZoomSlide(idx) {
        const order = this._zoomOrder;
        if (!order || idx < 0 || idx >= order.length) return;
        const slideId = order[idx];
        const info = this._getZoomInfo(slideId);
        if (!info) return;

        const total = order.length;
        const hasPrev = idx > 0;
        const hasNext = idx < total - 1;

        const box = document.getElementById('modal-box');
        const prevMax = box.style.maxWidth;
        box.style.maxWidth = '960px';

        const navHtml = `
            <div class="zoom-viewer">
                <button class="zoom-nav-btn zoom-prev" ${hasPrev ? '' : 'disabled'}
                    onclick="App._zoomNav(${idx - 1})" title="上一张">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <div class="zoom-image-wrap">
                    <img src="${info.thumbUrl}" style="max-width:100%;max-height:68vh;object-fit:contain;border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,0.15);">
                </div>
                <button class="zoom-nav-btn zoom-next" ${hasNext ? '' : 'disabled'}
                    onclick="App._zoomNav(${idx + 1})" title="下一张">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
            </div>
            <div class="zoom-footer">
                <span class="zoom-counter">${idx + 1} / ${total}</span>
                <span class="zoom-info">${escapeHtml(info.file_name)} · <strong>第${info.slide_number}页</strong></span>
                <button class="btn btn-sm btn-primary zoom-open-btn" onclick="App._openZoomSource(${slideId})">
                    📄 打开源文件
                </button>
            </div>
        `;

        Modal.show(`🔍 ${escapeHtml(info.title)}`, navHtml, []);

        // Clean up previous zoom session, then set up new keyboard handler
        this._cleanupZoom();
        this._zoomKeyHandler = (e) => {
            if (e.key === 'ArrowLeft' && hasPrev) this._zoomNav(idx - 1);
            if (e.key === 'ArrowRight' && hasNext) this._zoomNav(idx + 1);
            if (e.key === 'Escape') { this._cleanupZoom(); Modal.hide(); }
        };
        document.addEventListener('keydown', this._zoomKeyHandler);

        // Wire close button and overlay click to call cleanup
        const closeBtn = box.querySelector('.modal-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this._cleanupZoom(), { once: true });
        }
        const overlay = document.getElementById('modal-overlay');
        if (overlay) {
            const overlayHandler = (e) => {
                if (e.target === overlay) { this._cleanupZoom(); }
            };
            overlay.addEventListener('click', overlayHandler, { once: true });
        }
        // Store box ref for cleanup
        this._zoomBox = box;
        this._zoomPrevMax = prevMax;
    },

    _cleanupZoom() {
        if (this._zoomKeyHandler) {
            document.removeEventListener('keydown', this._zoomKeyHandler);
            this._zoomKeyHandler = null;
        }
        if (this._zoomBox) {
            this._zoomBox.style.maxWidth = this._zoomPrevMax || '';
            this._zoomBox = null;
            this._zoomPrevMax = null;
        }
    },

    _zoomNav(newIdx) {
        this._cleanupZoom();
        if (this._zoomOrder && newIdx >= 0 && newIdx < this._zoomOrder.length) {
            this._showZoomSlide(newIdx);
        }
    },

    _openZoomSource(slideId) {
        Modal.hide();
        const info = SlideCard._registry && SlideCard._registry[slideId];
        if (info) this.openSourceFile(info.file_path);
    },

    // ── Sidebar Collapse ──

    toggleSidebar() {
        const sb = document.getElementById('sidebar');
        sb.classList.toggle('collapsed');
    },

    toggleSubSidebar() {
        const sb = document.getElementById('sub-sidebar');
        const handle = document.getElementById('sub-sidebar-resize-handle');
        const isCollapsed = sb.classList.toggle('collapsed');
        // Toggle both chevrons — only the active page's chevron is visible
        ['browse-chevron', 'files-chevron'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('collapsed');
        });
        if (handle) {
            if (isCollapsed) {
                handle.classList.remove('visible');
            } else if (this.currentPage === 'browse' || this.currentPage === 'files') {
                handle.classList.add('visible');
            }
        }
        this.applySubSidebarWidth();
    },

    // ── Sub-sidebar Resize ──

    applySubSidebarWidth() {
        const sb = document.getElementById('sub-sidebar');
        if (!sb) return;
        const isCollapsed = sb.classList.contains('collapsed');
        if (isCollapsed) {
            sb.style.removeProperty('width');
            sb.style.removeProperty('min-width');
        } else {
            sb.style.setProperty('--sub-sidebar-width', this.subSidebarWidth + 'px');
            sb.style.width = this.subSidebarWidth + 'px';
            sb.style.minWidth = this.subSidebarWidth + 'px';
        }
    },

    initResizeHandle() {
        const handle = document.getElementById('sub-sidebar-resize-handle');
        const sb = document.getElementById('sub-sidebar');
        if (!handle || !sb) return;

        const saved = localStorage.getItem('pptNest_subSidebarWidth');
        if (saved) {
            const w = parseInt(saved, 10);
            if (w >= 120 && w <= 450) {
                this.subSidebarWidth = w;
            }
        }
        this.applySubSidebarWidth();

        let dragging = false;
        let startX = 0;
        let startWidth = 0;

        const onMouseDown = (e) => {
            if (sb.classList.contains('collapsed')) return;
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startWidth = sb.getBoundingClientRect().width;
            handle.classList.add('dragging');
            document.body.classList.add('sub-sidebar-resizing');
        };

        const onMouseMove = (e) => {
            if (!dragging) return;
            const delta = e.clientX - startX;
            let newWidth = startWidth + delta;
            newWidth = Math.max(120, Math.min(450, Math.round(newWidth)));
            this.subSidebarWidth = newWidth;
            sb.style.setProperty('--sub-sidebar-width', newWidth + 'px');
            sb.style.width = newWidth + 'px';
            sb.style.minWidth = newWidth + 'px';
        };

        const onMouseUp = () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.classList.remove('sub-sidebar-resizing');
            localStorage.setItem('pptNest_subSidebarWidth', this.subSidebarWidth);
        };

        handle.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    },
};

// ─── Boot ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
