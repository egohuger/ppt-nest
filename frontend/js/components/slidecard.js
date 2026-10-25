/**
 * Slide Card component
 * Renders a single slide in the grid
 */
const SlideCard = {
    // unique counter for data attributes
    _idCounter: 0,
    // maps uid → file_path (for openSourceFile) — bounded LRU
    _paths: {},
    _pathsKeys: [],
    _MAX_PATHS: 300,
    // registry: slide_id → { thumbUrl, file_path, title, slide_number, file_name }
    _registry: {},

    render(slide, options = {}) {
        const { showActions = true } = options;
        const id = slide.id;
        const title = (slide.title || '').substring(0, 40) || `第${slide.slide_number}页`;
        const source = `${icon('folder', 12)} ${escapeHtml(slide.file_name || '')} · 第${slide.slide_number}页`;

        let catText = `${icon('tag', 12)} 未分类`;
        if (slide.category_name) {
            const icons = { auto: icon('bot', 12), manual: icon('user', 12), llm: icon('brain', 12) };
            catText = `${icon('tag', 12)} ${escapeHtml(slide.category_name)} ${icons[slide.category_source] || ''}`;
        }

        const uid = ++SlideCard._idCounter;
        // Bounded LRU for _paths
        if (SlideCard._pathsKeys.length >= SlideCard._MAX_PATHS) {
            const oldest = SlideCard._pathsKeys.shift();
            delete SlideCard._paths[oldest];
        }
        SlideCard._paths[uid] = slide.file_path || '';
        SlideCard._pathsKeys.push(uid);

        // Register for zoom navigation (bounded: max 200 entries, LRU-style eviction)
        if (slide.thumbnail_url) {
            if (!SlideCard._registryKeys) SlideCard._registryKeys = [];
            if (SlideCard._registryKeys.length >= 200) {
                const oldest = SlideCard._registryKeys.shift();
                delete SlideCard._registry[oldest];
            }
            SlideCard._registry[slide.id] = {
                thumbUrl: API.baseUrl + slide.thumbnail_url,
                file_path: slide.file_path || '',
                title: title,
                slide_number: slide.slide_number,
                file_name: slide.file_name || '',
            };
            SlideCard._registryKeys.push(slide.id);
        }

        // Collection IDs for star states
        const colIds = slide.collection_ids || [];

        // Thumbnail
        let thumbHtml = '';
        if (slide.thumbnail_url) {
            const thumbUrl = API.baseUrl + slide.thumbnail_url;
            const starData = encodeURIComponent(JSON.stringify(colIds));
            thumbHtml = `
                <div class="slide-thumb">
                    <img src="${thumbUrl}" alt="${escapeHtml(title)}" loading="lazy">
                    <div class="thumb-hover-frame">
                        <button class="thumb-zoom-icon" data-sc-zoom="${slide.id}" data-tip="放大查看" aria-label="放大查看">
                            ${icon("zoom-in", 16)}
                        </button>
                        <button class="thumb-collect-icon" data-sc-collect="${slide.id}" data-sc-collected="${starData}" data-tip="收藏到收藏夹" aria-label="收藏到收藏夹">
                            ${icon("star", 16)}
                        </button>
                        <button class="thumb-open-icon" data-sc-open="${uid}" data-tip="打开源文件所在位置" aria-label="打开源文件所在位置">
                            ${icon("panel-left", 16)}
                        </button>
                    </div>
                </div>`;
        } else {
            thumbHtml = `<div class="slide-thumb"><span class="slide-thumb-placeholder">第 ${slide.slide_number} 页</span></div>`;
        }

        let html = `<div class="slide-card" data-slide-id="${id}">`;
        html += thumbHtml;
        html += `<div class="slide-info">`;
        html += `<div class="slide-title">${escapeHtml(title)}</div>`;
        html += `<div class="slide-meta">${source}</div>`;  // source 内部已做转义，含图标 SVG
        html += `<div class="slide-category">${catText}</div>`;  // 同上

        // Show collection badges
        if (colIds.length > 0) {
            html += '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px;">';
            for (const cid of colIds) {
                const cname = App._collectionNames && App._collectionNames[cid] || `收藏夹#${cid}`;
                html += `<span class="tag collection-tag" style="background:var(--warning-light);border-color:#fcd34d;">${icon('star', 12)} ${escapeHtml(cname)}</span>`;
            }
            html += '</div>';
        }

        html += '</div>';

        if (showActions) {
            html += `<div class="slide-actions">`;
            html += `<button class="btn btn-sm btn-secondary btn-icon" onclick="App.showSlideEditor(${id})" data-tip="编辑标题与分类" aria-label="编辑标题与分类">`
                 + `${icon('pencil', 14)}</button>`;
            html += `<button class="btn btn-sm btn-secondary btn-icon" onclick="App.confirmDeleteSlide(${id})" data-tip="删除这一页" aria-label="删除这一页">`
                 + `${icon('trash-2', 14)}</button>`;
            // 加入稿件：主动作，靠右，与编辑/删除同一行
            html += `<button class="btn btn-sm btn-secondary btn-icon slide-actions-add" data-sc-add="${id}" data-tip="加入稿件" aria-label="加入稿件">`
                 + `${icon('plus', 14)}</button>`;
            html += '</div>';
        }

        html += '</div>';
        return html;
    },
};

// ─── Global Event Delegation ──────────────────────────────────────
document.addEventListener('click', function(e) {
    // 加入稿件（浏览 / 搜索 / 收藏夹都能用）
    const addBtn = e.target.closest('[data-sc-add]');
    if (addBtn) {
        e.stopPropagation();
        App.addSlideToCompose(parseInt(addBtn.getAttribute('data-sc-add')));
        return;
    }

    // IMPORTANT: check zoom BEFORE open — zoom button is inside the open area
    const zoomBtn = e.target.closest('[data-sc-zoom]');
    if (zoomBtn) {
        e.stopPropagation();
        const slideId = parseInt(zoomBtn.getAttribute('data-sc-zoom'));
        App.zoomThumbnail(slideId);
        return;
    }

    // Collection star button
    const collectBtn = e.target.closest('[data-sc-collect]');
    if (collectBtn) {
        e.stopPropagation();
        const slideId = parseInt(collectBtn.getAttribute('data-sc-collect'));
        App.showCollectionPicker(slideId);
        return;
    }

    const openBtn = e.target.closest('[data-sc-open]');
    if (openBtn) {
        e.stopPropagation();
        const uid = openBtn.getAttribute('data-sc-open');
        const path = (SlideCard._paths && SlideCard._paths[uid]) || '';
        App.openSourceFile(path);
        return;
    }
});

// HTML escape helper (global) — pure string ops, no DOM allocation per call
const _ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, c => _ESCAPE_MAP[c]);
}
