/**
 * Settings Page - 设置
 */
const SettingsPage = {
    settings: null,
    showPaths: false,
    appVersion: '',
    GITHUB_REPO: 'https://github.com/egohuger/ppt-nest',

    // ── Provider presets: { val, label, base, model, note }
    //     base/modal can be empty string for "other"
    PROVIDERS: [
        // 国内
        { val: 'zhipu',      label: '智谱 GLM',            base: 'https://open.bigmodel.cn/api/paas/v4/',        model: 'glm-4-flash' },
        { val: 'deepseek',    label: 'DeepSeek',             base: 'https://api.deepseek.com/v1',                  model: 'deepseek-chat' },
        { val: 'qwen',        label: '通义千问 (阿里)',       base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
        { val: 'moonshot',    label: 'Moonshot (Kimi)',      base: 'https://api.moonshot.cn/v1',                   model: 'moonshot-v1-8k' },
        { val: 'baidu',       label: '百度文心',             base: 'https://qianfan.baidubce.com/v2',               model: 'ernie-speed-128k' },
        { val: 'volcengine',  label: '豆包 (火山引擎)',       base: 'https://ark.cn-beijing.volces.com/api/v3',      model: 'doubao-lite-128k' },
        // 国外
        { val: 'openai',      label: 'OpenAI (GPT)',         base: 'https://api.openai.com/v1',                     model: 'gpt-4o-mini' },
        { val: 'anthropic',   label: 'Anthropic Claude',     base: 'https://api.anthropic.com/v1',                  model: 'claude-3-haiku-20240307' },
        { val: 'gemini',      label: 'Google Gemini',        base: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-1.5-flash' },
        { val: 'mistral',     label: 'Mistral AI',           base: 'https://api.mistral.ai/v1',                     model: 'mistral-small-latest' },
        // 自定义
        { val: 'other',       label: '其他（自定义 OpenAI 兼容）', base: '', model: '' },
    ],

    async render() {
        let html = '<div class="page-header">';
        html += '<h1 class="page-title">设置</h1>';
        html += '</div>';

        try {
            this.settings = await API.getSettings();
        } catch (e) {
            html += `<div class="alert alert-danger">加载设置失败：${escapeHtml(e.message)}</div>`;
            return html;
        }

        const s = this.settings;

        // 获取应用版本号（用于帮助与反馈）
        this.appVersion = '';
        try {
            if (window.electronAPI && window.electronAPI.getAppVersion) {
                this.appVersion = await window.electronAPI.getAppVersion();
            }
        } catch (e) { /* ignore */ }

        // ═══════════ Storage paths (collapsible) ═══════════
        const showP = this.showPaths;
        html += '<div class="card mb-4">';
        html += `<div class="card-header" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;" onclick="SettingsPage.showPaths=!SettingsPage.showPaths;App.navigate('settings');">`;
        html += '<span>💾 存储路径</span>';
        html += `<span class="chevron-arrow${showP ? ' expanded' : ''}" style="color:var(--text-tertiary);"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>`;
        html += '</div>';
        if (showP) {
            html += '<div style="padding:12px 0;">';
            html += `<div class="form-group"><label class="form-label">数据目录</label><input type="text" class="form-input" id="set-data-dir" value="${escapeHtml(s.data_dir)}"></div>`;
            html += `<div class="form-hint">数据库：${escapeHtml(s.db_path)}</div>`;
            html += `<div class="form-hint">缩略图：${escapeHtml(s.thumbnail_dir)}</div>`;
            html += `<div class="form-hint" style="margin-top:4px;">PPT 文件夹及其他扫描设置在 <a href="#" onclick="App.navigate('scan');return false;" style="color:var(--accent);">扫描处理</a> 页面配置</div>`;
            html += '<button class="btn btn-primary mt-4" onclick="SettingsPage.savePaths()">💾 保存路径</button>';
            html += '</div>';
        }
        html += '</div>';

        // ═══════════ LLM API ═══════════
        html += '<div class="card mb-4">';
        html += '<div class="card-header">🧠 大模型 API 配置</div>';
        html += '<div style="padding:12px 0;">';

        // Resolve current provider defaults
        const curProv = this.PROVIDERS.find(p => p.val === s.llm_provider) || this.PROVIDERS[0];

        // Provider select
        html += '<div class="form-group"><label class="form-label">模型提供商</label>';
        html += '<select class="form-select" id="set-llm-provider" onchange="SettingsPage._onProviderChange()">';
        for (const p of this.PROVIDERS) {
            html += `<option value="${p.val}" data-base="${escapeHtml(p.base)}" data-model="${escapeHtml(p.model)}" ${s.llm_provider === p.val ? 'selected' : ''}>${p.label}</option>`;
        }
        html += '</select></div>';

        // API Key
        html += `<div class="form-group"><label class="form-label">API Key</label><input type="password" class="form-input" id="set-api-key" value="${escapeHtml(s.api_key)}" placeholder="sk-..."></div>`;

        // API Base URL (always visible, pre-filled from provider)
        html += `<div class="form-group"><label class="form-label">API Base URL</label><input type="text" class="form-input" id="set-api-base" value="${escapeHtml(s.api_base_url || curProv.base)}" placeholder="https://api.example.com/v1"></div>`;

        // Model name (pre-filled from provider)
        html += `<div class="form-group"><label class="form-label">模型名称</label><input type="text" class="form-input" id="set-model-name" value="${escapeHtml(s.model_name || curProv.model)}" placeholder="模型标识或名称"></div>`;

        html += '<button class="btn btn-primary" onclick="SettingsPage.saveLLM()">💾 保存 API 配置</button>';
        html += '</div>';
        html += '</div>';

        // ═══════════ Support / Donate ═══════════
        html += '<div class="card mb-4">';
        html += '<div class="card-header">☕ 支持作者</div>';
        html += '<div style="padding:12px 0;line-height:1.9;">';
        html += '<div style="margin-bottom:12px;">如果 PPT Nest 帮你节省了时间，欢迎请作者喝杯咖啡、关注公众号，你的支持是我持续迭代的动力。</div>';
        html += '<div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;">';

        // ── QR 1: 赞赏码 ──
        html += '<div style="text-align:center;">';
        html += '<img src="donate-qrcode.png" alt="打赏二维码" style="width:150px;height:150px;border-radius:8px;border:1px solid var(--border);object-fit:cover;" onerror="this.style.display=\'none\';document.getElementById(\'donate-fallback\').style.display=\'flex\';">';
        html += '<div id="donate-fallback" style="display:none;width:150px;height:150px;border-radius:8px;border:1px dashed var(--border);color:var(--text-tertiary);font-size:12px;align-items:center;justify-content:center;">暂无打赏二维码</div>';
        html += '<div style="margin-top:6px;font-size:13px;font-weight:600;">☕ 打赏支持</div>';
        html += '<div style="font-size:12px;color:var(--text-tertiary);">微信赞赏 <span style="user-select:all;">egohughu</span></div>';
        html += '</div>';

        // ── QR 2: 公众号 ──
        html += '<div style="text-align:center;">';
        html += '<img src="wechat-qrcode.png" alt="公众号二维码" style="width:150px;height:150px;border-radius:8px;border:1px solid var(--border);object-fit:cover;">';
        html += '<div style="margin-top:6px;font-size:13px;font-weight:600;">📢 关注公众号</div>';
        html += '<div style="font-size:12px;color:var(--text-tertiary);">岱森LIVE · 人、AI、效率、社会</div>';
        html += '</div>';

        html += '</div>';
        html += '<div style="margin-top:10px;color:var(--text-tertiary);font-size:12px;">打开微信 → 扫一扫，即可赞赏或关注公众号</div>';
        html += '</div>';
        html += '</div>';

        // ═══════════ Contact / About ═══════════
        html += '<div class="card mb-4">';
        html += '<div class="card-header">📮 联系我</div>';
        html += '<div style="padding:12px 0;line-height:1.9;">';
        html += '<div>📧 邮箱：<a href="mailto:egohug@126.com" style="color:var(--accent);">egohug@126.com</a></div>';
        html += '<div>💬 微信：<span style="user-select:all;">egohughu</span>（欢迎交流反馈）</div>';
        html += '</div>';
        html += '</div>';

        // ═══════════ Help & Feedback ═══════════
        const verTxt = this.appVersion ? `当前版本 <strong>v${escapeHtml(this.appVersion)}</strong> · ` : '';
        html += '<div class="card mb-4">';
        html += '<div class="card-header">🛟 帮助与反馈</div>';
        html += '<div style="padding:12px 0;">';
        html += `<div style="margin-bottom:12px;color:var(--text-secondary);font-size:13px;">${verTxt}喜欢 PPT Nest？给我们点亮一颗星，或告诉我们哪里可以更好。</div>`;
        html += '<div class="btn-row">';
        html += '<button class="btn btn-primary" onclick="SettingsPage.openRepo()">⭐ 点亮 Star</button>';
        html += '<button class="btn btn-secondary" onclick="SettingsPage.openReleases()">📦 检查更新</button>';
        html += '<button class="btn btn-secondary" onclick="SettingsPage.openBugReport()">🐛 反馈 Bug</button>';
        html += '<button class="btn btn-secondary" onclick="SettingsPage.openMailFeedback()">📧 邮件反馈</button>';
        html += '</div>';
        html += '<div style="margin-top:10px;color:var(--text-tertiary);font-size:12px;">在 GitHub 仓库页点击 <strong>Watch → Custom → Releases</strong>，新版本发布时即可收到通知。</div>';
        html += '</div>';
        html += '</div>';

        // ═══════════ Danger zone ═══════════
        html += '<div class="card" style="border-color:var(--danger);">';
        html += '<div class="card-header" style="color:var(--danger);">⚠️ 危险操作</div>';
        html += '<button class="btn btn-danger" onclick="SettingsPage.clearAll()">🗑️ 清空所有数据</button>';
        html += '</div>';

        return html;
    },

    _onProviderChange() {
        const sel = document.getElementById('set-llm-provider');
        if (!sel) return;
        const opt = sel.selectedOptions[0];
        const base = opt.getAttribute('data-base') || '';
        const model = opt.getAttribute('data-model') || '';
        const baseInput = document.getElementById('set-api-base');
        const modelInput = document.getElementById('set-model-name');
        if (baseInput && !baseInput.dataset.userEdited) baseInput.value = base;
        if (modelInput && !modelInput.dataset.userEdited) modelInput.value = model;
    },

    async savePaths() {
        const dataDir = document.getElementById('set-data-dir').value.trim();
        await API.updateSettings({ data_dir: dataDir || undefined });
        Toast.success('路径已保存，立即生效，重启应用后依然保持');
        App.navigate('settings');
    },

    async saveLLM() {
        const provider = document.getElementById('set-llm-provider').value;
        const apiKey = document.getElementById('set-api-key').value.trim();
        const apiBase = document.getElementById('set-api-base').value.trim();
        const modelName = document.getElementById('set-model-name').value.trim();
        const sel = document.getElementById('set-llm-provider');
        const opt = sel ? sel.selectedOptions[0] : null;
        const defaultBase = opt ? (opt.getAttribute('data-base') || '') : '';
        const defaultModel = opt ? (opt.getAttribute('data-model') || '') : '';

        await API.updateSettings({
            llm_provider: provider,
            api_key: apiKey || undefined,
            api_base_url: apiBase && apiBase !== defaultBase ? apiBase : undefined,
            model_name: modelName && modelName !== defaultModel ? modelName : undefined,
        });
        Toast.success('API 配置已保存');
    },

    async clearAll() {
        Modal.confirm('⚠️ 清空所有数据', '此操作不可逆！确定要删除所有数据吗？', async () => {
            await API.clearAll();
            Toast.success('全部数据已清空');
            App.navigate('settings');
        });
    },

    // ═══ GitHub / 反馈 ═══
    openUrl(url) {
        if (window.electronAPI && window.electronAPI.openUrl) {
            window.electronAPI.openUrl(url);
        }
    },

    openRepo() {
        this.openUrl(this.GITHUB_REPO);
    },

    openReleases() {
        this.openUrl(this.GITHUB_REPO + '/releases');
    },

    openBugReport() {
        const v = this.appVersion || '未知';
        const title = encodeURIComponent('[Bug] ');
        const body = encodeURIComponent(
            '**软件版本**：v' + v + '\n' +
            '**操作系统**：Windows\n\n' +
            '**问题描述**：\n\n\n' +
            '**复现步骤**：\n1. \n\n' +
            '**期望行为**：\n\n\n' +
            '**实际行为**：\n\n\n' +
            '**日志信息**：\n（日志位于「设置 → 存储路径」所示数据目录下的 pptnest.log，可粘贴相关片段）\n'
        );
        this.openUrl(this.GITHUB_REPO + '/issues/new?labels=bug&title=' + title + '&body=' + body);
    },

    openMailFeedback() {
        const v = this.appVersion || '未知';
        const subject = encodeURIComponent('[PPT Nest 反馈] v' + v);
        const body = encodeURIComponent('软件版本：v' + v + '\n\n问题或建议：\n');
        this.openUrl('mailto:egohug@126.com?subject=' + subject + '&body=' + body);
    },
};
