/**
 * Categories Page - 类别管理 (N-level recursive tree)
 */
const CategoriesPage = {
    showImport: false,
    async render() {
        let html = '<div class="page-header">';
        html += '<h1 class="page-title">类别管理</h1>';
        html += '</div>';

        // ── Import section (collapsible) ──
        const showImp = this.showImport;
        html += '<div class="card mb-4">';
        html += `<div class="card-header" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;" onclick="CategoriesPage.showImport=!CategoriesPage.showImport;App.navigate('categories');">`;
        html += '<span>📥 导入类别体系</span>';
        html += `<span class="chevron-arrow${showImp ? ' expanded' : ''}" style="color:var(--text-tertiary);"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>`;
        html += '</div>';
        if (showImp) {
            html += '<div style="padding:12px 0;">';
            html += '<p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">';
            html += '将 AI 生成的类别 JSON 粘贴到下方，一键导入。导入会<strong>替换</strong>当前所有类别。';
            html += '</p>';
            html += '<textarea id="import-json" class="form-input" style="height:120px;font-family:monospace;font-size:12px;" placeholder=\'[{"name":"...","keywords":["..."]}]\'></textarea>';
            html += '<div style="display:flex;gap:8px;margin-top:8px;">';
            html += '<button class="btn btn-primary" onclick="CategoriesPage.importCategories()">📥 导入</button>';
            html += '<button class="btn btn-ghost" onclick="CategoriesPage.showPromptModal()">💡 获取导入模板</button>';
            html += '<button class="btn btn-ghost" onclick="CategoriesPage.exportCategories()">📤 导出</button>';
            html += '<button class="btn btn-danger btn-sm" onclick="CategoriesPage.resetAll()">🗑️ 清空全部</button>';
            html += '</div>';
            html += '</div>';
        }
        html += '</div>';

        // ── Add new top-level category ──
        html += '<div class="card mb-4">';
        html += '<div class="card-header">➕ 添加一级类别</div>';
        html += '<div style="display:flex;gap:8px;align-items:flex-end;">';
        html += '<div style="flex:1;"><label class="form-label">类别名称</label><input type="text" class="form-input" id="new-cat-name" placeholder="一级类别名称"></div>';
        html += '<div style="flex:2;"><label class="form-label">关键词（逗号分隔）</label><input type="text" class="form-input" id="new-cat-kw" placeholder="关键词1，关键词2……"></div>';
        html += '<div><button class="btn btn-primary" onclick="CategoriesPage.addCategory()" style="margin-bottom:1px;">添加</button></div>';
        html += '</div></div>';

        // ── Category tree with expand/collapse buttons ──
        html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">';
        html += '<button class="btn btn-sm btn-ghost" onclick="CategoriesPage._expandAll()">📂 全部展开</button>';
        html += '<button class="btn btn-sm btn-ghost" onclick="CategoriesPage._collapseAll()">📁 全部折叠</button>';
        html += '</div>';
        html += '<div id="cat-tree-container">';
        html += '<div class="loading-spinner"><div class="spinner"></div><p>加载中...</p></div>';
        html += '</div>';

        // Render tree async
        setTimeout(() => this._renderTree(), 0);
        return html;
    },

    async _renderTree() {
        try {
            // Save open state before re-render
            const openIds = new Set();
            document.querySelectorAll('#cat-tree-container .expander.open').forEach(el => {
                const id = parseInt(el.getAttribute('data-cat-id'));
                if (id) openIds.add(id);
            });

            const categories = await API.getCategories();
            const container = document.getElementById('cat-tree-container');
            container.innerHTML = this._renderNodes(categories, 0);

            // Restore open state
            if (openIds.size > 0) {
                openIds.forEach(id => {
                    const el = document.querySelector(`#cat-tree-container .expander[data-cat-id="${id}"]`);
                    if (el) el.classList.add('open');
                });
            }
        } catch (e) {
            document.getElementById('cat-tree-container').innerHTML =
                `<div class="alert alert-danger">加载失败：${escapeHtml(e.message)}</div>`;
        }
    },

    _renderNodes(nodes, depth) {
        const MAX_DEPTH = 5;  // levels 1-5, depth 0-4
        let html = '';
        for (const cat of nodes) {
            const kws = (cat.keywords || []).join(', ');
            const hasKids = cat.children && cat.children.length > 0;
            const indent = depth * 16;
            const atMaxDepth = depth >= MAX_DEPTH - 1;  // depth 4 = level 5

            // Count display: "累计 / 本级"
            const totalCount = cat.slide_count || 0;
            const directCount = cat.direct_count || 0;
            let countHtml = `${totalCount}页`;
            if (hasKids && totalCount !== directCount) {
                countHtml = `<span title="本级 ${directCount}，含子类共 ${totalCount}">${totalCount}页 <span style="font-size:10px;opacity:0.6;">(${directCount})</span></span>`;
            }

            html += `<div class="expander" data-cat-id="${cat.id}" style="margin-left:${indent}px;">`;
            html += `<div class="expander-header" onclick="this.parentElement.classList.toggle('open')">`;
            html += `<span><span class="level-badge">L${depth + 1}</span>${hasKids ? '📁' : '📄'} ${escapeHtml(cat.name)} <span style="font-weight:400;color:var(--text-tertiary);">${countHtml}</span></span>`;
            html += '<span class="chevron-arrow" style="color:var(--text-tertiary);"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>';
            html += '</div>';
            html += '<div class="expander-body">';

            // Edit this category
            html += `<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:8px;">`;
            html += `<div style="flex:1;"><label class="form-label">名称</label><input type="text" class="form-input cat-name-${cat.id}" value="${escapeHtml(cat.name)}"></div>`;
            html += `<div style="flex:2;"><label class="form-label">关键词</label><input type="text" class="form-input cat-kw-${cat.id}" value="${escapeHtml(kws)}"></div>`;
            html += `<div><button class="btn btn-sm btn-primary" onclick="CategoriesPage.saveCategory(${cat.id})">💾 保存</button></div>`;
            html += `<div><button class="btn btn-sm btn-danger" onclick="CategoriesPage.deleteCategory(${cat.id})">🗑️</button></div>`;
            html += '</div>';

            // Add child (hidden at max depth)
            if (!atMaxDepth) {
                const childLevel = depth + 2;
                html += `<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:8px;">`;
                html += `<div style="flex:1;"><input type="text" class="form-input child-name-${cat.id}" placeholder="${childLevel}级子类别名称"></div>`;
                html += `<div style="flex:2;"><input type="text" class="form-input child-kw-${cat.id}" placeholder="关键词1，关键词2……"></div>`;
                html += `<div><button class="btn btn-sm btn-ghost" onclick="CategoriesPage.addChild(${cat.id})">➕ 添加子类别</button></div>`;
                html += '</div>';
            }

            // Render children
            if (hasKids) {
                html += this._renderNodes(cat.children, depth + 1);
            }

            html += '</div></div>';
        }
        return html;
    },

    // ── Expand/collapse all ──

    _expandAll() {
        document.querySelectorAll('#cat-tree-container .expander').forEach(el => {
            el.classList.add('open');
        });
    },

    _collapseAll() {
        document.querySelectorAll('#cat-tree-container .expander').forEach(el => {
            el.classList.remove('open');
        });
    },

    // ── Actions ──

    async addCategory() {
        const name = document.getElementById('new-cat-name').value.trim();
        const kwStr = document.getElementById('new-cat-kw').value.trim();
        const keywords = kwStr ? kwStr.split(',').map(k => k.trim()).filter(Boolean) : [];
        if (!name) { Toast.error('请输入类别名称'); return; }
        await API.createCategory(name, null, keywords);
        Toast.success(`已添加：${name}`);
        document.getElementById('new-cat-name').value = '';
        document.getElementById('new-cat-kw').value = '';
        this._renderTree();
        App.loadSubNav();
    },

    async saveCategory(id) {
        const nameEl = document.querySelector(`.cat-name-${id}`);
        const kwEl = document.querySelector(`.cat-kw-${id}`);
        const name = nameEl ? nameEl.value.trim() : null;
        const kwStr = kwEl ? kwEl.value.trim() : null;
        const keywords = kwStr ? kwStr.split(',').map(k => k.trim()).filter(Boolean) : [];
        await API.updateCategory(id, name, keywords);
        Toast.success('已保存');
        this._renderTree();
        App.loadSubNav();
    },

    async deleteCategory(id) {
        Modal.confirm('确认删除', '确定要删除此类别吗？子类别将上移一级，分类下的页面将变为未分类。', async () => {
            await API.deleteCategory(id);
            Toast.success('已删除');
            this._renderTree();
            App.loadSubNav();
        });
    },

    async addChild(parentId) {
        const nameEl = document.querySelector(`.child-name-${parentId}`);
        const kwEl = document.querySelector(`.child-kw-${parentId}`);
        if (!nameEl) return;
        const name = nameEl.value.trim();
        if (!name) { Toast.error('请输入子类别名称'); return; }
        const kwStr = kwEl ? kwEl.value.trim() : '';
        const keywords = kwStr ? kwStr.split(',').map(k => k.trim()).filter(Boolean) : [];
        await API.createCategory(name, parentId, keywords);
        Toast.success(`已添加子类别：${name}`);
        this._renderTree();
        App.loadSubNav();
    },

    // ── Import validation ──

    _validateTree(nodes, depth = 0) {
        if (!Array.isArray(nodes)) {
            return `根节点必须是一个数组 (当前类型: ${typeof nodes})`;
        }
        if (depth >= 5) {
            return '层级不能超过 5 级';
        }
        for (let i = 0; i < nodes.length; i++) {
            const item = nodes[i];
            if (typeof item !== 'object' || item === null) {
                return `第 ${i + 1} 个节点不是有效对象`;
            }
            if (!item.name || typeof item.name !== 'string') {
                return `第 ${i + 1} 个节点缺少 'name' (字符串)`;
            }
            if (item.keywords !== undefined) {
                if (!Array.isArray(item.keywords)) {
                    return `节点 "${item.name}" 的 'keywords' 必须是数组`;
                }
                for (const kw of item.keywords) {
                    if (typeof kw !== 'string') {
                        return `节点 "${item.name}" 的关键词包含非字符串值`;
                    }
                }
            }
            if (item.children !== undefined) {
                const err = this._validateTree(item.children, depth + 1);
                if (err) return err;
            }
        }
        return null;  // valid
    },

    // ── Import / Export ──

    async importCategories() {
        const raw = document.getElementById('import-json').value.trim();
        if (!raw) { Toast.error('请粘贴类别 JSON'); return; }
        let data;
        try { data = JSON.parse(raw); } catch { Toast.error('JSON 格式错误'); return; }

        // Validate structure
        const err = this._validateTree(data);
        if (err) {
            Toast.error(`格式校验失败：${err}`);
            return;
        }

        Modal.confirm('⚠️ 导入确认', '导入将<strong>清空现有所有类别</strong>，确定继续？', async () => {
            try {
                const result = await API.importCategories(data);
                Toast.success(`导入成功，共 ${result.imported} 个类别`);
                App.navigate('categories');
                App.loadSubNav();
            } catch (e) {
                Toast.error(`导入失败：${e.message}`);
            }
        });
    },

    async exportCategories() {
        try {
            const data = await API.exportCategories();
            const json = JSON.stringify(data, null, 2);
            await navigator.clipboard.writeText(json);
            Toast.success('已复制到剪贴板');
        } catch (e) {
            Toast.error(`导出失败：${e.message}`);
        }
    },

    async resetAll() {
        Modal.confirm('⚠️ 清空所有类别', '将删除所有类别及分类关系，不可恢复。确定？', async () => {
            await API.resetCategories();
            Toast.success('已清空');
            App.navigate('categories');
            App.loadSubNav();
        });
    },

    // ── Prompt Template ──

    showPromptModal() {
        const promptText = [
            '你是一个专业分类体系设计师。请根据我描述的领域，生成一套多级素材分类体系（输出 JSON，不要生成 PPT 文件）。',
            '',
            '【我的领域/需求】',
            '（此处由用户自行填写，例如：「我是做 HR 管理咨询的，覆盖组织、岗位、薪酬、绩效、人才、培训等模块」）',
            '',
            '【输出格式】纯 JSON 数组，每个节点包含：',
            '- name: 类别名称',
            '- keywords: 关键词数组（用于自动匹配内容，每个类别 5-15 个）',
            '- children: 子类别数组（可选，最多支持 5 级嵌套）',
            '',
            '格式示例：',
            '[',
            '  {',
            '    "name": "组织管理",',
            '    "keywords": ["组织架构", "组织设计", "部门职责", "管控模式", "组织优化"],',
            '    "children": [',
            '      {',
            '        "name": "组织架构",',
            '        "keywords": ["组织架构图", "架构设计", "架构优化"]',
            '      },',
            '      {',
            '        "name": "部门职责",',
            '        "keywords": ["部门职能", "职责划分", "职责界面", "权责"]',
            '      }',
            '    ]',
            '  }',
            ']',
            '',
            '要求：',
            '- 关键词要有区分度，不同类别的关键词尽量不要重叠',
            '- 层级不超过 5 级',
            '- 不要包含任何说明文字，只输出 JSON 数组（不要 markdown 代码块标记）',
            '- 根类别 5-10 个为宜',
            '',
            '请基于我上面描述的领域开始生成。',
        ].join('\n');

        const content = `<div style="font-size:13px;line-height:1.6;color:var(--text-primary);">
            <p style="margin-bottom:12px;">
                将此提示词发给任意 AI（ChatGPT / Claude / DeepSeek 等），<strong>把【我的领域/需求】替换成你的实际场景</strong>，AI 会生成可直接导入的分类 JSON。
            </p>
            <pre style="background:#1e293b;color:#e2e8f0;padding:14px;border-radius:8px;font-size:12.5px;white-space:pre-wrap;max-height:420px;overflow:auto;line-height:1.6;">${escapeHtml(promptText)}</pre>
            <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
                <span style="font-size:11px;color:var(--text-tertiary);align-self:center;">⬆️ 复制后替换方括号内的领域描述</span>
                <button class="btn btn-primary" onclick="CategoriesPage._copyPrompt()">📋 复制提示词</button>
            </div>
        </div>`;

        this._promptText = promptText;

        Modal.show('💡 AI 生成分类模板', content, [{ label: '关闭', key: 'close' }]);
    },

    _copyPrompt() {
        navigator.clipboard.writeText(this._promptText).then(
            () => Toast.success('已复制！粘贴给 AI 并替换领域描述即可'),
            () => Toast.error('复制失败，请手动选中文本')
        );
        Modal.hide();
    },
};
