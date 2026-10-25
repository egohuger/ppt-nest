import sqlite3
import json
import os
import logging
import threading
from contextlib import contextmanager

from config import get_db_path, get_thumbnail_dir

_log = logging.getLogger('pptnest.database')

# 浏览时默认排除已隐藏的重复副本
_HIDDEN_FILTER = (
    "s.id NOT IN ("
    "SELECT slide_id FROM duplicate_members WHERE is_hidden = 1"
    ")"
)


class Database:
    def __init__(self, db_path=None):
        self.db_path = db_path or get_db_path()
        parent = os.path.dirname(self.db_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys = ON")
        self._init_schema()

    # ── Visibility helper — replaces f-string SQL injection ──

    @staticmethod
    def _vis(include_hidden):
        """Return '' or a safe WHERE clause filtering hidden duplicates."""
        return '' if include_hidden else ' AND ' + _HIDDEN_FILTER

    @staticmethod
    def _like_pattern(keyword):
        """Build a LIKE pattern with %, _ and \\ escaped (used with ESCAPE '\\')."""
        esc = keyword.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        return '%' + esc + '%'

    @staticmethod
    def q_tokens(q):
        """把搜索词拆成多个关键词：空格（含全角空格）分隔，忽略空项。

        多个关键词之间是 AND —— 一页里每个词都出现才算命中。
        """
        return [t for t in (q or '').replace('\u3000', ' ').split() if t]

    # ── Schema ──

    def _init_schema(self):
        self.conn.executescript('''
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT UNIQUE NOT NULL,
                file_name TEXT NOT NULL,
                file_size INTEGER,
                modified_time REAL,
                total_slides INTEGER DEFAULT 0,
                processed INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime')),
                updated_at TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS slides (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL,
                slide_number INTEGER NOT NULL,
                title TEXT DEFAULT '',
                text_content TEXT DEFAULT '',
                content_hash TEXT DEFAULT '',
                thumbnail_path TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
                UNIQUE(file_id, slide_number)
            );

            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                parent_id INTEGER,
                keywords TEXT DEFAULT '[]',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS slide_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slide_id INTEGER NOT NULL,
                category_id INTEGER NOT NULL,
                confidence REAL DEFAULT 0.0,
                source TEXT DEFAULT 'auto',
                created_at TEXT DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (slide_id) REFERENCES slides(id) ON DELETE CASCADE,
                FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
                UNIQUE(slide_id)
            );

            CREATE TABLE IF NOT EXISTS duplicate_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_type TEXT DEFAULT 'exact',
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS duplicate_members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                slide_id INTEGER NOT NULL,
                similarity REAL DEFAULT 1.0,
                is_primary INTEGER DEFAULT 0,
                is_hidden INTEGER DEFAULT 0,
                FOREIGN KEY (group_id) REFERENCES duplicate_groups(id) ON DELETE CASCADE,
                FOREIGN KEY (slide_id) REFERENCES slides(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS collections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS collection_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection_id INTEGER NOT NULL,
                slide_id INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
                FOREIGN KEY (slide_id) REFERENCES slides(id) ON DELETE CASCADE,
                UNIQUE(collection_id, slide_id)
            );

            -- 类别级收藏：夹里装的是「分类」本身（点开看这类下面的页）
            CREATE TABLE IF NOT EXISTS collection_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection_id INTEGER NOT NULL,
                category_id INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
                FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
                UNIQUE(collection_id, category_id)
            );

            -- 文件级收藏：和 collection_items（页面级）并列，互不混合
            CREATE TABLE IF NOT EXISTS collection_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection_id INTEGER NOT NULL,
                file_id INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
                FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
                UNIQUE(collection_id, file_id)
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            -- 导入耗时样本：用来按「本机实际速度」估算，而不是写死一个常量
            -- （不同电脑的 LibreOffice 启动、磁盘、CPU 差异能到 5-10 倍）
            CREATE TABLE IF NOT EXISTS perf_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                seconds REAL NOT NULL,
                slides INTEGER NOT NULL DEFAULT 0,
                engine TEXT,
                llm INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );

            -- 手动组页：一份稿件 = 若干页的顺序集合（同一页允许出现多次）
            CREATE TABLE IF NOT EXISTS compositions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now','localtime')),
                updated_at TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS composition_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                comp_id INTEGER NOT NULL,
                slide_id INTEGER NOT NULL,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (comp_id) REFERENCES compositions(id) ON DELETE CASCADE,
                FOREIGN KEY (slide_id) REFERENCES slides(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_comp_items ON composition_items(comp_id, sort_order);

            CREATE INDEX IF NOT EXISTS idx_slides_file ON slides(file_id);
            CREATE INDEX IF NOT EXISTS idx_slides_hash ON slides(content_hash);
            CREATE INDEX IF NOT EXISTS idx_sc_slide ON slide_categories(slide_id);
            CREATE INDEX IF NOT EXISTS idx_sc_cat ON slide_categories(category_id);
            CREATE INDEX IF NOT EXISTS idx_cat_parent ON categories(parent_id);
            CREATE INDEX IF NOT EXISTS idx_col_items_col ON collection_items(collection_id);
            CREATE INDEX IF NOT EXISTS idx_col_items_slide ON collection_items(slide_id);
            CREATE INDEX IF NOT EXISTS idx_col_cats_col ON collection_categories(collection_id);
            CREATE INDEX IF NOT EXISTS idx_col_cats_cat ON collection_categories(category_id);
            CREATE INDEX IF NOT EXISTS idx_col_files_col ON collection_files(collection_id);
            CREATE INDEX IF NOT EXISTS idx_col_files_file ON collection_files(file_id);
            CREATE INDEX IF NOT EXISTS idx_dm_hidden_slide ON duplicate_members(is_hidden, slide_id);
        ''')

        # 老库补列：骨架标记（组稿可以另存为可复用的「骨架」）
        cols = [r[1] for r in self.conn.execute('PRAGMA table_info(compositions)').fetchall()]
        if 'is_template' not in cols:
            self.conn.execute('ALTER TABLE compositions ADD COLUMN is_template INTEGER DEFAULT 0')

        # 老库补列：收藏夹分两类（slide=页面收藏夹，file=文件收藏夹）
        ccols = [r[1] for r in self.conn.execute('PRAGMA table_info(collections)').fetchall()]
        if 'kind' not in ccols:
            self.conn.execute("ALTER TABLE collections ADD COLUMN kind TEXT DEFAULT 'slide'")

        self.conn.commit()

    # ── File operations ──

    def add_file(self, file_path, file_name, file_size, modified_time, total_slides=0):
        existing = self.get_file_by_path(file_path)
        if existing:
            file_id = existing['id']
            self.conn.execute('DELETE FROM slides WHERE file_id = ?', (file_id,))
            self.conn.execute(
                '''UPDATE files SET file_name=?, file_size=?, modified_time=?,
                   total_slides=?, processed=0, updated_at=datetime('now','localtime')
                   WHERE id=?''',
                (file_name, file_size, modified_time, total_slides, file_id))
            self.conn.commit()
            return file_id
        else:
            cur = self.conn.execute(
                '''INSERT INTO files (file_path, file_name, file_size, modified_time, total_slides)
                   VALUES (?, ?, ?, ?, ?)''',
                (file_path, file_name, file_size, modified_time, total_slides))
            self.conn.commit()
            return cur.lastrowid

    def get_file_by_path(self, file_path):
        return self.conn.execute(
            'SELECT * FROM files WHERE file_path = ?', (file_path,)
        ).fetchone()

    # ── 事务：把「一个文件」的所有写入合成一次提交 ──

    @contextmanager
    def transaction(self):
        """把一段写操作包成一个事务。

        期间所有 commit 都推迟到退出时一次提交，异常（含用户取消的 Interrupted）
        时整体回滚 —— 导入被打断时，正在处理的那个文件不会留下半截数据，
        重扫（changed）被打断时旧版本的数据也会原样回来。
        只有发起事务的线程受推迟影响，别的线程照常提交。
        """
        if getattr(self, '_tx_owner', None) is not None:
            yield                      # 嵌套调用：交给最外层管
            return

        real = self.conn
        owner = threading.get_ident()

        class _Deferred:
            def __getattr__(self, name):
                return getattr(real, name)

            def commit(self):
                if threading.get_ident() != owner:
                    real.commit()      # 别的线程写完照常落盘
                # 本线程：推迟到事务结束

        self._tx_owner = owner
        self.conn = _Deferred()
        try:
            yield
            real.commit()
        except BaseException:
            real.rollback()
            raise
        finally:
            self.conn = real
            self._tx_owner = None

    def get_all_files(self):
        return self.conn.execute(
            'SELECT * FROM files ORDER BY file_name'
        ).fetchall()

    def update_file_path(self, file_id, new_path):
        """文件被移动/改名后只改路径，保留 file_id（缩略图目录按 file_id 命名，不受影响）。"""
        self.conn.execute(
            "UPDATE files SET file_path = ?, file_name = ?, updated_at = datetime('now','localtime') WHERE id = ?",
            (new_path, os.path.basename(new_path), file_id))
        self.conn.commit()

    def get_files_with_counts(self):
        """Return all files with their slide counts."""
        return self.conn.execute(
            '''SELECT f.*, COUNT(s.id) AS slide_count
               FROM files f LEFT JOIN slides s ON s.file_id = f.id
               GROUP BY f.id ORDER BY f.file_name'''
        ).fetchall()

    def mark_file_processed(self, file_id):
        self.conn.execute(
            'UPDATE files SET processed=1, updated_at=datetime("now","localtime") WHERE id=?',
            (file_id,))
        self.conn.commit()

    def delete_file(self, file_id):
        self.conn.execute('DELETE FROM files WHERE id = ?', (file_id,))
        self.conn.commit()

    def delete_file_by_path(self, file_path):
        self.conn.execute('DELETE FROM files WHERE file_path = ?', (file_path,))
        self.conn.commit()

    # ── 从素材库移除文件（只删库记录和缩略图，磁盘上的源 PPT 一律不动）──

    def deletion_impact(self, file_ids):
        """移除前的影响面：多少页、几条归类、落在哪些收藏夹/组稿、几个重复组。

        用 JOIN slides.file_id 而不是把 slide id 塞进 IN(...)，文件页数再多也不会
        撑爆 SQLite 的变量上限。
        """
        ids = [int(i) for i in (file_ids or [])]
        out = {"files": [], "totals": {
            "files": 0, "slides": 0, "categorized": 0,
            "collections": 0, "collection_names": [],
            "file_collections": 0, "file_collection_names": [],
            "compositions": 0, "composition_names": [],
            "dup_groups": 0,
        }}
        if not ids:
            return out

        ph = ','.join('?' * len(ids))
        files = self.conn.execute(
            f'''SELECT id, file_name, file_size, total_slides, created_at
                FROM files WHERE id IN ({ph}) ORDER BY file_name''', ids).fetchall()
        counts = {r['file_id']: r['n'] for r in self.conn.execute(
            f'SELECT file_id, COUNT(*) n FROM slides WHERE file_id IN ({ph}) GROUP BY file_id',
            ids).fetchall()}

        for f in files:
            out["files"].append({
                "id": f['id'], "name": f['file_name'], "size": f['file_size'] or 0,
                "slides": counts.get(f['id'], 0), "created_at": f['created_at'],
            })

        out["totals"]["files"] = len(files)
        out["totals"]["slides"] = sum(counts.values())
        out["totals"]["categorized"] = self.conn.execute(
            f'''SELECT COUNT(*) c FROM slide_categories sc
                JOIN slides s ON s.id = sc.slide_id WHERE s.file_id IN ({ph})''',
            ids).fetchone()['c']
        cols = self.conn.execute(
            f'''SELECT c.name AS name, COUNT(*) AS n
                FROM collection_items ci
                JOIN slides s ON s.id = ci.slide_id
                JOIN collections c ON c.id = ci.collection_id
                WHERE s.file_id IN ({ph})
                GROUP BY c.id ORDER BY n DESC''', ids).fetchall()
        out["totals"]["collections"] = sum(r['n'] for r in cols)
        out["totals"]["collection_names"] = [r['name'] for r in cols]
        # 文件收藏夹：这几份文件本身被收进了哪些夹
        fcols = self.conn.execute(
            f'''SELECT c.name AS name, COUNT(*) AS n
                FROM collection_files cf
                JOIN collections c ON c.id = cf.collection_id
                WHERE cf.file_id IN ({ph})
                GROUP BY c.id ORDER BY n DESC''', ids).fetchall()
        out["totals"]["file_collections"] = sum(r['n'] for r in fcols)
        out["totals"]["file_collection_names"] = [r['name'] for r in fcols]
        comps = self.conn.execute(
            f'''SELECT c.name AS name, COUNT(*) AS n
                FROM composition_items it
                JOIN slides s ON s.id = it.slide_id
                JOIN compositions c ON c.id = it.comp_id
                WHERE s.file_id IN ({ph})
                GROUP BY c.id ORDER BY n DESC''', ids).fetchall()
        out["totals"]["compositions"] = sum(r['n'] for r in comps)
        out["totals"]["composition_names"] = [r['name'] for r in comps]
        out["totals"]["dup_groups"] = self.conn.execute(
            f'''SELECT COUNT(DISTINCT dm.group_id) c FROM duplicate_members dm
                JOIN slides s ON s.id = dm.slide_id WHERE s.file_id IN ({ph})''',
            ids).fetchone()['c']
        return out

    def delete_files(self, file_ids):
        """删掉文件记录；slides / 归类 / 收藏 / 组稿 / 重复组靠外键级联一起清。

        返回实际删掉的文件数和页数。缩略图目录由调用方清理。
        """
        ids = [int(i) for i in (file_ids or [])]
        if not ids:
            return {"deleted": 0, "slides": 0}
        ph = ','.join('?' * len(ids))
        slides = self.conn.execute(
            f'SELECT COUNT(*) c FROM slides WHERE file_id IN ({ph})', ids).fetchone()['c']
        cur = self.conn.execute(f'DELETE FROM files WHERE id IN ({ph})', ids)
        deleted = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        # 成员被删空的重复组一并清掉，否则重复检测页会留下空组
        self.conn.execute(
            '''DELETE FROM duplicate_groups
               WHERE id NOT IN (SELECT DISTINCT group_id FROM duplicate_members)''')
        self.conn.commit()
        return {"deleted": deleted, "slides": slides}

    # ── Slide operations ──

    def add_slide(self, file_id, slide_number, title, text_content, content_hash,
                  thumbnail_path=''):
        cur = self.conn.execute(
            '''INSERT OR REPLACE INTO slides
               (file_id, slide_number, title, text_content, content_hash, thumbnail_path)
               VALUES (?, ?, ?, ?, ?, ?)''',
            (file_id, slide_number, title, text_content, content_hash, thumbnail_path))
        self.conn.commit()
        return cur.lastrowid

    def get_slides_by_file(self, file_id, include_hidden=False):
        return self.conn.execute(
            '''SELECT s.*, f.file_name, f.file_path
               FROM slides s JOIN files f ON s.file_id = f.id
               WHERE s.file_id = ?''' + self._vis(include_hidden) +
            ' ORDER BY s.slide_number',
            (file_id,)).fetchall()

    def get_slide_by_id(self, slide_id):
        return self.conn.execute(
            'SELECT * FROM slides WHERE id = ?', (slide_id,)).fetchone()

    def get_all_slides(self, include_hidden=False):
        sql = (
            'SELECT s.*, f.file_name, f.file_path '
            'FROM slides s JOIN files f ON s.file_id = f.id '
            'WHERE 1=1' + self._vis(include_hidden) + ' '
            'ORDER BY f.file_name, s.slide_number'
        )
        return self.conn.execute(sql).fetchall()

    def get_slides_by_category(self, category_id, include_hidden=False, include_children=False):
        if include_children:
            ids = self.get_all_descendant_ids(category_id)
            placeholders = ','.join('?' * len(ids))
            sql = (
                f'SELECT s.*, f.file_name, f.file_path, sc.confidence, sc.source '
                f'FROM slides s '
                f'JOIN slide_categories sc ON s.id = sc.slide_id '
                f'JOIN files f ON s.file_id = f.id '
                f'WHERE sc.category_id IN ({placeholders})'
                + self._vis(include_hidden) + ' '
                f'ORDER BY sc.confidence DESC, f.file_name, s.slide_number'
            )
            return self.conn.execute(sql, ids).fetchall()
        else:
            sql = (
                'SELECT s.*, f.file_name, f.file_path, sc.confidence, sc.source '
                'FROM slides s '
                'JOIN slide_categories sc ON s.id = sc.slide_id '
                'JOIN files f ON s.file_id = f.id '
                'WHERE sc.category_id = ?' + self._vis(include_hidden) + ' '
                'ORDER BY sc.confidence DESC, f.file_name, s.slide_number'
            )
            return self.conn.execute(sql, (category_id,)).fetchall()

    def get_uncategorized_slides(self, include_hidden=False):
        sql = (
            'SELECT s.*, f.file_name, f.file_path '
            'FROM slides s '
            'JOIN files f ON s.file_id = f.id '
            'WHERE s.id NOT IN (SELECT slide_id FROM slide_categories)'
            + self._vis(include_hidden) + ' '
            'ORDER BY f.file_name, s.slide_number'
        )
        return self.conn.execute(sql).fetchall()

    def search_slides(self, keyword, include_hidden=False):
        # 多个关键词（空格分隔）之间是 AND
        tokens = self.q_tokens(keyword) or [keyword]
        where = ' AND '.join(
            ["(s.text_content LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')"] * len(tokens))
        params = []
        for t in tokens:
            pat = self._like_pattern(t)
            params.extend([pat, pat])
        sql = (
            'SELECT s.*, f.file_name, f.file_path '
            'FROM slides s JOIN files f ON s.file_id = f.id '
            'WHERE ' + where
            + self._vis(include_hidden) + ' '
            'ORDER BY f.file_name, s.slide_number'
        )
        return self.conn.execute(sql, params).fetchall()

    def get_slides_filtered(self, category_id=None, include_children=False,
                            collection_id=None, file_id=None, q=None,
                            include_hidden=False):
        """Unified slide query with SQL-level filtering.
        Replaces the pattern of loading all slides then filtering in Python."""
        base_select = (
            'SELECT s.*, f.file_name, f.file_path '
            'FROM slides s JOIN files f ON s.file_id = f.id '
        )
        joins = []
        wheres = []
        params = []

        if collection_id is not None:
            # 页面收藏夹：夹里的页；文件收藏夹：夹里所有文件的全部页；
            # 类别收藏夹：夹里那些分类（含子分类）下的所有页
            kind = self.get_collection_kind(collection_id)
            if kind == 'category':
                cat_ids = [r['category_id'] for r in self.conn.execute(
                    'SELECT category_id FROM collection_categories WHERE collection_id = ?',
                    (collection_id,)).fetchall()]
                expanded = []
                for cid in cat_ids:
                    expanded.extend(self.get_all_descendant_ids(cid))
                if not expanded:
                    wheres.append('0 = 1')
                else:
                    ph = ','.join('?' * len(expanded))
                    wheres.append(
                        f's.id IN (SELECT slide_id FROM slide_categories WHERE category_id IN ({ph}))')
                    params.extend(expanded)
            elif kind == 'file':
                wheres.append(
                    's.file_id IN (SELECT file_id FROM collection_files WHERE collection_id = ?)'
                )
                params.append(collection_id)
            else:
                joins.append(
                    'JOIN collection_items ci ON ci.slide_id = s.id '
                )
                wheres.append('ci.collection_id = ?')
                params.append(collection_id)

        if category_id is not None and category_id != -1:
            if include_children:
                ids = self.get_all_descendant_ids(category_id)
                placeholders = ','.join('?' * len(ids))
                joins.append(
                    'JOIN slide_categories sc ON s.id = sc.slide_id '
                )
                wheres.append(f'sc.category_id IN ({placeholders})')
                params.extend(ids)
            else:
                joins.append(
                    'JOIN slide_categories sc ON s.id = sc.slide_id '
                )
                wheres.append('sc.category_id = ?')
                params.append(category_id)
        elif category_id == -1:
            wheres.append(
                's.id NOT IN (SELECT slide_id FROM slide_categories)'
            )

        if file_id is not None:
            wheres.append('s.file_id = ?')
            params.append(file_id)

        if q:
            # 空格分隔的多个关键词：每个词都要命中（标题或正文），即 AND
            for tok in self.q_tokens(q):
                wheres.append("(s.title LIKE ? ESCAPE '\\' OR s.text_content LIKE ? ESCAPE '\\')")
                pat = self._like_pattern(tok)
                params.extend([pat, pat])

        sql = base_select + ''.join(joins)
        if wheres:
            sql += 'WHERE ' + ' AND '.join(wheres)
        else:
            sql += 'WHERE 1=1'
        sql += self._vis(include_hidden)
        sql += ' ORDER BY f.file_name, s.slide_number'

        return self.conn.execute(sql, params).fetchall()

    def update_slide_thumbnail(self, slide_id, thumbnail_path):
        self.conn.execute(
            'UPDATE slides SET thumbnail_path = ? WHERE id = ?',
            (thumbnail_path, slide_id))
        self.conn.commit()

    def _resolve_thumbnail(self, thumb_path):
        if not thumb_path:
            return None
        if os.path.isabs(thumb_path) and os.path.exists(thumb_path):
            return thumb_path
        thumb_dir = get_thumbnail_dir()
        resolved = os.path.join(thumb_dir, thumb_path)
        if os.path.exists(resolved):
            return resolved
        norm = thumb_path.replace('\\', '/')
        if '/thumbnails/' in norm:
            resolved = os.path.join(thumb_dir, norm.split('/thumbnails/')[-1])
            if os.path.exists(resolved):
                return resolved
        return None

    # ── Slide operations (continued) ──

    def delete_slide_completely(self, slide_id):
        from ppt_parser import delete_slide_from_file
        slide = self.get_slide_by_id(slide_id)
        if not slide:
            return False, "未找到该页面记录"

        file_id = slide['file_id']
        slide_number = slide['slide_number']

        file_info = self.conn.execute(
            'SELECT file_path FROM files WHERE id = ?', (file_id,)).fetchone()
        file_path = file_info['file_path'] if file_info else None

        if file_path and os.path.exists(file_path):
            try:
                delete_slide_from_file(file_path, slide_number)
            except Exception as e:
                _log.error("delete_slide_from_file failed: %s", e)
                return False, f"源PPT处理失败, 可能处于打开状态或只读: {str(e)}"
        else:
            return False, "源文件不存在"

        if slide['thumbnail_path']:
            thumb_path = self._resolve_thumbnail(slide['thumbnail_path'])
            if thumb_path and os.path.exists(thumb_path):
                try:
                    os.remove(thumb_path)
                except Exception:
                    pass

        # First update DB slide_number for subsequent slides, THEN rename thumbnails
        # Also refresh the source file's mtime/size in DB — otherwise the next scan
        # sees the file as "modified" and re-imports it entirely (losing all
        # manual categories/collections for its remaining slides).
        try:
            new_stat = os.stat(file_path)
        except OSError:
            new_stat = None

        self.conn.execute('DELETE FROM slides WHERE id = ?', (slide_id,))
        self.conn.execute(
            'UPDATE slides SET slide_number = slide_number - 1 '
            'WHERE file_id = ? AND slide_number > ?',
            (file_id, slide_number))
        if new_stat is not None:
            self.conn.execute(
                'UPDATE files SET total_slides = total_slides - 1, '
                'file_size = ?, modified_time = ?, '
                "updated_at = datetime('now','localtime') WHERE id = ?",
                (new_stat.st_size, new_stat.st_mtime, file_id))
        else:
            self.conn.execute(
                'UPDATE files SET total_slides = total_slides - 1 WHERE id = ?',
                (file_id,))
        self.conn.commit()

        # Now rename thumbnails to match the new slide_numbers
        subsequent = self.conn.execute(
            'SELECT id, slide_number, thumbnail_path FROM slides '
            'WHERE file_id = ? ORDER BY slide_number ASC',
            (file_id,)
        ).fetchall()

        for sub in subsequent:
            if sub['thumbnail_path']:
                old_thumb = self._resolve_thumbnail(sub['thumbnail_path'])
                if old_thumb and os.path.exists(old_thumb):
                    expected_name = f"slide_{sub['slide_number']}.png"
                    if os.path.basename(old_thumb) != expected_name:
                        new_thumb = os.path.join(
                            os.path.dirname(old_thumb), expected_name)
                        try:
                            os.rename(old_thumb, new_thumb)
                            rel_path = f"{file_id}/{expected_name}"
                            self.conn.execute(
                                'UPDATE slides SET thumbnail_path = ? WHERE id = ?',
                                (rel_path, sub['id']))
                        except Exception:
                            pass
        self.conn.commit()

        return True, "彻底删除成功"

    def delete_slide_softly(self, slide_id):
        """只清理数据库信息和它附属的缩略图图源，不改动物理PPT并不让后续页号位移。"""
        slide = self.get_slide_by_id(slide_id)
        if not slide:
            return False, "未找到该页面记录"

        file_id = slide['file_id']

        if slide['thumbnail_path']:
            thumb_path = self._resolve_thumbnail(slide['thumbnail_path'])
            if thumb_path and os.path.exists(thumb_path):
                try:
                    os.remove(thumb_path)
                except Exception:
                    pass

        self.conn.execute('DELETE FROM slides WHERE id = ?', (slide_id,))
        self.conn.execute(
            'UPDATE files SET total_slides = total_slides - 1 WHERE id = ?',
            (file_id,))
        self.conn.commit()

        return True, "已成功从库中移除重复页及缩略图"

    # ── Category operations ──

    def add_category(self, name, parent_id=None, keywords=None, sort_order=0):
        kw_json = json.dumps(keywords or [], ensure_ascii=False)
        cur = self.conn.execute(
            'INSERT INTO categories (name, parent_id, keywords, sort_order) VALUES (?,?,?,?)',
            (name, parent_id, kw_json, sort_order))
        self.conn.commit()
        return cur.lastrowid

    def get_all_categories(self):
        return self.conn.execute(
            'SELECT * FROM categories ORDER BY sort_order, name'
        ).fetchall()

    def get_root_categories(self):
        return self.conn.execute(
            'SELECT * FROM categories WHERE parent_id IS NULL ORDER BY sort_order, name'
        ).fetchall()

    def get_children(self, parent_id):
        """Get immediate children of a category. Pass None for roots."""
        if parent_id is None:
            return self.get_root_categories()
        return self.conn.execute(
            'SELECT * FROM categories WHERE parent_id = ? ORDER BY sort_order, name',
            (parent_id,)).fetchall()

    def get_all_descendant_ids(self, cat_id):
        """Collect all descendant category IDs (recursive, for cumulative counts)."""
        ids = [cat_id]
        for child in self.get_children(cat_id):
            ids.extend(self.get_all_descendant_ids(child['id']))
        return ids

    def get_category_tree(self, parent_id=None, max_depth=5, with_members=False):
        """Return the full category tree as nested dicts. max_depth guards infinite loops.
        Uses batch COUNT queries instead of per-node N+1.

        with_members=True 时每个节点额外带 slide_ids / collection_ids，
        供导出→导入往返时把页面归属与类别收藏夹成员一起恢复。
        """
        if max_depth <= 0:
            return []

        # Fetch all categories in one shot and build lookup maps
        all_cats = self.conn.execute(
            'SELECT * FROM categories ORDER BY sort_order, name'
        ).fetchall()

        # Build parent→children map
        children_map = {}
        cat_by_id = {}
        for c in all_cats:
            cid = c['id']
            cat_by_id[cid] = c
            pid = c['parent_id']
            if pid not in children_map:
                children_map[pid] = []
            children_map[pid].append(cid)

        # Batch direct counts: one query with GROUP BY
        direct_counts = {}
        count_rows = self.conn.execute(
            '''SELECT sc.category_id, COUNT(*) AS cnt
               FROM slide_categories sc
               WHERE sc.slide_id NOT IN (
                   SELECT slide_id FROM duplicate_members WHERE is_hidden = 1
               )
               GROUP BY sc.category_id'''
        ).fetchall()
        for r in count_rows:
            direct_counts[r['category_id']] = r['cnt']

        members_map, coll_map = {}, {}
        if with_members:
            for r in self.conn.execute(
                    'SELECT category_id, slide_id FROM slide_categories'):
                members_map.setdefault(r['category_id'], []).append(r['slide_id'])
            for r in self.conn.execute(
                    'SELECT category_id, collection_id FROM collection_categories'):
                coll_map.setdefault(r['category_id'], []).append(r['collection_id'])

        def _cumulative_count(cat_id, visited=None):
            """Recursively compute cumulative slide count (including descendants)."""
            if visited is None:
                visited = set()
            if cat_id in visited:
                return 0
            visited.add(cat_id)
            total = direct_counts.get(cat_id, 0)
            for child_id in children_map.get(cat_id, []):
                total += _cumulative_count(child_id, visited)
            return total

        def _build_nodes(pid, depth):
            if depth >= max_depth:
                return []
            child_ids = children_map.get(pid, [])
            result = []
            for cid in child_ids:
                cat = cat_by_id[cid]
                children = _build_nodes(cid, depth + 1)
                cumulative_cnt = _cumulative_count(cid)
                direct_cnt = direct_counts.get(cid, 0)
                result.append({
                    'id': cat['id'],
                    'name': cat['name'],
                    'parent_id': cat['parent_id'],
                    'keywords': json.loads(cat['keywords']) if cat['keywords'] else [],
                    'slide_count': cumulative_cnt,
                    'direct_count': direct_cnt,
                    'children': children,
                    **({'slide_ids': members_map.get(cid, []),
                        'collection_ids': coll_map.get(cid, [])} if with_members else {}),
                })
            return result

        return _build_nodes(parent_id, 0)

    def import_category_tree(self, data, parent_id=None, sort_order=0, restore_members=False):
        """Import a category tree from JSON.
        data: list of {name, keywords, children?} dicts — supports arbitrary depth.

        restore_members=True 时按节点里的 slide_ids / collection_ids 恢复页面归属与
        类别收藏夹成员（slide id 与 collection id 在导入过程中不变，可直接回填）。
        """
        imported = 0
        for i, item in enumerate(data):
            cid = self.add_category(
                item['name'],
                parent_id=parent_id,
                keywords=item.get('keywords', []),
                sort_order=sort_order + i,
            )
            imported += 1
            if restore_members:
                for sid in item.get('slide_ids') or []:
                    try:
                        self.conn.execute(
                            'INSERT OR IGNORE INTO slide_categories (slide_id, category_id) VALUES (?,?)',
                            (int(sid), cid))
                    except Exception:
                        pass
                for col in item.get('collection_ids') or []:
                    try:
                        self.conn.execute(
                            'INSERT OR IGNORE INTO collection_categories (collection_id, category_id) VALUES (?,?)',
                            (int(col), cid))
                    except Exception:
                        pass
                self.conn.commit()
            if item.get('children'):
                imported += self.import_category_tree(
                    item['children'], parent_id=cid, sort_order=0,
                    restore_members=restore_members)
        return imported

    def get_category_by_id(self, cat_id):
        return self.conn.execute(
            'SELECT * FROM categories WHERE id = ?', (cat_id,)).fetchone()

    def update_category(self, cat_id, name=None, keywords=None, parent_id=None,
                        sort_order=None):
        """Update category fields. Uses parameterized SQL — no f-string injection."""
        sets = []
        params = []
        if name is not None:
            sets.append('name = ?')
            params.append(name)
        if keywords is not None:
            sets.append('keywords = ?')
            params.append(json.dumps(keywords, ensure_ascii=False))
        if parent_id is not None:
            sets.append('parent_id = ?')
            params.append(parent_id if parent_id != 0 else None)
        if sort_order is not None:
            sets.append('sort_order = ?')
            params.append(sort_order)
        if sets:
            params.append(cat_id)
            sql = 'UPDATE categories SET ' + ', '.join(sets) + ' WHERE id = ?'
            self.conn.execute(sql, params)
            self.conn.commit()

    def delete_category(self, cat_id):
        cat = self.get_category_by_id(cat_id)
        if cat:
            self.conn.execute(
                'UPDATE categories SET parent_id = ? WHERE parent_id = ?',
                (cat['parent_id'], cat_id))
            self.conn.execute(
                'DELETE FROM slide_categories WHERE category_id = ?', (cat_id,))
            self.conn.execute('DELETE FROM categories WHERE id = ?', (cat_id,))
            self.conn.commit()

    def category_count(self):
        return self.conn.execute('SELECT COUNT(*) FROM categories').fetchone()[0]

    def get_category_slide_count(self, cat_id, cumulative=False, include_hidden=False):
        """Count slides in a category.
        cumulative=True: also count slides in all descendant categories."""
        if cumulative:
            ids = self.get_all_descendant_ids(cat_id)
            placeholders = ','.join('?' * len(ids))
            if include_hidden:
                sql = f'SELECT COUNT(*) FROM slide_categories sc WHERE sc.category_id IN ({placeholders})'
            else:
                sql = (
                    f'SELECT COUNT(*) FROM slide_categories sc '
                    f'WHERE sc.category_id IN ({placeholders}) '
                    f'AND sc.slide_id NOT IN ('
                    f'SELECT slide_id FROM duplicate_members WHERE is_hidden = 1'
                    f')'
                )
            return self.conn.execute(sql, ids).fetchone()[0]
        else:
            if include_hidden:
                sql = 'SELECT COUNT(*) FROM slide_categories sc WHERE sc.category_id = ?'
            else:
                sql = (
                    'SELECT COUNT(*) FROM slide_categories sc '
                    'WHERE sc.category_id = ? '
                    'AND sc.slide_id NOT IN ('
                    'SELECT slide_id FROM duplicate_members WHERE is_hidden = 1'
                    ')'
                )
            return self.conn.execute(sql, (cat_id,)).fetchone()[0]

    # ── Slide ↔ Category mapping ──

    def set_slide_category(self, slide_id, category_id, confidence=1.0, source='manual'):
        self.conn.execute(
            '''INSERT OR REPLACE INTO slide_categories
               (slide_id, category_id, confidence, source) VALUES (?,?,?,?)''',
            (slide_id, category_id, confidence, source))
        self.conn.commit()

    def remove_slide_category(self, slide_id):
        self.conn.execute(
            'DELETE FROM slide_categories WHERE slide_id = ?', (slide_id,))
        self.conn.commit()

    def get_slide_category(self, slide_id):
        return self.conn.execute('''
            SELECT sc.*, c.name AS category_name
            FROM slide_categories sc JOIN categories c ON sc.category_id = c.id
            WHERE sc.slide_id = ?
        ''', (slide_id,)).fetchone()

    # ── Duplicate operations ──

    def clear_duplicate_groups(self):
        self.conn.execute('DELETE FROM duplicate_members')
        self.conn.execute('DELETE FROM duplicate_groups')
        self.conn.commit()

    def create_duplicate_group(self, group_type='exact'):
        cur = self.conn.execute(
            'INSERT INTO duplicate_groups (group_type) VALUES (?)', (group_type,))
        self.conn.commit()
        return cur.lastrowid

    def add_duplicate_member(self, group_id, slide_id, similarity=1.0, is_primary=0):
        self.conn.execute(
            '''INSERT INTO duplicate_members
               (group_id, slide_id, similarity, is_primary) VALUES (?,?,?,?)''',
            (group_id, slide_id, similarity, is_primary))
        self.conn.commit()

    def get_duplicate_groups(self):
        return self.conn.execute('''
            SELECT dg.*, COUNT(dm.id) AS member_count
            FROM duplicate_groups dg
            JOIN duplicate_members dm ON dg.id = dm.group_id
            WHERE dm.is_hidden = 0
            GROUP BY dg.id
            HAVING member_count >= 2
            ORDER BY member_count DESC
        ''').fetchall()

    def get_duplicate_members(self, group_id):
        return self.conn.execute('''
            SELECT dm.*, s.title, s.text_content, s.thumbnail_path, s.slide_number,
                   f.file_name, f.file_path
            FROM duplicate_members dm
            JOIN slides s ON dm.slide_id = s.id
            JOIN files f ON s.file_id = f.id
            WHERE dm.group_id = ? AND dm.is_hidden = 0
            ORDER BY dm.is_primary DESC, f.file_name
        ''', (group_id,)).fetchall()

    def set_primary_duplicate(self, group_id, slide_id):
        self.conn.execute(
            'UPDATE duplicate_members SET is_primary=0 WHERE group_id=?', (group_id,))
        self.conn.execute(
            'UPDATE duplicate_members SET is_primary=1 WHERE group_id=? AND slide_id=?',
            (group_id, slide_id))
        self.conn.execute(
            'UPDATE duplicate_members SET is_hidden=1 WHERE group_id=? AND slide_id!=?',
            (group_id, slide_id))
        self.conn.execute(
            'UPDATE duplicate_members SET is_hidden=0 WHERE group_id=? AND slide_id=?',
            (group_id, slide_id))
        self.conn.commit()

    def hide_duplicate(self, member_id):
        self.conn.execute(
            'UPDATE duplicate_members SET is_hidden=1 WHERE id=?', (member_id,))
        self.conn.commit()

    def hide_non_primary_in_group(self, group_id):
        self.conn.execute(
            'UPDATE duplicate_members SET is_hidden=1 WHERE group_id=? AND is_primary=0',
            (group_id,))
        self.conn.commit()

    def hide_all_non_primary_duplicates(self):
        """隐藏所有重复组中的非主版本。"""
        n = self.conn.execute('''
            UPDATE duplicate_members SET is_hidden=1
            WHERE is_primary=0 AND is_hidden=0
        ''').rowcount
        self.conn.commit()
        return n

    def unhide_duplicate_by_slide(self, slide_id):
        self.conn.execute(
            'UPDATE duplicate_members SET is_hidden=0 WHERE slide_id=?',
            (slide_id,))
        self.conn.commit()

    def unhide_all_duplicate_slides(self):
        """Unhide all hidden duplicate slides."""
        cur = self.conn.execute(
            'UPDATE duplicate_members SET is_hidden=0 WHERE is_hidden=1')
        self.conn.commit()
        return cur.rowcount

    def get_hidden_duplicate_slides(self):
        return self.conn.execute('''
            SELECT s.*, f.file_name, f.file_path, dm.id AS dup_member_id,
                   dg.group_type, dm.is_primary
            FROM duplicate_members dm
            JOIN slides s ON dm.slide_id = s.id
            JOIN files f ON s.file_id = f.id
            JOIN duplicate_groups dg ON dm.group_id = dg.id
            WHERE dm.is_hidden = 1
            ORDER BY dg.id, f.file_name, s.slide_number
        ''').fetchall()

    def count_hidden_duplicates(self):
        return self.conn.execute(
            'SELECT COUNT(*) FROM duplicate_members WHERE is_hidden = 1'
        ).fetchone()[0]

    def get_slides_for_llm_classify(self, min_confidence=0.22):
        """未分类，或自动/LLM 归类且置信度低于阈值的页面。"""
        return self.conn.execute('''
            SELECT s.*, f.file_name, f.file_path
            FROM slides s
            JOIN files f ON s.file_id = f.id
            WHERE s.id NOT IN (SELECT slide_id FROM duplicate_members WHERE is_hidden = 1)
            AND (
                s.id NOT IN (SELECT slide_id FROM slide_categories)
                OR s.id IN (
                    SELECT sc.slide_id FROM slide_categories sc
                    WHERE sc.source IN ('auto', 'llm') AND sc.confidence < ?
                )
            )
            ORDER BY f.file_name, s.slide_number
        ''', (min_confidence,)).fetchall()

    def absorb_manual_keywords(self, limit=80):
        """从近期手改归类中抽取标题词加入对应类别关键词。"""
        rows = self.conn.execute('''
            SELECT s.title, sc.category_id
            FROM slide_categories sc
            JOIN slides s ON sc.slide_id = s.id
            WHERE sc.source = 'manual' AND s.title != ''
            ORDER BY sc.created_at DESC
            LIMIT ?
        ''', (limit,)).fetchall()
        updated = 0
        for row in rows:
            title = (row['title'] or '').strip()
            if len(title) < 2 or len(title) > 30:
                continue
            cat = self.get_category_by_id(row['category_id'])
            if not cat:
                continue
            kws = json.loads(cat['keywords']) if cat['keywords'] else []
            if title in kws:
                continue
            kws.append(title)
            self.update_category(row['category_id'], keywords=kws[:40])
            updated += 1
        return updated

    # ── Settings ──

    # ── 导入耗时样本（估算用）──

    def add_perf_sample(self, seconds, slides, engine='render', llm=0):
        """记一条真实导入耗时，只留最近 120 条。"""
        try:
            self.conn.execute(
                "INSERT INTO perf_samples (seconds, slides, engine, llm) VALUES (?,?,?,?)",
                (round(float(seconds), 3), int(slides or 0), engine, 1 if llm else 0))
            self.conn.execute(
                "DELETE FROM perf_samples WHERE id NOT IN "
                "(SELECT id FROM perf_samples ORDER BY id DESC LIMIT 120)")
            self.conn.commit()
        except Exception as e:
            _log.debug('add_perf_sample failed: %s', e)

    def get_perf_samples(self, limit=60):
        try:
            rows = self.conn.execute(
                "SELECT seconds, slides, engine, llm FROM perf_samples ORDER BY id DESC LIMIT ?",
                (int(limit),)).fetchall()
            return [dict(r) for r in rows]
        except Exception:
            return []

    def get_setting(self, key, default=None):
        row = self.conn.execute(
            'SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
        return row['value'] if row else default

    def set_setting(self, key, value):
        self.conn.execute(
            'INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)',
            (key, str(value)))
        self.conn.commit()

    # ── Stats ──

    def get_stats(self):
        total_files = self.conn.execute('SELECT COUNT(*) FROM files').fetchone()[0]
        processed = self.conn.execute(
            'SELECT COUNT(*) FROM files WHERE processed=1').fetchone()[0]
        total_slides = self.conn.execute('SELECT COUNT(*) FROM slides').fetchone()[0]
        visible_slides = self.conn.execute('''
            SELECT COUNT(*) FROM slides s
            WHERE s.id NOT IN (
                SELECT slide_id FROM duplicate_members WHERE is_hidden = 1
            )
        ''').fetchone()[0]
        categorized = self.conn.execute('''
            SELECT COUNT(*) FROM slide_categories sc
            JOIN slides s ON sc.slide_id = s.id
            WHERE s.id NOT IN (
                SELECT slide_id FROM duplicate_members WHERE is_hidden = 1
            )
        ''').fetchone()[0]
        dup_groups = self.conn.execute(
            'SELECT COUNT(*) FROM duplicate_groups').fetchone()[0]
        hidden_dup = self.count_hidden_duplicates()
        return {
            'total_files': total_files,
            'processed_files': processed,
            'total_slides': total_slides,
            'visible_slides': visible_slides,
            'categorized_slides': categorized,
            'uncategorized_slides': visible_slides - categorized,
            'duplicate_groups': dup_groups,
            'hidden_duplicates': hidden_dup,
        }

    # ── Default categories ──

    def init_default_categories(self):
        """No longer auto-injects HR categories.
        Users generate their own category tree via the import prompt
        and visit Categories → Import to apply it."""
        pass

    # ── Export / Import ──

    def export_category_tree(self):
        """Export all categories as a tree JSON ready for re-import.

        with_members=True：带上每类的页面归属（slide_ids）与类别收藏夹成员
        （collection_ids），导入时一起恢复，否则导出→导入一圈会把归属清空。
        """
        return self.get_category_tree(parent_id=None, with_members=True)

    def reset_all_categories(self):
        """Delete all categories and their slide assignments."""
        self.conn.execute('DELETE FROM collection_categories')
        self.conn.execute('DELETE FROM slide_categories')
        self.conn.execute('DELETE FROM categories')
        self.conn.commit()

    # ── Collections ──

    def get_collections(self, kind=None):
        """所有收藏夹。kind='slide' 页面收藏夹 / 'file' 文件收藏夹 / None 全部。

        slide_count = 夹里的页数；file_count = 夹里的文件数（文件收藏夹只看它）。
        """
        sql = '''
            SELECT c.*,
                   (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS slide_count,
                   (SELECT COUNT(*) FROM collection_files cf WHERE cf.collection_id = c.id) AS file_count,
                   (SELECT COUNT(*) FROM collection_categories cc WHERE cc.collection_id = c.id) AS category_count
            FROM collections c
        '''
        params = []
        if kind:
            sql += " WHERE COALESCE(c.kind,'slide') = ?"
            params.append(kind)
        sql += ' ORDER BY c.sort_order, c.created_at'
        return self.conn.execute(sql, params).fetchall()

    def get_collection_kind(self, col_id):
        row = self.conn.execute(
            "SELECT COALESCE(kind,'slide') AS kind FROM collections WHERE id = ?",
            (col_id,)).fetchone()
        return row['kind'] if row else None

    def get_collection_counts(self):
        """Return {collection_id: slide_count} map."""
        rows = self.conn.execute('''
            SELECT collection_id, COUNT(*) AS cnt
            FROM collection_items GROUP BY collection_id
        ''').fetchall()
        return {r['collection_id']: r['cnt'] for r in rows}

    def create_collection(self, name, kind='slide'):
        if kind not in ('slide', 'file', 'category'):
            kind = 'slide'
        cur = self.conn.execute(
            'INSERT INTO collections (name, kind) VALUES (?, ?)', (name, kind))
        self.conn.commit()
        return cur.lastrowid

    def rename_collection(self, col_id, name):
        self.conn.execute(
            'UPDATE collections SET name = ? WHERE id = ?', (name, col_id))
        self.conn.commit()

    def delete_collection(self, col_id):
        self.conn.execute('DELETE FROM collection_items WHERE collection_id = ?', (col_id,))
        self.conn.execute('DELETE FROM collection_files WHERE collection_id = ?', (col_id,))
        self.conn.execute('DELETE FROM collection_categories WHERE collection_id = ?', (col_id,))
        self.conn.execute('DELETE FROM collections WHERE id = ?', (col_id,))
        self.conn.commit()

    def add_slide_to_collection(self, col_id, slide_id):
        try:
            self.conn.execute(
                'INSERT OR IGNORE INTO collection_items (collection_id, slide_id) VALUES (?,?)',
                (col_id, slide_id))
            self.conn.commit()
            return True
        except Exception:
            return False

    def remove_slide_from_collection(self, col_id, slide_id):
        self.conn.execute(
            'DELETE FROM collection_items WHERE collection_id = ? AND slide_id = ?',
            (col_id, slide_id))
        self.conn.commit()

    def is_slide_in_collection(self, col_id, slide_id):
        row = self.conn.execute(
            'SELECT 1 FROM collection_items WHERE collection_id = ? AND slide_id = ?',
            (col_id, slide_id)).fetchone()
        return row is not None

    def get_slide_collections(self, slide_id):
        """Returns list of collection IDs that contain this slide."""
        rows = self.conn.execute(
            'SELECT collection_id FROM collection_items WHERE slide_id = ?',
            (slide_id,)).fetchall()
        return [r['collection_id'] for r in rows]

    # ── 类别级收藏（collection_categories）──

    def add_category_to_collection(self, col_id, category_id):
        try:
            self.conn.execute(
                'INSERT OR IGNORE INTO collection_categories (collection_id, category_id) VALUES (?,?)',
                (col_id, category_id))
            self.conn.commit()
            return True
        except Exception:
            return False

    def remove_category_from_collection(self, col_id, category_id):
        self.conn.execute(
            'DELETE FROM collection_categories WHERE collection_id = ? AND category_id = ?',
            (col_id, category_id))
        self.conn.commit()

    def get_category_collections(self, category_id):
        rows = self.conn.execute(
            'SELECT collection_id FROM collection_categories WHERE category_id = ?',
            (category_id,)).fetchall()
        return [r['collection_id'] for r in rows]

    def get_categories_by_collection(self, col_id):
        return self.conn.execute(
            '''SELECT c.* FROM collection_categories cc
               JOIN categories c ON c.id = cc.category_id
               WHERE cc.collection_id = ?
               ORDER BY cc.created_at DESC, c.name''',
            (col_id,)).fetchall()

    # ── 文件级收藏（collection_files）──

    def add_file_to_collection(self, col_id, file_id):
        try:
            self.conn.execute(
                'INSERT OR IGNORE INTO collection_files (collection_id, file_id) VALUES (?,?)',
                (col_id, file_id))
            self.conn.commit()
            return True
        except Exception:
            return False

    def remove_file_from_collection(self, col_id, file_id):
        self.conn.execute(
            'DELETE FROM collection_files WHERE collection_id = ? AND file_id = ?',
            (col_id, file_id))
        self.conn.commit()

    def get_file_collections(self, file_id):
        """这个文件被收进了哪些收藏夹。"""
        rows = self.conn.execute(
            'SELECT collection_id FROM collection_files WHERE file_id = ?',
            (file_id,)).fetchall()
        return [r['collection_id'] for r in rows]

    def get_files_by_collection(self, col_id):
        rows = self.conn.execute(
            '''SELECT f.* FROM collection_files cf
                JOIN files f ON f.id = cf.file_id
                WHERE cf.collection_id = ?
                ORDER BY cf.created_at DESC, f.file_name''',
            (col_id,)).fetchall()
        return rows

    def get_slides_by_collection(self, col_id, include_hidden=False):
        sql = (
            'SELECT s.*, f.file_name, f.file_path '
            'FROM collection_items ci '
            'JOIN slides s ON ci.slide_id = s.id '
            'JOIN files f ON s.file_id = f.id '
            'WHERE ci.collection_id = ?'
            + self._vis(include_hidden) + ' '
            'ORDER BY ci.created_at DESC, f.file_name, s.slide_number'
        )
        return self.conn.execute(sql, (col_id,)).fetchall()

    # ── 手动组页（compositions）─────────────────────────────────

    def create_composition(self, name):
        cur = self.conn.execute('INSERT INTO compositions (name) VALUES (?)', (name,))
        self.conn.commit()
        return cur.lastrowid

    def list_compositions(self):
        return self.conn.execute(
            'SELECT c.*, (SELECT COUNT(*) FROM composition_items i WHERE i.comp_id = c.id) AS item_count '
            'FROM compositions c WHERE COALESCE(c.is_template, 0) = 0 ORDER BY c.id DESC'
        ).fetchall()

    # ── 骨架（模板）：一种特殊组稿，只当样板看，不出现在普通组稿下拉里 ──

    def list_templates(self):
        return self.conn.execute(
            'SELECT c.*, (SELECT COUNT(*) FROM composition_items i WHERE i.comp_id = c.id) AS item_count '
            'FROM compositions c WHERE COALESCE(c.is_template, 0) = 1 ORDER BY c.id DESC'
        ).fetchall()

    def set_composition_template(self, comp_id, flag=1):
        self.conn.execute(
            "UPDATE compositions SET is_template = ?, updated_at = datetime('now','localtime') WHERE id = ?",
            (1 if flag else 0, comp_id))
        self.conn.commit()

    def get_template_pages(self, comp_id):
        """骨架里的页：带上原始来源，供按标题找相似页。"""
        return self.conn.execute(
            'SELECT i.slide_id, i.sort_order, s.title, s.text_content, '
            '       s.slide_number, f.file_name, f.file_path '
            'FROM composition_items i '
            'JOIN slides s ON i.slide_id = s.id '
            'JOIN files f ON s.file_id = f.id '
            'WHERE i.comp_id = ? ORDER BY i.sort_order, i.id',
            (comp_id,)).fetchall()

    def rename_composition(self, comp_id, name):
        self.conn.execute(
            "UPDATE compositions SET name = ?, updated_at = datetime('now','localtime') WHERE id = ?",
            (name, comp_id))
        self.conn.commit()

    def delete_composition(self, comp_id):
        self.conn.execute('DELETE FROM compositions WHERE id = ?', (comp_id,))
        self.conn.commit()

    def get_composition_items(self, comp_id):
        """按 sort_order 返回稿件里的页，带来源信息（含 thumbnail_path 相对路径）。"""
        return self.conn.execute(
            'SELECT i.id AS item_id, i.slide_id, i.sort_order, '
            '       s.title, s.slide_number, s.thumbnail_path, '
            '       f.id AS file_id, f.file_name, f.file_path '
            'FROM composition_items i '
            'JOIN slides s ON i.slide_id = s.id '
            'JOIN files f ON s.file_id = f.id '
            'WHERE i.comp_id = ? ORDER BY i.sort_order, i.id',
            (comp_id,)).fetchall()

    def get_composition(self, comp_id):
        comp = self.conn.execute(
            'SELECT * FROM compositions WHERE id = ?', (comp_id,)).fetchone()
        if not comp:
            return None, []
        return comp, self.get_composition_items(comp_id)

    def _rewrite_order(self, comp_id, item_ids):
        for idx, item_id in enumerate(item_ids):
            self.conn.execute(
                'UPDATE composition_items SET sort_order = ? WHERE id = ? AND comp_id = ?',
                (idx, item_id, comp_id))
        self.conn.execute(
            "UPDATE compositions SET updated_at = datetime('now','localtime') WHERE id = ?",
            (comp_id,))
        self.conn.commit()

    def add_composition_item(self, comp_id, slide_id, after_index=None):
        """after_index：插到第 N 项之后（0 基，None=追加到末尾）。返回新 item_id。"""
        exists = self.conn.execute(
            'SELECT 1 FROM slides WHERE id = ?', (slide_id,)).fetchone()
        if not exists:
            raise ValueError(f'页不存在：{slide_id}')
        cur = self.conn.execute(
            'INSERT INTO composition_items (comp_id, slide_id, sort_order) VALUES (?,?,?)',
            (comp_id, slide_id, 999999))
        new_id = cur.lastrowid
        self.conn.commit()

        current = [r['item_id'] for r in self.conn.execute(
            'SELECT id AS item_id FROM composition_items WHERE comp_id = ? ORDER BY sort_order, id',
            (comp_id,)).fetchall() if r['item_id'] != new_id]
        pos = len(current) if after_index is None else max(0, min(int(after_index), len(current)))
        current.insert(pos, new_id)
        self._rewrite_order(comp_id, current)
        return new_id

    def reorder_composition_items(self, comp_id, item_ids):
        owned = {r['item_id'] for r in self.conn.execute(
            'SELECT id AS item_id FROM composition_items WHERE comp_id = ?',
            (comp_id,)).fetchall()}
        ordered = [int(i) for i in item_ids if int(i) in owned]
        # 前端没提交到的项按原顺序补到末尾，避免丢页
        rest = [i for i in (r['item_id'] for r in self.conn.execute(
            'SELECT id AS item_id FROM composition_items WHERE comp_id = ? ORDER BY sort_order, id',
            (comp_id,)).fetchall()) if i not in ordered]
        self._rewrite_order(comp_id, ordered + rest)
        return len(ordered)

    def remove_composition_item(self, comp_id, item_id):
        self.conn.execute(
            'DELETE FROM composition_items WHERE id = ? AND comp_id = ?',
            (item_id, comp_id))
        self.conn.commit()

    def close(self):
        self.conn.close()
