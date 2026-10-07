"""
Dedup worker — runs in a separate process to completely avoid GIL contention.
Communicates progress via a JSON file in the data directory.

Usage: python dedup_worker.py <db_path> [threshold] [--incremental]
"""
import sys, os, json

def main():
    if len(sys.argv) < 2:
        print("Usage: python dedup_worker.py <db_path> [threshold] [--incremental]", file=sys.stderr)
        sys.exit(1)

    db_path = sys.argv[1]
    threshold = float(sys.argv[2]) if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else 0.85
    incremental = '--incremental' in sys.argv

    data_dir = os.path.dirname(db_path)
    progress_file = os.path.join(data_dir, 'dedup_progress.json')

    def write_progress(data):
        """Atomic progress write: temp file + rename."""
        tmp = progress_file + '.tmp'
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, progress_file)
        except OSError:
            pass

    # Signal startup
    write_progress({"running": True, "current": 0, "total": 100, "done": False})

    # Delayed imports — ensure rapidfuzz etc. are available
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from database import Database
    from dedup import run_dedup

    db = Database(db_path)

    # Note: run_dedup() handles clear_duplicate_groups() internally for non-incremental mode
    def progress_cb(current, total, msg):
        write_progress({
            "running": True,
            "current": current,
            "total": total,
            "done": False,
            "message": msg,
        })

    try:
        exact, similar, hidden = run_dedup(
            db, auto_hide=False, incremental=incremental,
            progress_callback=progress_cb)

        write_progress({
            "running": False,
            "current": 100,
            "total": 100,
            "done": True,
            "exact_groups": exact,
            "similar_groups": similar,
            "hidden": hidden,
        })
        print(f"Dedup complete: {exact} exact, {similar} similar, {hidden} hidden")

    except Exception as e:
        write_progress({
            "running": False,
            "current": 0,
            "total": 100,
            "done": True,
            "error": str(e),
        })
        print(f"Dedup failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
