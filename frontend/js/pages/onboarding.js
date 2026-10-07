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
        html += '<p style="font-size:13px;color:var(--text-secondary);">一站式 PPT 素材管理 — 扫描、分类、去重</p>';
        html += '</div>';

        // ═══ Feature cards ═══
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">';

        html += '<div class="card" style="padding:16px;text-align:center;">';
        html += '<div style="font-size:28px;margin-bottom:4px;">📂</div>';
        html += '<div style="font-size:14px;font-weight:600;">扫描入库</div>';
        html += '<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">自动解析 PPT 文件<br>生成缩略图</div>';
        html += '</div>';

        html += '<div class="card" style="padding:16px;text-align:center;">';
        html += '<div style="font-size:28px;margin-bottom:4px;">🏷️</div>';
        html += '<div style="font-size:14px;font-weight:600;">智能分类</div>';
        html += '<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">关键词 + AI 双引擎<br>自动归类页面</div>';
        html += '</div>';

        html += '<div class="card" style="padding:16px;text-align:center;">';
        html += '<div style="font-size:28px;margin-bottom:4px;">🔍</div>';
        html += '<div style="font-size:14px;font-weight:600;">重复检测</div>';
        html += '<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">找出重复页面<br>隐藏冗余副本</div>';
        html += '</div>';

        html += '<div class="card" style="padding:16px;text-align:center;">';
        html += '<div style="font-size:28px;margin-bottom:4px;">⭐</div>';
        html += '<div style="font-size:14px;font-weight:600;">收藏整理</div>';
        html += '<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">收藏常用页面<br>快速查找复用</div>';
        html += '</div>';

        html += '</div>';

        // ═══ Quick start guide ═══
        html += '<div class="card" style="padding:20px;margin-bottom:20px;">';
        html += '<h2 style="font-size:15px;font-weight:600;margin-bottom:12px;">🚀 快速上手</h2>';
        html += '<div style="font-size:13px;color:var(--text-secondary);line-height:2;">';
        html += '<div>① 在「扫描处理」中设置 PPT 文件夹，点击扫描入库</div>';
        html += '<div>② 在「类别管理」中用 AI 生成或手动创建分类体系</div>';
        html += '<div>③ 扫描后点击 <strong>重新分类</strong>，将页面归入对应类别</div>';
        html += '<div>④ 在「重复检测」中清理冗余副本</div>';
        html += '<div>⑤ 在「分类浏览」中按类别查找和使用素材</div>';
        html += '</div>';
        html += '</div>';

        // ═══ Action ═══
        html += '<div style="text-align:center;">';
        html += '<button class="btn btn-primary" style="padding:10px 40px;font-size:14px;" onclick="App.navigate(\'browse\');App.loadSubNav();">';
        html += '开始使用 →';
        html += '</button>';
        html += '</div>';

        html += '</div>';
        return html;
    },

    async init() {
        // no-op — keep for API compatibility with App.init
    },
};
