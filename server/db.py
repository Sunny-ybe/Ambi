from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "ambi_v0.db"

# ---------------------------------------------------------------------------
# Cluster tuning constants
# ---------------------------------------------------------------------------

# Minimum cosine similarity to join an existing cluster (tighter than V1's 0.45).
CLUSTER_SIMILARITY_THRESHOLD = 0.65

# Cosine similarity above which two clusters are candidates for merging.
CLUSTER_MERGE_THRESHOLD = 0.88

# Size-ratio guard: only merge if min(sizeA, sizeB) / max(sizeA, sizeB) > this.
# Prevents a large cluster from silently absorbing a small, unrelated one.
CLUSTER_MERGE_MIN_SIZE_RATIO = 0.3

# Hard cap on the number of clusters.
MAX_CLUSTERS = 20

# Recompute centroid from representative embeddings every N additions to a cluster.
CENTROID_RECOMPUTE_EVERY = 10

# Confidence below this triggers re-evaluation on the next reassignment pass.
REASSIGN_CONFIDENCE_THRESHOLD = 0.55

# ---------------------------------------------------------------------------
# Stopwords — generic words that hurt label quality
# ---------------------------------------------------------------------------

_STOPWORDS = frozenset({
    # function words
    "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for",
    "is", "are", "was", "were", "be", "been", "with", "from", "by", "as",
    "it", "its", "this", "that", "my", "your", "our", "their", "how",
    "what", "why", "when", "which", "who", "not", "no", "so", "if",
    "about", "up", "out", "vs", "via", "into", "than", "but", "also",
    # generic content words that don't distinguish a topic
    "data", "system", "article", "page", "post", "blog", "guide", "tutorial",
    "introduction", "intro", "overview", "part", "section", "chapter",
    "new", "best", "top", "free", "online", "complete",
    "learn", "learning", "read", "reading", "write", "writing",
    "news", "update", "updates", "review", "reviews",
    "tips", "tricks", "tool", "tools", "resource", "resources",
    "site", "web", "app", "application", "software", "platform",
    "2023", "2024", "2025", "2026",
    "use", "get", "set", "make", "take", "put", "run",
})


# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------

def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


# ---------------------------------------------------------------------------
# Schema init + migrations
# ---------------------------------------------------------------------------

