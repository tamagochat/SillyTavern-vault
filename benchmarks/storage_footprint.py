#!/usr/bin/env python3
"""
Storage footprint benchmark: Filesystem (.jsonl) vs PostgreSQL.

Generates realistic SillyTavern chat data (~100MB), writes to filesystem,
imports into PostgreSQL, and compares sizes.

Usage:
    # Estimate only (no Postgres needed)
    python storage_footprint.py --estimate

    # Full benchmark (requires Postgres running)
    python storage_footprint.py --db-url postgresql://vault:vault123@localhost:5432/vault

    # Custom target size
    python storage_footprint.py --target-mb 500 --db-url postgresql://...

Prerequisites:
    pip install psycopg2-binary
"""

import argparse
import json
import os
import random
import shutil
import string
import sys
import tempfile
import time

# ─── Chat data generator ─────────────────────────────────────────────

SAMPLE_MESSAGES = [
    "Hello! How are you doing today?",
    "I've been thinking about what you said earlier, and I think you make a really good point about the nature of consciousness.",
    "Let me tell you a story. Once upon a time, in a land far far away, there lived a curious adventurer who sought to understand the mysteries of the universe.",
    "*smiles warmly* That's a wonderful way to look at it. I appreciate your perspective on this matter.",
    "The weather has been quite unpredictable lately. Yesterday it was sunny, today it's raining, and tomorrow they're predicting snow. Climate patterns are fascinating.",
    "I wanted to share something interesting I read about quantum mechanics. Apparently, particles can exist in multiple states simultaneously until they're observed.",
    "What do you think about the latest developments in artificial intelligence? It seems like every week there's a new breakthrough.",
    "*leans back thoughtfully* You know, I've always believed that the best conversations happen when people are willing to be vulnerable and honest with each other.",
    "Here's a fun fact: octopuses have three hearts, blue blood, and can change both their color and texture in milliseconds.",
    "I completely agree with your analysis. The socioeconomic factors you mentioned play a crucial role in shaping public policy decisions.",
    "Oh, that reminds me of a similar experience I had last summer. We were hiking through the mountains when we stumbled upon this hidden waterfall.",
    "The philosophical implications of determinism versus free will have been debated for centuries, and I don't think we're any closer to a definitive answer.",
]

CHARACTERS = ["Alice", "Bob", "Charlie", "Diana", "Echo", "Frost", "Ghost", "Haven"]
USER_HANDLES = ["default-user", "user-alpha", "user-beta"]


def generate_message(is_user: bool, character_name: str) -> dict:
    """Generate a single realistic SillyTavern chat message."""
    msg = random.choice(SAMPLE_MESSAGES)
    # Vary message length randomly
    repeats = random.randint(1, 5)
    msg = " ".join([msg] * repeats)

    return {
        "name": "You" if is_user else character_name,
        "is_user": is_user,
        "mes": msg,
        "send_date": f"2025-{random.randint(1,12):02d}-{random.randint(1,28):02d}T{random.randint(0,23):02d}:{random.randint(0,59):02d}:{random.randint(0,59):02d}",
        "extra": {"api": "openai", "model": "gpt-4"},
    }


def generate_chat_jsonl(character_name: str, num_messages: int) -> str:
    """Generate a JSONL chat file content."""
    lines = []
    # First line is always the system/metadata
    lines.append(json.dumps({
        "user_name": "You",
        "character_name": character_name,
        "create_date": "2025-01-15T10:00:00",
    }))
    for i in range(num_messages):
        is_user = i % 2 == 1
        msg = generate_message(is_user, character_name)
        lines.append(json.dumps(msg))
    return "\n".join(lines)


def generate_chats(target_bytes: int) -> list[dict]:
    """Generate chat data until we hit the target size."""
    chats = []
    total_bytes = 0
    chat_id = 0

    while total_bytes < target_bytes:
        chat_id += 1
        user_handle = random.choice(USER_HANDLES)
        character = random.choice(CHARACTERS)
        num_messages = random.randint(10, 200)
        file_name = f"chat_{chat_id:06d}.jsonl"

        content = generate_chat_jsonl(character, num_messages)
        content_bytes = len(content.encode("utf-8"))
        total_bytes += content_bytes

        chats.append({
            "user_handle": user_handle,
            "character_name": character,
            "file_name": file_name,
            "content": content,
            "content_bytes": content_bytes,
        })

    return chats


# ─── Filesystem measurement ──────────────────────────────────────────

