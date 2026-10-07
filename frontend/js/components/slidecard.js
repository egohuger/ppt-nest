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
        const source = `📁 ${slide.file_name || ''} · 第${slide.slide_number}页`;

        let catText = '🏷️ 未分类';
        if (slide.category_name) {
            const icons = { auto: '🤖', manual: '👤', llm: '🧠' };
            catText = `🏷️ ${slide.category_name} ${icons[slide.category_source] || ''}`;
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
                        <button class="thumb-zoom-icon" data-sc-zoom="${slide.id}" title="放大查看">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                        </button>
                        <button class="thumb-collect-icon" data-sc-collect="${slide.id}" data-sc-collected="${starData}" title="收藏">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                        </button>
                        <button class="thumb-open-icon" data-sc-open="${uid}" title="打开源文件">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
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
        html += `<div class="slide-meta">${escapeHtml(source)}</div>`;
        html += `<div class="slide-category">${escapeHtml(catText)}</div>`;

        // Show collection badges
        if (colIds.length > 0) {
            html += '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px;">';
            for (const cid of colIds) {
                const cname = App._collectionNames && App._collectionNames[cid] || `收藏夹#${cid}`;
                html += `<span class="tag collection-tag" style="background:var(--warning-light);border-color:#fcd34d;">⭐ ${escapeHtml(cname)}</span>`;
            }
            html += '</div>';
        }

        html += '</div>';

        if (showActions) {
            html += `<div style="padding:0 14px 10px;display:flex;gap:4px;flex-wrap:wrap;">`;
            html += `<button class="btn btn-sm btn-secondary" onclick="App.showSlideEditor(${id})">✏️ 编辑</button>`;
            html += `<button class="btn btn-sm btn-secondary" onclick="App.confirmDeleteSlide(${id})">🗑️</button>`;
            html += '</div>';
        }

        html += '</div>';
        return html;
    },
};

// ─── Global Event Delegation ──────────────────────────────────────
document.addEventListener('click', function(e) {
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
