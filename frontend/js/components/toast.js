/**
 * Toast notifications
 * 右下角提示条：深蓝灰底 + 白字（整体一个颜色，只用图标区分类型）；出现后立刻开始变淡，
 * 到时长末尾完全透明并移除。总时长比原来长（6s / 错误 8s），不会一闪就没。
 * 支持 key：同一个 key 只占一条，后来的内容原地替换（连点同一动作不会堆一墙）
 */
const Toast = {
    MAX: 5,             // 最多同时显示几条，超了挤掉最早的
    DEFAULT_MS: 6000,   // 出现即开始淡出，走完 6s 彻底透明
    ERROR_MS: 8000,

    show(message, type = 'info', duration = this.DEFAULT_MS, key = null) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        // 同一 key 原地更新，不新增一条：换文案、重启淡出与计时
        if (key) {
            const prev = container.querySelector(`.toast[data-key="${key}"]`);
            if (prev) {
                const span = prev.querySelector('.toast-msg');
                if (span) span.textContent = message;
                prev.className = `toast toast-${type}`;
                prev.style.setProperty('--toast-dur', `${duration}ms`);
                prev.style.animation = 'none';
                void prev.offsetWidth;   // 强制重排，让动画从头再来
                prev.style.animation = '';
                clearTimeout(prev._timer);
                prev._timer = setTimeout(() => prev.remove(), duration + 120);
                return;
            }
        }

        const icons = { success: 'circle-check', error: 'circle-alert', info: 'info' };
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        if (key) el.dataset.key = key;
        el.style.setProperty('--toast-dur', `${duration}ms`);
        el.innerHTML = `<span class="toast-icon">${icon(icons[type] || 'info', 14)}</span>`
            + '<span class="toast-msg"></span>';
        el.querySelector('.toast-msg').textContent = message;
        // 右上角向下叠：最新的一条插到最上面
        container.insertBefore(el, container.firstElementChild);

        // 超出上限：挤掉最早那条（现在它排在最后）
        while (container.children.length > this.MAX) {
            container.removeChild(container.lastElementChild);
        }

        // 淡出由 CSS 动画负责，这里只负责到点移除
        el._timer = setTimeout(() => el.remove(), duration + 120);
    },

    success(msg, key = null) { this.show(msg, 'success', this.DEFAULT_MS, key); },
    error(msg, key = null) { this.show(msg, 'error', this.ERROR_MS, key); },
    info(msg, key = null) { this.show(msg, 'info', this.DEFAULT_MS, key); },
};
