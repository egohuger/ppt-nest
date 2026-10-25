/**
 * Scan Page - 素材入库 + 设置
 */
const ScanPage = {
    scanData: null,
    stats: null,
    processing: false,
    reclassifying: false,
    showFileList: false,
    showSettings: false,
    _progressTimer: null,

    async render() {
        let html = '';

        // ═══════════ Page title ═══════════
        html += '<div class="page-header">';
        html += '<h1 class="page-title">素材入库</h1>';
        html += '</div>';

        // ═══════════ 重新分类：整页进度（导入不走这里，导入用浮层）═══════════
        if (this.reclassifying) {
            this._startProgressPolling();
            html += '<div id="scan-progress-card" class="card" style="text-align:center;padding:40px 20px;">';
            html += `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">${icon("clock", 14)} 正在处理 PPT 文件…</div>`;
            html += '<div id="scan-progress-big" style="font-size:56px;font-weight:700;color:var(--accent);line-height:1.2;">0%</div>';
            html += '<div id="scan-progress-msg" style="font-size:13px;color:var(--text-tertiary);margin-top:8px;">准备中...</div>';
            html += `<button class="btn btn-sm btn-danger" style="margin-top:16px;" onclick="ScanPage.cancelScan()">${icon("x", 14)} 取消扫描</button>`;
            html += '</div>';
            return html;
        }

        // 后端还在跑（页面重载/切页回来）：页面照常渲染，进度用浮层盖上去
        try {
            const sp = await API.scanProgress();
            if (sp.running) {
                this.processing = true;
                this._sawRunning = true;  // real in-flight scan — allow done detection
                this._resumeOverlay = true;
            }
        } catch (e) { /* ignore */ }

        try {
            const [scanData, stats] = await Promise.all([
                API.scanCheck(),
                API.getStats(),
            ]);
            this.scanData = scanData;
            this.stats = stats;
        } catch (e) {
            html += `<div class="alert alert-danger">加载失败：${escapeHtml(e.message)}</div>`;
            return html;
        }

        const d = this.scanData;
        const emptyLib = !this.stats || (this.stats.total_files || 0) === 0;
        const newCount = (d.new_files || []).length;
        const processedCount = (d.processed_files || []).filter(f => f.processed).length;

        // ═══════════ 素材路径选择（路径 + 扫描 + 去重 + 清单）═══════════
        const showSet = this._settingsTouched ? this.showSettings : emptyLib;
        html += '<div class="card mb-4">';
        html += '<div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;cursor:pointer;" onclick="ScanPage.toggleSettings()">';
        html += `<span style="display:inline-flex;align-items:center;gap:6px;">${icon("settings", 16)} 素材路径选择</span>`;
        html += '<span style="display:flex;align-items:center;gap:8px;">';
        if (d.deleted_files && d.deleted_files.length > 0) {
            html += `<button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();ScanPage.cleanup()" data-tip="源文件已不在原路径的记录，清理只删记录和缩略图，不动磁盘上的文件">${icon('trash-2', 13)} 清理失效记录</button>`;
        }
        html += `<span class="chevron-arrow${showSet ? ' expanded' : ''}" style="color:var(--text-tertiary);">${icon('chevron-down', 12)}</span>`;
        html += '</span>';
        html += '</div>';
        if (showSet) {
            html += '<div style="padding:12px 0;">';
            // 路径
            html += '<div style="margin-bottom:12px;">';
            html += '<div id="scan-roots-box"></div>';
            html += '</div>';
            // 动作
            html += '<div style="border-top:1px solid var(--border-light);margin:14px 0 12px;"></div>';
            html += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">';
            html += `<button class="btn btn-secondary" onclick="ScanPage.addRoot()">${icon('plus', 14)} 添加位置</button>`;
            html += `<button class="btn btn-primary" onclick="ScanPage.discover()">${icon('scan-line', 14)} 扫描</button>`;
            html += `<span class="help-icon" data-tip="每个位置都会递归扫子文件夹。应用不会复制你的 PPT，只存缩略图和文字；临时文件、隐藏目录、云盘占位文件自动跳过。" aria-label="扫描位置说明">${icon('circle-help', 14)}</span>`;
            html += '</div>';

            // 发现清单
            html += '<div id="scan-manifest" style="margin-top:12px;"></div>';
            html += '</div>';
        }
        html += '</div>';

        // ═══════════ ③ 自动分类（有页面才显示）═══════════
        const hasSlides = this.stats.total_slides > 0;
        if (hasSlides) {
            const pct = Math.round(this.stats.categorized_slides / Math.max(this.stats.visible_slides, 1) * 100);
            html += '<div class="card mb-4">';
            html += `<div class="card-header">${icon("tag", 16)} 自动分类</div>`;
            html += '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">';
            html += `已归类 <strong>${this.stats.categorized_slides}</strong> / ${this.stats.visible_slides} 页 (${pct}%)`;
            html += '</div>';
            html += '<div style="margin-bottom:14px;height:6px;background:var(--border);border-radius:3px;overflow:hidden;">';
            html += `<div style="width:${pct}%;height:100%;background:var(--accent);border-radius:3px;transition:width 0.3s ease;"></div>`;
            html += '</div>';
            html += '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">';
            html += `<button class="btn btn-secondary" onclick="ScanPage.reclassify()">${icon('refresh-cw', 14)} 重新分类现有 ${this.stats.total_slides} 页</button>`;
            html += '<span style="font-size:12px;color:var(--text-tertiary);">分类模式与阈值在【类别管理】里调整</span>';
            html += '</div>';
            html += '</div>';
        }

        // ═══════════ Processed files ═══════════
        if (d.processed_files && d.processed_files.length > 0) {
            html += '<div class="card">';
            html += `<div class="card-header" style="display:flex;justify-content:space-between;">`;
            html += `<span>${icon('circle-check', 14)} 已处理 (${d.processed_files.length})</span>`;
            html += `<span style="font-size:12px;font-weight:400;color:var(--text-tertiary);">${d.processed_files.reduce((s,f) => s+f.slides, 0)} 页</span>`;
            html += `</div>`;
            html += '<div style="max-height:260px;overflow-y:auto;">';
            for (const f of d.processed_files) {
                html += `<div style="padding:5px 0;font-size:13px;border-bottom:1px solid var(--border-light);display:flex;justify-content:space-between;">`;
                html += `<span>${f.processed ? icon('circle-check', 13) : icon('clock', 13)} ${escapeHtml(f.name)}</span>`;
                html += `<span style="color:var(--text-tertiary);font-size:12px;flex-shrink:0;margin-left:12px;">${f.slides}页</span>`;
                html += `</div>`;
            }
            html += '</div></div>';
        }

        setTimeout(() => this._afterRender(), 0);
        return html;
    },

    _afterRender() {
        this._renderRoots();
        this._renderManifest();
        // 回到本页时后端还在导：把浮层盖回去（页面不清空，下面照常可看）
        if (this._resumeOverlay) {
            this._resumeOverlay = false;
            this._showImportOverlay();
            if (!this.manifest) this.discover();
            this._startProgressPolling();
        }
    },

    // ═══════════ 导入进度浮层：盖在当前页上，不跳页、下层点不动 ═══════════

    _showImportOverlay() {
        if (document.getElementById('import-overlay')) return;
        const el = document.createElement('div');
        el.id = 'import-overlay';
        el.className = 'modal-overlay import-overlay';
        el.innerHTML = `
            <div class="modal-box" role="dialog" aria-modal="true" aria-label="正在导入" style="max-width:480px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="color:var(--accent);display:inline-flex;">${icon('upload', 17)}</span>
                    <span class="modal-title">正在导入</span>
                </div>
                <div style="text-align:center;margin-top:18px;">
                    <div id="scan-progress-big" style="font-size:52px;font-weight:700;color:var(--accent);line-height:1.15;">0%</div>
                    <div id="scan-progress-msg" style="font-size:12.5px;color:var(--text-secondary);margin-top:8px;min-height:18px;">准备中…</div>
                    <div id="scan-progress-file" style="font-size:12px;color:var(--text-tertiary);margin-top:3px;min-height:16px;"></div>
                </div>
                <div style="margin:16px 0 0;height:6px;background:var(--border);border-radius:3px;overflow:hidden;">
                    <div id="scan-progress-bar" style="width:0%;height:100%;background:var(--accent);border-radius:3px;transition:width .25s ease;"></div>
                </div>
                <div style="display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:18px;">
                    <button id="scan-cancel-btn" class="btn btn-sm btn-secondary" onclick="ScanPage.cancelScan()">${icon('x', 13)} 取消导入</button>
                </div>
            </div>`;
        document.body.appendChild(el);
        // 浮层铺满整个窗口，点哪儿都落在它身上；下层既点不到也滚不动
        document.body.style.overflow = 'hidden';
        const armEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); } };
        el.addEventListener('keydown', armEsc);
        this._escGuard = armEsc;
        document.addEventListener('keydown', armEsc, true);
    },

    _closeImportOverlay() {
        const el = document.getElementById('import-overlay');
        if (el) el.remove();
        document.body.style.overflow = '';
        if (this._escGuard) {
            document.removeEventListener('keydown', this._escGuard, true);
            this._escGuard = null;
        }
    },

    // 浮层收尾态：成功 / 中断 两种
    _renderImportDone({ cancelled, processed, slides, errors, note }) {
        const el = document.querySelector('#import-overlay .modal-box');
        if (!el) return;
        const title = cancelled ? '已停止导入' : '导入完成';
        const sub = cancelled
            ? (processed > 0 ? '' : '正在处理的那一份已经整份撤回，没有留下半截页。')
            : (errors && errors.length ? `${errors.length} 个文件出错，其余已导入。` : '');
        el.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;">
                <span style="color:${cancelled ? 'var(--text-tertiary)' : 'var(--accent)'};display:inline-flex;">${icon(cancelled ? 'circle-alert' : 'circle-check', 17)}</span>
                <span class="modal-title">${title}</span>
            </div>
            <div style="margin-top:16px;font-size:13px;color:var(--text-secondary);line-height:1.9;">
                <div>已导入 <strong style="font-size:15px;color:var(--text-primary);">${processed}</strong> 个文件，共 <strong style="font-size:15px;color:var(--text-primary);">${slides}</strong> 页</div>
                ${sub ? `<div style="color:var(--text-tertiary);font-size:12px;">${escapeHtml(sub)}</div>` : ''}
                ${note ? `<div style="color:var(--text-tertiary);font-size:12px;">${escapeHtml(note)}</div>` : ''}
                ${errors && errors.length ? `<div style="margin-top:6px;color:var(--danger);font-size:12px;max-height:96px;overflow-y:auto;">${errors.slice(0, 6).map(e => `${escapeHtml(e.file)}：${escapeHtml(e.error)}`).join('<br>')}</div>` : ''}
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:20px;">
                <button class="btn btn-primary" onclick="ScanPage.closeImportOverlay()">完成</button>
            </div>`;
    },

    closeImportOverlay() {
        this._closeImportOverlay();
        this._importResult = null;
        this._importError = null;
        this._cancelReq = false;
        // 清单原来是打开的就别关：用户刚看过刷新后的列表，收尾后应该还在
        if (this.manifest) { this._settingsTouched = true; this.showSettings = true; }
        App.navigate('scan');   // 停在同一页，只是把下面的清单和统计刷成最新
    },

    // ── 扫描位置（多根）──

    _roots() {
        if (!this.roots) {
            const src = (this.scanData && this.scanData.roots) || [];
            this.roots = src.map(r => ({ path: r.path, enabled: r.enabled !== false }));
            if (!this.roots.length) this.roots = [{ path: '', enabled: true }];
        }
        return this.roots;
    },

    _renderRoots() {
        const box = document.getElementById('scan-roots-box');
        if (!box) return;
        const roots = this._roots();
        let html = '<div style="display:flex;flex-direction:column;gap:6px;">';
        roots.forEach((r, i) => {
            html += '<div style="display:flex;align-items:center;gap:8px;">';
            html += `<input type="checkbox" ${r.enabled ? 'checked' : ''} data-root-enable="${i}" data-tip="取消勾选就不扫这个位置" style="flex:0 0 auto;">`;
            html += `<input type="text" class="form-input" data-root-path="${i}" value="${escapeHtml(r.path)}" placeholder="点击右侧【选择】按钮选择路径或复制路径" style="font-size:12px;flex:1 1 auto;min-width:0;">`;
            html += `<button class="btn btn-sm btn-secondary" onclick="ScanPage.pickRoot(${i})" style="flex:0 0 auto;">选择</button>`;
            html += roots.length > 1
                ? `<button class="btn btn-sm btn-ghost" onclick="ScanPage.removeRoot(${i})" data-tip="移除这个位置" aria-label="移除" style="flex:0 0 auto;">${icon('x', 13)}</button>`
                : '';
            html += '</div>';
        });
        html += '</div>';
        box.innerHTML = html;

        box.querySelectorAll('[data-root-path]').forEach(inp => {
            inp.addEventListener('input', () => {
                const i = parseInt(inp.dataset.rootPath);
                this._roots()[i].path = inp.value;
                this._markRootsDirty();
            });
        });
        box.querySelectorAll('[data-root-enable]').forEach(cb => {
            cb.addEventListener('change', () => {
                const i = parseInt(cb.dataset.rootEnable);
                this._roots()[i].enabled = cb.checked;
                this._markRootsDirty();
            });
        });
    },

    async pickRoot(i) {
        let dir = null;
        if (window.electronAPI && window.electronAPI.showOpenDirectory) {
            try {
                dir = await window.electronAPI.showOpenDirectory({ title: '选一个要扫描的文件夹' });
            } catch (e) {
                dir = null;   // 老版本壳子没有这个通道，退回手输
            }
        }
        if (!dir) {
            // 浏览器里没有原生对话框，退回手输
            const v = prompt('文件夹路径', this._roots()[i].path || '');
            if (v === null) return;
            dir = v.trim();
        }
        if (!dir) return;
        this._roots()[i].path = dir;
        this._roots()[i].enabled = true;
        this._renderRoots();
        this._markRootsDirty();
    },

    addRoot() {
        this._roots().push({ path: '', enabled: true });
        this._renderRoots();
        this._markRootsDirty();
    },

    removeRoot(i) {
        this._roots().splice(i, 1);
        this._renderRoots();
        this._markRootsDirty();
    },

    // ── 发现清单（先看清单再决定导什么）──

    async discover() {
        try {
            const data = await API.scanDiscover();
            this.manifest = data;
            this.selected = new Set(
                data.groups.flatMap(g => g.files)
                    .filter(f => ['new', 'changed', 'moved', 'moved_changed'].includes(f.status))
                    .map(f => f.path)
            );
            this.collapsedDirs = this.collapsedDirs || new Set();
            this._renderManifest();
        } catch (e) {
            Toast.error('扫描失败：' + e.message);
        }
    },

    // ── 文件名级去重（不影响内容去重那一套）──

    // 取「系列名」：剥掉尾部的版本号、短数字、分隔符、副本/定稿之类，四位年份不动
    _seriesBase(name) {
        let base = String(name || '').replace(/\.[^.]+$/, '').trim();
        const YEAR = /^(19[5-9]\d|20[0-3]\d)$/;
        for (let i = 0; i < 8; i++) {
            const before = base;
            base = base.replace(/[\s_\-—–~·]*[（(]\s*\d{1,4}\s*[)）]\s*$/, '');
            base = base.replace(/[\s_\-—–~·]*[vV]\s*\d{1,3}(?:\.\d+)?\s*$/, '');
            base = base.replace(/[\s_\-—–~·]*第\s*\d{1,3}\s*[版稿]\s*$/, '');
            base = base.replace(/[\s_\-—–~·]*(?:副本|最终版|最终|定稿|final|copy)\s*$/i, '');
            const m = base.match(/^(.*?)[\s_\-—–~·]*(\d{1,4})$/);
            if (m && !YEAR.test(m[2])) base = m[1];
            base = base.replace(/[\s_\-—–~·]+$/, '');
            if (base === before) break;
        }
        return base.trim();
    },

    _seriesKey(name) {
        return this._seriesBase(name).toLowerCase();
    },

    // 返回 [{kind:'same_name'|'series', keep:path, drop:[path], key}]
    _findDuplicates(only) {
        const groups = (this.manifest && this.manifest.groups) || [];
        const pool = [];
        const seen = new Set();
        for (const g of groups) {
            for (const f of (g.files || [])) {
                if (f.status === 'known') continue;
                // 同一绝对路径可能被父/子两个扫描位置各列一次：只算一份
                const key = (f.path || '').toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                pool.push(f);
            }
        }
        const out = [];
        const used = new Set();

        if (only !== 'series') {
            const byName = new Map();
            for (const f of pool) {
                const k = (f.name || '').toLowerCase();
                if (!byName.has(k)) byName.set(k, []);
                byName.get(k).push(f);
            }
            for (const arr of byName.values()) {
                if (arr.length < 2) continue;
                const dirs = new Set(arr.map(f => `${f.root}|${f.rel || ''}`));
                if (dirs.size < 2) continue;      // 同一个目录里不会出现同名，跳过保险
                const sorted = [...arr].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
                out.push({ kind: 'same_name', key: arr[0].name, keep: sorted[0].path, drop: sorted.slice(1).map(f => f.path) });
                sorted.forEach(f => used.add(f.path));
            }
        }

        if (only !== 'same_name') {
            const bySeries = new Map();
            for (const f of pool) {
                if (used.has(f.path)) continue;
                const k = this._seriesKey(f.name);
                if (!k || k.length < 2 || !/[\u4e00-\u9fff]/.test(k)) continue;
                if (!bySeries.has(k)) bySeries.set(k, []);
                bySeries.get(k).push(f);
            }
            for (const arr of bySeries.values()) {
                if (arr.length < 2) continue;
                const sorted = [...arr].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
                out.push({ kind: 'series', key: arr[0].name, keep: sorted[0].path, drop: sorted.slice(1).map(f => f.path) });
            }
        }
        return out;
    },

    async applyDedupe() {
        if (!this.manifest) {
            await this.discover();
            if (!this.manifest) return;
        }
        const dups = this._findDuplicates();
        if (!dups.length) { Toast.info('没有发现同名的或同系列的重复文件'); return; }
        let off = 0;
        for (const g of dups) {
            for (const p of g.drop) {
                if (this.selected && this.selected.has(p)) { this.selected.delete(p); off++; }
            }
        }
        this._renderManifest();
        Toast.success(`找到 ${dups.length} 组重复，已取消 ${off} 个旧版本的勾选`);
    },

    // 只更新按钮里的两个数字，不重渲染整个清单（勾选时不会跳）
    _syncSelectedCount() {
        const n = (this.selected || new Set()).size;
        const cnt = document.getElementById('scan-selected-count');
        if (cnt) cnt.textContent = n;
        const tm = document.getElementById('scan-est-time');
        if (tm) {
            const est = this.manifest && this.manifest.estimate;
            const perFile = (est && est.per_file) ? est.per_file : 6;
            tm.textContent = n > 0 ? this._fmtDur(perFile * n) : '—';
        }
        this._syncCheckStates();
    },

    // 表头全选框 + 目录勾选框的三态，跟着勾选数量走（不重渲染，勾的时候列表不跳）
    _syncCheckStates() {
        const box = document.getElementById('scan-manifest');
        if (!box || !this.manifest) return;
        const sel = this.selected || new Set();
        const all = (this.manifest.groups || []).flatMap(g => g.files).filter(f => f.status !== 'known');
        const setState = (cb, files) => {
            const on = files.filter(f => sel.has(f.path)).length;
            cb.checked = files.length > 0 && on === files.length;
            cb.indeterminate = on > 0 && on < files.length;
        };
        const sa = box.querySelector('#scan-check-all');
        if (sa) setState(sa, all);
        box.querySelectorAll('[data-dir-check]').forEach(cb => {
            setState(cb, this._filesUnderKey(decodeURIComponent(cb.dataset.dirCheck)));
        });
    },

    _fmtDur(sec) {
        const s = Math.max(1, Math.round(sec || 0));
        if (s < 60) return `${s} 秒`;
        const m = Math.round(s / 60);
        if (m < 60) return `${m} 分钟`;
        return `${(m / 60).toFixed(1)} 小时`;
    },

    _fmtBytes(n) {
        if (!n) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0, v = n;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
    },

    _statusText(status) {
        return ({ new: '新文件', changed: '改过，重扫', moved: '移动/改名', moved_changed: '移动且改过', known: '已入库' })[status] || status;
    },

    _renderManifest() {
        const box = document.getElementById('scan-manifest');
        if (!box) return;
        const m = this.manifest;
        if (!m) { box.innerHTML = ''; return; }

        const s = m.summary || {};
        const dupMap = new Map();
        for (const g of this._findDuplicates()) {
            dupMap.set(g.keep, { keep: true, kind: g.kind, n: g.drop.length + 1 });
            for (const p of g.drop) dupMap.set(p, { keep: false, kind: g.kind, n: g.drop.length + 1 });
        }
        this.viewMode = this.viewMode || 'name';   // 点扫描后默认「按文件名」
        this.collapsedDirs = this.collapsedDirs || new Set();
        const withDir = this.viewMode === 'name';
        const rowCls = withDir ? 'mf-row mf-row-name' : 'mf-row mf-row-dir';
        // 列宽：目录列可拖，记在 localStorage，文件名列吃剩余空间（最小 200px）
        if (this.colDirW == null) {
            let w = 170;
            try { const v = parseInt(localStorage.getItem('pptNest.dirColW'), 10); if (v >= 100 && v <= 480) w = v; } catch (e) {}
            this.colDirW = w;
        }
        document.documentElement.style.setProperty('--mf-dir-w', this.colDirW + 'px');

        const est = m.estimate || null;
        const perFileSec = (est && est.per_file) ? est.per_file : 6;   // 每个文件的平均耗时
        const selCount = (this.selected || new Set()).size;
        const estSec = perFileSec * selCount;                          // 跟着勾选数量走
        const estBasis = !est ? '按保守值估算'
            : (est.basis === 'machine'
                ? `按本机最近 ${est.samples} 次导入的实测速度，约 ${this._fmtDur(perFileSec)}/个`
                : (est.engine === 'placeholder'
                    ? '没检测到 LibreOffice，只写入库不渲染，所以很快'
                    : '本机还没有导入记录，先按保守值估算，导完一次就会变准'));


        const statusBadge = (st) => {
            const map = {
                new: ['新文件', 'badge-primary', '还没入过库'],
                changed: ['改过', 'badge-similar', '文件改过，需要重扫'],
                moved: ['移动', 'badge-llm', '只是换了位置或改名，内容没变，认领路径不重复入库'],
                moved_changed: ['移动+改', 'badge-llm', '换了位置且内容改过'],
                known: ['已入库', 'badge-muted', '已经在库里，不用再导']
            };
            const [txt, cls, tip] = map[st] || [st, 'badge-muted', ''];
            return `<span class="badge ${cls}" data-tip="${tip}">${txt}</span>`;
        };
        const dupBadge = (path) => {
            const d = dupMap.get(path);
            if (!d) return '';
            const kindTxt = d.kind === 'same_name' ? '同名' : '同系列';
            return d.keep
                ? `<span class="badge badge-success" data-tip="${kindTxt}共 ${d.n} 个，时间最新的这份">保留</span>`
                : `<span class="badge badge-warn" data-tip="${kindTxt}共 ${d.n} 个，这份不是最新的，默认不勾">旧版本</span>`;
        };

        let html = '<div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;">';
        html += `<div style="font-size:13px;margin-bottom:4px;">共 <strong>${s.pending || 0}</strong> 个待入库文件`;
        if (s.bytes) html += `（${this._fmtBytes(s.bytes)}）`;
        html += `，已入库 ${s.known || 0} 个</div>`;
        if (s.changed || s.moved) {
            html += '<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;">';
            if (s.changed) html += `改过需重扫 ${s.changed} 个`;
            if (s.changed && s.moved) html += ' ｜ ';
            if (s.moved) html += `移动认领 ${s.moved} 个（不重复入库）`;
            html += '</div>';
        }
        // ── 视图切换 ──
        const tabBtn = (mode, text) => {
            const on = this.viewMode === mode;
            return `<button data-view="${mode}" style="border:0;cursor:pointer;padding:5px 12px;font-size:12px;font-family:inherit;background:${on ? 'var(--accent)' : 'transparent'};color:${on ? '#fff' : 'var(--text-secondary)'};font-weight:${on ? '600' : '400'};">${text}</button>`;
        };
        html += '<div style="display:flex;align-items:center;gap:10px;margin:10px 0 8px;flex-wrap:wrap;">';
        html += '<div style="display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden;">';
        html += tabBtn('name', '按文件名');
        html += tabBtn('dir', '按路径');
        html += '</div>';
        html += '</div>';

        // ── 表头 ──
        html += '<div style="border:1px solid var(--border-light);border-radius:8px;overflow:hidden;">';
        html += '<div style="max-height:380px;overflow:auto;">';
        html += `<div class="${rowCls} mf-head" style="padding:6px 10px;background:#f8fafc;font-size:11.5px;color:var(--text-secondary);font-weight:600;">`;
        html += '<span style="position:relative;display:flex;align-items:center;gap:8px;min-width:0;">';
        html += `<input type="checkbox" id="scan-check-all" data-tip="全选 / 全不选（已入库的不会选中）" aria-label="全选" style="flex:0 0 auto;margin:0;">`;
        html += '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">文件名</span>';
        if (withDir) html += '<span class="mf-col-resize" data-col-resize="dir" data-tip="拖动调整文件名与所在目录的宽度"></span>';
        html += '</span>';
        if (withDir) html += '<span>所在目录</span>';
        html += '<span style="text-align:center;">大小</span><span style="text-align:center;">状态</span><span style="text-align:center;">去重</span>';
        html += '</div>';

        const relOf = (f) => (f.rel === '.' || !f.rel) ? '（根目录）' : f.rel;
        const fileRow = (f, indent) => {
            const disabled = f.status === 'known' ? 'disabled' : '';
            const checked = this.selected && this.selected.has(f.path) ? 'checked' : '';
            let h = `<div class="${rowCls}" style="padding:4px 10px;border-bottom:1px solid var(--border-light);">`;
            h += `<label style="display:flex;align-items:center;gap:8px;min-width:0;padding-left:${indent}px;">`;
            h += `<input type="checkbox" data-file="${encodeURIComponent(f.path)}" ${checked} ${disabled} style="flex:0 0 auto;">`;
            h += `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;${f.status === 'known' ? 'color:var(--text-tertiary);' : ''}">${escapeHtml(f.name)}</span>`;
            h += '</label>';
            if (withDir) h += `<span style="font-size:11px;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" data-tip="${escapeHtml(relOf(f))}">${escapeHtml(relOf(f))}</span>`;
            h += `<span style="text-align:center;font-size:11.5px;color:var(--text-tertiary);font-variant-numeric:tabular-nums;">${this._fmtBytes(f.bytes)}</span>`;
            h += `<span style="text-align:center;">${statusBadge(f.status)}</span>`;
            h += `<span style="text-align:center;">${dupBadge(f.path)}</span>`;
            h += '</div>';
            return h;
        };

        // ── 目录视图：逐级树，每一级都能折叠 ──
        if (!withDir) {
            const buildTree = (files) => {
                const root = { dirs: new Map(), files: [], name: '' };
                for (const f of files) {
                    const rel = (f.rel === '.' || !f.rel) ? '' : f.rel;
                    let node = root;
                    if (rel) {
                        for (const seg of rel.split('/')) {
                            if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [], name: seg });
                            node = node.dirs.get(seg);
                        }
                    }
                    node.files.push(f);
                }
                return root;
            };
            const collect = (node, out) => {
                out.push(...node.files);
                for (const c of node.dirs.values()) collect(c, out);
                return out;
            };
            const renderDir = (node, rootPath, prefix, depth) => {
                const key = rootPath + '|' + prefix;
                const all = collect(node, []);
                const selectable = all.filter(f => f.status !== 'known');
                const allOn = selectable.length > 0 && selectable.every(f => this.selected && this.selected.has(f.path));
                const collapsed = this.collapsedDirs.has(key);
                const label = depth === 0 ? rootPath : node.name;
                let h = `<div class="mf-row mf-row-dir" style="padding:5px 10px;border-bottom:1px solid var(--border-light);">`;
                h += `<div style="display:flex;align-items:center;gap:6px;min-width:0;padding-left:${depth * 14}px;">`;
                h += selectable.length
                    ? `<input type="checkbox" data-dir-check="${encodeURIComponent(key)}" ${allOn ? 'checked' : ''} data-tip="整个目录一起选" style="flex:0 0 auto;">`
                    : '<span style="width:13px;flex:0 0 auto;"></span>';
                h += `<div style="display:flex;align-items:center;gap:5px;min-width:0;flex:1 1 auto;cursor:pointer;user-select:none;" data-dir-toggle="${encodeURIComponent(key)}">`;
                h += `<span class="chevron-arrow${collapsed ? '' : ' expanded'}" style="color:var(--text-tertiary);display:inline-flex;flex:0 0 auto;">${icon('chevron-down', 11)}</span>`;
                h += `<span style="color:var(--accent);display:inline-flex;flex:0 0 auto;">${icon(depth === 0 ? 'folder-open' : 'folder', 13)}</span>`;
                h += `<span style="font-size:12.5px;${depth === 0 ? 'font-weight:600;' : ''}color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(label)}</span>`;
                h += `<span style="font-size:11px;color:var(--text-tertiary);flex:0 0 auto;">· ${all.length}</span>`;
                h += '</div></div>';
                if (withDir) h += '<span></span>';
                h += '<span></span><span></span><span></span>';
                h += '</div>';
                if (collapsed) return h;
                for (const f of node.files) h += fileRow(f, depth * 14 + 19);
                for (const child of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
                    h += renderDir(child, rootPath, prefix ? prefix + '/' + child.name : child.name, depth + 1);
                }
                return h;
            };

            for (const g of m.groups) {
                if (!g.exists) {
                    html += `<div style="padding:8px 10px;font-size:12.5px;color:var(--danger);">${icon('circle-alert', 13)} ${escapeHtml(g.root)} 打不开（路径不存在或无权限）</div>`;
                    continue;
                }
                html += renderDir(buildTree(g.files), g.root, '', 0);
            }
        } else {
            // ── 按文件名：名字相同/相近的相邻排列，所有行同一格式 ──
            const rows = [];
            for (const g of m.groups) {
                if (!g.exists) continue;
                for (const f of g.files) rows.push({ f, k: this._seriesKey(f.name) || (f.name || '').toLowerCase() });
            }
            rows.sort((a, b) => a.k === b.k
                ? ((b.f.mtime || 0) - (a.f.mtime || 0))
                : a.k.localeCompare(b.k, 'zh'));
            for (const it of rows) html += fileRow(it.f, 0);
        }
        html += '</div></div>';

        html += '<div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap;">';
        html += `<button class="btn btn-primary" onclick="ScanPage.applyDedupe()">${icon('file-stack', 14)} 去重</button>`;
        html += `<span class="help-icon" data-tip="只勾选修改时间最近的同名版本；同系列文件（V1/V2、日期、版本尾巴）也同样只留最近的那份。" aria-label="去重规则" style="margin-right:2px;">${icon('circle-help', 14)}</span>`;
        html += `<button class="btn btn-primary" style="font-weight:400;" onclick="ScanPage.processSelected()">导入选中的 <strong id="scan-selected-count" style="font-weight:700;">${selCount}</strong> 个，预计用时 <strong id="scan-est-time" style="font-weight:700;" data-tip="${escapeHtml(estBasis)}">${selCount > 0 ? this._fmtDur(estSec) : '—'}</strong></button>`;
        html += '</div></div>';
        box.innerHTML = html;

        // 表头全选框：全选（跳过已入库的）/ 全不选，三态跟着勾选数量走
        const selAll = box.querySelector('#scan-check-all');
        if (selAll) {
            const selectable = m.groups.flatMap(g => g.files).filter(f => f.status !== 'known');
            const n = selectable.filter(f => this.selected && this.selected.has(f.path)).length;
            selAll.checked = selectable.length > 0 && n === selectable.length;
            selAll.indeterminate = n > 0 && n < selectable.length;
            selAll.disabled = selectable.length === 0;
            selAll.addEventListener('change', () => this.toggleAll(selAll.checked));
        }

        box.querySelectorAll('[data-view]').forEach(b => {
            b.addEventListener('click', () => { this.viewMode = b.dataset.view; this._renderManifest(); });
        });
        box.querySelectorAll('[data-col-resize]').forEach(h => {
            h.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const startX = ev.clientX;
                const startDir = this.colDirW;
                // 用实际行宽算可用空间，别估（行有左右 10px padding）
                const rowEl = box.querySelector('.mf-row-name');
                const contentW = rowEl ? Math.max(300, rowEl.clientWidth - 20) : 700;
                const FIXED = 60 + 76 + 56;   // 大小 / 状态 / 去重
                const GAP = 10;
                const move = (e2) => {
                    const dx = e2.clientX - startX;
                    // 边界向右拖 → 所在目录变窄、文件名变宽，跟手
                    const maxW = Math.max(100, contentW - 200 - FIXED - 4 * GAP);
                    this.colDirW = Math.round(Math.min(maxW, Math.max(100, startDir - dx)));
                    document.documentElement.style.setProperty('--mf-dir-w', this.colDirW + 'px');
                };
                const up = () => {
                    document.removeEventListener('mousemove', move);
                    document.removeEventListener('mouseup', up);
                    document.body.style.userSelect = '';
                    try { localStorage.setItem('pptNest.dirColW', String(this.colDirW)); } catch (e) {}
                };
                document.body.style.userSelect = 'none';
                document.addEventListener('mousemove', move);
                document.addEventListener('mouseup', up);
            });
        });

        box.querySelectorAll('[data-file]').forEach(cb => {
            cb.addEventListener('change', () => {
                const path = decodeURIComponent(cb.dataset.file);
                if (cb.checked) this.selected.add(path); else this.selected.delete(path);
                this._syncSelectedCount();
            });
        });
        box.querySelectorAll('[data-dir-toggle]').forEach(el => {
            el.addEventListener('click', () => {
                const key = decodeURIComponent(el.dataset.dirToggle);
                if (this.collapsedDirs.has(key)) this.collapsedDirs.delete(key);
                else this.collapsedDirs.add(key);
                this._renderManifest();
            });
        });
        box.querySelectorAll('[data-dir-check]').forEach(cb => {
            cb.addEventListener('change', () => {
                const files = this._filesUnderKey(decodeURIComponent(cb.dataset.dirCheck));
                files.forEach(f => { if (cb.checked) this.selected.add(f.path); else this.selected.delete(f.path); });
                this._renderManifest();
            });
        });
    },

    // 某个目录 key（root|相对路径）下所有文件，含子目录
    _filesUnderKey(key) {
        const idx = key.indexOf('|');
        const root = key.slice(0, idx);
        const rel = key.slice(idx + 1);
        const g = ((this.manifest && this.manifest.groups) || []).find(x => x.root === root);
        if (!g) return [];
        return (g.files || []).filter(f => {
            const r = (f.rel === '.' || !f.rel) ? '' : f.rel;
            if (f.status === 'known') return false;
            return rel === '' ? true : (r === rel || r.startsWith(rel + '/'));
        });
    },

    toggleAll(on) {
        if (!this.manifest) return;
        this.selected = on
            ? new Set(this.manifest.groups.flatMap(g => g.files)
                .filter(f => f.status !== 'known').map(f => f.path))
            : new Set();
        this._renderManifest();
    },

    async processSelected() {
        const paths = [...(this.selected || [])];
        if (!paths.length) { Toast.error('没有勾选任何文件'); return; }
        await this._runProcess(paths);
    },

    // ── 入库位置：改动即自动保存，不再需要手动点保存 ──

    _markRootsDirty() {
        clearTimeout(this._rootsSaveTimer);
        this._rootsSaveTimer = setTimeout(() => this._autosaveRoots(), 700);
    },

    async _autosaveRoots() {
        const roots = this._roots()
            .map(r => ({ path: (r.path || '').trim(), enabled: r.enabled !== false }))
            .filter(r => r.path);
        if (!roots.length) return;
        try {
            await API.updateScanRoots(roots);
            // 静默刷新统计数据，不重渲染页面（避免打断正在输入路径）
            this.scanData = await API.scanCheck();
            this.stats = await API.getStats();
        } catch (e) {
            Toast.error('保存位置失败：' + e.message);
        }
    },

    toggleSettings() {
        const emptyLib = !this.stats || (this.stats.total_files || 0) === 0;
        const cur = this._settingsTouched ? this.showSettings : emptyLib;
        this._settingsTouched = true;
        this.showSettings = !cur;
        App.navigate('scan');
    },

    toggleMore(e) {
        if (e) e.stopPropagation();
        const menu = document.getElementById('scan-more-menu');
        if (!menu) return;
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        if (!this._moreBound) {
            this._moreBound = true;
            document.addEventListener('click', () => {
                const m = document.getElementById('scan-more-menu');
                if (m) m.style.display = 'none';
            });
        }
    },

    refreshList() {
        const m = document.getElementById('scan-more-menu');
        if (m) m.style.display = 'none';
        this.scan();
    },


    // ── Progress ──

    _startProgressPolling() {
        if (this._progressTimer) return;
        this._progressTimer = setInterval(async () => {
            try {
                const p = await API.scanProgress();
                this._updateProgressUI(p);
                if (p.running) this._sawRunning = true;
                // Guard against a STALE done:true from the previous scan:
                // only accept completion if we've seen this scan actually run.
                const ended = (p.done || !p.running);
                if (ended && this._sawRunning) {
                    this._stopProgressPolling();
                    if (this.processing) setTimeout(() => this._finishImport(), 200);
                } else if (ended) {
                    // Fallback: scan finished between two polls (never saw
                    // running:true). Require 3 consecutive done reads (~1.2s)
                    // to rule out the stale-progress race.
                    this._doneStreak = (this._doneStreak || 0) + 1;
                    if (this._doneStreak >= 3) {
                        this._stopProgressPolling();
                        if (this.processing) setTimeout(() => this._finishImport(), 200);
                    }
                } else {
                    this._doneStreak = 0;
                }
            } catch (e) { /* ignore */ }
        }, 400);
    },

    _stopProgressPolling() {
        if (this._progressTimer) {
            clearInterval(this._progressTimer);
            this._progressTimer = null;
        }
    },

    _updateProgressUI(p) {
        const big = document.getElementById('scan-progress-big');
        const msg = document.getElementById('scan-progress-msg');
        const fileEl = document.getElementById('scan-progress-file');
        const bar = document.getElementById('scan-progress-bar');

        const filesTotal = Math.max(p.total || 1, 1);
        const filesCur = Math.min(p.current || 0, filesTotal);
        const pDone = p.pages_done || 0;
        const pCur = p.page_current || 0;
        const pCurTotal = p.page_current_total || 0;
        const pagesSeen = pDone + pCur;

        // 页数口径：所有文件的页数都已知时按页走（文件内部也在动，比按文件精确）；
        // 有 .ppt 这类还没解析出页数的，退回按文件走，但处理了多少页照常显示
        const known = (p.pages_total || 0) > 0 && !(p.pages_unknown > 0);
        const done = known ? Math.min(pagesSeen, p.pages_total) : filesCur;
        const all = known ? p.pages_total : filesTotal;

        const pct = Math.min(Math.round(done / Math.max(all, 1) * 100), 100);
        if (big) big.textContent = `${pct}%`;
        if (bar) bar.style.width = `${pct}%`;

        if (msg) {
            if (known) msg.textContent = `${pagesSeen} / ${all} 页 · 第 ${filesCur}/${filesTotal} 个文件`;
            else if (pagesSeen > 0) msg.textContent = `第 ${filesCur}/${filesTotal} 个文件 · 已处理 ${pagesSeen} 页`;
            else msg.textContent = `第 ${filesCur}/${filesTotal} 个文件`;
        }

        if (fileEl) {
            const parts = [];
            if (p.current_file) {
                parts.push(pCurTotal
                    ? `${p.current_file} · 缩略图 ${pCur}/${pCurTotal} 页`
                    : p.current_file);
            }
            if (p.elapsed > 0) {
                let tail = `已用 ${this._fmtDur(p.elapsed)}`;
                let eta = 0;
                if (known && done > 0 && done < all) eta = (p.elapsed / done) * (all - done);
                else if (!known && filesCur > 0 && filesCur < filesTotal) eta = (p.elapsed / filesCur) * (filesTotal - filesCur);
                if (eta >= 1) tail += `，剩余约 ${this._fmtDur(eta)}`;
                parts.push(tail);
            }
            fileEl.textContent = parts.join('　');
        }
    },

    // ── Actions ──

    async reclassify() {
        this.reclassifying = true;
        // Inject progress card directly — no page jump
        const container = document.getElementById('page-container');
        if (container) {
            container.innerHTML = `
                <div class="page-header"><h1 class="page-title">素材入库</h1></div>
                <div id="scan-progress-card" class="card" style="text-align:center;padding:40px 20px;">
                    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">${icon("clock", 14)} 正在重新分类…</div>
                    <div id="scan-progress-big" style="font-size:56px;font-weight:700;color:var(--accent);line-height:1.2;">0%</div>
                    <div id="scan-progress-msg" style="font-size:13px;color:var(--text-tertiary);margin-top:8px;">准备中...</div>
                </div>`;
        }
        this._startReclassifyPolling();

        try {
            const result = await API.reclassifyAll();
            this._stopReclassifyPolling();
            Toast.success(`已重新分类 ${result.reclassified} 页`);
        } catch (e) {
            this._stopReclassifyPolling();
            Toast.error(`分类失败：${e.message}`);
        }
        this.reclassifying = false;
        App.navigate('scan');
    },

    _startReclassifyPolling() {
        if (this._rcTimer) return;
        this._rcTimer = setInterval(async () => {
            try {
                const p = await API.reclassifyProgress();
                const big = document.getElementById('scan-progress-big');
                const msg = document.getElementById('scan-progress-msg');
                if (big && p.running) {
                    const pct = Math.min(Math.round((p.current / Math.max(p.total, 1)) * 100), 100);
                    big.textContent = `${pct}%`;
                }
                if (msg) {
                    msg.textContent = `${p.current} / ${p.total} 页`;
                }
            } catch(e) {}
        }, 300);
    },

    _stopReclassifyPolling() {
        if (this._rcTimer) { clearInterval(this._rcTimer); this._rcTimer = null; }
    },

    async scan() {
        this.showFileList = false;
        this.roots = null;   // 跟着后端配置刷新
        this.scanData = await API.scanCheck();
        App.navigate('scan');
    },


    // paths=null 表示处理全部待处理；否则只处理勾选的
    async _runProcess(paths) {
        if (this.processing) return;
        if (!paths && (!this.scanData || !(this.scanData.new_files || []).length)) {
            Toast.error('没有新文件需要处理');
            return;
        }
        this.processing = true;
        this._sawRunning = false;  // reset: ignore stale done:true from last scan
        this._cancelReq = false;
        this._importResult = null;
        this._importError = null;
        this._finishing = false;
        this._doneStreak = 0;
        // 不跳页：进度浮层盖在当前页上，下层点不动
        this._showImportOverlay();
        this._startProgressPolling();
        try {
            this._importResult = await API.scanProcess(paths);
        } catch (e) {
            // 请求超时/断连，但后端可能还在跑 —— 交给轮询等它自己结束
            this._importError = e.message || '连接中断';
        }
        if (this._importResult) await this._finishImport();
        // 没拿到结果时，轮询在 p.done 处收尾
    },

    // 导入收尾：浮层切成结果态，下面那页静默刷成最新（不跳页）
    async _finishImport() {
        if (!this.processing || this._finishing) return;
        this._finishing = true;
        this._stopProgressPolling();

        const r = this._importResult;
        const cancelled = !!(r && r.cancelled) || !!this._cancelReq;
        const processed = r ? (r.processed || 0) : 0;
        const slides = r ? (r.total_slides || 0) : 0;
        const errors = (r && r.errors) || [];
        let note = '';
        if (!r) {
            note = `后端已结束，但没拿到结果（${this._importError || '连接中断'}），下面的清单会刷新成最新状态。`;
        } else if (r.moved && !processed) {
            note = `只更新了 ${r.moved} 个移动/改名的文件路径，内容没变。`;
        }
        this._renderImportDone({ cancelled, processed, slides, errors, note });

        this.processing = false;
        try {
            this.selected = null;
            this.manifest = null;
            this.scanData = await API.scanCheck();
            this.stats = await API.getStats();
            if (document.getElementById('scan-manifest')) await this.discover();
        } catch (e) { /* 刷新失败不影响收尾 */ }
        this._finishing = false;
    },

    async cleanup() {
        const list = (this.scanData && this.scanData.deleted_files) || [];
        if (!list.length) { Toast.info('没有失效记录'); return; }
        const preview = list.slice(0, 8).map(f => `<li style="margin:2px 0;">${escapeHtml(f.name)}</li>`).join('');
        const more = list.length > 8 ? `<li style="margin:2px 0;color:var(--text-tertiary);">…还有 ${list.length - 8} 个</li>` : '';
        Modal.show(`${icon('trash-2', 18)} 清理失效记录`,
            `<p style="font-size:13px;line-height:1.8;">这 ${list.length} 份文件的源 PPT 已经不在原路径了。清理只会删掉素材库里的记录和缩略图，<strong>不会动磁盘上的任何文件</strong>。</p>
             <ul style="font-size:12.5px;color:var(--text-secondary);padding-left:18px;max-height:200px;overflow-y:auto;">${preview}${more}</ul>
             <p style="font-size:12px;color:var(--text-tertiary);">如果只是把文件挪了位置，先点【检查新增】——应用会认领移动的文件，不用清理。</p>`,
            [{ key: 'cancel', label: '取消' },
             { key: 'ok', label: `清理 ${list.length} 条`, primary: true, onClick: async () => {
                 try {
                     const r = await API.scanCleanup(list.map(f => f.path));
                     Toast.success(`已清理 ${r.cleaned} 条记录`);
                     await this.scan();
                 } catch (e) {
                     Toast.error(`清理失败：${e.message}`);
                 }
             } }]);
    },

    async cancelScan() {
        if (this._cancelReq) return;
        this._cancelReq = true;
        const btn = document.getElementById('scan-cancel-btn');
        if (btn) {
            btn.disabled = true;
            btn.style.opacity = '0.55';
            btn.style.cursor = 'default';
            btn.textContent = '正在停止…';
        }
        try {
            await API.scanCancel();
        } catch (e) {
            this._cancelReq = false;
            if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; btn.textContent = '取消导入'; }
            Toast.error(`取消失败：${e.message}`);
        }
    },
};