def write_filesystem(chats: list[dict], base_dir: str) -> int:
    """Write chats as .jsonl files and return total size on disk."""
    for chat in chats:
        chat_dir = os.path.join(
            base_dir, chat["user_handle"], "chats", chat["character_name"]
        )
        os.makedirs(chat_dir, exist_ok=True)
        file_path = os.path.join(chat_dir, chat["file_name"])
        with open(file_path, "w") as f:
            f.write(chat["content"])

    # Measure actual disk usage
    total = 0
    for dirpath, _, filenames in os.walk(base_dir):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            total += os.path.getsize(fp)
    return total


# ─── PostgreSQL measurement ──────────────────────────────────────────

def measure_postgres(chats: list[dict], db_url: str) -> dict:
    """Import chats into PostgreSQL and measure storage."""
    try:
        import psycopg2
    except ImportError:
        print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")
        sys.exit(1)

    conn = psycopg2.connect(db_url)
    cur = conn.cursor()

    # Create benchmark table
    cur.execute("DROP TABLE IF EXISTS bench_chats")
    cur.execute("""
        CREATE TABLE bench_chats (
            id SERIAL PRIMARY KEY,
            user_handle TEXT NOT NULL,
            character_name TEXT NOT NULL,
            file_name TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(user_handle, character_name, file_name)
        )
    """)
    cur.execute("""
        CREATE INDEX bench_chats_lookup ON bench_chats(user_handle, character_name)
    """)
    cur.execute("""
        CREATE INDEX bench_chats_search ON bench_chats USING gin(to_tsvector('simple', content))
    """)
    conn.commit()

    # Import
    print(f"  Importing {len(chats)} chats into PostgreSQL...")
    t0 = time.time()
    for chat in chats:
        cur.execute(
            """INSERT INTO bench_chats (user_handle, character_name, file_name, content)
               VALUES (%s, %s, %s, %s)""",
            (chat["user_handle"], chat["character_name"], chat["file_name"], chat["content"]),
        )
    conn.commit()
    import_time = time.time() - t0

    # Measure sizes
    cur.execute("SELECT pg_total_relation_size('bench_chats')")
    total_size = cur.fetchone()[0]

    cur.execute("SELECT pg_table_size('bench_chats')")
    table_size = cur.fetchone()[0]

    cur.execute("SELECT pg_indexes_size('bench_chats')")
    index_size = cur.fetchone()[0]

    # TOAST size (large text values stored out-of-line)
    cur.execute("""
        SELECT pg_total_relation_size(reltoastrelid)
        FROM pg_class WHERE relname = 'bench_chats' AND reltoastrelid != 0
    """)
    row = cur.fetchone()
    toast_size = row[0] if row else 0

    cur.execute("SELECT COUNT(*) FROM bench_chats")
    row_count = cur.fetchone()[0]

    # Cleanup
    cur.execute("DROP TABLE bench_chats")
    conn.commit()
    cur.close()
    conn.close()

    return {
        "total_size": total_size,
        "table_size": table_size,
        "index_size": index_size,
        "toast_size": toast_size,
        "row_count": row_count,
        "import_time": import_time,
    }


# ─── Estimation (no Postgres needed) ─────────────────────────────────

def estimate_postgres(chats: list[dict]) -> dict:
    """Estimate PostgreSQL storage without importing.

    PostgreSQL row overhead:
    - 23 bytes tuple header per row
    - 4 bytes item pointer per row
    - ~8 bytes alignment padding
    - text values: 4 bytes varlena header + data
    - TOAST: values > 2KB are compressed + stored out-of-line
      (typical compression ratio for JSONL text: ~40-60%)

    Index overhead:
    - B-tree (lookup): ~50 bytes per row for composite key
    - GIN (full-text): ~200-400 bytes per unique word occurrence
      (rough estimate: 15-25% of text content size)
    """
    raw_content_bytes = sum(c["content_bytes"] for c in chats)
    num_rows = len(chats)

    # Per-row fixed overhead
    ROW_OVERHEAD = 23 + 4 + 8  # tuple header + item pointer + alignment
    VARLENA_HEADERS = 4 * 4  # 4 text columns × 4 bytes each
    AVG_METADATA_SIZE = 40  # user_handle + character_name + file_name avg

    # Table size estimate
    # Small rows stored inline, large rows TOASTed with ~50% compression
    total_inline = 0
    total_toast = 0
    for chat in chats:
        row_data = ROW_OVERHEAD + VARLENA_HEADERS + AVG_METADATA_SIZE
        if chat["content_bytes"] <= 2000:
            row_data += chat["content_bytes"]
            total_inline += row_data
        else:
            row_data += 18  # TOAST pointer
            total_inline += row_data
            # TOAST: compressed, typically ~50% for repetitive JSONL
            total_toast += int(chat["content_bytes"] * 0.55)

    # Page overhead (~24 bytes per 8KB page)
    num_pages = max(1, total_inline // 8000)
    page_overhead = num_pages * 24

    table_estimate = total_inline + page_overhead

    # Index estimates
    btree_index = num_rows * 50  # lookup index
    gin_index = int(raw_content_bytes * 0.20)  # GIN full-text ~20% of content

    total_estimate = table_estimate + total_toast + btree_index + gin_index

    return {
        "total_size": total_estimate,
        "table_size": table_estimate + total_toast,
        "index_size": btree_index + gin_index,
        "toast_size": total_toast,
        "row_count": num_rows,
        "note": "estimated (no Postgres connection)",
    }


# ─── Output ──────────────────────────────────────────────────────────

def fmt_size(n: int) -> str:
    if n >= 1_000_000_000:
        return f"{n / 1_000_000_000:.2f} GB"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f} MB"
    if n >= 1_000:
        return f"{n / 1_000:.2f} KB"
    return f"{n} B"