def init_db() -> None:
    with get_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS clusters (
              id                INTEGER PRIMARY KEY AUTOINCREMENT,
              centroid          TEXT NOT NULL,
              member_count      INTEGER NOT NULL DEFAULT 0,
              label             TEXT NOT NULL DEFAULT '',
              representative_ids TEXT NOT NULL DEFAULT '[]',
              created_at        TEXT NOT NULL,
              updated_at        TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS page_visits (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              url              TEXT NOT NULL UNIQUE,
              title            TEXT NOT NULL,
              text             TEXT NOT NULL,
              domain           TEXT NOT NULL,
              timestamp        TEXT NOT NULL,
              last_visited_at  TEXT NOT NULL,
              total_time_spent REAL NOT NULL DEFAULT 0,
              visit_count      INTEGER NOT NULL DEFAULT 1,
              cluster_id       INTEGER REFERENCES clusters(id),
              cluster_confidence REAL
            )
            """
        )
        # Safe migrations for databases that predate each column.
        _add_column_if_missing(connection, "page_visits", "cluster_id",
                               "INTEGER REFERENCES clusters(id)")
        _add_column_if_missing(connection, "page_visits", "cluster_confidence", "REAL")
        _add_column_if_missing(connection, "clusters", "representative_ids",
                               "TEXT NOT NULL DEFAULT '[]'")
        connection.commit()


def _add_column_if_missing(connection: sqlite3.Connection, table: str,
                            column: str, definition: str) -> None:
    existing = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


# ---------------------------------------------------------------------------
# page_visits — CRUD helpers
# ---------------------------------------------------------------------------

def upsert_page_visit(
    *,
    url: str,
    title: str,
    text: str,
    domain: str,
    timestamp: str,
    time_spent: float,
) -> dict[str, Any]:
    with get_connection() as connection:
        existing = connection.execute(
            "SELECT id, total_time_spent, visit_count, cluster_id FROM page_visits WHERE url = ?",
            (url,),
        ).fetchone()

        if existing:
            new_time = existing["total_time_spent"] + time_spent
            new_count = existing["visit_count"] + 1
            connection.execute(
                """
                UPDATE page_visits
                SET title = ?, text = ?, domain = ?, last_visited_at = ?,
                    total_time_spent = ?, visit_count = ?
                WHERE id = ?
                """,
                (title, text, domain, timestamp, new_time, new_count, existing["id"]),
            )
            connection.commit()
            return {
                "id": existing["id"],
                "status": "updated",
                "total_time_spent": new_time,
                "visit_count": new_count,
                "cluster_id": existing["cluster_id"],
            }

        cursor = connection.execute(
            """
            INSERT INTO page_visits
              (url, title, text, domain, timestamp, last_visited_at, total_time_spent, visit_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (url, title, text, domain, timestamp, timestamp, time_spent, 1),
        )
        connection.commit()
        return {
            "id": cursor.lastrowid,
            "status": "inserted",
            "total_time_spent": time_spent,
            "visit_count": 1,
            "cluster_id": None,
        }


def set_page_visit_cluster(record_id: int, cluster_id: int,
                            confidence: float | None = None) -> None:
    with get_connection() as connection:
        if confidence is not None:
            connection.execute(
                "UPDATE page_visits SET cluster_id = ?, cluster_confidence = ? WHERE id = ?",
                (cluster_id, round(confidence, 4), record_id),
            )
        else:
            connection.execute(
                "UPDATE page_visits SET cluster_id = ? WHERE id = ?",
                (cluster_id, record_id),
            )
        connection.commit()


def delete_page_visit(record_id: int) -> bool:
    with get_connection() as connection:
        cursor = connection.execute(
            "DELETE FROM page_visits WHERE id = ?", (record_id,)
        )
        return cursor.rowcount > 0


def fetch_page_visit_by_url(url: str) -> dict[str, Any] | None:
    with get_connection() as connection:
        row = connection.execute(
            "SELECT id, url, title FROM page_visits WHERE url = ?", (url,)
        ).fetchone()
        return dict(row) if row else None


def fetch_page_visits_by_ids(record_ids: list[int]) -> list[dict[str, Any]]:
    if not record_ids:
        return []

    placeholders = ", ".join(["?"] * len(record_ids))
    with get_connection() as connection:
        rows = connection.execute(
            f"""
            SELECT id, url, title, text, domain, timestamp, last_visited_at,
                   total_time_spent, visit_count, cluster_id, cluster_confidence
            FROM page_visits WHERE id IN ({placeholders})
            """,
            record_ids,
        ).fetchall()

    rows_by_id = {row["id"]: dict(row) for row in rows}
    return [rows_by_id[rid] for rid in record_ids if rid in rows_by_id]


def fetch_related_by_cluster(
    cluster_id: int, exclude_id: int, limit: int = 2
) -> list[dict[str, Any]]:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, url, title, text, total_time_spent
            FROM page_visits
            WHERE cluster_id = ? AND id != ?
            ORDER BY total_time_spent DESC
            LIMIT ?
            """,
            (cluster_id, exclude_id, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def fetch_low_confidence_members(
    cluster_id: int,
    threshold: float = REASSIGN_CONFIDENCE_THRESHOLD,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Return members whose cluster_confidence is below threshold (or NULL)."""
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, url, title
            FROM page_visits
            WHERE cluster_id = ?
              AND (cluster_confidence IS NULL OR cluster_confidence < ?)
            ORDER BY cluster_confidence ASC
            LIMIT ?
            """,
            (cluster_id, threshold, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def search_keyword_matches(query: str, limit: int = 20) -> list[dict[str, Any]]:
    normalized = query.strip().lower()
    if not normalized:
        return []

    tokens = [t for t in normalized.split() if t]
    if not tokens:
        return []

    like_clauses: list[str] = []
    score_fragments: list[str] = []
    score_params: list[Any] = []
    where_params: list[Any] = []

    for token in tokens:
        like_val = f"%{token}%"
        like_clauses.append(
            "(lower(title) LIKE ? OR lower(url) LIKE ? OR lower(text) LIKE ?)"
        )
        where_params.extend([like_val, like_val, like_val])
        score_fragments.append(
            """
            (CASE WHEN lower(title) LIKE ? THEN 3 ELSE 0 END) +
            (CASE WHEN lower(url)   LIKE ? THEN 2 ELSE 0 END) +
            (CASE WHEN lower(text)  LIKE ? THEN 1 ELSE 0 END)
            """
        )
        score_params.extend([like_val, like_val, like_val])

    score_expr = " + ".join(score_fragments) or "0"
    where_expr = " AND ".join(like_clauses)

    with get_connection() as connection:
        rows = connection.execute(
            f"""
            SELECT id, url, title, text, domain, timestamp, last_visited_at,
                   total_time_spent, visit_count, cluster_id, cluster_confidence,
                   ({score_expr}) AS keyword_score
            FROM page_visits
            WHERE {where_expr}
            ORDER BY keyword_score DESC, last_visited_at DESC
            LIMIT ?
            """,
            [*score_params, *where_params, limit],
        ).fetchall()
    return [dict(row) for row in rows]


# ---------------------------------------------------------------------------
# clusters — low-level DB helpers
# ---------------------------------------------------------------------------

def fetch_all_clusters() -> list[dict[str, Any]]:
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT id, centroid, member_count, label, representative_ids FROM clusters"
        ).fetchall()

    result = []
    for row in rows:
        result.append({
            "id": row["id"],
            "centroid": json.loads(row["centroid"]),
            "member_count": row["member_count"],
            "label": row["label"],
            "representative_ids": json.loads(row["representative_ids"] or "[]"),
        })
    return result


def create_cluster(centroid: list[float], label: str = "") -> int:
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO clusters (centroid, member_count, label, representative_ids, created_at, updated_at)
            VALUES (?, 1, ?, '[]', ?, ?)
            """,
            (json.dumps(centroid), label, now, now),
        )
        connection.commit()
        return cursor.lastrowid


