/**
 * Modal dialog
 */
const Modal = {
    show(title, contentHtml, actions = []) {
        const overlay = document.getElementById('modal-overlay');
        const box = document.getElementById('modal-box');
        overlay.style.display = 'flex';

        let html = `<div class="modal-header">`;
        html += `<div class="modal-title">${title}</div>`;
        html += `<button class="modal-close-btn" onclick="Modal.hide()" title="关闭">&times;</button>`;
        html += `</div>`;
        html += `<div class="modal-body">${contentHtml}</div>`;
        if (actions.length > 0) {
            html += '<div class="modal-actions">';
            for (const a of actions) {
                const cls = a.primary ? 'btn-primary' : 'btn-secondary';
                html += `<button class="btn ${cls} modal-action-btn" data-action="${a.key || ''}">${a.label}</button>`;
            }
            html += '</div>';
        }
        box.innerHTML = html;

        // Bind actions
        const btns = box.querySelectorAll('.modal-action-btn');
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.action;
                const action = actions.find(a => (a.key || '') === key);
                if (action && action.onClick) action.onClick();
                if (action && action.closeOnClick !== false) this.hide();
            });
        });

        // Click outside to close
        overlay.onclick = (e) => {
            if (e.target === overlay) this.hide();
        };
    },

    hide() {
        document.getElementById('modal-overlay').style.display = 'none';
    },

    confirm(title, message, onConfirm, onCancel) {
        // Wrap callbacks to ensure correct this context
        const wrappedConfirm = onConfirm ? () => onConfirm() : undefined;
        const wrappedCancel = onCancel ? () => onCancel() : undefined;
        this.show(title, `<p>${message}</p>`, [
            { label: '取消', key: 'cancel', onClick: wrappedCancel },
            { label: '确认', key: 'confirm', primary: true, onClick: wrappedConfirm },
        ]);
    },
};
