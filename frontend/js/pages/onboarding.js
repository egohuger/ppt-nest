/**
 * Onboarding Page - 新用户欢迎页（纯介绍，无配置）
 */
const OnboardingPage = {

    async render() {
        let html = '';
        html += '<div style="max-width:640px;margin:32px auto;padding:0 20px;">';

        // ═══ Header ═══
        html += '<div style="text-align:center;margin-bottom:24px;">';
        html += '<div style="margin-bottom:12px;"><img src="icon.png" alt="PPT Nest" width="72" height="72" style="border-radius:16px;"></div>';
        html += '<h1 style="font-size:22px;font-weight:700;margin-bottom:4px;">欢迎使用 PPT Nest 片巢</h1>';
        html += '<p style="font-size:13px;color:var(--text-secondary);">一站式PPT素材管理</p>';
        html += '</div>';

        // ═══ Feature cards ═══
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">';

        html += '<div class="card" style="padding:16px;text-align:center;">';
        html += `<div style="margin-bottom:6px;color:var(--accent);">${icon("folder-open", 26)}</div>`;
        html += '<div style="font-size:14px;font-weight:600;">扫描入库</div>';
        html += '<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">自动解析 PPT 文件<br>生成缩略图</div>';
        html += '</div>';

        html += '<div class="card" style="padding:16px;text-align:center;">';
        html += `<div style="margin-bottom:6px;color:var(--accent);">${icon("tag", 26)}</div>`;
        html += '<div style="font-size:14px;font-weight:600;">智能分类</div>';
        html += '<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">关键词 + AI 双引擎<br>自动归类页面</div>';
        html += '</div>';

        html += '<div class="card" style="padding:16px;text-align:center;">';
        html += `<div style="margin-bottom:6px;color:var(--accent);">${icon("search", 26)}</div>`;
        html += '<div style="font-size:14px;font-weight:600;">重复检测</div>';
        html += '<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">找出重复页面<br>隐藏冗余副本</div>';
        html += '</div>';

        html += '<div class="card" style="padding:16px;text-align:center;">';
        html += `<div style="margin-bottom:6px;color:var(--accent);">${icon("star", 26)}</div>`;
        html += '<div style="font-size:14px;font-weight:600;">收藏整理</div>';
        html += '<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">收藏常用页面<br>快速查找复用</div>';
        html += '</div>';

        html += '</div>';

        // ═══ Quick start guide ═══
        html += '<div class="card" style="padding:20px;margin-bottom:20px;">';
        html += `<h2 style="font-size:15px;font-weight:600;margin-bottom:12px;">${icon("rocket", 15)} 快速上手</h2>`;
        html += '<div style="font-size:13px;color:var(--text-secondary);line-height:2;">';
        html += '<div><span class="step-num">1</span>进入【素材入库】设置 PPT 文件夹，点击【检查新增】</div>';
        html += '<div><span class="step-num">2</span>在【类别管理】里用 AI 生成或手动创建分类体系</div>';
        html += '<div><span class="step-num">3</span>入库后点击【重新分类】，将页面归入对应类别</div>';
        html += '<div><span class="step-num">4</span>在【重复检测】里清理冗余副本</div>';
        html += '<div><span class="step-num">5</span>在【分类浏览】里按类别查找和使用素材</div>';
        html += '</div>';
        html += '</div>';

        // ═══ Action ═══
        html += '<div style="text-align:center;">';
        html += '<button class="btn btn-primary" style="padding:10px 40px;font-size:14px;" onclick="OnboardingPage.finish()">';
        html += `${icon('arrow-right', 15)} 开始使用`;
        html += '</button>';
        html += '</div>';

        html += '</div>';
        return html;
    },

    async init() {
        // no-op — keep for API compatibility with App.init
    },

    // 点「开始使用」：先落一次性标记，再进主界面
    async finish() {
        try { await API.completeOnboarding(); } catch (e) { /* 标记失败不挡用户 */ }
        await App.navigate('browse');
        App.loadSubNav();
    },
};
