/**
 * Files Page - 文件浏览
 * Reuses BrowsePage grid, filtered by selected file.
 */
const FilesPage = {
    async render() {
        // Show hint if no file selected
        if (BrowsePage.currentFile === null) {
            return `<div class="page-header">
                <h1 class="page-title">文件浏览</h1>
                <p class="page-subtitle">从左侧选择文件查看其所有页面</p>
            </div>
            <div class="alert alert-info" style="margin-top:40px;text-align:center;">
                👈 请在左侧搜索并选择一个 PPT 文件
            </div>`;
        }

        // Delegate to BrowsePage (it reads currentFile from its state)
        return BrowsePage.render();
    }
};