def print_results(chats, fs_size, pg):
    raw_bytes = sum(c["content_bytes"] for c in chats)
    num_chats = len(chats)
    avg_messages = sum(
        c["content"].count("\n") for c in chats
    ) / num_chats

    print()
    print("=" * 60)
    print("  Storage Footprint Benchmark")
    print("=" * 60)
    print()
    print(f"  Chats generated:     {num_chats}")
    print(f"  Avg messages/chat:   {avg_messages:.0f}")
    print(f"  Raw content size:    {fmt_size(raw_bytes)}")
    print()
    print(f"  {'':30s} {'Filesystem':>12s}  {'PostgreSQL':>12s}")
    print(f"  {'-'*30} {'-'*12}  {'-'*12}")
    print(f"  {'Total size':30s} {fmt_size(fs_size):>12s}  {fmt_size(pg['total_size']):>12s}")
    print(f"  {'Table / data':30s} {fmt_size(fs_size):>12s}  {fmt_size(pg['table_size']):>12s}")
    print(f"  {'Indexes':30s} {'—':>12s}  {fmt_size(pg['index_size']):>12s}")
    if pg.get("toast_size"):
        print(f"  {'TOAST (compressed large text)':30s} {'—':>12s}  {fmt_size(pg['toast_size']):>12s}")
    print()

    ratio = pg["total_size"] / fs_size if fs_size > 0 else 0
    savings = (1 - ratio) * 100
    if savings > 0:
        print(f"  PostgreSQL is {savings:.1f}% smaller than filesystem")
    else:
        print(f"  PostgreSQL is {-savings:.1f}% larger than filesystem")

    if pg.get("import_time"):
        print(f"  Import time: {pg['import_time']:.1f}s")
    if pg.get("note"):
        print(f"  ({pg['note']})")
    print()

    # Markdown table for README
    print("Markdown table (copy to README):")
    print()
    print(f"| Metric | Filesystem | PostgreSQL |")
    print(f"|--------|-----------|------------|")
    print(f"| Total size | {fmt_size(fs_size)} | {fmt_size(pg['total_size'])} |")
    print(f"| Data | {fmt_size(fs_size)} | {fmt_size(pg['table_size'])} |")
    print(f"| Indexes | — | {fmt_size(pg['index_size'])} |")
    print(f"| Chats | {num_chats} | {num_chats} |")
    print(f"| Avg messages/chat | {avg_messages:.0f} | {avg_messages:.0f} |")
    print(f"| Size vs filesystem | 100% | {ratio*100:.0f}% |")
    print()


# ─── Main ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Storage footprint benchmark")
    parser.add_argument("--target-mb", type=int, default=100, help="Target data size in MB (default: 100)")
    parser.add_argument("--db-url", type=str, help="PostgreSQL connection string")
    parser.add_argument("--estimate", action="store_true", help="Estimate PostgreSQL size without importing")
    args = parser.parse_args()

    target_bytes = args.target_mb * 1_000_000

    print(f"Generating ~{args.target_mb}MB of chat data...")
    chats = generate_chats(target_bytes)

    # Filesystem
    tmp_dir = tempfile.mkdtemp(prefix="st-vault-bench-")
    try:
        print(f"Writing to filesystem ({tmp_dir})...")
        fs_size = write_filesystem(chats, tmp_dir)
    finally:
        shutil.rmtree(tmp_dir)

    # PostgreSQL
    if args.estimate or not args.db_url:
        if not args.estimate and not args.db_url:
            print("No --db-url provided, using estimation mode.")
        print("Estimating PostgreSQL size...")
        pg = estimate_postgres(chats)
    else:
        print(f"Importing into PostgreSQL...")
        pg = measure_postgres(chats, args.db_url)

    print_results(chats, fs_size, pg)


if __name__ == "__main__":
    main()