def update_cluster_centroid(
    cluster_id: int,
    new_centroid: list[float],
    new_member_count: int,
    *,
    new_label: str = "",
    new_representative_ids: list[int] | None = None,
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as connection:
        if new_label and new_representative_ids is not None:
            connection.execute(
                """
                UPDATE clusters
                SET centroid = ?, member_count = ?, label = ?, representative_ids = ?, updated_at = ?
                WHERE id = ?
                """,
                (json.dumps(new_centroid), new_member_count, new_label,
                 json.dumps(new_representative_ids), now, cluster_id),
            )
        elif new_label:
            connection.execute(
                """
                UPDATE clusters
                SET centroid = ?, member_count = ?, label = ?, updated_at = ?
                WHERE id = ?
                """,
                (json.dumps(new_centroid), new_member_count, new_label, now, cluster_id),
            )
        elif new_representative_ids is not None:
            connection.execute(
                """
                UPDATE clusters
                SET centroid = ?, member_count = ?, representative_ids = ?, updated_at = ?
                WHERE id = ?
                """,
                (json.dumps(new_centroid), new_member_count,
                 json.dumps(new_representative_ids), now, cluster_id),
            )
        else:
            connection.execute(
                """
                UPDATE clusters
                SET centroid = ?, member_count = ?, updated_at = ?
                WHERE id = ?
                """,
                (json.dumps(new_centroid), new_member_count, now, cluster_id),
            )
        connection.commit()


def merge_cluster_into(source_id: int, target_id: int) -> None:
    with get_connection() as connection:
        connection.execute(
            "UPDATE page_visits SET cluster_id = ? WHERE cluster_id = ?",
            (target_id, source_id),
        )
        connection.execute("DELETE FROM clusters WHERE id = ?", (source_id,))
        connection.commit()


def fetch_cluster_label_titles(cluster_id: int, limit: int = 50) -> list[str]:
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT title FROM page_visits WHERE cluster_id = ? LIMIT ?",
            (cluster_id, limit),
        ).fetchall()
    return [row["title"] for row in rows]


def fetch_cluster_details() -> list[dict[str, Any]]:
    """Return cluster summary with representative item data. Used by GET /clusters."""
    clusters = fetch_all_clusters()
    result = []
    for cluster in clusters:
        rep_ids = cluster["representative_ids"]
        rep_items: list[dict[str, str]] = []
        if rep_ids:
            rows = fetch_page_visits_by_ids(rep_ids)
            rep_items = [{"title": r["title"], "url": r["url"]} for r in rows]
        result.append({
            "cluster_id": cluster["id"],
            "label": cluster["label"],
            "member_count": cluster["member_count"],
            "representative_items": rep_items,
        })
    return result


# ---------------------------------------------------------------------------
# Labeling
# ---------------------------------------------------------------------------

