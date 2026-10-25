/**
 * Files Page - 文件浏览
 * Reuses BrowsePage grid, filtered by selected file.
 */
const FilesPage = {
    async render() {
        // 选中了文件收藏夹：右侧直接铺夹内所有文件的页面（左侧仍留在文件面板）
        if (BrowsePage.currentFile === null && BrowsePage.currentCollection !== null) {
            return BrowsePage.render();
        }

        // Show hint if no file selected
        if (BrowsePage.currentFile === null) {
            return `<div class="page-header">
                <h1 class="page-title">文件浏览</h1>
                <p class="page-subtitle">从左侧选择文件查看其所有页面</p>
            </div>
            <div class="alert alert-info" style="margin-top:40px;text-align:center;">
                ${icon("arrow-left", 14)} 左侧点【打开文件】选一份 PPT，或用 Finder 右键【打开方式】交进来
            </div>`;
        }

        // Delegate to BrowsePage (it reads currentFile from its state)
        return BrowsePage.render();
    }
};
