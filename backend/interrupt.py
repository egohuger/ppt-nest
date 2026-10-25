"""导入中断信号。

用户在界面上点「取消导入」时，`/api/scan/cancel` 会把当前 scan_id 置 0。
解析、渲染、写库各个环节都拿一个 cancel 回调轮询这个标记，命中就抛 Interrupted，
由 server.py 那边回滚整个文件的事务 —— 未完成的那个文件不会留下半截数据。
"""


class Interrupted(Exception):
    """处理被用户中断：调用方负责把这个文件的写入整体撤销。"""