def _build_label(titles: list[str]) -> str:
    """
    Extract a short, human-readable label from a list of page titles.

    Strategy:
    1. Score bigrams (adjacent word pairs) from each title.
    2. If any bigram appears in ≥2 titles, use the top one.
    3. Otherwise fall back to the top 3 unigrams joined with " / ".
    """
    tokens_per_title: list[list[str]] = []
    for title in titles:
        tokens = [
            t for t in re.split(r"\W+", title.lower())
            if t and len(t) > 2 and t not in _STOPWORDS
        ]
        tokens_per_title.append(tokens)

    bigram_freq: dict[tuple[str, str], int] = {}
    unigram_freq: dict[str, int] = {}

    for tokens in tokens_per_title:
        seen_bigrams: set[tuple[str, str]] = set()
        seen_tokens: set[str] = set()
        for tok in tokens:
            if tok not in seen_tokens:
                unigram_freq[tok] = unigram_freq.get(tok, 0) + 1
                seen_tokens.add(tok)
        for i in range(len(tokens) - 1):
            bg = (tokens[i], tokens[i + 1])
            if bg not in seen_bigrams:
                bigram_freq[bg] = bigram_freq.get(bg, 0) + 1
                seen_bigrams.add(bg)

    # Require bigram to appear in at least 2 titles.
    good_bigrams = [(bg, freq) for bg, freq in bigram_freq.items() if freq >= 2]
    good_bigrams.sort(key=lambda x: -x[1])
    if good_bigrams:
        return " ".join(good_bigrams[0][0])

    top_unis = sorted(unigram_freq, key=lambda k: -unigram_freq[k])[:3]
    return " / ".join(top_unis) if top_unis else ""


def refresh_cluster_label(cluster_id: int) -> str:
    """Rebuild label using only representative nodes' titles (higher signal)."""
    with get_connection() as connection:
        row = connection.execute(
            "SELECT representative_ids FROM clusters WHERE id = ?",
            (cluster_id,),
        ).fetchone()

    if not row:
        return ""

    rep_ids = json.loads(row["representative_ids"] or "[]")

    # Prefer representative titles; fall back to all member titles if reps not yet set.
    if rep_ids:
        with get_connection() as connection:
            rows = connection.execute(
                f"SELECT title FROM page_visits WHERE id IN ({','.join('?' * len(rep_ids))})",
                rep_ids,
            ).fetchall()
        titles = [r["title"] for r in rows]
    else:
        titles = fetch_cluster_label_titles(cluster_id)

    label = _build_label(titles)
    if label:
        with get_connection() as connection:
            connection.execute(
                "UPDATE clusters SET label = ? WHERE id = ?",
                (label, cluster_id),
            )
            connection.commit()
    return label


# ---------------------------------------------------------------------------
# Representative nodes
# ---------------------------------------------------------------------------

