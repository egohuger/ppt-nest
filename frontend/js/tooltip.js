/**
 * PPT Nest - 轻量气泡提示（tooltip）
 *
 * 用法：给任意元素加 data-tip="文案"，悬停 400ms 或键盘聚焦后出现。
 * 与原生 title 的区别：样式可控、出现更快、贴边自动翻转/夹紧、支持多行。
 * 原生 title 会同时弹出，所以用了 data-tip 的元素请去掉 title，语义留给 aria-label。
 */
const Tooltip = {
    DELAY: 400,
    GAP: 8,      // 气泡与触发元素的间距
    MARGIN: 10,  // 距视口边缘的最小距离

    el: null,
    trigger: null,     // 气泡正在指向的元素
    pending: null,     // 已排定延迟、还没弹出的元素
    timer: 0,
    seq: 0,

    init() {
        if (this.el) return;
        const el = document.createElement('div');
        el.className = 'htip';
        el.setAttribute('role', 'tooltip');
        el.id = 'htip';
        el.style.setProperty('--ax', '50%');
        document.body.appendChild(el);
        this.el = el;

        document.addEventListener('pointerover', (e) => this._onOver(e), true);
        document.addEventListener('pointerout', (e) => this._onOut(e), true);
        document.addEventListener('pointerdown', () => this.hide(), true);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.hide(); }, true);
        document.addEventListener('focusin', (e) => {
            const t = e.target.closest && e.target.closest('[data-tip]');
            if (t) this._show(t, 0);
        }, true);
        document.addEventListener('focusout', () => this.hide(), true);
        window.addEventListener('scroll', () => this.hide(), true);
        window.addEventListener('blur', () => this.hide());
        window.addEventListener('resize', () => this.hide());
    },

    _onOver(e) {
        const t = e.target.closest && e.target.closest('[data-tip]');
        if (!t) return;
        // 从子元素移到父元素（或反过来）时不要重排闪烁
        if (t === this.trigger && this.el.classList.contains('in')) return;
        this._show(t, this.DELAY);
    },

    _onOut(e) {
        const t = e.target.closest && e.target.closest('[data-tip]');
        if (!t) return;
        const to = e.relatedTarget;
        // 只是在按钮内部从 svg 移到按钮本身（或反过来），不算离开
        if (to && t.contains(to)) return;
        // 关键：还没弹出但已排定的，离开也必须取消，
        // 否则快速掠过图标后指针已经走远，400ms 后气泡仍会冒出来
        if (this.pending === t || this.trigger === t) this.hide();
    },

    _show(trigger, delay) {
        const text = (trigger.getAttribute('data-tip') || '').trim();
        if (!text) return;
        clearTimeout(this.timer);
        const seq = ++this.seq;
        this.pending = trigger;
        const fire = () => {
            // 延迟期间卡片可能被重渲染，触发元素已不在文档里就放弃
            if (seq !== this.seq || !trigger.isConnected) return;
            this.trigger = trigger;
            this.pending = null;
            this.el.textContent = text;
            this.el.classList.add('visible');
            this._place();
            // 下一帧再加 in，让位置先落定，避免淡入时从旧位置滑过来
            requestAnimationFrame(() => {
                if (seq === this.seq) this.el.classList.add('in');
            });
        };
        if (!delay) fire();
        else this.timer = setTimeout(fire, delay);
    },

    _place() {
        const el = this.el, r = this.trigger.getBoundingClientRect();
        el.style.left = '0px';
        el.style.top = '0px';
        el.dataset.side = 'top';
        const box = el.getBoundingClientRect();

        let left = r.left + r.width / 2 - box.width / 2;
        left = Math.max(this.MARGIN, Math.min(left, window.innerWidth - box.width - this.MARGIN));

        let top = r.top - box.height - this.GAP;
        if (top < this.MARGIN) {
            top = r.bottom + this.GAP;
            el.dataset.side = 'bottom';
        }

        el.style.left = Math.round(left) + 'px';
        el.style.top = Math.round(top) + 'px';
        // 小三角始终对准触发元素中心（已被夹紧的部分不偏移）
        const ax = Math.max(10, Math.min(box.width - 10, r.left + r.width / 2 - left));
        el.style.setProperty('--ax', Math.round(ax) + 'px');
    },

    hide() {
        clearTimeout(this.timer);
        this.timer = 0;
        this.seq++;
        this.trigger = null;
        this.pending = null;
        if (this.el) {
            this.el.classList.remove('in');
            this.el.classList.remove('visible');
        }
    },
};

document.addEventListener('DOMContentLoaded', () => Tooltip.init());
if (document.readyState !== 'loading') Tooltip.init();
