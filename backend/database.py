import sqlite3
import json
import os
import logging

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

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_slides_file ON slides(file_id);
            CREATE INDEX IF NOT EXISTS idx_slides_hash ON slides(content_hash);
            CREATE INDEX IF NOT EXISTS idx_sc_slide ON slide_categories(slide_id);
            CREATE INDEX IF NOT EXISTS idx_sc_cat ON slide_categories(category_id);
            CREATE INDEX IF NOT EXISTS idx_cat_parent ON categories(parent_id);
            CREATE INDEX IF NOT EXISTS idx_col_items_col ON collection_items(collection_id);
            CREATE INDEX IF NOT EXISTS idx_col_items_slide ON collection_items(slide_id);
            CREATE INDEX IF NOT EXISTS idx_dm_hidden_slide ON duplicate_members(is_hidden, slide_id);
        ''')

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

    def get_all_files(self):
        return self.conn.execute(
            'SELECT * FROM files ORDER BY file_name'
        ).fetchall()

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
        pattern = self._like_pattern(keyword)
        sql = (
            'SELECT s.*, f.file_name, f.file_path '
            'FROM slides s JOIN files f ON s.file_id = f.id '
            "WHERE (s.text_content LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')"
            + self._vis(include_hidden) + ' '
            'ORDER BY f.file_name, s.slide_number'
        )
        return self.conn.execute(sql, (pattern, pattern)).fetchall()

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
            wheres.append("(s.title LIKE ? ESCAPE '\\' OR s.text_content LIKE ? ESCAPE '\\')")
            pattern = self._like_pattern(q)
            params.extend([pattern, pattern])

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

    def get_category_tree(self, parent_id=None, max_depth=5):
        """Return the full category tree as nested dicts. max_depth guards infinite loops.
        Uses batch COUNT queries instead of per-node N+1."""
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
                })
            return result

        return _build_nodes(parent_id, 0)

    def import_category_tree(self, data, parent_id=None, sort_order=0):
        """Import a category tree from JSON.
        data: list of {name, keywords, children?} dicts — supports arbitrary depth."""
        imported = 0
        for i, item in enumerate(data):
            cid = self.add_category(
                item['name'],
                parent_id=parent_id,
                keywords=item.get('keywords', []),
                sort_order=sort_order + i,
            )
            imported += 1
            if item.get('children'):
                imported += self.import_category_tree(
                    item['children'], parent_id=cid, sort_order=0)
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
        """Export all categories as a tree JSON ready for re-import."""
        return self.get_category_tree(parent_id=None)

    def reset_all_categories(self):
        """Delete all categories and their slide assignments."""
        self.conn.execute('DELETE FROM slide_categories')
        self.conn.execute('DELETE FROM categories')
        self.conn.commit()

    # ── Collections ──

    def get_collections(self):
        """Return all collections with slide counts."""
        return self.conn.execute('''
            SELECT c.*, COUNT(ci.id) AS slide_count
            FROM collections c
            LEFT JOIN collection_items ci ON c.id = ci.collection_id
            GROUP BY c.id
            ORDER BY c.sort_order, c.created_at
        ''').fetchall()

    def get_collection_counts(self):
        """Return {collection_id: slide_count} map."""
        rows = self.conn.execute('''
            SELECT collection_id, COUNT(*) AS cnt
            FROM collection_items GROUP BY collection_id
        ''').fetchall()
        return {r['collection_id']: r['cnt'] for r in rows}

    def create_collection(self, name):
        cur = self.conn.execute(
            'INSERT INTO collections (name) VALUES (?)', (name,))
        self.conn.commit()
        return cur.lastrowid

    def rename_collection(self, col_id, name):
        self.conn.execute(
            'UPDATE collections SET name = ? WHERE id = ?', (name, col_id))
        self.conn.commit()

    def delete_collection(self, col_id):
        self.conn.execute('DELETE FROM collection_items WHERE collection_id = ?', (col_id,))
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

    def close(self):
        self.conn.close()
