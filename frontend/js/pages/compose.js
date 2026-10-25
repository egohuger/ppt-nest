/**
 * 组稿导出页 —— 手动组页
 * 左边挑页（素材库），右边排顺序（稿件），导出成一份新的 PPTX。
 * 稿件存在后端 compositions 里，每次增删改都即时落库，不存在「未保存」状态。
 */
const ComposePage = {
    compId: null,
    compName: '',
    comps: [],
    items: [],
    // 素材库筛选
    q: '',
    categoryId: '',
    fileId: '',
    page: 1,
    pageSize: 24,
    total: 0,
    libItems: [],
    files: [],
    cats: [],
    exportTimer: null,
    _searchTimer: null,
    _dragItemId: null,

    // ─── 渲染 ───────────────────────────────────────────────────────

    async render() {
        await this._ensureComp();
        App._rememberComposeId(this.compId);
        const [lib] = await Promise.all([this._loadLib(), this._loadFilesAndCats()]);
        this.libItems = lib.items || [];
        this.total = lib.total || 0;

        let html = '<div class="page-header compose-header">';
        html += '<h1 class="page-title">组稿导出</h1>';
        html += '<p class="page-subtitle">左边挑页，右边排顺序，导出一份新的 PPTX。稿件边改边存，不用手动保存。</p>';
        html += '</div>';
        html += '<div class="compose-wrap">';
        html += this._libHtml();
        html += this._dockHtml();
        html += '</div>';

        setTimeout(() => this._bind(), 0);
        return html;
    },

    async _ensureComp() {
        this.comps = await API.composeList();
        if (this.compId && this.comps.some(c => c.id === this.compId)) {
            const d = await API.composeGet(this.compId);
            this.compName = d.name;
            this.items = d.items || [];
            return;
        }
        if (this.comps.length) {
            this.compId = this.comps[0].id;
            const d = await API.composeGet(this.compId);
            this.compName = d.name;
            this.items = d.items || [];
            return;
        }
        const created = await API.composeCreate('未命名组稿');
        this.compId = created.id;
        this.compName = created.name;
        this.items = [];
        this.comps = await API.composeList();
    },

    async _loadLib() {
        const params = { page: this.page, page_size: this.pageSize };
        if (this.q) params.q = this.q;
        if (this.categoryId) {
            params.category_id = this.categoryId;
            // 与分类浏览同口径：一级分类要带子分类的页，否则两边页数对不上
            params.include_children = true;
        }
        if (this.fileId) params.file_id = this.fileId;
        try {
            return await API.getSlides(params);
        } catch (e) {
            Toast.error('素材加载失败：' + e.message);
            return { total: 0, items: [] };
        }
    },

    // 左侧素材库当前的筛选条件。大图（zoom）要用同一套条件，
    // 否则大图里前后翻的顺序会和左边看到的列表不一致。
    _libParams() {
        const p = {};
        if (this.q) p.q = this.q;
        if (this.categoryId) {
            p.category_id = this.categoryId;
            p.include_children = true;
        }
        if (this.fileId) p.file_id = this.fileId;
        return p;
    },

    async _loadFilesAndCats() {
        try { this.files = await API.getFiles(); } catch (e) { this.files = []; }
        try { this.cats = await API.getCategories(); } catch (e) { this.cats = []; }
    },

    // ─── 左：素材库 ─────────────────────────────────────────────────

    _libHtml() {
        let html = '<section class="compose-lib">';
        html += '<div class="compose-lib-bar">';
        html += `<div class="compose-search">${icon('search', 14)}<input type="text" id="compose-q" class="form-input" placeholder="搜索标题或正文" value="${escapeHtml(this.q)}"></div>`;
        html += '<select class="form-select compose-select" id="compose-cat">';
        html += `<option value="">全部分类</option>`;
        for (const c of this._flatCats()) {
            html += `<option value="${c.id}"${String(this.categoryId) === String(c.id) ? ' selected' : ''}>${escapeHtml('　'.repeat(c.depth) + c.name)}</option>`;
        }
        html += '</select>';
        html += '<select class="form-select compose-select" id="compose-file">';
        html += `<option value="">全部来源文件</option>`;
        for (const f of this.files) {
            html += `<option value="${f.id}"${String(this.fileId) === String(f.id) ? ' selected' : ''}>${escapeHtml(f.file_name)}（${f.total_slides} 页）</option>`;
        }
        html += '</select>';
        html += `<span class="compose-lib-count">共 ${this.total} 页</span>`;
        html += '</div>';

        if (!this.libItems.length) {
            html += '<div class="alert alert-info">没有匹配的页面。换个关键词，或先进入【素材入库】导入 PPT。</div>';
        } else {
            html += '<div class="compose-grid">';
            for (const s of this.libItems) html += this._cardHtml(s);
            html += '</div>';
        }
        html += '<div id="compose-paginator"></div>';
        html += '</section>';
        return html;
    },

    _flatCats() {
        const out = [];
        // 接口返的是 children 树；也兼容扁平带 parent_id 的老结构
        const nested = Array.isArray(this.cats)
            && this.cats.some(c => Array.isArray(c.children) && c.children.length);
        if (nested) {
            const walkTree = (list, depth) => {
                for (const c of list || []) {
                    out.push({ id: c.id, name: c.name, depth });
                    if (Array.isArray(c.children) && c.children.length) {
                        walkTree(c.children, depth + 1);
                    }
                }
            };
            walkTree(this.cats, 0);
            return out;
        }
        const walk = (parentId, depth) => {
            for (const c of this.cats.filter(x => (x.parent_id || null) === parentId)) {
                out.push({ id: c.id, name: c.name, depth });
                walk(c.id, depth + 1);
            }
        };
        walk(null, 0);
        return out;
    },

    _cardHtml(s) {
        const title = (s.title || '').substring(0, 40) || `第${s.slide_number}页`;
        const thumb = s.thumbnail_url ? API.baseUrl + s.thumbnail_url : '';
        const inDock = this.items.filter(it => it.slide_id === s.id).length;
        let html = `<div class="compose-card" data-slide-id="${s.id}">`;
        html += '<div class="compose-card-thumb">';
        html += thumb
            ? `<img src="${thumb}" alt="" loading="lazy">`
            : `<span class="slide-thumb-placeholder">第 ${s.slide_number} 页</span>`;
        // 悬停浮层：和「分类浏览」的缩略图按钮同一位置——缩略图正中间横排，视觉居中
        html += '<div class="compose-hover-frame">';
        html += `<button class="compose-icon-btn" data-zoom="${s.id}" data-tip="放大查看" aria-label="放大查看">${icon('zoom-in', 16)}</button>`;
        html += `<button class="compose-icon-btn" data-add="${s.id}" data-tip="加入稿件" aria-label="加入稿件">${icon('plus', 16)}</button>`;
        html += '</div>';
        if (inDock) html += `<span class="compose-added" data-tip="稿件里已有 ${inDock} 次">${inDock}</span>`;
        html += '</div>';
        html += `<div class="compose-card-title" data-tip="${escapeHtml(title)}">${escapeHtml(title)}</div>`;
        html += `<div class="compose-card-meta">${escapeHtml((s.file_name || '').replace(/\.pptx?$/i, ''))} · 第${s.slide_number}页</div>`;
        html += '</div>';
        return html;
    },

    // ─── 右：稿件栏 ─────────────────────────────────────────────────

    _dockHtml() {
        let html = '<aside class="compose-dock">';
        html += '<div class="dock-head">';
        html += '<select class="form-select dock-comp" id="dock-comp">';
        for (const c of this.comps) {
            html += `<option value="${c.id}"${c.id === this.compId ? ' selected' : ''}>${escapeHtml(c.name)}（${c.item_count || 0}）</option>`;
        }
        html += '</select>';
        html += `<button class="btn btn-sm btn-secondary btn-icon" id="dock-skeleton" data-tip="骨架：把这份稿存成样板，或用样板快速新建" aria-label="骨架">${icon('layers', 14)}</button>`;
        html += `<button class="btn btn-sm btn-secondary btn-icon" id="dock-new" data-tip="新建一份组稿" aria-label="新建组稿">${icon('plus', 14)}</button>`;
        html += `<button class="btn btn-sm btn-secondary btn-icon" id="dock-rename" data-tip="重命名当前组稿" aria-label="重命名">${icon('pencil', 14)}</button>`;
        html += `<button class="btn btn-sm btn-secondary btn-icon" id="dock-del-comp" data-tip="删除当前组稿" aria-label="删除组稿">${icon('trash-2', 14)}</button>`;
        html += '</div>';
        html += `<div class="dock-meta"><span id="dock-count">${this.items.length} 页</span><span id="dock-duration"></span></div>`;
        html += '<div class="dock-list" id="dock-list">';
        html += this._dockListHtml();
        html += '</div>';
        html += '<div class="dock-foot">';
        html += `<button class="btn btn-primary dock-export" id="dock-export">${icon('download', 15)} 导出 PPTX</button>`;
        html += '</div>';
        html += '<div class="dock-progress" id="dock-progress" hidden></div>';
        html += '</aside>';
        return html;
    },

    _dockListHtml() {
        if (!this.items.length) {
            return '<div class="dock-empty">稿件还是空的。<br>在左边点卡片上的【+】加入页面，加入后可以拖动排序。</div>';
        }
        let html = '';
        this.items.forEach((it, idx) => {
            const title = (it.title || '').substring(0, 60) || `第${it.slide_number}页`;
            const thumb = it.thumbnail_url ? API.baseUrl + it.thumbnail_url : '';
            html += `<div class="dock-item" draggable="true" data-item-id="${it.item_id}">`;
            html += `<span class="dock-grip">${icon('grip-vertical', 14)}</span>`;
            html += `<span class="dock-no">${idx + 1}</span>`;
            html += thumb
                ? `<img class="dock-thumb" src="${thumb}" data-zoom="${it.slide_id}" data-tip="点开看大图" alt="">`
                : `<span class="dock-thumb dock-thumb-empty"></span>`;
            html += '<div class="dock-info">';
            html += `<div class="dock-title" data-tip="${escapeHtml(title)}">${escapeHtml(title)}</div>`;
            html += `<div class="dock-src">${escapeHtml(it.file_name || '')} · 第${it.slide_number}页</div>`;
            html += '</div>';
            html += `<button class="dock-del" data-del="${it.item_id}" data-tip="从稿件移除" aria-label="从稿件移除">${icon('x', 13)}</button>`;
            html += '</div>';
        });
        return html;
    },

    _refreshDock() {
        const list = document.getElementById('dock-list');
        if (list) list.innerHTML = this._dockListHtml();
        const count = document.getElementById('dock-count');
        if (count) count.textContent = `${this.items.length} 页`;
        const dur = document.getElementById('dock-duration');
        if (dur) {
            const minutes = Math.round(this.items.length * 40 / 60);
            dur.textContent = this.items.length ? `约讲 ${minutes} 分钟` : '';
        }
        // 下拉里的「（页数）」也要跟着变，不然会一直显示创建时的 0
        const sel = document.getElementById('dock-comp');
        if (sel) {
            const opt = sel.options[sel.selectedIndex];
            if (opt) {
                const name = this.compName || opt.textContent.replace(/（\d+）$/, '');
                opt.textContent = `${name}（${this.items.length}）`;
            }
        }
    },

    // ─── 事件绑定 ───────────────────────────────────────────────────

    _bind() {
        const q = document.getElementById('compose-q');
        if (q) {
            q.addEventListener('input', () => {
                clearTimeout(this._searchTimer);
                this._searchTimer = setTimeout(() => {
                    this.q = q.value.trim();
                    this.page = 1;
                    App.navigate('compose');
                }, 320);
            });
            q.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    clearTimeout(this._searchTimer);
                    this.q = q.value.trim();
                    this.page = 1;
                    App.navigate('compose');
                }
            });
        }
        const cat = document.getElementById('compose-cat');
        if (cat) cat.addEventListener('change', () => { this.categoryId = cat.value; this.page = 1; App.navigate('compose'); });
        const file = document.getElementById('compose-file');
        if (file) file.addEventListener('change', () => { this.fileId = file.value; this.page = 1; App.navigate('compose'); });

        // 分页
        const pg = document.getElementById('compose-paginator');
        if (pg && this.total > this.pageSize) {
            pg.innerHTML = Paginator.render(this.total, this.pageSize, this.page,
                (p) => { this.page = p; App.navigate('compose'); }, 'compose-paginator');
        }

        // 加入稿件 / 放大查看：只认卡片上的按钮，点卡片别的位置什么都不做
        const grid = document.querySelector('.compose-grid');
        if (grid) {
            grid.addEventListener('click', (e) => {
                const addBtn = e.target.closest('[data-add]');
                if (addBtn) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.addSlide(parseInt(addBtn.getAttribute('data-add')));
                    return;
                }
                const zoomBtn = e.target.closest('[data-zoom]');
                if (zoomBtn) {
                    e.preventDefault();
                    e.stopPropagation();
                    App.zoomThumbnail(parseInt(zoomBtn.getAttribute('data-zoom')), this._libParams());
                }
            });
        }

        // 稿件栏：删除 / 大图 / 拖拽
        const list = document.getElementById('dock-list');
        if (list) {
            list.addEventListener('click', (e) => {
                const del = e.target.closest('[data-del]');
                if (del) { this.removeItem(parseInt(del.getAttribute('data-del'))); return; }
                const zoom = e.target.closest('[data-zoom]');
                if (zoom) App.zoomThumbnail(parseInt(zoom.getAttribute('data-zoom')));
            });
            list.addEventListener('dragstart', (e) => {
                const row = e.target.closest('.dock-item');
                if (!row) return;
                this._dragItemId = parseInt(row.getAttribute('data-item-id'));
                row.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', String(this._dragItemId)); } catch (_) {}
            });
            list.addEventListener('dragend', () => {
                this._dragItemId = null;
                list.querySelectorAll('.dock-item').forEach(r => r.classList.remove('dragging', 'drop-above', 'drop-below'));
            });
            list.addEventListener('dragover', (e) => {
                const row = e.target.closest('.dock-item');
                if (!row || this._dragItemId === null) return;
                e.preventDefault();
                const rect = row.getBoundingClientRect();
                const below = (e.clientY - rect.top) > rect.height / 2;
                list.querySelectorAll('.dock-item').forEach(r => r.classList.remove('drop-above', 'drop-below'));
                row.classList.add(below ? 'drop-below' : 'drop-above');
            });
            list.addEventListener('drop', (e) => {
                const row = e.target.closest('.dock-item');
                if (!row || this._dragItemId === null) return;
                e.preventDefault();
                const targetId = parseInt(row.getAttribute('data-item-id'));
                const rect = row.getBoundingClientRect();
                const below = (e.clientY - rect.top) > rect.height / 2;
                this.moveItem(this._dragItemId, targetId, below);
            });
        }

        // 组稿切换 / 增删
        const sel = document.getElementById('dock-comp');
        if (sel) sel.addEventListener('change', async () => {
            this.compId = parseInt(sel.value);
            App._rememberComposeId(this.compId);
            const d = await API.composeGet(this.compId);
            this.compName = d.name;
            this.items = d.items || [];
            this._refreshDock();
        });
        const btnNew = document.getElementById('dock-new');
        if (btnNew) btnNew.addEventListener('click', () => this.createComp());
        const btnSkeleton = document.getElementById('dock-skeleton');
        if (btnSkeleton) btnSkeleton.addEventListener('click', () => this.openSkeletonPanel());
        const btnRename = document.getElementById('dock-rename');
        if (btnRename) btnRename.addEventListener('click', () => this.renameComp());
        const btnDelComp = document.getElementById('dock-del-comp');
        if (btnDelComp) btnDelComp.addEventListener('click', () => this.deleteComp());
        const btnExport = document.getElementById('dock-export');
        if (btnExport) btnExport.addEventListener('click', () => this.exportPptx());

        this._refreshDock();
        // 导出任务在跑时（比如切换页面回来），续上进度
        this._resumeProgress();
    },

    // ─── 动作 ───────────────────────────────────────────────────────

    async addSlide(slideId) {
        if (!slideId || !this.compId) return;
        try {
            const res = await API.composeAddItem(this.compId, slideId);
            this.items = res.items || [];
            this._refreshDock();
            this._refreshAddedBadges();
            const list = document.getElementById('dock-list');
            if (list) list.scrollTop = list.scrollHeight;
        } catch (e) {
            Toast.error('加入失败：' + e.message);
        }
    },

    async removeItem(itemId) {
        try {
            const res = await API.composeRemoveItem(this.compId, itemId);
            this.items = res.items || [];
            this._refreshDock();
            this._refreshAddedBadges();
        } catch (e) {
            Toast.error('移除失败：' + e.message);
        }
    },

    async moveItem(fromItemId, targetItemId, below) {
        if (fromItemId === targetItemId) return;
        const ids = this.items.map(it => it.item_id).filter(id => id !== fromItemId);
        let idx = ids.indexOf(targetItemId);
        if (idx === -1) idx = ids.length - 1;
        ids.splice(below ? idx + 1 : idx, 0, fromItemId);
        // 先本地重排，界面不闪
        const byId = {};
        this.items.forEach(it => { byId[it.item_id] = it; });
        this.items = ids.map(id => byId[id]).filter(Boolean);
        this._refreshDock();
        try {
            const res = await API.composeReorder(this.compId, ids);
            this.items = res.items || this.items;
            this._refreshDock();
        } catch (e) {
            Toast.error('排序保存失败：' + e.message);
        }
    },

    _refreshAddedBadges() {
        document.querySelectorAll('.compose-card').forEach(card => {
            const id = parseInt(card.getAttribute('data-slide-id'));
            const n = this.items.filter(it => it.slide_id === id).length;
            const thumb = card.querySelector('.compose-card-thumb');
            if (!thumb) return;
            let badge = thumb.querySelector('.compose-added');
            if (n && !badge) {
                badge = document.createElement('span');
                badge.className = 'compose-added';
                thumb.appendChild(badge);
            }
            if (badge) {
                if (n) { badge.textContent = n; badge.setAttribute('data-tip', `稿件里已有 ${n} 次`); }
                else badge.remove();
            }
        });
    },

    async createComp() {
        try {
            const created = await API.composeCreate(`组稿 ${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}`);
            this.compId = created.id;
            this.compName = created.name;
            this.items = [];
            this.comps = await API.composeList();
            App.navigate('compose');
        } catch (e) {
            Toast.error('新建失败：' + e.message);
        }
    },

    renameComp() {
        const self = this;
        const input = `<div class="form-group"><label class="form-label">组稿名称</label>
            <input type="text" class="form-input" id="rename-comp-input" value="${escapeHtml(this.compName)}"></div>`;
        Modal.show('重命名组稿', input, [
            { key: 'cancel', label: '取消' },
            { key: 'ok', label: '保存', primary: true, onClick: async () => {
                const v = (document.getElementById('rename-comp-input').value || '').trim();
                if (!v) return;
                try {
                    await API.composeRename(self.compId, v);
                    self.compName = v;
                    self.comps = await API.composeList();
                    App.navigate('compose');
                } catch (e) { Toast.error('重命名失败：' + e.message); }
            } },
        ]);
    },

    deleteComp() {
        const self = this;
        Modal.show('删除组稿',
            `<p style="font-size:13px;color:var(--text-secondary);line-height:1.7;">删除的是这份组稿清单本身，素材库里的页面不受影响。</p>`,
            [
                { key: 'cancel', label: '取消' },
                { key: 'ok', label: '删除', primary: true, onClick: async () => {
                    try {
                        await API.composeDelete(self.compId);
                        self.compId = null;
                        self.items = [];
                        self.comps = [];
                        await self._ensureComp();
                        App.navigate('compose');
                    } catch (e) { Toast.error('删除失败：' + e.message); }
                } },
            ]);
    },

    // ─── 骨架（样板复用）─────────────────────────────────────────────

    async openSkeletonPanel() {
        let tpls = [];
        try { tpls = await API.composeTemplates(); } catch (e) { tpls = []; }
        let html = '<p class="skel-hint">骨架 = 一份排好页序的定稿，只留"第几页该放什么"，下次按标题从库里自动配页。生成的是一份<strong>新组稿</strong>，骨架本身不会被改动。</p>';
        if (!tpls.length) {
            html += '<div class="skel-empty">还没有骨架。把当前这份组稿存成骨架，以后就能一键复用它的页序。</div>';
        } else {
            html += '<div class="skel-list">';
            for (const t of tpls) {
                html += `<div class="skel-row">
                    <div class="skel-name">${escapeHtml(t.name)}<span class="skel-count">${t.item_count || 0} 页</span></div>
                    <button class="btn btn-sm btn-primary skel-use" data-tpl="${t.id}" data-name="${escapeHtml(t.name)}">用它新建</button>
                </div>`;
            }
            html += '</div>';
        }
        html += `<div class="skel-foot"><button class="btn btn-sm btn-secondary" id="skel-save">把当前稿件存为骨架</button></div>`;

        Modal.show(`${icon('layers', 18)} 骨架`, html, [{ key: 'close', label: '关闭' }]);

        document.querySelectorAll('.skel-use').forEach(btn => {
            btn.addEventListener('click', () => {
                Modal.hide();
                this.createFromSkeleton(parseInt(btn.dataset.tpl), btn.dataset.name);
            });
        });
        const saveBtn = document.getElementById('skel-save');
        if (saveBtn) saveBtn.addEventListener('click', () => { Modal.hide(); this.saveAsSkeleton(); });
    },

    async saveAsSkeleton() {
        if (!this.items.length) { Toast.error('空稿件存成骨架没有意义'); return; }
        try {
            await API.composeMarkTemplate(this.compId, true);
            Toast.success(`《${this.compName}》已存为骨架，可在骨架面板里复用`);
        } catch (e) {
            Toast.error('存为骨架失败：' + e.message);
        }
    },

    async createFromSkeleton(templateId, name) {
        Toast.info('正在按骨架配页…');
        try {
            const res = await API.composeFromTemplate(templateId, null);
            this.compId = res.id;
            this.compName = res.name;
            this.items = res.items || [];
            App._rememberComposeId(res.id);
            await App.navigate('compose');
            this._showSkeletonResult(name || '', res.rows || []);
        } catch (e) {
            Toast.error('按骨架新建失败：' + e.message);
        }
    },

    _showSkeletonResult(name, rows) {
        const stat = { exact: 0, similar: 0, weak: 0, missing: 0 };
        rows.forEach(r => { stat[r.status] = (stat[r.status] || 0) + 1; });
        const label = { exact: '原页', similar: '相似页', weak: '勉强匹配', missing: '没配到' };
        let html = `<p class="skel-hint">按“${escapeHtml(name)}”建好了：原页 ${stat.exact} 页、相似页 ${stat.similar} 页、勉强匹配 ${stat.weak} 页、没配到 ${stat.missing} 页。</p>`;
        html += '<div class="skel-result">';
        for (const r of rows) {
            html += `<div class="skel-result-row skel-${r.status}">
                <span class="skel-idx">${r.index}</span>
                <span class="skel-target">${escapeHtml((r.skeleton_title || '（无标题）').slice(0, 28))}</span>
                <span class="skel-arrow">→</span>
                <span class="skel-hit">${escapeHtml((r.matched_title || '—').slice(0, 28))}</span>
                <span class="skel-status">${label[r.status] || ''}${r.score ? ' ' + r.score : ''}</span>
            </div>`;
        }
        html += '</div><p class="skel-hint">标【勉强匹配】和【没配到】的页优先复核，其余直接拖拽调整即可。</p>';
        Modal.show(`${icon('layers', 18)} 骨架配页结果`, html, [{ key: 'ok', label: '知道了', primary: true }]);
    },

    // ─── 导出 ───────────────────────────────────────────────────────

    // 导出前先体检，再问成套改字，最后才弹保存框
    async exportPptx() {
        if (!this.items.length) { Toast.error('稿件还是空的'); return; }

        // 1) 体检
        let report = null;
        try { report = await API.composePreflight(this.compId); } catch (e) { report = null; }
        if (report && (report.issues || []).length) {
            const go = await this._askPreflight(report);
            if (!go) return;
        }

        // 2) 成套改字（可以跳过）
        const rules = await this._askReplacements();
        if (rules === null) return;   // 用户取消

        const stamp = new Date().toISOString().slice(0, 10);
        const defaultName = `${(this.compName || '组稿').replace(/[\\/:*?"<>|]/g, '_')}-${stamp}.pptx`;
        if (!window.electronAPI || !window.electronAPI.showSaveDialog) {
            Toast.error('只有在桌面应用里才能导出');
            return;
        }
        const target = await window.electronAPI.showSaveDialog({
            title: '导出组稿为 PPT',
            defaultPath: defaultName,
        });
        if (!target) return;   // 用户取消

        this._setProgress('准备中…', true);
        try {
            await API.composeExport(this.compId, target, rules);
            this._pollProgress();
        } catch (e) {
            this._setProgress(null);
            Toast.error('导出失败：' + e.message);
        }
    },

    _askPreflight(report) {
        return new Promise((resolve) => {
            const levelStyle = { blocker: 'danger', warn: 'warn', info: 'info' };
            const levelText = { blocker: '必须处理', warn: '注意', info: '提醒' };
            let html = `<p class="preflight-sum">稿件 ${report.pages} 页，来自 ${report.files} 份源文件。</p>`;
            for (const it of report.issues) {
                const cls = levelStyle[it.level] || 'info';
                html += `<div class="preflight-item preflight-${cls}">`;
                html += `<div class="preflight-head"><span class="preflight-tag">${levelText[it.level] || ''}</span>${escapeHtml(it.title)}</div>`;
                html += `<div class="preflight-detail">${escapeHtml(it.detail)}</div>`;
                if (it.pages && it.pages.length) {
                    html += `<div class="preflight-pages">涉及页码：${it.pages.join('、')}${it.pages.length >= 60 ? ' …' : ''}</div>`;
                }
                html += '</div>';
            }
            if ((report.ratios || []).length > 1) {
                html += '<div class="preflight-ratios">页面尺寸分布：';
                html += report.ratios.map(r => `${escapeHtml(r.label)} ${r.pages} 页`).join(' ｜ ');
                html += '</div>';
            }
            Modal.show(`${icon('circle-alert', 18)} 导出前体检`, html, [
                { key: 'cancel', label: '回去改', onClick: () => resolve(false) },
                { key: 'go', label: '仍然导出', primary: true, onClick: () => resolve(true) },
            ]);
        });
    },

    _askReplacements() {
        return new Promise((resolve) => {
            let rows = '';
            for (let i = 0; i < 3; i++) {
                rows += `<div class="replace-row">
                    <input type="text" class="form-input replace-from" placeholder="原文（留空忽略）">
                    <span class="replace-arrow">→</span>
                    <input type="text" class="form-input replace-to" placeholder="替换成">
                </div>`;
            }
            const html = `<p class="replace-hint">整套一次性改掉客户名、项目名这类字样。<strong>只作用于这次导出的文件</strong>，素材库和源 PPT 都不动；备注里的字也会一起改。图表和 SmartArt 里的文字改不了，导出后会在提示里告诉你有几处没改到。</p>
                <div class="replace-rows">${rows}</div>`;
            Modal.show(`${icon('pencil', 18)} 成套改字`, html, [
                { key: 'cancel', label: '取消', onClick: () => resolve(null) },
                { key: 'skip', label: '不改，直接导出', onClick: () => resolve([]) },
                { key: 'go', label: '应用并导出', primary: true, onClick: () => {
                    const rules = [];
                    document.querySelectorAll('.replace-row').forEach(row => {
                        const from = (row.querySelector('.replace-from').value || '').trim();
                        const to = row.querySelector('.replace-to').value || '';
                        if (from) rules.push({ from, to });
                    });
                    resolve(rules);
                } },
            ]);
        });
    },

    _setProgress(text, running = false) {
        const box = document.getElementById('dock-progress');
        const btn = document.getElementById('dock-export');
        if (!box) return;
        if (text === null) { box.hidden = true; box.textContent = ''; }
        else { box.hidden = false; box.textContent = text; }
        if (btn) btn.disabled = running;
    },

    _pollProgress() {
        clearInterval(this.exportTimer);
        this.exportTimer = setInterval(async () => {
            let p;
            try { p = await API.composeExportProgress(); } catch (_) { return; }
            if (p.running) {
                this._setProgress(`正在拼装 ${p.current}/${p.total} 页 ${p.label ? '· ' + p.label.slice(0, 40) : ''}`, true);
                return;
            }
            clearInterval(this.exportTimer);
            this.exportTimer = null;
            if (p.error) {
                this._setProgress(null);
                Toast.error('导出失败：' + p.error);
                return;
            }
            const r = p.result || {};
            this._setProgress(null);
            const bits = [`原生可编辑 ${r.native || 0} 页`];
            if (r.cloned) bits.push(`从别的文件搬来 ${r.cloned} 页`);
            if (r.image) bits.push(`${r.image} 页用整页图代替`);
            const rep = r.replacements;
            if (rep && rep.replaced) {
                bits.push(`改字 ${rep.replaced} 处`);
                if (rep.chart_skipped) bits.push(`${rep.chart_skipped} 处图表字没改到`);
            }
            if ((r.notes || []).length) {
                Toast.info((r.notes || []).slice(0, 2).join('；'), 6000);
            }
            Toast.success(`已导出 ${r.slides || 0} 页：${bits.join('，')}`);
            if (r.output && window.electronAPI?.revealPath) {
                window.electronAPI.revealPath(r.output);
            }
        }, 500);
    },

    async _resumeProgress() {
        try {
            const p = await API.composeExportProgress();
            if (p && p.running) { this._setProgress('正在拼装…', true); this._pollProgress(); }
        } catch (_) {}
    },
};