def update_cluster_representatives(cluster_id: int) -> list[int]:
    """
    Recompute top-5 representative members by engagement score
    (time_spent + visit_count * 10 000) and persist to clusters table.
    """
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT id
            FROM page_visits
            WHERE cluster_id = ?
            ORDER BY (total_time_spent + visit_count * 10000) DESC
            LIMIT 5
            """,
            (cluster_id,),
        ).fetchall()
    rep_ids = [row["id"] for row in rows]

    with get_connection() as connection:
        connection.execute(
            "UPDATE clusters SET representative_ids = ? WHERE id = ?",
            (json.dumps(rep_ids), cluster_id),
        )
        connection.commit()

    return rep_ids


# ---------------------------------------------------------------------------
# High-level cluster logic
# ---------------------------------------------------------------------------

def assign_cluster(record_id: int, embedding: list[float]) -> int:
    """
    Assign a page_visit to a cluster, update the centroid, and return cluster_id.

    - Computes cosine similarity against all cluster centroids.
    - If best >= CLUSTER_SIMILARITY_THRESHOLD → join.
    - Else if room → create new cluster.
    - Else → join closest (cap enforced).
    - Stores cluster_confidence on the page_visit row.
    - Every CENTROID_RECOMPUTE_EVERY additions, rebuilds centroid from
      representative embeddings to prevent drift.
    """
    from .embedding import cosine_similarity, fetch_embeddings_by_ids, normalize_vector, update_centroid

    clusters = fetch_all_clusters()

    best_id: int | None = None
    best_sim: float = -1.0

    for cluster in clusters:
        sim = cosine_similarity(embedding, cluster["centroid"])
        if sim > best_sim:
            best_sim = sim
            best_id = cluster["id"]

    # Decide which cluster to join.
    if best_id is not None and best_sim >= CLUSTER_SIMILARITY_THRESHOLD:
        target_id = best_id
        confidence = best_sim
    elif len(clusters) < MAX_CLUSTERS:
        new_id = create_cluster(embedding)
        set_page_visit_cluster(record_id, new_id, confidence=1.0)
        return new_id
    else:
        # Cap hit — join closest regardless of threshold.
        target_id = best_id
        confidence = best_sim

    target = next(c for c in clusters if c["id"] == target_id)
    new_count = target["member_count"] + 1

    # Persist cluster assignment + confidence.
    set_page_visit_cluster(record_id, target_id, confidence=confidence)

    # Decide centroid update strategy.
    if new_count % CENTROID_RECOMPUTE_EVERY == 0:
        # Periodic: recompute from representative embeddings to prevent drift.
        rep_ids = update_cluster_representatives(target_id)
        rep_embeddings = fetch_embeddings_by_ids(rep_ids) if rep_ids else []
        if rep_embeddings:
            dim = len(rep_embeddings[0])
            avg = [sum(e[i] for e in rep_embeddings) / len(rep_embeddings) for i in range(dim)]
            new_centroid = normalize_vector(avg)
        else:
            new_centroid = update_centroid(target["centroid"], target["member_count"], embedding)
        update_cluster_centroid(target_id, new_centroid, new_count,
                                new_representative_ids=rep_ids)
    else:
        # Standard: incremental weighted update.
        new_centroid = update_centroid(target["centroid"], target["member_count"], embedding)
        update_cluster_centroid(target_id, new_centroid, new_count)

    return target_id


def maybe_merge_clusters() -> None:
    """
    Merge cluster pairs that are semantically near-identical.

    Guards:
    - Similarity must exceed CLUSTER_MERGE_THRESHOLD (0.88).
    - Size ratio (min/max members) must exceed CLUSTER_MERGE_MIN_SIZE_RATIO (0.3)
      to prevent a large cluster from silently absorbing a tiny one.
    - Uses proper weighted centroid merge (not incremental approximation).

    After merging, triggers a reassignment pass on borderline members.
    """
    from .embedding import cosine_similarity, normalize_vector

    clusters = fetch_all_clusters()
    merged_ids: set[int] = set()

    for i, a in enumerate(clusters):
        if a["id"] in merged_ids:
            continue
        for b in clusters[i + 1:]:
            if b["id"] in merged_ids:
                continue

            sim = cosine_similarity(a["centroid"], b["centroid"])
            if sim < CLUSTER_MERGE_THRESHOLD:
                continue

            # Size ratio guard.
            size_ratio = min(a["member_count"], b["member_count"]) / max(
                a["member_count"], b["member_count"], 1
            )
            if size_ratio < CLUSTER_MERGE_MIN_SIZE_RATIO:
                continue

            # Keep larger cluster; merge smaller into it.
            larger, smaller = (a, b) if a["member_count"] >= b["member_count"] else (b, a)
            total = larger["member_count"] + smaller["member_count"]

            # Proper weighted centroid average (not incremental approximation).
            dim = len(larger["centroid"])
            weighted = [
                (larger["centroid"][i] * larger["member_count"] +
                 smaller["centroid"][i] * smaller["member_count"]) / total
                for i in range(dim)
            ]
            merged_centroid = normalize_vector(weighted)

            merge_cluster_into(smaller["id"], larger["id"])
            update_cluster_centroid(larger["id"], merged_centroid, total)
            merged_ids.add(smaller["id"])

            # Re-evaluate borderline members of the merged cluster.
            reassign_borderline_items(larger["id"])
            break


def reassign_borderline_items(cluster_id: int) -> None:
    """
    Re-evaluate up to 10 low-confidence members of a cluster.
    If a different cluster fits better (and the item would actually pass its
    threshold), move the item there.

    This runs after merges to clean up misassigned items.
    """
    from .embedding import cosine_similarity, fetch_embeddings_by_ids

    borderline = fetch_low_confidence_members(cluster_id)
    if not borderline:
        return

    record_ids = [r["id"] for r in borderline]
    clusters = fetch_all_clusters()
    if not clusters:
        return

    embeddings = fetch_embeddings_by_ids(record_ids)
    if not embeddings:
        return

    for record, emb in zip(borderline, embeddings):
        best_id: int | None = None
        best_sim: float = -1.0

        for c in clusters:
            sim = cosine_similarity(emb, c["centroid"])
            if sim > best_sim:
                best_sim = sim
                best_id = c["id"]

        # Only move if the new cluster is meaningfully better and passes threshold.
        current_conf = 0.0
        if best_id is not None and best_id != cluster_id and best_sim >= CLUSTER_SIMILARITY_THRESHOLD:
            set_page_visit_cluster(record["id"], best_id, confidence=best_sim)
