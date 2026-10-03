#!/usr/bin/env python3
"""Deletes agy conversation data older than N days in every Meridian account (Cd1s/meridian fork).

agy keeps every conversation forever under <account>/.gemini/antigravity-cli:
brain/<id>/ (full transcripts), conversations/<id>.db*, annotations/<id>.pbtxt and presence/<id>.lock,
plus implicit/*.pb, log/*.log and crashes/. A conversation is removed only when none of its files
changed within the window. conversation_summaries.db and jetbox_summaries_proto.pb are agy's own
indexes and are left alone.

Usage: agy-retention.py [--days 7] [--dry-run] [accounts_dir]
"""
import argparse, os, shutil, sys, time

PER_CONVERSATION = {"brain": "", "annotations": ".pbtxt", "presence": ".lock"}
LOOSE = ["implicit", "log", "crashes"]


def entries(path):
    try: return os.listdir(path)
    except FileNotFoundError: return []


def newest(path):
    """Latest mtime of a file, or of a directory and everything below it; 0 if missing."""
    try: latest = os.lstat(path).st_mtime
    except FileNotFoundError: return 0
    if os.path.isdir(path) and not os.path.islink(path):
        for root, dirs, files in os.walk(path):
            for name in dirs + files:
                try: latest = max(latest, os.lstat(os.path.join(root, name)).st_mtime)
                except FileNotFoundError: pass
    return latest


def remove(path):
    if os.path.isdir(path) and not os.path.islink(path): shutil.rmtree(path)
    else:
        try: os.remove(path)
        except FileNotFoundError: pass


def clean(base, cutoff, dry_run):
    conversations = {}
    for folder, suffix in PER_CONVERSATION.items():
        for name in entries(os.path.join(base, folder)):
            if name.endswith(suffix): conversations.setdefault(name[:len(name) - len(suffix)] if suffix else name, []).append(os.path.join(base, folder, name))
    # conversations/<id>.db plus its SQLite -wal/-shm companions.
    for name in entries(os.path.join(base, "conversations")):
        conversations.setdefault(name.split(".", 1)[0], []).append(os.path.join(base, "conversations", name))
    stale = [paths for paths in conversations.values() if max(newest(path) for path in paths) < cutoff]
    loose = [os.path.join(base, folder, name) for folder in LOOSE for name in entries(os.path.join(base, folder)) if newest(os.path.join(base, folder, name)) < cutoff]
    if not dry_run:
        for path in [path for paths in stale for path in paths] + loose: remove(path)
    return len(stale), len(conversations), len(loose)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("accounts_dir", nargs="?", default=os.environ.get("MERIDIAN_AGY_ACCOUNTS_DIR", "/var/lib/meridian/instances"))
    parser.add_argument("--days", type=float, default=7)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.days < 1: sys.exit("--days must be at least 1")
    cutoff = time.time() - args.days * 86400
    verb = "would delete" if args.dry_run else "deleted"
    total = 0
    for account in sorted(entries(args.accounts_dir)):
        base = os.path.join(args.accounts_dir, account, ".gemini", "antigravity-cli")
        if not os.path.isdir(base): continue
        stale, kept, loose = clean(base, cutoff, args.dry_run)
        total += stale
        if stale or loose: print(f"{account}: {verb} {stale}/{kept} conversations, {loose} log/implicit/crash files", flush=True)
    print(f"done: {verb} {total} conversations older than {args.days:g} days", flush=True)


if __name__ == "__main__":
    main()
