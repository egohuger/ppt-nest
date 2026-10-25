/**
 * PPT Nest - Main Application
 * Router, navigation, global event handling
 */

const App = {
    currentPage: 'browse',
    expandedCategories: new Set(),
    // 侧栏最小宽度：低于这个值「全部页面/未分类」的计数和「收藏夹」会被挤断行
    SUB_SIDEBAR_MIN: 176,
    SUB_SIDEBAR_MAX: 450,
    subSidebarWidth: 176, // default, overridden by localStorage
    // 分类浏览 / 文件浏览 各自记折叠状态，互不同步
    _subCollapsed: { browse: false, files: false },
    _collectionNames: {}, // {id: name} cache
    _collectionKinds: {}, // {id: 'slide'|'file'} cache
    catFilter: '',        // 分类面板的关键词（只过滤类别名，切页面/选完结果都保留）
    fileFilter: '',       // 文件面板的关键词（只过滤文件名，同上）

    pageMap: {
        onboarding: OnboardingPage,
        browse: BrowsePage,
        files: FilesPage,
        scan: ScanPage,
        dedup: DedupPage,
        compose: ComposePage,
        categories: CategoriesPage,
        settings: SettingsPage,
    },

    pageTitles: {
        onboarding: '欢迎',
        browse: '分类浏览',
        files: '文件浏览',
        scan: '素材入库',
        dedup: '重复检测',
        compose: '组稿导出',
        categories: '类别管理',
        settings: '设置',
    },

    // “即将上线”功能（画饼）：{ icon, name, desc }——均为基于现有能力可落地的功能
    comingSoonFeatures: {
        aigc: {
            icon: 'sparkles',
            name: 'AI 智能组稿',
            desc: '只需描述你的方案需求（主题、客户行业、篇幅），AI 就会从你的素材库中自动挑选合适的页面，组合成一份结构完整的 PPT 初稿。',
        },
        export: {
            icon: 'upload',
            name: '导出合集为 PPT',
            desc: '把收藏夹里的页面一键导出成一份全新的 PPT 文件，挑好的素材秒变成品，直接交付。',
        },
        similar: {
            icon: 'search',
            name: '相似页推荐',
            desc: '看到一页好素材？一键找出库里风格、内容相近的更多页面，一次收集齐。',
        },
        backup: {
            icon: 'save',
            name: '一键备份还原',
            desc: '一键打包你的素材库、分类体系和收藏，换电脑或重装系统也不怕丢。',
        },
    },

    async init() {
        await API.init();
        console.log('[PPTNest] API initialized, backend:', API.baseUrl);

        // 静态 HTML 里的 <span data-icon="..."> 填成统一图标
        hydrateIcons();

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

        // Bind browse chevron: 在本模块=折叠/展开右侧面板；在别的模块=直接跳到本模块
        document.getElementById('browse-chevron').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.onNavChevron('browse');
        });

        // Bind files chevron（同上）
        document.getElementById('files-chevron').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.onNavChevron('files');
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

        // 右键「打开方式」/ 拖 Dock / 命令行带进来的 PPT：主进程攒着，等这里挂号后再推过来
        if (window.electronAPI && window.electronAPI.onOpenFiles) {
            window.electronAPI.onOpenFiles((paths) => this.handleOpenFiles(paths));
            if (window.electronAPI.notifyReady) window.electronAPI.notifyReady();
        }
    },

    // ── 右键「打开方式」/ 拖 Dock 带进来的 PPT ──────────────────────────
    // 顺序：check（已在库里的跳过）→ 先问要不要归类 → 导入（浮层显示页级进度）→ 落到文件浏览并高亮

    _openQueue: [],
    _importBusy: false,
    _importPollTimer: null,
    pendingFileHighlight: null,

    handleOpenFiles(paths) {
        const list = (paths || []).filter(p => typeof p === 'string' && p.trim());
        if (!list.length) return;
        this._openQueue.push(...list);
        if (this._importBusy) return;   // 正在导入：先排队，这轮结束自动接手
        this._drainOpenQueue();
    },

    /** 文件浏览页的【打开文件】：弹系统文件选择框，选完走和右键打开同一条导入链路 */
    async pickOpenFiles() {
        if (!(window.electronAPI && window.electronAPI.showOpenFiles)) {
            Toast.error('只有在桌面应用里才能打开本地文件');
            return;
        }
        try {
            const paths = await window.electronAPI.showOpenFiles();
            if (paths && paths.length) this.handleOpenFiles(paths);
        } catch (e) {
            Toast.error('打开文件失败：' + e.message);
        }
    },

    async _drainOpenQueue() {
        if (this._importBusy) return;
        this._importBusy = true;
        try {
            while (this._openQueue.length) {
                const batch = this._openQueue.splice(0, 20);
                try { await this._importOpenBatch(batch); }
                catch (e) { Toast.error('打开文件失败：' + e.message); }
            }
        } finally {
            this._importBusy = false;
        }
    },

    async _importOpenBatch(paths) {
        let check;
        try { check = await API.importCheck(paths); }
        catch (e) { Toast.error('读取文件失败：' + e.message); return; }

        const fresh = check.files.filter(f => f.status === 'new');
        const known = check.files.filter(f => f.status === 'known');
        const bad = check.files.filter(f => f.status === 'invalid');

        if (bad.length) Toast.error('打不开：' + bad.map(f => `${f.name}（${f.reason}）`).join('、'));
        if (known.length) Toast.info('已在库里，跳过：' + known.map(f => f.name).join('、'));
        if (!fresh.length) {
            if (!bad.length && !known.length) Toast.error('没有可导入的 PPT 文件');
            return;
        }

        // 先问要不要归类；库里一个类别都没有就没得归，直接入库
        let classify = false;
        if (check.has_categories) {
            classify = await this._askAutoClassify(fresh);
        } else {
            Toast.info('库里还没有类别，这次只入库不归类');
        }

        // 导入请求同步跑，另开轮询显示页级进度
        this._showImportOverlay(fresh.length);
        this._startImportPolling();
        let res;
        try {
            res = await API.importFiles(fresh.map(f => f.path), classify);
        } catch (e) {
            this._stopImportPolling();
            this._hideImportOverlay();
            const busy = e.status === 409 || /正在扫描|运行中/.test(e.message || '');
            Toast.error(busy ? '正在扫描或导入中，等这次做完再打开文件' : '导入失败：' + e.message);
            return;
        }
        this._stopImportPolling();
        this._hideImportOverlay();

        const imported = res.imported || [];
        const errs = res.errors || [];
        for (const it of imported) {
            const extra = classify ? ` · 归类 ${it.classified || 0} 页` : '';
            Toast.success(`已入库《${it.file}》· ${it.slides} 页${extra}`);
        }
        if (errs.length) Toast.error('导入失败：' + errs.map(x => `${x.file}（${x.error}）`).join('、'));

        if (imported.length) {
            const first = imported[0];
            if (first.file_id) {
                BrowsePage.currentFile = first.file_id;
                BrowsePage.currentCollection = null;
                this.pendingFileHighlight = first.file_id;
            }
            await this.navigate('files');
            this.refreshComposeBar();
        }
    },

    /** 导入前问一句：要不要按已有类别自动归类。点 ✕ / 遮罩关掉按「不归类」算，别把导入卡住 */
    _askAutoClassify(files) {
        return new Promise(resolve => {
            const rows = files.slice(0, 5)
                .map(f => `<li>${escapeHtml(f.name)}${f.slides ? `（${f.slides} 页）` : ''}</li>`)
                .join('');
            const more = files.length > 5 ? `<li>…还有 ${files.length - 5} 个</li>` : '';
            const content = `
                <p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">要按你库里已有的类别自动归类吗？</p>
                <ul style="margin:0 0 10px 18px;font-size:12.5px;color:var(--text-secondary);line-height:1.7;">${rows}${more}</ul>
                <p style="font-size:12px;color:var(--text-tertiary);margin:0;">不归类也能正常用：页会进「未分类」，之后在卡片上点 ✏️ 手动归类。</p>`;
            let settled = false;
            const done = (v) => {
                if (settled) return;
                settled = true;
                if (obs) obs.disconnect();
                Modal.hide();
                resolve(v);
            };
            Modal.show('新文件要归类吗？', content, [
                { label: '不归类', key: 'no', onClick: () => done(false) },
                { label: '自动归类', key: 'yes', primary: true, onClick: () => done(true) },
            ]);
            const overlay = document.getElementById('modal-overlay');
            const obs = new MutationObserver(() => {
                if (overlay.style.display === 'none') done(false);
            });
            obs.observe(overlay, { attributes: true, attributeFilter: ['style'] });
        });
    },

    _showImportOverlay(nFiles) {
        let el = document.getElementById('open-import-overlay');
        if (!el) {
            el = document.createElement('div');
            el.id = 'open-import-overlay';
            el.className = 'modal-overlay import-overlay';
            el.innerHTML = `
                <div class="modal-box" style="padding:22px 24px;">
                    <div id="oi-pct" style="font-size:44px;font-weight:700;color:var(--accent);line-height:1.15;text-align:center;">0%</div>
                    <div id="oi-msg" style="font-size:12.5px;color:var(--text-secondary);margin-top:8px;text-align:center;min-height:18px;"></div>
                    <div id="oi-file" style="font-size:12px;color:var(--text-tertiary);margin-top:3px;text-align:center;min-height:16px;"></div>
                    <div style="margin-top:12px;height:6px;background:var(--border-light);border-radius:3px;overflow:hidden;">
                        <div id="oi-bar" style="width:0%;height:100%;background:var(--accent);border-radius:3px;transition:width .25s ease;"></div>
                    </div>
                </div>`;
            document.body.appendChild(el);
        }
        el.style.display = 'flex';
        document.getElementById('oi-pct').textContent = '0%';
        document.getElementById('oi-msg').textContent = `正在导入 ${nFiles} 个文件…`;
        document.getElementById('oi-file').textContent = '';
        document.getElementById('oi-bar').style.width = '0%';
    },

    _updateImportOverlay(p) {
        if (!p) return;
        const pctEl = document.getElementById('oi-pct');
        if (!pctEl) return;
        const done = Number(p.pages_done || 0);
        const total = Number(p.pages_total || 0);
        const pct = total > 0 ? Math.min(100, Math.round(done * 100 / total))
            : (p.total > 0 ? Math.round((p.current || 0) * 100 / p.total) : 0);
        pctEl.textContent = pct + '%';
        const fTotal = Number(p.page_current_total || 0);
        document.getElementById('oi-msg').textContent =
            `已处理 ${done} / ${total} 页 · 第 ${p.current || 0}/${p.total || 0} 个文件`;
        document.getElementById('oi-file').textContent =
            (p.current_file || '') + (fTotal ? ` · 缩略图 ${p.page_current || 0}/${fTotal} 页` : '');
        document.getElementById('oi-bar').style.width = pct + '%';
    },

    _hideImportOverlay() {
        const el = document.getElementById('open-import-overlay');
        if (el) el.style.display = 'none';
    },

    _startImportPolling() {
        this._stopImportPolling();
        this._importPollTimer = setInterval(async () => {
            try { this._updateImportOverlay(await API.scanProgress()); }
            catch (e) { /* 单次失败忽略，下一拍再试 */ }
        }, 500);
    },

    _stopImportPolling() {
        if (this._importPollTimer) {
            clearInterval(this._importPollTimer);
            this._importPollTimer = null;
        }
    },

    // “即将上线”功能弹窗：介绍功能 + 提示到 Releases 查看进度
    showComingSoon(key) {
        const f = this.comingSoonFeatures[key];
        if (!f) return;

        let html = '';
        html += '<div style="text-align:center;padding:6px 0 2px;">';
        html += `<div style="margin-bottom:8px;color:var(--accent);">${icon(f.icon, 34)}</div>`;
        html += `<div style="font-size:16px;font-weight:700;">${escapeHtml(f.name)}</div>`;
        html += `<div style="display:inline-block;margin:8px 0 12px;padding:3px 12px;border-radius:999px;background:rgba(245,158,11,0.15);color:#d97706;font-size:12px;font-weight:600;">${icon("lock", 12)} 即将上线 · 敬请期待</div>`;
        html += `<p style="font-size:13px;color:var(--text-secondary);line-height:1.7;text-align:left;">${escapeHtml(f.desc)}</p>`;
        html += '</div>';

        html += '<div style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px;">';
        html += '<div style="font-size:13px;color:var(--text-secondary);line-height:1.8;margin-bottom:12px;">新功能上线后会在 GitHub Releases 发布，可在【设置】>【帮助与反馈】> 点击【检查更新】查看。</div>';
        html += '<div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;">';

        // 公众号（永久有效）
        html += '<div style="text-align:center;">';
        html += '<img src="wechat-qrcode.png" alt="公众号二维码" style="width:130px;height:130px;border-radius:8px;border:1px solid var(--border);object-fit:cover;">';
        html += '<div style="margin-top:6px;font-size:12px;color:var(--text-secondary);">关注公众号「岱森驻场」<br>上线第一时间通知你</div>';
        html += '</div>';

        // 用户群（引导加个人微信，避免群二维码 7 天失效）
        html += '<div style="flex:1;min-width:180px;font-size:13px;color:var(--text-secondary);line-height:1.8;">';
        html += `<div style="font-weight:600;color:var(--text-primary);margin-bottom:4px;display:flex;align-items:center;gap:4px;">${icon('message-circle', 13)} 加入用户群</div>`;
        html += '添加微信 <span style="user-select:all;color:var(--accent);">egohughu</span>，备注「<strong>进群</strong>」，即可加入 PPT Nest 用户群，获取内测资格与上线通知。';
        html += '</div>';

        html += '</div>';
        html += '</div>';

        Modal.show(`${icon(f.icon, 18)} ${f.name}`, html, [
            { label: '我知道了', key: 'ok', primary: true },
        ]);
    },

    async navigate(page) {
        const prevPage = this.currentPage;
        this.currentPage = page;
        // 用户不点「开始使用」、直接从引导页点侧栏离开，也算完成过一次引导
        if (prevPage === 'onboarding' && page !== 'onboarding') {
            API.completeOnboarding().catch(() => {});
        }

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
            if (subTitle) subTitle.textContent = page === 'browse' ? '分类浏览' : '文件浏览';
            // 每个模块用自己的折叠状态（在 A 折叠不影响 B）
            this.applySubSidebarState();
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
        // 右下角「当前组稿」浮栏：只在这两页显示，组稿非空才出现
        this.refreshComposeBar();
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
            this._collectionKinds = {};
            for (const c of collections) {
                this._collectionNames[c.id] = c.name;
                this._collectionKinds[c.id] = c.kind || 'slide';
            }

            this._catData = { categories, collections, stats };

            // 搜索框只建一次：之后只重画下面的树，打字时不丢焦点、也不重复请求接口
            const el = document.getElementById('sub-categories');
            if (!document.getElementById('cat-search-input')) {
                let bar = '<div class="sub-main-scroll"><div class="sub-search-wrap"><div class="sub-search-row">';
                bar += '<div class="sub-search-field">';
                bar += `<input type="text" id="cat-search-input" class="form-input sub-search-input" placeholder="搜索某个类别" value="${escapeHtml(this.catFilter || '')}" oninput="App._onCatFilterInput(this.value)" onkeydown="App._navKey(event,'#sub-categories','cat')" data-tip="回车打开第一个结果；↑↓ 换下一个；Esc 清空" aria-label="搜索类别">`;
                bar += `<button class="sub-search-clear" onclick="App._clearCatFilter()" data-tip="清空搜索" aria-label="清空搜索">${icon('x', 12)}</button>`;
                bar += '</div>';
                bar += `<button class="btn btn-sm btn-primary sub-search-btn" onclick="App._applyCatFilter()" data-tip="搜索" aria-label="搜索">${icon('search', 13)}</button>`;
                bar += '</div></div><div id="cat-tree-box"></div></div>';
                bar += '<div id="sub-col-dock" class="sub-col-dock"></div>';
                el.innerHTML = bar;
            }
            this._renderCatTree();
            this._renderDock('cat', this._catData.collections);
        } catch (e) {
            console.error('Sub-nav load error:', e);
            document.getElementById('sub-categories').innerHTML =
                '<div class="alert alert-warning" style="margin:12px;">加载分类失败</div>';
        }
    },

    // 只重画分类树 + 收藏夹（搜索框留在原地），数据来自 this._catData
    _renderCatTree() {
        const el = document.getElementById('cat-tree-box');
        const data = this._catData;
        if (!el || !data) return;
        const { categories, collections, stats } = data;
        const catKey = BrowsePage.currentCategory;
        const colId = BrowsePage.currentCollection;

        let html = '';
        const catQ = (this.catFilter || '').trim();
        const catsShown = catQ ? this._filterCategoryTree(categories, catQ) : categories;

            // ── Category section header ──
            // Single toggle button: shows open folder when everything is
            // expanded (click → collapse all), closed folder otherwise.
            const expandableIds = this._collectExpandableIds(catsShown);
            const allExpanded = expandableIds.length > 0 &&
                expandableIds.every(id => this.expandedCategories.has(id));
            const folderIcon = allExpanded
                ? icon('folder-open', 14)
                : icon('folder', 14);

            html += '<div class="sub-section-header" style="display:flex;justify-content:space-between;align-items:center;">';
            html += catQ
                ? `<span>${this._countCats(catsShown)} 个匹配类别</span>`
                : '<span>分类</span>';
            if (!catQ) {
                html += '<span class="sub-section-actions">';
                html += `<button class="sub-action-btn" onclick="App.toggleAllCategories()" data-tip="${allExpanded ? '全部折叠子分类' : '全部展开所有子分类'}" aria-label="展开或折叠全部分类">${folderIcon}</button>`;
                html += '</span>';
            }
            html += '</div>';

            if (!catQ) {
                // "All slides" item
                const isAllActive = catKey === null && colId === null;
                html += `<div class="sub-nav-item${isAllActive ? ' active' : ''}" data-nav="1" onclick="App.subSelectCategory(null)">`;
                html += `<span class="sub-nav-icon">${icon('list', 14)}</span>`;
                html += `<span class="sub-nav-name">全部页面</span>`;
                html += `<span class="sub-count">${stats.visible_slides}</span>`;
                html += `</div>`;

                // "Uncategorized" item
                html += `<div class="sub-nav-item${catKey === 'uncategorized' ? ' active' : ''}" data-nav="1" onclick="App.subSelectCategory('uncategorized')">`;
                html += `<span class="sub-nav-icon">${icon('inbox', 14)}</span>`;
                html += `<span class="sub-nav-name">未分类</span>`;
                html += `<span class="sub-count">${stats.uncategorized_slides}</span>`;
                html += `</div>`;

                html += '<div class="sub-nav-sep"></div>';
            }

            // Recursive category tree — N levels
            function renderTree(nodes, depth) {
                let out = '';
                for (const cat of nodes) {
                    const nodeKey = 'cat_' + cat.id;
                    const hasKids = cat.children && cat.children.length > 0;
                    const isActive = catKey === nodeKey;
                    // 搜索时一律展开，直接能看见命中的层级
                    const isExpanded = !!App.catFilter || App.expandedCategories.has(cat.id);
                    const indent = 8 + depth * 14;

                    out += `<div class="sub-nav-item${isActive ? ' active' : ''}" data-nav="1" style="cursor:pointer;padding-left:${indent}px;" oncontextmenu="App._onCategoryContextMenu(event, ${cat.id})">`;
                    if (hasKids) {
                        out += `<span class="sub-expand-toggle${isExpanded ? ' expanded' : ''}" data-tip="${isExpanded ? '折叠子分类' : '展开子分类'}" role="button" aria-label="展开或折叠子分类" onclick="event.stopPropagation(); App.toggleCategoryExpand(${cat.id})">`;
                        out += `${icon('chevron-down', 12)}`;
                        out += `</span>`;
                    }
                    out += `<span class="sub-nav-icon">${icon('folder', 14)}</span>`;
                    out += `<span class="sub-nav-name" onclick="App.subSelectCategory('${nodeKey}')" data-tip="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</span>`;
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

            html += renderTree(catsShown, 0);

            el.innerHTML = html;

            // Update slide count
            document.getElementById('sub-slide-count').textContent =
                '共 ' + stats.visible_slides + ' 个页面';
    },

    // 侧栏底部固定区：两个面板都是「页面收藏夹 → 模块专属收藏夹」，位置一致
    _renderDock(panel, collections) {
        const dock = document.getElementById('sub-col-dock');
        if (!dock) return;
        const own = panel === 'file' ? 'file' : 'category';
        dock.innerHTML = this._colGroupHtml('slide', collections) + this._colGroupHtml(own, collections);
    },

    // 收藏夹分组（页面 / 类别 / 文件三种共用一套版面）
    _colGroupHtml(kind, collections) {
        const CFG = {
            slide: { label: '页面收藏夹', ic: 'star', tip: '页面收藏夹', count: c => c.slide_count || 0, unit: '页' },
            category: { label: '类别收藏夹', ic: 'folder', tip: '类别收藏夹', count: c => c.category_count || 0, unit: '个分类' },
            file: { label: '文件收藏夹', ic: 'file-text', tip: '文件收藏夹', count: c => c.file_count || 0, unit: '个文件' },
        };
        const cfg = CFG[kind] || CFG.slide;
        const groupCols = (collections || []).filter(c => (c.kind || 'slide') === kind);
        const rowId = `sub-col-add-row-${kind}`;
        const inputId = `sub-col-add-input-${kind}`;
        const activeId = BrowsePage.currentCollection;

        let html = '';
        html += '<div class="sub-section-header" style="display:flex;justify-content:space-between;align-items:center;">';
        html += `<span class="sub-section-label">${icon(cfg.ic, 13)} ${cfg.label}</span>`;
        html += `<button class="sub-add-btn" onclick="App._showAddColInput('${kind}')" data-tip="新建${cfg.tip}" aria-label="新建${cfg.tip}">+</button>`;
        html += '</div>';
        html += `<div id="${rowId}" style="display:none;padding:4px 14px;">`;
        html += `<div style="display:flex;gap:4px;"><input type="text" id="${inputId}" class="form-input" style="flex:1;padding:3px 8px;font-size:12px;height:26px;" placeholder="${cfg.tip}名称" onkeydown="if(event.key==='Enter')App._doAddCollection('${kind}');if(event.key==='Escape')App._hideAddColInput('${kind}');">`;
        html += `<button class="btn btn-sm btn-primary" style="height:26px;font-size:11px;padding:0 8px;" onclick="App._doAddCollection('${kind}')" data-tip="确定" aria-label="确定">${icon('check', 12)}</button>`;
        html += `<button class="btn btn-sm btn-ghost" style="height:26px;font-size:11px;padding:0 8px;" onclick="App._hideAddColInput('${kind}')" data-tip="取消" aria-label="取消">${icon('x', 12)}</button>`;
        html += '</div></div>';

        for (const c of groupCols) {
            const isActive = activeId === c.id;
            const safeName = c.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const n = cfg.count(c);
            html += `<div class="sub-nav-item sub-col-item${isActive ? ' active' : ''}" onclick="App.subSelectCollection(${c.id})" data-tip="${n} ${cfg.unit}">`;
            html += `<span class="sub-nav-name sub-col-name" data-col-id="${c.id}" data-tip="${escapeHtml(c.name)}">${icon(cfg.ic, 12)} ${escapeHtml(c.name)}</span>`;
            html += `<input type="text" class="sub-col-edit-input" id="sub-col-edit-${c.id}" style="display:none;flex:1;min-width:0;padding:2px 6px;font-size:12px;height:22px;background:rgba(255,255,255,0.08);border:1px solid var(--accent);border-radius:3px;color:var(--text-inverse);" value="${escapeHtml(c.name)}" onkeydown="if(event.key==='Enter')App._doRenameCollection(${c.id});if(event.key==='Escape')App._cancelRenameCollection(${c.id});" onblur="App._doRenameCollection(${c.id})">`;
            html += `<span class="sub-col-actions">`;
            html += `<button class="sub-col-btn" onclick="event.stopPropagation();App._startRenameCollection(${c.id})" data-tip="重命名" aria-label="重命名">${icon('pencil', 12)}</button>`;
            html += `<button class="sub-col-btn sub-col-del" onclick="event.stopPropagation();App.deleteCollection(${c.id},'${safeName}','${kind}')" data-tip="删除收藏夹" aria-label="删除收藏夹">${icon("x", 12)}</button>`;
            html += `</span>`;
            html += `<span class="sub-count">${n}</span>`;
            html += `</div>`;
        }
        if (groupCols.length === 0) {
            html += `<div class="sub-empty-hint">暂无 · 点【+】新建</div>`;
        }
        return html;
    },

    // 收藏夹变了：只刷当前这个面板（两个面板内容互斥，乱刷会把对方的面板画上来）
    async _refreshCollections() {
        try {
            const collections = await API.getCollections();
            this._collectionNames = {};
            this._collectionKinds = {};
            for (const c of collections) {
                this._collectionNames[c.id] = c.name;
                this._collectionKinds[c.id] = c.kind || 'slide';
            }
            this._fileCollections = collections;
            if (this._catData) this._catData.collections = collections;
        } catch (e) { /* 刷面板时再报错也一样 */ }
        if (this.currentPage === 'files') await this.loadFileSubNav();
        else await this.loadSubNav();
        // 面板内容互斥：文件面板不重画分类面板，反之亦然
    },

    async loadFileSubNav() {
        try {
            const el = document.getElementById('sub-categories');
            const barExists = !!document.getElementById('file-search-input');

            // 已经有搜索框就只刷新列表：切换文件时不再重画侧栏，也就不会闪转圈
            if (!barExists) {
                let html = '';
                html += '<div class="sub-main-scroll">';
                // 打开文件：选 PPT 直接入库（和 Finder 右键「打开方式」同一条链路）
                html += '<div class="sub-open-row">'
                     + `<button class="sub-open-btn" onclick="App.pickOpenFiles()" data-tip="选一个或多个 PPT 打开并入库">${icon('folder-open', 13)} 打开文件</button>`
                     + '</div>';
                html += '<div class="sub-search-wrap">';
                html += '<div class="sub-search-row">';
                html += '<div class="sub-search-field">';
                html += `<input type="text" id="file-search-input" class="form-input sub-search-input" placeholder="搜索某个文件" value="${escapeHtml(this.fileFilter || '')}" oninput="App._onFileFilterInput(this.value)" onkeydown="App._navKey(event,'#sub-categories','file')" data-tip="回车打开第一个结果；↑↓ 换下一个；Esc 清空" aria-label="搜索文件">`;
                html += `<button class="sub-search-clear" onclick="App._clearFileFilter()" data-tip="清空搜索" aria-label="清空搜索">${icon('x', 12)}</button>`;
                html += '</div>';
                html += `<button class="btn btn-sm btn-primary sub-search-btn" onclick="App._applyFileFilter()" data-tip="搜索" aria-label="搜索">${icon('search', 13)}</button>`;
                html += '</div></div>';
                html += '<div id="file-list-container"></div></div>';
                html += '<div id="sub-col-dock" class="sub-col-dock"></div>';
                el.innerHTML = html;
            }

            // 先用手上的缓存把列表画出来（没有缓存才显示一次转圈）
            if (Array.isArray(this._cachedFiles) && this._cacheReady) {
                this._filterFileList();
            } else {
                const box = document.getElementById('file-list-container');
                if (box) box.innerHTML = '<div class="loading-spinner sub-loading"><div class="spinner"></div></div>';
            }

            const [files, collections] = await Promise.all([
                API.getFiles(),
                API.getCollections(),
            ]);
            this._cachedFiles = files.filter(f => f.slide_count > 0);
            this._cacheReady = true;
            for (const c of collections) {
                this._collectionNames[c.id] = c.name;
                this._collectionKinds[c.id] = c.kind || 'slide';
            }
            this._fileCollections = collections;
            this._renderDock('file', collections);
            this._filterFileList();

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
        const manage = !!this.fileManage;
        const checked = this.fileChecked || (this.fileChecked = new Set());
        this._shownFiles = files;

        let html = '';
        // 顶部一行：文件数 + 管理开关 / 批量操作
        if (manage) {
            const allOn = files.length > 0 && files.every(f => checked.has(f.id));
            const totalN = checked.size;
            html += '<div class="file-manage-bar">';
            html += `<label class="file-manage-chk"><input type="checkbox" ${allOn ? 'checked' : ''} onchange="App._toggleCheckAll(this.checked)">全选</label>`;
            html += `<button class="file-manage-del" ${totalN ? '' : 'disabled'} onclick="App.deleteSelectedFiles()">移除${totalN ? ' ' + totalN : ''}</button>`;
            html += `<button class="file-manage-btn" onclick="App.toggleFileManage(false)">完成</button>`;
            html += '</div>';
        } else {
            html += '<div class="file-manage-bar">';
            const q = (this.fileFilter || '').trim();
            html += `<span class="file-manage-count" style="margin-right:auto;">${q ? `匹配 ${files.length} 个` : `${files.length} 个文件`}</span>`;
            html += `<button class="file-manage-btn" data-tip="批量移除文件" onclick="App.toggleFileManage(true)">管理</button>`;
            html += '</div>';
        }

        if (files.length === 0) {
            html += '<div style="padding:16px;font-size:12px;color:var(--text-tertiary);text-align:center;">无匹配文件</div>';
            container.innerHTML = html;
            return;
        }

        for (const f of files) {
            const isFileActive = fId === f.id;
            const rowClick = manage ? `App._toggleFileCheck(${f.id})` : `App._onFileClick(${f.id})`;
            const flash = this.pendingFileHighlight === f.id ? ' row-flash' : '';
            html += `<div class="sub-nav-item${isFileActive ? ' active' : ''}${flash}" data-file-id="${f.id}" data-nav="1" onclick="${rowClick}" oncontextmenu="App._onFileContextMenu(event, ${f.id})">`;
            if (manage) {
                html += `<input type="checkbox" class="file-row-check" ${checked.has(f.id) ? 'checked' : ''} onclick="event.stopPropagation();App._toggleFileCheck(${f.id})" style="margin:0;flex:0 0 auto;">`;
            }
            html += `<span class="sub-nav-icon">${icon('file-text', 14)}</span>`;
            html += `<span class="sub-nav-name" data-tip="${escapeHtml(f.file_name)}">${escapeHtml(f.file_name)}</span>`;
            html += `<span class="sub-count">${f.slide_count}</span>`;
            html += `</div>`;
        }
        container.innerHTML = html;

        // 刚「打开方式」导入的文件：滚到可见处并闪一下，让人一眼看到它在哪
        if (this.pendingFileHighlight !== null) {
            const targetId = this.pendingFileHighlight;
            this.pendingFileHighlight = null;
            const row = container.querySelector(`.sub-nav-item[data-file-id="${targetId}"]`);
            if (row) {
                try { row.scrollIntoView({ block: 'center' }); } catch (_) {}
                setTimeout(() => row.classList.remove('row-flash'), 2600);
            }
        }
    },

    // ── 文件移除（只删库记录，磁盘上的 PPT 不动）──

    toggleFileManage(on) {
        this.fileManage = !!on;
        if (!on) this.fileChecked = new Set();
        this._filterFileList();      // 保留当前搜索过滤
    },

    _toggleFileCheck(id) {
        if (!this.fileChecked) this.fileChecked = new Set();
        if (this.fileChecked.has(id)) this.fileChecked.delete(id);
        else this.fileChecked.add(id);
        this._filterFileList();
    },

    _toggleCheckAll(on) {
        const files = this._shownFiles || [];
        if (!this.fileChecked) this.fileChecked = new Set();
        for (const f of files) {
            if (on) this.fileChecked.add(f.id);
            else this.fileChecked.delete(f.id);
        }
        this._filterFileList();
    },

    deleteSelectedFiles() {
        const ids = [...(this.fileChecked || new Set())];
        if (!ids.length) { Toast.info('没有选中文件'); return; }
        this._confirmDeleteFiles(ids);
    },

    async _confirmDeleteFiles(ids) {
        let impact;
        try {
            impact = await API.filesImpact(ids);
        } catch (e) {
            Toast.error(`读取影响面失败：${e.message}`);
            return;
        }
        const t = (impact && impact.totals) || {};
        const list = (impact && impact.files) || [];
        if (!list.length) { Toast.info('这些文件已经不在库里了'); return; }

        const one = list.length === 1;
        let body = '';
        if (one) {
            body += `<p style="font-size:13px;line-height:1.8;">从素材库移除 <strong>${escapeHtml(list[0].name)}</strong>（${list[0].slides} 页）。</p>`;
        } else {
            const names = list.slice(0, 6).map(f => `<li style="margin:2px 0;">${escapeHtml(f.name)}</li>`).join('');
            const more = list.length > 6 ? `<li style="margin:2px 0;color:var(--text-tertiary);">…还有 ${list.length - 6} 个</li>` : '';
            body += `<p style="font-size:13px;line-height:1.8;">共 ${t.slides} 页：</p>`;
            body += `<ul style="font-size:12.5px;color:var(--text-secondary);padding-left:18px;max-height:180px;overflow-y:auto;">${names}${more}</ul>`;
        }

        const also = [];
        if (t.categorized) also.push(`归类记录 ${t.categorized} 页`);
        if (t.collections) also.push(`收藏夹 ${t.collections} 处${(t.collection_names || []).length ? `（${t.collection_names.map(escapeHtml).join('、')}）` : ''}`);
        if (t.file_collections) also.push(`文件收藏夹 ${t.file_collections} 处${(t.file_collection_names || []).length ? `（${t.file_collection_names.map(escapeHtml).join('、')}）` : ''}`);
        if (t.compositions) also.push(`组稿 ${t.compositions} 处${(t.composition_names || []).length ? `（${t.composition_names.map(escapeHtml).join('、')}）` : ''}`);
        if (t.dup_groups) also.push(`重复组 ${t.dup_groups} 个`);
        if (also.length) {
            body += `<p style="font-size:12.5px;color:var(--text-secondary);line-height:1.8;margin-top:8px;">会一起清掉：${also.join('；')}。</p>`;
        }
        body += `<p style="font-size:12px;color:var(--text-tertiary);line-height:1.8;margin-top:8px;">磁盘上的原 PPT 不会动。移除后${one ? '它' : '它们'}会在下次扫描时重新变成「新文件」，可以再导入；手动归类和收藏会丢。</p>`;

        Modal.show(one ? '从素材库移除文件' : `从素材库移除 ${list.length} 个文件`, body, [
            { key: 'cancel', label: '取消' },
            { key: 'ok', label: one ? '移除' : `移除 ${list.length} 个`, danger: true, onClick: () => this._doDeleteFiles(ids) },
        ]);
    },

    async _doDeleteFiles(ids) {
        try {
            const r = await API.filesDelete(ids);
            Toast.success(`已从素材库移除 ${r.deleted} 个文件（${r.slides} 页），磁盘上的 PPT 没动`);
            this.fileChecked = new Set();
            this._cachedFiles = null;
            if (ids.includes(BrowsePage.currentFile)) {
                BrowsePage.currentFile = null;
            }
            await this.loadFileSubNav();
            this.updateStats();
            if (App.currentPage === 'files' || App.currentPage === 'browse') {
                this.navigate(this.currentPage);
            }
        } catch (e) {
            Toast.error(`移除失败：${e.message}`);
        }
    },


    // ── 侧栏搜索（类别 / 文件）：只过滤本面板的条目，选完结果关键词保留 ──

    // 关键词匹配：空格（含全角）分隔的多个词全部命中才算匹配（AND）
    _matchAll(text, q) {
        const hay = (text || '').toLowerCase();
        const tokens = (q || '').replace(/\u3000/g, ' ').split(/\s+/).filter(Boolean);
        if (!tokens.length) return true;
        return tokens.every(t => hay.includes(t.toLowerCase()));
    },

    _filterCategoryTree(nodes, q) {
        const out = [];
        for (const cat of nodes || []) {
            const kids = this._filterCategoryTree(cat.children || [], q);
            const hit = this._matchAll(cat.name, q);
            if (hit) out.push({ ...cat, children: cat.children || [] });
            else if (kids.length) out.push({ ...cat, children: kids });
        }
        return out;
    },

    _countCats(nodes) {
        let n = 0;
        for (const c of nodes || []) n += 1 + this._countCats(c.children || []);
        return n;
    },

    _onCatFilterInput(val) {
        this.catFilter = val || '';
        this._renderCatTree();
    },

    _applyCatFilter() {
        const i = document.getElementById('cat-search-input');
        if (i) this._onCatFilterInput(i.value);
    },

    _clearCatFilter() {
        this.catFilter = '';
        const i = document.getElementById('cat-search-input');
        if (i) { i.value = ''; i.focus(); }
        this._renderCatTree();
    },

    _onFileFilterInput(val) {
        this.fileFilter = val || '';
        this._filterFileList();
    },

    _applyFileFilter() {
        const i = document.getElementById('file-search-input');
        if (i) this._onFileFilterInput(i.value);
    },

    _clearFileFilter() {
        this.fileFilter = '';
        const i = document.getElementById('file-search-input');
        if (i) { i.value = ''; i.focus(); }
        this._filterFileList();
    },

    // 输入框里的键盘操作：↑↓ 在结果间移动高亮，回车打开高亮项（没有就打开第一个），
    // Esc 清空关键词。这样一条条看结果不用重新输入关键词。
    _navKey(e, scopeSel, kind) {
        const box = document.querySelector(scopeSel);
        if (!box) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            if (kind === 'cat') this._clearCatFilter();
            else { this.fileFilter = ''; const i = document.getElementById('file-search-input'); if (i) i.value = ''; this._filterFileList(); }
            return;
        }
        const items = [...box.querySelectorAll('.sub-nav-item[data-nav]')];
        if (!items.length) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            let idx = items.findIndex(el => el.classList.contains('kb-on'));
            if (idx < 0) idx = e.key === 'ArrowDown' ? -1 : items.length;
            const next = e.key === 'ArrowDown'
                ? Math.min(idx + 1, items.length - 1)
                : Math.max(idx - 1, 0);
            items.forEach(el => el.classList.remove('kb-on'));
            items[next].classList.add('kb-on');
            items[next].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const cur = items.find(el => el.classList.contains('kb-on')) || items[0];
            if (cur) (cur.querySelector('.sub-nav-name') || cur).click();
        }
    },

    _filterFileList() {
        const q = (this.fileFilter || '').trim();
        const files = this._cachedFiles || [];
        const filtered = q ? files.filter(f => this._matchAll(f.file_name, q)) : files;
        this._renderFileList(filtered);
    },

    _onFileClick(fileId) {
        BrowsePage.currentCategory = null;
        BrowsePage.currentCollection = null;
        BrowsePage.currentFile = fileId;
        BrowsePage.currentPage = 1;
        this.navigate('files');
    },

    // ── 文件行右键菜单：打开 / 加入收藏夹 / 删除 ──
    _onFileContextMenu(e, fileId) {
        e.preventDefault();
        e.stopPropagation();
        const f = (this._cachedFiles || []).find(x => x.id === fileId);
        const name = f ? f.file_name : `文件 #${fileId}`;
        ContextMenu.show(e.clientX, e.clientY, [
            { label: '打开', icon: 'file-text', onClick: () => this._onFileClick(fileId) },
            { label: '加入收藏夹', icon: 'star', onClick: () => this.showFileCollectionPicker(fileId) },
            { sep: true },
            { label: '删除', icon: 'trash-2', danger: true, onClick: () => this._confirmDeleteFiles([fileId]) },
        ]);
    },

    // ── 分类行右键菜单：打开 / 加入类别收藏夹 ──
    _onCategoryContextMenu(e, catId) {
        e.preventDefault();
        e.stopPropagation();
        const nameEl = e.currentTarget ? e.currentTarget.querySelector('.sub-nav-name') : null;
        const name = nameEl ? nameEl.innerText.trim() : `分类 #${catId}`;
        ContextMenu.show(e.clientX, e.clientY, [
            { label: '打开', icon: 'folder', onClick: () => this.subSelectCategory('cat_' + catId) },
            { label: '加入类别收藏夹', icon: 'star', onClick: () => this.showCategoryCollectionPicker(catId, name) },
        ]);
    },

    async showCategoryCollectionPicker(catId, catName) {
        try {
            const [collections, mine] = await Promise.all([
                API.getCollections(),
                API.getCategoryCollections(catId),
            ]);
            const catCols = collections.filter(c => (c.kind || 'slide') === 'category');
            const current = new Set(mine.collection_ids || []);

            let itemsHtml = '';
            for (const c of catCols) {
                itemsHtml += `
                    <label class="col-picker-item">
                        <input type="checkbox" value="${c.id}" ${current.has(c.id) ? 'checked' : ''}>
                        <span>${icon("folder", 13)} ${escapeHtml(c.name)}</span>
                        <span style="color:var(--text-tertiary);font-size:11px;">${c.category_count} 个分类</span>
                    </label>`;
            }
            if (catCols.length === 0) {
                itemsHtml = '<p style="color:var(--text-tertiary);font-size:13px;">暂无类别收藏夹，在下面输入名称新建</p>';
            }

            const content = `
                <div style="max-height:300px;overflow-y:auto;margin-bottom:12px;">${itemsHtml}</div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <input type="text" id="picker-new-catcol-name" class="form-input" placeholder="新建类别收藏夹名称" style="flex:1;">
                    <button class="btn btn-sm btn-ghost" onclick="App._createCatColAndCollect(${catId})">${icon("plus", 14)} 新建并收藏</button>
                </div>
            `;

            Modal.show(`${icon('star', 18)} 收藏分类到`, content, [
                { label: '取消', key: 'cancel' },
                {
                    label: icon('save', 14) + ' 保存',
                    key: 'save',
                    primary: true,
                    onClick: async () => {
                        const desired = new Set();
                        document.querySelectorAll('.col-picker-item input[type="checkbox"]:checked')
                            .forEach(cb => desired.add(parseInt(cb.value)));
                        for (const cid of desired) {
                            if (!current.has(cid)) await API.addCategoryToCollection(cid, catId);
                        }
                        for (const cid of current) {
                            if (!desired.has(cid)) await API.removeCategoryFromCollection(cid, catId);
                        }
                        Toast.success('已更新收藏');
                        this._refreshCollections();
                        if (BrowsePage.currentCollection !== null &&
                            this._collectionKinds[BrowsePage.currentCollection] === 'category') {
                            this.navigate(this.currentPage);
                        }
                    }
                },
            ]);
        } catch (e) {
            Toast.error(`加载类别收藏夹失败：${e.message}`);
        }
    },

    async _createCatColAndCollect(catId) {
        const nameEl = document.getElementById('picker-new-catcol-name');
        const name = (nameEl ? nameEl.value : '').trim();
        if (!name) { Toast.error('请输入名称'); return; }
        try {
            const r = await API.createCollection(name, 'category');
            await API.addCategoryToCollection(r.id, catId);
            Toast.success(`已创建并收藏：${name}`);
            Modal.hide();
            this._refreshCollections();
        } catch (e) {
            Toast.error(`操作失败：${e.message}`);
        }
    },

    // 文件收藏夹的勾选弹窗（复刻页面版的交互，数据换成 collection_files）
    async showFileCollectionPicker(fileId) {
        try {
            const [collections, mine] = await Promise.all([
                API.getCollections(),
                API.getFileCollections(fileId),
            ]);
            const fileCols = collections.filter(c => (c.kind || 'slide') === 'file');
            const current = new Set(mine.collection_ids || []);

            let itemsHtml = '';
            for (const c of fileCols) {
                const checked = current.has(c.id);
                itemsHtml += `
                    <label class="col-picker-item">
                        <input type="checkbox" value="${c.id}" ${checked ? 'checked' : ''}>
                        <span>${icon("star", 13)} ${escapeHtml(c.name)}</span>
                        <span style="color:var(--text-tertiary);font-size:11px;">${c.file_count} 个文件</span>
                    </label>`;
            }
            if (fileCols.length === 0) {
                itemsHtml = '<p style="color:var(--text-tertiary);font-size:13px;">暂无文件收藏夹，在下面输入名称新建</p>';
            }

            const content = `
                <div style="max-height:300px;overflow-y:auto;margin-bottom:12px;">
                    ${itemsHtml}
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <input type="text" id="picker-new-filecol-name" class="form-input" placeholder="新建文件收藏夹名称" style="flex:1;">
                    <button class="btn btn-sm btn-ghost" onclick="App._createFileColAndCollect(${fileId})">${icon("plus", 14)} 新建并收藏</button>
                </div>
            `;

            Modal.show(`${icon('star', 18)} 收藏到文件收藏夹`, content, [
                { label: '取消', key: 'cancel' },
                {
                    label: icon('save', 14) + ' 保存',
                    key: 'save',
                    primary: true,
                    onClick: async () => {
                        const desired = new Set();
                        document.querySelectorAll('.col-picker-item input[type="checkbox"]:checked')
                            .forEach(cb => desired.add(parseInt(cb.value)));
                        for (const cid of desired) {
                            if (!current.has(cid)) await API.addFileToCollection(cid, fileId);
                        }
                        for (const cid of current) {
                            if (!desired.has(cid)) await API.removeFileFromCollection(cid, fileId);
                        }
                        Toast.success('已更新收藏');
                        this._refreshCollections();
                        if (BrowsePage.currentCollection !== null &&
                            this._collectionKinds[BrowsePage.currentCollection] === 'file') {
                            App.navigate(App.currentPage);
                        }
                    }
                },
            ]);
        } catch (e) {
            Toast.error(`加载文件收藏夹失败：${e.message}`);
        }
    },

    async _createFileColAndCollect(fileId) {
        const nameEl = document.getElementById('picker-new-filecol-name');
        const name = (nameEl ? nameEl.value : '').trim();
        if (!name) { Toast.error('请输入名称'); return; }
        try {
            const r = await API.createCollection(name, 'file');
            await API.addFileToCollection(r.id, fileId);
            Toast.success(`已创建并收藏：${name}`);
            Modal.hide();
            this._refreshCollections();
        } catch (e) {
            Toast.error(`操作失败：${e.message}`);
        }
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
        // 两个面板都有收藏夹区：就地换右侧内容，不跳页（左侧面板和高亮都留着）
        this.navigate(this.currentPage === 'files' ? 'files' : 'browse');
    },

    subSelectFile(fileId) {
        this._onFileClick(fileId);
    },

    // ── Collection CRUD from sub-sidebar ──

    _showAddColInput(kind = 'slide') {
        const row = document.getElementById(`sub-col-add-row-${kind}`);
        if (row) row.style.display = 'block';
        const inp = document.getElementById(`sub-col-add-input-${kind}`);
        if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
    },

    _hideAddColInput(kind = 'slide') {
        const row = document.getElementById(`sub-col-add-row-${kind}`);
        if (row) row.style.display = 'none';
    },

    async _doAddCollection(kind = 'slide') {
        const inp = document.getElementById(`sub-col-add-input-${kind}`);
        if (!inp) return;
        const name = inp.value.trim();
        if (!name) { Toast.error('请输入名称'); return; }
        try {
            await API.createCollection(name, kind);
            Toast.success(`已创建：${name}`);
            this._hideAddColInput(kind);
            this._refreshCollections();
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
        // 兼容旧调用：侧栏搜索已改为只过滤类别，等价于重新应用一次关键词
        this._applyCatFilter();
    },

    async deleteCollection(colId, name, kind = 'slide') {
        const keep = kind === 'file' ? '收藏的文件不会被删除，只是移出收藏夹。' : '收藏的页面不会被删除，只是移出收藏夹。';
        Modal.confirm(`${icon('trash-2', 18)} 删除收藏夹`, `确定要删除“${name}”吗？${keep}`, async () => {
            try {
                await API.deleteCollection(colId);
                delete this._collectionNames[colId];
                delete this._collectionKinds[colId];
                if (BrowsePage.currentCollection === colId) {
                    BrowsePage.currentCollection = null;
                }
                Toast.success(`已删除：${name}`);
                this._refreshCollections();
            } catch (e) {
                Toast.error(`删除失败：${e.message}`);
            }
        });
    },

    // ── Collection Picker Modal ──

    async showCollectionPicker(slideId) {
        try {
            const [allCollections, slide] = await Promise.all([
                API.getCollections(),
                API.getSlide(slideId),
            ]);
            // 缩略图上的 ⭐ 只收进「页面收藏夹」，类别/文件收藏夹各走各的入口
            const collections = allCollections.filter(c => (c.kind || 'slide') === 'slide');
            const currentCols = new Set(slide.collection_ids || []);

            let itemsHtml = '';
            for (const c of collections) {
                const checked = currentCols.has(c.id);
                itemsHtml += `
                    <label class="col-picker-item">
                        <input type="checkbox" value="${c.id}" ${checked ? 'checked' : ''}>
                        <span>${icon("star", 13)} ${escapeHtml(c.name)}</span>
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
                    <button class="btn btn-sm btn-ghost" onclick="App._createAndCollect(${slideId})">${icon("plus", 14)} 新建并收藏</button>
                </div>
            `;

            Modal.show(`${icon('star', 18)} 收藏到`, content, [
                { label: '取消', key: 'cancel' },
                {
                    label: icon('save', 14) + ' 保存',
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
            // 只列页面收藏夹（类别/文件收藏夹不装页），勾选=这一页收进哪个夹，名字可直接改
            const pageCols = collections.filter(c => (c.kind || 'slide') === 'slide');
            let colCheckboxes = '';
            for (const c of pageCols) {
                colCheckboxes += `<div class="col-edit-row">
                    <label class="col-edit-check" data-tip="${slideCols.has(c.id) ? '已收藏：点一下移出' : '点一下收藏到这儿'}">
                        <input type="checkbox" value="${c.id}" ${slideCols.has(c.id) ? 'checked' : ''}>
                        <span>${icon("star", 13)}</span>
                    </label>
                    <input type="text" class="form-input col-name-edit" data-col-id="${c.id}" data-orig="${escapeHtml(c.name)}" value="${escapeHtml(c.name)}" placeholder="收藏夹名称" aria-label="收藏夹名称" data-tip="直接改名字，保存后侧栏和卡片一起更新">
                </div>`;
            }
            if (!pageCols.length) {
                colCheckboxes = '<p style="color:var(--text-tertiary);font-size:12.5px;margin:0;">还没有页面收藏夹，先去左侧【+】建一个</p>';
            }

            const content = `
                <div class="form-group">
                    <label class="form-label">${icon("clipboard-list", 13)} 归类</label>
                    <select class="form-select" id="edit-category">${catsHtml}</select>
                </div>
                <div class="form-group">
                    <label class="form-label">${icon("star", 13)} 页面收藏夹 <span style="font-weight:400;color:var(--text-tertiary);font-size:11.5px;">勾选=收进这个夹，右侧可改名</span></label>
                    <div style="max-height:190px;overflow-y:auto;">${colCheckboxes}</div>
                </div>
                <div style="font-size:12px;color:var(--text-tertiary);">
                    ${icon("file-text", 12)} ${escapeHtml(slide.file_name || '')} · 第${slide.slide_number}页
                </div>
            `;

            Modal.show(`编辑 - ${escapeHtml(slide.title || `第${slide.slide_number}页`)}`, content, [
                { label: '取消', key: 'cancel' },
                {
                    label: icon('save', 14) + ' 保存',
                    key: 'save',
                    primary: true,
                    onClick: async () => {
                        const catId = parseInt(document.getElementById('edit-category').value) || 0;
                        await API.updateSlideCategory(slideId, catId);

                        // 先处理改名：勾选框旁边那个输入框改了就改名
                        let renamed = 0;
                        for (const inp of document.querySelectorAll('#modal-box .col-name-edit')) {
                            const cid = parseInt(inp.dataset.colId);
                            const oldName = inp.dataset.orig || '';
                            const newName = (inp.value || '').trim();
                            if (!newName) { inp.value = oldName; continue; }   // 空名字不生效
                            if (newName === oldName) continue;
                            await API.renameCollection(cid, newName);
                            inp.dataset.orig = newName;
                            renamed++;
                        }

                        // Update collections
                        const currentColSet = new Set(slide.collection_ids || []);
                        const desiredColSet = new Set();
                        document.querySelectorAll('#modal-box .col-edit-row input[type="checkbox"]:checked').forEach(cb => {
                            desiredColSet.add(parseInt(cb.value));
                        });
                        for (const cid of desiredColSet) {
                            if (!currentColSet.has(cid)) await API.addToCollection(cid, slideId);
                        }
                        for (const cid of currentColSet) {
                            if (!desiredColSet.has(cid)) await API.removeFromCollection(cid, slideId);
                        }

                        Toast.success(renamed ? `已保存（收藏夹改名 ${renamed} 个）` : '已保存');
                        if (renamed) await this._refreshCollections();
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
        Modal.confirm(`${icon('trash-2', 18)} 删除此页`, '确定要永久删除此页面吗？缩略图和数据库记录将被删除。', async () => {
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

    // ── 加入稿件（浏览页 / 搜索页 / 收藏夹都能直接加到「上次用的那份组稿」）──

    _lastComposeId() {
        const v = parseInt(localStorage.getItem('pptNest.composeTarget') || '0', 10);
        return !v || isNaN(v) ? null : v;
    },

    _rememberComposeId(id) {
        if (id) localStorage.setItem('pptNest.composeTarget', String(id));
    },

    async addSlideToCompose(slideId) {
        if (!slideId) return;
        try {
            let comps = await API.composeList();
            if (!comps.length) {
                const created = await API.composeCreate('未命名组稿');
                comps = [created];
            }
            let targetId = this._lastComposeId();
            if (!targetId || !comps.some(c => c.id === targetId)) targetId = comps[0].id;
            const res = await API.composeAddItem(targetId, slideId);
            this._rememberComposeId(targetId);
            const comp = comps.find(c => c.id === targetId) || comps[0];
            // 每次动作各出一条提示（最多同时 5 条，最早的自卷走），不再合并成一条
            Toast.success(`已加入《${comp.name}》· 现在 ${(res.items || []).length} 页`);
            // 右下角浮栏：只刷新页数徽标，保持折叠，要看得自己点开
            this.refreshComposeBar();
            // 人就在组稿页上，右栏跟着刷新，不用手动切页
            if (this.currentPage === 'compose' && typeof ComposePage !== 'undefined'
                && ComposePage.compId === targetId) {
                ComposePage.items = res.items || [];
                ComposePage._refreshDock();
                ComposePage._refreshAddedBadges();
            }
        } catch (e) {
            Toast.error('加入稿件失败：' + e.message);
        }
    },

    // ── 当前组稿浮栏（分类浏览 / 文件浏览 页右下角） ─────────────────
    // 组稿非空时常驻：圆形 FAB + 页数徽标，点开向上展开浮层看页、逐页移除

    _composeBar: { compId: null, name: '', items: [], open: false },

    _ensureComposeBar() {
        if (document.getElementById('compose-bar')) return;
        const wrap = document.createElement('div');
        wrap.id = 'compose-bar';
        wrap.className = 'compose-bar';
        wrap.hidden = true;
        // 右下角：浮层在圆按钮上方，向上展开
        wrap.innerHTML = `
            <div id="compose-bar-panel" class="compose-bar-panel" hidden>
                <div class="compose-bar-head">
                    <span id="compose-bar-name" class="compose-bar-name"></span>
                    <span id="compose-bar-pages" class="compose-bar-pages"></span>
                    <button id="compose-bar-clear" class="compose-bar-clear" data-tip="清空这份组稿（只清组稿，素材库不动）" aria-label="清空组稿">${icon('trash-2', 12)} 清空</button>
                </div>
                <div id="compose-bar-list" class="compose-bar-list"></div>
            </div>
            <button id="compose-bar-fab" class="compose-bar-fab" onclick="App.toggleComposeBar()" data-tip="看当前组稿" aria-label="看当前组稿">
                <span id="compose-bar-badge" class="compose-bar-badge">0</span>
                ${icon('layers', 18)}
            </button>`;
        wrap.addEventListener('click', (e) => {
            if (e.target.closest('#compose-bar-clear')) {
                e.stopPropagation();
                App._clearComposeBar();
                return;
            }
            const del = e.target.closest('[data-bar-del]');
            if (del) {
                e.stopPropagation();
                App._removeComposeBarItem(parseInt(del.getAttribute('data-bar-del')));
                return;
            }
            const zoom = e.target.closest('[data-bar-zoom]');
            if (zoom) {
                e.stopPropagation();
                App.zoomThumbnail(parseInt(zoom.getAttribute('data-bar-zoom')), {});
            }
        });
        document.body.appendChild(wrap);
    },

    _composeBarListHtml(items) {
        let html = '';
        items.forEach((it, idx) => {
            const title = (it.title || '').substring(0, 60) || `第${it.slide_number}页`;
            const thumb = it.thumbnail_url ? API.baseUrl + it.thumbnail_url : '';
            html += `<div class="compose-bar-item" data-item-id="${it.item_id}">`;
            html += `<span class="compose-bar-no">${idx + 1}</span>`;
            html += thumb
                ? `<img src="${thumb}" alt="" data-bar-zoom="${it.slide_id}" data-tip="点开看大图">`
                : '<span class="compose-bar-thumb-empty"></span>';
            html += '<div class="compose-bar-t">';
            html += `<div class="compose-bar-title" data-tip="${escapeHtml(title)}">${escapeHtml(title)}</div>`;
            html += `<div class="compose-bar-src">${escapeHtml((it.file_name || '').replace(/\.pptx?$/i, ''))} · 第${it.slide_number}页</div>`;
            html += '</div>';
            html += `<button class="compose-bar-del" data-bar-del="${it.item_id}" data-tip="从组稿移除" aria-label="从组稿移除">${icon('x', 13)}</button>`;
            html += '</div>';
        });
        return html;
    },

    /** 只在有缩略图网格的页面出现（分类浏览 / 文件浏览）；组稿非空才显示 */
    async refreshComposeBar() {
        this._ensureComposeBar();
        const bar = document.getElementById('compose-bar');
        if (!bar) return;
        const compId = this._lastComposeId();
        const pageOk = this.currentPage === 'browse' || this.currentPage === 'files';
        let shown = false;
        if (compId && pageOk) {
            try {
                const detail = await API.composeGet(compId);
                const items = detail.items || [];
                if (items.length) {
                    this._composeBar = {
                        compId: detail.id, name: detail.name || '未命名组稿',
                        items, open: this._composeBar.open,
                    };
                    document.getElementById('compose-bar-name').textContent = this._composeBar.name;
                    document.getElementById('compose-bar-pages').textContent = `${items.length} 页`;
                    document.getElementById('compose-bar-badge').textContent = items.length;
                    shown = true;
                }
            } catch (e) { /* 组稿被删或接口异常：当作没有 */ }
        }
        if (!shown) {
            this._composeBar = { compId: null, name: '', items: [], open: false };
            bar.hidden = true;
            // 收起时把徽标与列表一起复位，别留着上一轮的数字和行
            const badge = document.getElementById('compose-bar-badge');
            if (badge) badge.textContent = '0';
            const nameEl = document.getElementById('compose-bar-name');
            if (nameEl) nameEl.textContent = '';
            const pagesEl = document.getElementById('compose-bar-pages');
            if (pagesEl) pagesEl.textContent = '0 页';
            const listEl = document.getElementById('compose-bar-list');
            if (listEl) listEl.innerHTML = '';
            const panel = document.getElementById('compose-bar-panel');
            if (panel) panel.hidden = true;
            return;
        }
        bar.hidden = false;
        this._renderComposeBarPanel();
    },

    _renderComposeBarPanel() {
        const panel = document.getElementById('compose-bar-panel');
        const list = document.getElementById('compose-bar-list');
        if (!panel || !list) return;
        list.innerHTML = this._composeBarListHtml(this._composeBar.items);
        panel.hidden = !this._composeBar.open;
    },

    toggleComposeBar() {
        this._composeBar.open = !this._composeBar.open;
        this._renderComposeBarPanel();
    },

    /** 一键清空：把当前组稿里的页全部移除（只动组稿，素材库与源文件都不碰） */
    async _clearComposeBar() {
        const st = this._composeBar;
        if (!st.compId || !st.items.length) return;
        const n = st.items.length;
        try {
            for (const it of st.items.slice()) {
                await API.composeRemoveItem(st.compId, it.item_id);
            }
            Toast.success(`已清空《${st.name}》· 移除了 ${n} 页`);
            if (this.currentPage === 'compose' && typeof ComposePage !== 'undefined'
                && ComposePage.compId === st.compId) {
                ComposePage.items = [];
                ComposePage._refreshDock();
                ComposePage._refreshAddedBadges();
            }
            await this.refreshComposeBar();
        } catch (e) {
            Toast.error('清空失败：' + e.message);
        }
    },

    async _removeComposeBarItem(itemId) {
        const st = this._composeBar;
        if (!st.compId || !itemId) return;
        const item = st.items.find(i => i.item_id === itemId);
        try {
            const res = await API.composeRemoveItem(st.compId, itemId);
            const items = res.items || [];
            Toast.success(`已从《${st.name}》移除${item ? '第' + item.slide_number + '页' : '一页'} · 现在 ${items.length} 页`);
            // 人可能在组稿页也开着同一份，右栏同步
            if (this.currentPage === 'compose' && typeof ComposePage !== 'undefined'
                && ComposePage.compId === st.compId) {
                ComposePage.items = items;
                ComposePage._refreshDock();
                ComposePage._refreshAddedBadges();
            }
            await this.refreshComposeBar();
        } catch (e) {
            Toast.error('移除失败：' + e.message);
        }
    },

    // ── Zoom / Enlarge Thumbnail ──

    /**
     * 打开大图。不传 params 时沿用浏览页的筛选口径；
     * 组稿页等别处调用时把自己的筛选条件传进来，否则大图的顺序会和当前看到的不一致。
     */
    async zoomThumbnail(slideId, paramsOverride = null) {
        // Build filter params matching the caller view (browse by default)
        const params = Object.assign({ page_size: 9999, include_hidden: BrowsePage.includeHidden }, paramsOverride || {});
        if (!paramsOverride) {
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
            // 二级搜索的关键词必须带进大图，否则大图的 x/N 与前后翻页会按全库顺序走。
            // 用 _appliedQ（网格当前真正生效的那次查询）而不是输入框草稿，避免防抖窗口内口径不一致。
            const appliedQ = (typeof BrowsePage !== 'undefined')
                ? (BrowsePage._appliedQ !== undefined ? BrowsePage._appliedQ : '')
                : '';
            const draftedQ = (typeof BrowsePage !== 'undefined' && BrowsePage._effectiveQuery)
                ? (BrowsePage._effectiveQuery() || '') : '';
            const zoomQ = appliedQ || draftedQ;
            if (zoomQ) params.q = zoomQ;
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

        let curIdx = this._zoomOrder.indexOf(slideId);
        if (curIdx < 0) {
            // 兜底：网格与查询口径在极端时序下仍可能不一致（比如刚改条件、DOM 还没刷）。
            // 这时按页面上真实渲染的卡片顺序定位，绝不让点击变成「点了没反应」。
            const domOrder = Array.from(document.querySelectorAll('.slide-card'))
                .map(c => parseInt(c.getAttribute('data-slide-id')))
                .filter(x => !isNaN(x));
            if (domOrder.length) {
                this._zoomOrder = domOrder;
                curIdx = domOrder.indexOf(slideId);
            }
        }
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
                    onclick="App._zoomNav(${idx - 1})" data-tip="上一张" aria-label="上一张">
                    ${icon("chevron-left", 26)}
                </button>
                <div class="zoom-image-wrap">
                    <img src="${info.thumbUrl}" style="max-width:100%;max-height:68vh;object-fit:contain;border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,0.15);">
                </div>
                <button class="zoom-nav-btn zoom-next" ${hasNext ? '' : 'disabled'}
                    onclick="App._zoomNav(${idx + 1})" data-tip="下一张" aria-label="下一张">
                    ${icon("chevron-right", 26)}
                </button>
            </div>
            <div class="zoom-footer">
                <span class="zoom-counter">${idx + 1} / ${total}</span>
                <span class="zoom-info">${escapeHtml(info.file_name)} · <strong>第${info.slide_number}页</strong></span>
                <button class="btn btn-sm btn-primary zoom-open-btn" onclick="App._openZoomSource(${slideId})">
                    ${icon("file-text", 14)} 打开源文件
                </button>
            </div>
        `;

        Modal.show(`${icon('zoom-in', 18)} ${escapeHtml(info.title)}`, navHtml, []);

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

    /** 折叠三角：在别的模块点它=直接跳过去（并把该模块的面板展开）；已经在本模块=折叠/展开 */
    onNavChevron(page) {
        if (this.currentPage !== page) {
            this._subCollapsed[page] = false;   // 跳过去时给个展开的面板
            this.navigate(page);
            return;
        }
        this.toggleSubSidebar();
    },

    /** 两个模块的折叠状态各记一份：在分类浏览折叠，不应影响文件浏览的三角和面板 */
    toggleSubSidebar() {
        const page = this.currentPage;
        if (page !== 'browse' && page !== 'files') return;
        this._subCollapsed[page] = !this._subCollapsed[page];
        this.applySubSidebarState();
    },

    /** 按当前模块自己的折叠状态刷新二级侧栏（面板 + 对应那个三角 + 拖拽手柄） */
    applySubSidebarState() {
        const sb = document.getElementById('sub-sidebar');
        if (!sb) return;
        const page = this.currentPage;
        const onPanelPage = page === 'browse' || page === 'files';
        const collapsed = onPanelPage ? !!this._subCollapsed[page] : false;

        sb.classList.toggle('collapsed', collapsed);

        // 只有当前模块的三角跟着转，另一个保持默认朝向
        [['browse', 'browse-chevron'], ['files', 'files-chevron']].forEach(([p, id]) => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('collapsed', p === page && collapsed);
        });

        const handle = document.getElementById('sub-sidebar-resize-handle');
        if (handle) handle.classList.toggle('visible', onPanelPage && !collapsed);

        this.applySubSidebarWidth();
    },

    // ── Sub-sidebar Resize ──

    applySubSidebarWidth() {
        const sb = document.getElementById('sub-sidebar');
        if (!sb) return;
        const isCollapsed = sb.classList.contains('collapsed');
        if (isCollapsed) {
            sb.style.removeProperty('--sub-sidebar-width');
        } else {
            sb.style.setProperty('--sub-sidebar-width', this.subSidebarWidth + 'px');
        }
    },

    initResizeHandle() {
        const handle = document.getElementById('sub-sidebar-resize-handle');
        const sb = document.getElementById('sub-sidebar');
        if (!handle || !sb) return;

        const saved = localStorage.getItem('pptNest_subSidebarWidth');
        if (saved) {
            const w = parseInt(saved, 10);
            if (!Number.isNaN(w)) {
                // 旧版本允许拖到 120px，会把侧栏文字挤断行，这里夹回可用区间
                this.subSidebarWidth = Math.max(this.SUB_SIDEBAR_MIN,
                    Math.min(this.SUB_SIDEBAR_MAX, w));
            }
        }
        this.applySubSidebarWidth();

        let dragging = false;
        let startX = 0;
        let startWidth = 0;
        let pendingX = 0;
        let rafId = 0;

        // 一帧只写一次样式：多次 pointermove 合并成一次布局
        const flush = () => {
            rafId = 0;
            if (!dragging) return;
            let newWidth = startWidth + (pendingX - startX);
            newWidth = Math.max(this.SUB_SIDEBAR_MIN,
                Math.min(this.SUB_SIDEBAR_MAX, Math.round(newWidth)));
            if (newWidth === this.subSidebarWidth) return;
            this.subSidebarWidth = newWidth;
            // CSS 里 width 与 min-width 都读这个变量，只写一处
            sb.style.setProperty('--sub-sidebar-width', newWidth + 'px');
        };

        const cleanup = () => {
            if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
            dragging = false;
            handle.classList.remove('dragging');
            document.body.classList.remove('sub-sidebar-resizing');
        };

        const onPointerDown = (e) => {
            if (sb.classList.contains('collapsed') || e.button !== 0) return;
            e.preventDefault();
            // 捕获指针：拖出窗口边界也能继续收到移动事件
            try { handle.setPointerCapture(e.pointerId); } catch (_) { }
            dragging = true;
            startX = e.clientX;
            pendingX = e.clientX;
            startWidth = sb.getBoundingClientRect().width;
            handle.classList.add('dragging');
            document.body.classList.add('sub-sidebar-resizing');
        };

        const onPointerMove = (e) => {
            if (!dragging) return;
            pendingX = e.clientX;
            if (!rafId) rafId = requestAnimationFrame(flush);
        };

        const onPointerUp = () => {
            if (!dragging) { cleanup(); return; }
            // 收尾前把最后一帧的位移应用掉，避免松手时差几像素
            if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
            const finalWidth = Math.max(this.SUB_SIDEBAR_MIN,
                Math.min(this.SUB_SIDEBAR_MAX, Math.round(startWidth + (pendingX - startX))));
            if (finalWidth !== this.subSidebarWidth) {
                this.subSidebarWidth = finalWidth;
                sb.style.setProperty('--sub-sidebar-width', finalWidth + 'px');
            }
            localStorage.setItem('pptNest_subSidebarWidth', this.subSidebarWidth);
            cleanup();
        };

        handle.addEventListener('pointerdown', onPointerDown);
        // 移动/抬起挂在 window 上：即使指针捕获失效、指针跑出 5px 把手，拖拽也不会中断
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        handle.addEventListener('lostpointercapture', () => { if (dragging) onPointerUp(); });
    },
};

// ─── Boot ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
