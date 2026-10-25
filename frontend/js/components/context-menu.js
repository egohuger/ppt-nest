/**
 * ContextMenu - 轻量右键菜单
 *
 * ContextMenu.show(x, y, items)
 *   items: [{ label, icon?, onClick, danger?, disabled? } | { sep: true }]
 */
const ContextMenu = {
    _el: null,
    _bound: null,

    show(x, y, items) {
        this.hide();
        const el = document.createElement('div');
        el.className = 'ctx-menu';
        el.setAttribute('role', 'menu');

        for (const it of items || []) {
            if (!it || it.sep) {
                el.insertAdjacentHTML('beforeend', '<div class="ctx-sep"></div>');
                continue;
            }
            const row = document.createElement('button');
            row.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
            row.setAttribute('role', 'menuitem');
            if (it.disabled) row.disabled = true;
            const ic = it.icon ? `<span class="ctx-ico">${icon(it.icon, 13)}</span>` : '<span class="ctx-ico"></span>';
            row.innerHTML = ic + `<span class="ctx-label">${it.label}</span>`;
            row.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (it.disabled) return;
                this.hide();
                try { it.onClick && it.onClick(); } catch (e) { console.error(e); }
            });
            el.appendChild(row);
        }

        document.body.appendChild(el);
        // 先量再定位，超出视口就往回收
        const r = el.getBoundingClientRect();
        const pad = 6;
        let left = x, top = y;
        if (left + r.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - r.width - pad);
        if (top + r.height + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - r.height - pad);
        el.style.left = left + 'px';
        el.style.top = top + 'px';

        this._el = el;
        // 点别处 / Esc / 滚动 / 窗口失焦 都关掉
        const onDown = (ev) => { if (!el.contains(ev.target)) this.hide(); };
        const onKey = (ev) => { if (ev.key === 'Escape') { this.hide(); } };
        const onScroll = () => this.hide();
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onScroll, true);
        document.addEventListener('scroll', onScroll, true);
        this._bound = { onDown, onKey, onScroll };
        return el;
    },

    hide() {
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null;
        if (this._bound) {
            const { onDown, onKey, onScroll } = this._bound;
            document.removeEventListener('mousedown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('resize', onScroll, true);
            document.removeEventListener('scroll', onScroll, true);
            this._bound = null;
        }
    },
};
