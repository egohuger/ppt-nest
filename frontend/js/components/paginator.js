/**
 * Paginator component
 */
const Paginator = {
    render(totalItems, pageSize, currentPage, onPageChange, containerId = 'paginator') {
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
        if (totalPages <= 1) return '';

        const maxVisible = 10;
        let pages = [];
        if (totalPages <= maxVisible) {
            pages = Array.from({ length: totalPages }, (_, i) => i + 1);
        } else {
            const start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
            const end = Math.min(totalPages, start + maxVisible - 1);
            const adjustedStart = Math.max(1, end - maxVisible + 1);
            pages = Array.from({ length: end - adjustedStart + 1 }, (_, i) => adjustedStart + i);
        }

        let html = '<div class="paginator">';
        html += `<button ${currentPage <= 1 ? 'disabled' : ''} data-page="${currentPage - 1}">‹</button>`;
        for (const p of pages) {
            html += `<button class="${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
        }
        html += `<button ${currentPage >= totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">›</button>`;
        if (totalPages > 10) {
            html += `<input type="number" min="1" max="${totalPages}" value="${currentPage}" data-jump="true" style="margin-left:8px;width:50px;" title="跳转到">`;
            html += `<button class="btn btn-sm btn-secondary" data-go="true" style="margin-left:4px;">跳转</button>`;
        }
        html += `<span style="margin-left:8px;font-size:12px;color:var(--text-tertiary);">共 ${totalPages} 页</span>`;
        html += '</div>';

        // Delegate clicks via event listener on container
        setTimeout(() => {
            const container = document.getElementById(containerId);
            if (!container) return;
            const pg = container.querySelector('.paginator');
            if (!pg) return;

            // Page number / prev-next buttons
            pg.querySelectorAll('button[data-page]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const p = parseInt(btn.dataset.page);
                    if (!isNaN(p) && p !== currentPage) onPageChange(p);
                });
            });

            // Jump-to-page input (Enter key)
            const jumpInput = pg.querySelector('input[data-jump]');
            if (jumpInput) {
                jumpInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        const p = parseInt(jumpInput.value);
                        if (p >= 1 && p <= totalPages) onPageChange(p);
                    }
                });
            }

            // Go button
            const goBtn = pg.querySelector('button[data-go]');
            if (goBtn && jumpInput) {
                goBtn.addEventListener('click', () => {
                    const p = parseInt(jumpInput.value);
                    if (p >= 1 && p <= totalPages) onPageChange(p);
                });
            }
        }, 0);

        return html;
    },
};
