/**
 * Dedup Page - 重复检测与整理
 */
const DedupPage = {
    currentPage: 1,
    pageSize: 10,
    groups: null,
    hiddenSlides: [],
    _running: false,
    _progressTimer: null,
    _threshold: 0.85,
    showSettings: false,

    async render() {
        // Load settings for threshold
        try {
            const s = await API.getSettings();
            this._threshold = s.dedup_threshold || 0.85;
        } catch (e) {}

        // Recovery: if a dedup is already in flight (user navigated away and
        // back), resume the progress UI.
        if (!this._running) {
            try {
                const p = await API.dedupProgress();
                if (p.running && !p.done) {
                    this._running = true;
                    this._sawRunning = true;
                    this._startProgressPolling();
                }
            } catch (e) { /* ignore */ }
        }

        let html = '<div class="page-header">';
        html += '<div style="display:flex;align-items:center;gap:8px;">';
        html += '<h1 class="page-title">重复检测与整理</h1>';
        html += '<span style="cursor:pointer;font-size:13px;color:var(--accent);" onclick="DedupPage._showHelp()" title="这是什么？">ℹ️</span>';
        html += '</div>';
        html += '</div>';

        // Dedup settings card (collapsible)
        const showSet = this.showSettings;
        html += '<div class="card mb-4">';
        html += `<div class="card-header" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;" onclick="DedupPage.showSettings=!DedupPage.showSettings;App.navigate('dedup');">`;
        html += '<span>🔍 去重设置</span>';
        html += `<span class="chevron-arrow${showSet ? ' expanded' : ''}" style="color:var(--text-tertiary);"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>`;
        html += '</div>';
        if (showSet) {
            html += '<div style="padding:12px 0;">';
            html += `<div class="form-group"><label class="form-label">相似度阈值：<span id="dedup-thr-val" style="font-weight:600;">${this._threshold}</span></label>`;
            html += `<input type="range" min="0.5" max="1.0" step="0.05" value="${this._threshold}" id="dedup-threshold-slider" style="width:100%;"></div>`;
            html += '<button class="btn btn-primary btn-sm" onclick="DedupPage.saveDedup()">💾 保存阈值</button>';
            html += '</div>';
        }
        html += '</div>';

        // Action buttons
        html += '<div class="btn-row mb-4" style="align-items:center;">';
        html += `<button class="btn btn-primary" id="btn-dedup-full" onclick="DedupPage.runDedup(false)" ${this._running ? 'disabled' : ''}>${this._running ? '⏳ 全量检测中...' : '🔍 全量重新检测'}</button>`;
        html += `<button class="btn btn-secondary" id="btn-dedup-incr" onclick="DedupPage.runDedup(true)" ${this._running ? 'disabled' : ''}>${this._running ? '⏳ 检测新增页面中...' : '⚡ 仅检测新增页面'}</button>`;
        html += '<span style="cursor:pointer;font-size:13px;color:var(--accent);" onclick="DedupPage._showRunHelp()" title="检测逻辑">ℹ️</span>';
        html += `<span style='font-size:13px;color:var(--text-secondary);' id='dedup-progress-text'></span>`;
        html += '</div>';

        // ── Running: show progress card, skip everything else ──
        if (this._running) {
            html += '<div id="dedup-progress-card" class="card" style="text-align:center;padding:40px 20px;">';
            html += '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">⏳ 重复检测进行中</div>';
            html += '<div id="dedup-progress-big" style="font-size:56px;font-weight:700;color:var(--accent);line-height:1.2;">0%</div>';
            html += '<div id="dedup-progress-msg" style="font-size:13px;color:var(--text-tertiary);margin-top:8px;">准备中...</div>';
            html += '</div>';

            // Bind slider live update
            setTimeout(() => {
                const slider = document.getElementById('dedup-threshold-slider');
                if (slider) slider.addEventListener('input', () => {
                    const val = document.getElementById('dedup-thr-val');
                    if (val) val.textContent = slider.value;
                });
            }, 0);

            return html;
        }

        // ── Normal: load groups ──
        try {
            const result = await API.dedupGroups(this.currentPage, this.pageSize);
            this.groups = result;
        } catch (e) {
            html += `<div class="alert alert-danger">加载失败：${escapeHtml(e.message)}</div>`;
            return html;
        }

        if (!this.groups || this.groups.total === 0) {
            html += '<div class="alert alert-info">没有检测到重复页面。点击上方按钮开始检测。</div>';
        } else {
            html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">';
            html += `<span style="font-size:14px;color:var(--text-secondary);">发现 ${this.groups.total} 组重复</span>`;
            html += '<button class="btn btn-sm btn-secondary" onclick="DedupPage.hideAll()">隐藏所有非主版本</button>';
            html += '</div>';

            for (const g of this.groups.groups) {
                const label = g.group_type === 'exact' ? '完全重复' : '高度相似';
                const badgeCls = g.group_type === 'exact' ? 'badge-exact' : 'badge-similar';

                html += '<div class="expander">';
                html += `<div class="expander-header" onclick="this.parentElement.classList.toggle('open')">`;
                html += `<span>📋 <span class="badge ${badgeCls}">${label}</span> · ${g.members.length} 页</span>`;
                html += '<span class="chevron-arrow" style="color:var(--text-tertiary);"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>';
                html += '</div>';
                html += '<div class="expander-body">';
                html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;">';

                for (const m of g.members) {
                    const isPrimary = m.is_primary;
                    html += '<div style="text-align:center;">';
                    if (m.thumbnail_url) {
                        html += `<img src="${API.baseUrl}${m.thumbnail_url}" style="width:100%;aspect-ratio:16/9;object-fit:contain;background:#f0f0f0;border-radius:6px;${isPrimary ? 'box-shadow:0 0 0 2px var(--accent);' : ''}">`;
                    }
                    html += `<div style="font-size:12px;font-weight:600;margin-top:4px;">${escapeHtml(m.title || `第${m.slide_number}页`)}${isPrimary ? ' ⭐' : ''}</div>`;
                    html += `<div style="font-size:11px;color:var(--text-tertiary);">${escapeHtml(m.file_name)} · 第${m.slide_number}页</div>`;
                    html += '<div style="display:flex;gap:4px;justify-content:center;margin-top:4px;flex-wrap:wrap;">';
                    if (!isPrimary) {
                        html += `<button class="btn btn-sm btn-ghost" onclick="DedupPage.setPrimary(${g.id},${m.slide_id})">⭐ 设为主版本</button>`;
                        html += `<button class="btn btn-sm btn-ghost" style="color:var(--danger);" onclick="DedupPage.removeMember(${m.id})">🗑️ 移除</button>`;
                    }
                    html += '</div>';
                    html += '</div>';
                }

                html += '</div></div></div>';
            }

            html += '<div id="dedup-paginator"></div>';
        }

        // Hidden slides section
        html += '<hr class="section-divider">';
        html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">';
        html += '<h2 style="font-size:16px;font-weight:600;">已隐藏的重复副本</h2>';
        html += '</div>';

        try {
            this.hiddenSlides = await API.dedupHidden();
        } catch (e) {}

        if (!this.hiddenSlides || this.hiddenSlides.length === 0) {
            html += '<div class="alert alert-info">暂无已隐藏副本</div>';
        } else {
            html += '<div style="margin-bottom:8px;display:flex;align-items:center;gap:12px;">';
            html += `<span style="font-size:12px;color:var(--text-tertiary);">共 ${this.hiddenSlides.length} 个</span>`;
            html += '<button class="btn btn-sm btn-primary" onclick="DedupPage.unhideAll()">↩ 一键恢复显示</button>';
            html += '</div>';
            html += '<div style="max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius);">';
            for (const hs of this.hiddenSlides) {
                html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;border-bottom:1px solid var(--border-light);">';
                html += `<span style="font-size:13px;">${escapeHtml(hs.file_name || '')} · 第${hs.slide_number}页</span>`;
                html += `<button class="btn btn-sm btn-ghost" onclick="DedupPage.unhide(${hs.id})">↩ 恢复显示</button>`;
                html += '</div>';
            }
            html += '</div>';
        }

        // Paginator + slider binding
        setTimeout(() => {
            const slider = document.getElementById('dedup-threshold-slider');
            if (slider) slider.addEventListener('input', () => {
                const val = document.getElementById('dedup-thr-val');
                if (val) val.textContent = slider.value;
            });
            if (this.groups && this.groups.total > this.pageSize) {
                const pc = document.getElementById('dedup-paginator');
                if (pc) {
                    pc.innerHTML = Paginator.render(
                        this.groups.total, this.pageSize, this.currentPage,
                        (p) => { this.currentPage = p; App.navigate('dedup'); }
                    );
                }
            }
        }, 0);

        return html;
    },

    // ── Help modals ──

    _showHelp() {
        const content = `<div style="line-height:1.8;">
            <p><strong>重复检测与整理</strong> 用于找出素材库中内容重复或高度相似的幻灯片页面，避免冗余。</p>
            <p>📋 <strong>完全重复</strong>：内容哈希值完全一致（同一页被多次扫描或跨文件复制）。</p>
            <p>🔍 <strong>高度相似</strong>：文本相似度 ≥ 阈值（默认 85%），视为同一内容的变体。</p>
            <p>⭐ <strong>主版本</strong>：每组保留一个主版本（按文件名+页码排序优先），其余自动隐藏（不在分类浏览中显示）。</p>
            <p>💡 隐藏的副本可在下方「已隐藏的重复副本」区域恢复显示。</p>
        </div>`;
        Modal.show('❗ 什么是重复检测？', content, [{ label: '知道了', key: 'ok', primary: true }]);
    },

    _showRunHelp() {
        const content = `<div style="line-height:1.8;">
            <p><strong>🔍 检测并自动整理</strong>：清空旧结果，对全部页面重新检测完全重复 + 高度相似，自动隐藏非主版本。</p>
            <p><strong>⚡ 增量检测</strong>：只检测新增页面（不在已有重复组中的），保留已整理的结果不动。适合扫描新文件后快速去重。</p>
        </div>`;
        Modal.show('❗ 检测模式说明', content, [{ label: '知道了', key: 'ok', primary: true }]);
    },

    // ── Actions ──

    async runDedup(incremental) {
        if (this._running) return;

        // Incremental: check for new slides first
        if (incremental) {
            try {
                const { count } = await API.dedupPendingCount();
                if (count === 0) {
                    Toast.info('没有新增页面，无需检测');
                    return;
                }
            } catch (e) {
                // Endpoint may not exist (old backend) — fall through, let backend decide
                console.warn('dedupPendingCount failed, proceeding anyway:', e.message);
            }
        }

        this._running = true;
        this._sawRunning = false;  // ignore stale done:true from previous run

        // Re-render to show progress card (render() checks _running)
        await App.navigate('dedup');
        this._startProgressPolling();

        try {
            // Subprocess mode: API returns immediately, completion handled in polling
            await API.dedupRun(incremental);
        } catch (e) {
            this._stopProgressPolling();
            this._running = false;
            Toast.error(`启动失败：${e.message}`);
            App.navigate('dedup');
        }
    },

    _startProgressPolling() {
        this._stopProgressPolling();
        this._progressTimer = setInterval(async () => {
            try {
                const p = await API.dedupProgress();
                const pct = Math.min(100, Math.round((p.current / Math.max(p.total, 1)) * 100));

                // Small text in button row
                const el = document.getElementById('dedup-progress-text');
                if (el) {
                    el.textContent = `${pct}%`;
                    if (p.message) el.textContent += ` · ${p.message}`;
                }

                // Big progress card
                const big = document.getElementById('dedup-progress-big');
                if (big) big.textContent = `${pct}%`;
                const msg = document.getElementById('dedup-progress-msg');
                if (msg && p.message) msg.textContent = p.message;

                if (p.running) {
                    this._sawRunning = true;
                    this._doneStreak = 0;
                }

                // Completion: toast + re-render with results.
                // Guard: a stale progress file from the previous run says
                // done:true — only accept completion once we've seen this run
                // actually start (or 3 consecutive done reads as fallback).
                const finished = p.done && !p.running;
                if (finished && this._sawRunning) {
                    this._handleDedupFinished(p);
                } else if (finished) {
                    this._doneStreak = (this._doneStreak || 0) + 1;
                    if (this._doneStreak >= 3) this._handleDedupFinished(p);
                }
            } catch (e) {}
        }, 500);
    },

    _handleDedupFinished(p) {
        this._stopProgressPolling();
        this._running = false;
        this.currentPage = 1;
        if (p.error) {
            Toast.error(`检测失败：${p.error}`);
        } else {
            const exact = p.exact_groups || 0;
            const similar = p.similar_groups || 0;
            if (exact === 0 && similar === 0) {
                Toast.info('没有发现重复页面');
            } else {
                Toast.success(`完成：${exact} 组完全重复，${similar} 组高度相似`);
            }
        }
        if (App.currentPage === 'dedup') {
            App.navigate('dedup');
        }
    },

    _stopProgressPolling() {
        if (this._progressTimer) { clearInterval(this._progressTimer); this._progressTimer = null; }
        const el = document.getElementById('dedup-progress-text');
        if (el) el.style.display = 'none';
    },

    async hideAll() {
        const result = await API.dedupHideAll();
        Toast.success(`已隐藏 ${result.hidden} 个非主版本`);
        App.navigate('dedup');
    },

    async saveDedup() {
        const slider = document.getElementById('dedup-threshold-slider');
        const thr = slider ? parseFloat(slider.value) : 0.85;
        await API.updateSettings({ dedup_threshold: thr });
        this._threshold = thr;
        Toast.success(`相似度阈值已保存为 ${thr}`);
    },

    async unhideAll() {
        Modal.confirm('一键恢复显示', '确定要恢复所有已隐藏的重复副本吗？这些页面将重新出现在分类浏览中。', async () => {
            const result = await API.dedupUnhideAll();
            Toast.success(`已恢复 ${result.unhidden} 个副本`);
            App.navigate('dedup');
        });
    },

    async setPrimary(groupId, slideId) {
        await API.dedupSetPrimary(groupId, slideId);
        App.navigate('dedup');
    },

    async removeMember(memberId) {
        Modal.confirm('确认移除', '确定要移除此副本吗？源文件不会改变。', async () => {
            await API.dedupRemoveMember(memberId);
            Toast.success('已移除副本');
            App.navigate('dedup');
        });
    },

    async unhide(slideId) {
        await API.dedupUnhide(slideId);
        Toast.success('已恢复显示');
        App.navigate('dedup');
    },
};
