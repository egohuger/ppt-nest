/**
 * Scan Page - 扫描处理 + 设置
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
        html += '<h1 class="page-title">扫描处理</h1>';
        html += '</div>';

        // ═══════════ Processing: live progress (dedup-style) ═══════════
        if (this.processing || this.reclassifying) {
            this._startProgressPolling();
            html += '<div id="scan-progress-card" class="card" style="text-align:center;padding:40px 20px;">';
            html += '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">⏳ 正在处理 PPT 文件…</div>';
            html += '<div id="scan-progress-big" style="font-size:56px;font-weight:700;color:var(--accent);line-height:1.2;">0%</div>';
            html += '<div id="scan-progress-msg" style="font-size:13px;color:var(--text-tertiary);margin-top:8px;">准备中...</div>';
            html += '<button class="btn btn-sm btn-danger" style="margin-top:16px;" onclick="ScanPage.cancelScan()">✕ 取消扫描</button>';
            html += '</div>';
            return html;
        }

        // Check if backend is still running (recovery from timeout / page reload)
        try {
            const sp = await API.scanProgress();
            if (sp.running) {
                this.processing = true;
                this._sawRunning = true;  // real in-flight scan — allow done detection
                this._startProgressPolling();
                html += '<div id="scan-progress-card" class="card" style="text-align:center;padding:40px 20px;">';
                html += '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">⏳ 后端正在处理中…</div>';
                html += '<div id="scan-progress-big" style="font-size:56px;font-weight:700;color:var(--accent);line-height:1.2;">…</div>';
                html += '<div id="scan-progress-msg" style="font-size:13px;color:var(--text-tertiary);margin-top:8px;">等待进度更新...</div>';
                html += '</div>';
                return html;
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

        // ═══════════ Settings (collapsible) ═══════════
        const showSet = this.showSettings;
        html += '<div class="card mb-4">';
        html += `<div class="card-header" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;" onclick="ScanPage.showSettings=!ScanPage.showSettings;App.navigate('scan');">`;
        html += '<span>⚙️ 扫描设置</span>';
        html += `<span class="chevron-arrow${showSet ? ' expanded' : ''}" style="color:var(--text-tertiary);"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>`;
        html += '</div>';
        if (showSet) {
            html += '<div style="padding:12px 0;">';
            // PPT folder
            html += '<div style="margin-bottom:12px;">';
            html += '<label class="form-label">PPT 文件夹</label>';
            html += `<input type="text" class="form-input" id="scan-ppt-folder" value="${escapeHtml(d.ppt_folder)}" style="font-size:12px;" oninput="ScanPage._onSettingChanged()">`;
            html += '</div>';
            // Classify mode
            html += '<div style="display:flex;gap:12px;align-items:flex-end;margin-bottom:12px;">';
            html += '<div style="flex:1;">';
            html += '<label class="form-label">分类模式</label>';
            html += `<select class="form-select" id="scan-classify-mode" style="font-size:12px;" onchange="ScanPage._onSettingChanged()">`;
            html += `<option value="keyword"${d.classify_mode === 'keyword' ? ' selected' : ''}>仅关键词</option>`;
            html += `<option value="hybrid"${d.classify_mode === 'hybrid' ? ' selected' : ''}>关键词 + LLM (推荐)</option>`;
            html += `<option value="llm"${d.classify_mode === 'llm' ? ' selected' : ''}>仅 LLM</option>`;
            html += `</select></div>`;
            html += '<div style="flex:1;">';
            html += '<label class="form-label" style="display:flex;align-items:center;gap:4px;">置信度阈值 <span style="cursor:pointer;font-size:13px;color:var(--accent);" onclick="event.stopPropagation();ScanPage._showConfHelp()" title="这是什么？">ℹ️</span></label>';
            html += `<input type="number" class="form-input" id="scan-min-conf" value="${d.classify_min_confidence}" step="0.01" min="0.05" max="0.95" style="font-size:12px;" oninput="ScanPage._onSettingChanged()">`;
            html += '</div>';
            html += '</div>';
            html += '<p style="font-size:11px;color:var(--text-tertiary);margin-bottom:10px;">关键词分值低于此阈值的页面将交由 LLM 分类（hybrid 模式）</p>';
            // Confirm button
            html += `<button class="btn btn-primary" id="scan-settings-confirm" disabled style="opacity:0.4;" onclick="ScanPage._saveSettings()">确定</button>`;
            html += '<span style="margin-left:8px;font-size:11px;color:var(--text-tertiary);" id="scan-settings-hint"></span>';
            html += '</div>';
        }
        html += '</div>';

        // ═══════════ File scan ═══════════
        const newCount = (d.new_files || []).length;
        const processedCount = (d.processed_files || []).filter(f => f.processed).length;

        html += '<div class="card mb-4">';
        html += '<div class="card-header">📂 文件扫描</div>';

        html += '<div style="display:flex;gap:24px;margin-bottom:16px;">';
        html += `<div><span style="font-size:24px;font-weight:700;">${d.total_files}</span><span style="font-size:13px;color:var(--text-tertiary);margin-left:4px;">个文件</span></div>`;
        if (processedCount > 0) {
            html += `<div><span style="font-size:24px;font-weight:700;color:var(--success);">${processedCount}</span><span style="font-size:13px;color:var(--text-tertiary);margin-left:4px;">已处理</span></div>`;
        }
        if (newCount > 0) {
            html += `<div><span style="font-size:24px;font-weight:700;color:var(--accent);">${newCount}</span><span style="font-size:13px;color:var(--text-tertiary);margin-left:4px;">待处理</span></div>`;
        }
        html += '</div>';

        if (newCount > 0) {
            const show = this.showFileList;
            html += `<div style="margin-bottom:12px;cursor:pointer;font-size:13px;color:var(--accent);user-select:none;" onclick="ScanPage.showFileList=!ScanPage.showFileList;App.navigate('scan');">`;
            html += `<span class="chevron-arrow${show ? ' expanded' : ''}" style="margin-right:2px;color:var(--accent);"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span> 待处理文件列表 (${newCount})</div>`;
            if (show) {
                html += '<div style="max-height:240px;overflow-y:auto;margin-bottom:12px;background:var(--bg-page);border-radius:6px;padding:8px 12px;">';
                for (const f of d.new_files) {
                    html += `<div style="padding:3px 0;font-size:12.5px;border-bottom:1px solid var(--border-light);">📄 ${escapeHtml(f.name)}</div>`;
                }
                html += '</div>';
            }
        }

        html += '<div style="display:flex;gap:8px;">';
        html += `<button class="btn btn-primary" onclick="ScanPage.process()" ${newCount === 0 ? 'disabled' : ''}>`;
        html += `▶ 处理${newCount > 0 ? '全部' : ''}新文件${newCount > 0 ? ` (${newCount})` : ''}</button>`;
        html += '<button class="btn btn-ghost" onclick="ScanPage.scan()">🔄 刷新</button>';
        if (d.deleted_files && d.deleted_files.length > 0) {
            html += `<button class="btn btn-ghost" onclick="ScanPage.cleanup()">🗑 清理 ${d.deleted_files.length} 个</button>`;
        }
        html += '</div>';
        html += '</div>';

        // ═══════════ Classification ═══════════
        if (this.stats.total_slides > 0) {
            const pct = Math.round(this.stats.categorized_slides / this.stats.visible_slides * 100);
            html += '<div class="card mb-4">';
            html += '<div class="card-header">🏷️ 自动分类</div>';
            html += `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">`;
            html += `已归类 <strong>${this.stats.categorized_slides}</strong> / ${this.stats.visible_slides} 页 (${pct}%)`;
            html += `</div>`;
            html += '<div style="margin-bottom:12px;height:6px;background:var(--border);border-radius:3px;overflow:hidden;">';
            html += `<div style="width:${pct}%;height:100%;background:var(--accent);border-radius:3px;transition:width 0.3s ease;"></div>`;
            html += '</div>';
            html += `<button class="btn btn-primary" onclick="ScanPage.reclassify()">🔄 重新分类</button>`;
            if (this.reclassifying) {
                html += '<span style="margin-left:8px;font-size:12px;color:var(--accent);">分类中…</span>';
            }
            html += '</div>';
        }

        // ═══════════ Processed files ═══════════
        if (d.processed_files && d.processed_files.length > 0) {
            html += '<div class="card">';
            html += `<div class="card-header" style="display:flex;justify-content:space-between;">`;
            html += `<span>✅ 已处理 (${d.processed_files.length})</span>`;
            html += `<span style="font-size:12px;font-weight:400;color:var(--text-tertiary);">${d.processed_files.reduce((s,f) => s+f.slides, 0)} 页</span>`;
            html += `</div>`;
            html += '<div style="max-height:260px;overflow-y:auto;">';
            for (const f of d.processed_files) {
                html += `<div style="padding:5px 0;font-size:13px;border-bottom:1px solid var(--border-light);display:flex;justify-content:space-between;">`;
                html += `<span>${f.processed ? '✅' : '⏳'} ${escapeHtml(f.name)}</span>`;
                html += `<span style="color:var(--text-tertiary);font-size:12px;flex-shrink:0;margin-left:12px;">${f.slides}页</span>`;
                html += `</div>`;
            }
            html += '</div></div>';
        }

        return html;
    },

    // ── Settings ──

    _showConfHelp() {
        Modal.show('ℹ️ 分类逻辑说明',
            `<div style="font-size:13px;line-height:1.9;max-width:480px;">
                <p><strong>🔍 关键词匹配</strong></p>
                <p>系统遍历每个类别的关键词，在幻灯片的 <em>标题 + 正文 + 文件路径</em> 中搜索。标题命中权重 ×2，路径命中权重 ×0.6。长关键词（≥4字）额外 ×1.5 加分。</p>

                <p style="margin-top:12px;"><strong>📊 置信度计算</strong></p>
                <p>总分 ÷ 文本长度系数 → 置信度（0~1）。文本越短越容易得高分，所以用长度系数做了归一化。</p>

                <p style="margin-top:12px;"><strong>🎯 阈值作用</strong></p>
                <p>置信度 <strong>≥ 阈值</strong> → 直接归类到得分最高的类别<br>
                置信度 <strong>&lt; 阈值</strong> →
                    <span style="color:var(--accent);">仅关键词模式</span>：不归类<br>
                    <span style="color:var(--accent);">混合模式</span>：交由大模型二次判断</p>

                <p style="margin-top:12px;"><strong>🌳 N级级联下沉</strong></p>
                <p>命中父类后，继续检查子类得分。子类得分 ≥ 父类 × 0.35 → 下沉到子类。逐级向下直到叶子节点或不再满足条件。</p>

                <p style="margin-top:12px;color:var(--text-tertiary);">建议阈值 <strong>0.20~0.30</strong>：太低容易误分，太高则大量走大模型（慢且费钱）。</p>
            </div>`,
            [{ label: '知道了', key: 'close' }]
        );
    },

    _onSettingChanged() {
        const btn = document.getElementById('scan-settings-confirm');
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    },

    _saveSettings() {
        const folder = document.getElementById('scan-ppt-folder').value.trim();
        const mode = document.getElementById('scan-classify-mode').value;
        const conf = parseFloat(document.getElementById('scan-min-conf').value) || 0.22;

        API.updateScanSettings({
            ppt_folder: folder,
            classify_mode: mode,
            classify_min_confidence: conf,
        }).then(() => {
            // Disable button again
            const btn = document.getElementById('scan-settings-confirm');
            if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; }

            if (this.stats && this.stats.total_slides > 0) {
                Modal.confirm('🔄 是否重新分类？',
                    `要用新设置重新分类现有的 ${this.stats.total_slides} 页幻灯片吗？<br><span style="font-size:12px;color:var(--text-tertiary);">选择"否"仅保存设置，下次扫描时生效。</span>`,
                    () => {
                        this.reclassify();
                    },
                    () => {
                        Toast.success('设置已保存（未重新分类）');
                        this.scan();
                    }
                );
            } else {
                Toast.success('设置已保存');
                this.scan();
            }
        }).catch(e => {
            Toast.error(`保存失败：${e.message}`);
        });
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
                if ((p.done || !p.running) && this._sawRunning) {
                    this._stopProgressPolling();
                    setTimeout(() => {
                        this.processing = false;
                        App.navigate('scan');
                    }, 600);
                } else if (p.done && !p.running) {
                    // Fallback: scan finished between two polls (never saw
                    // running:true). Require 3 consecutive done reads (~1.2s)
                    // to rule out the stale-progress race.
                    this._doneStreak = (this._doneStreak || 0) + 1;
                    if (this._doneStreak >= 3) {
                        this._stopProgressPolling();
                        setTimeout(() => {
                            this.processing = false;
                            App.navigate('scan');
                        }, 600);
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

        const total = Math.max(p.total || 1, 1);
        const current = Math.min(p.current, total);
        const pct = Math.min(Math.round((current / total) * 100), 100);

        if (big) big.textContent = `${pct}%`;
        if (msg) {
            let text = `${current} / ${total} 个文件`;
            if (p.current_file) text += ` · ${p.current_file}`;
            msg.textContent = text;
        }
    },

    // ── Actions ──

    async reclassify() {
        this.reclassifying = true;
        // Inject progress card directly — no page jump
        const container = document.getElementById('page-container');
        if (container) {
            container.innerHTML = `
                <div class="page-header"><h1 class="page-title">扫描处理</h1></div>
                <div id="scan-progress-card" class="card" style="text-align:center;padding:40px 20px;">
                    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">⏳ 正在重新分类…</div>
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
        this.scanData = await API.scanCheck();
        App.navigate('scan');
    },

    async process() {
        if (!this.scanData || !this.scanData.new_files || this.scanData.new_files.length === 0) {
            Toast.error('没有新文件需要处理');
            return;
        }
        if (this.processing) return;
        this.processing = true;
        this._sawRunning = false;  // reset: ignore stale done:true from last scan
        this.showFileList = false;
        await App.navigate('scan');  // await so progress card is rendered before API call
        try {
            const result = await API.scanProcess();
            // API returned normally — scan finished
            if (result.errors && result.errors.length > 0) {
                const msgs = result.errors.map(e => `${e.file}: ${e.error}`).join('; ');
                Toast.error(`部分失败：${msgs.substring(0, 120)}`);
            } else {
                Toast.success(`已处理 ${result.processed} 个文件，共 ${result.total_slides} 页`);
            }
        } catch (e) {
            // API timed out or connection lost — backend may still be running
            // Don't stop polling; let _startProgressPolling detect p.done naturally
            Toast.info('后端仍在处理中，请等待扫描完成…');
        }
        // Only cleanup if scan actually finished (polling detected p.done)
        // Otherwise polling will handle cleanup when p.done becomes true
    },

    async cleanup() {
        const result = await API.scanCleanup();
        Toast.success(`已清理 ${result.cleaned} 条记录`);
        App.navigate('scan');
    },

    async cancelScan() {
        try {
            await API.scanCancel();
            Toast.info('已发送取消请求');
        } catch (e) {
            Toast.error(`取消失败：${e.message}`);
        }
    },
};
