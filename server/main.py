from __future__ import annotations

import math
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import FastAPI
from pydantic import BaseModel, Field

from .db import (
  assign_cluster,
  fetch_all_clusters,
  fetch_cluster_details,
  fetch_page_visits_by_ids,
  fetch_related_by_cluster,
  init_db,
  maybe_merge_clusters,
  refresh_cluster_label,
  search_keyword_matches,
  upsert_page_visit,
)
from .embedding import (
  embed_document,
  initialize_vector_store,
  search_similar_documents,
  upsert_document_embedding,
)


app = FastAPI(title="Ambi V1 API")


class IngestRequest(BaseModel):
  url: str
  title: str
  text: str
  timestamp: str
  time_spent: float = Field(ge=0)


class SearchRequest(BaseModel):
  query: str = Field(min_length=1)


# Scoring weights — must sum to ≤1 before boosts so raw scores stay comparable.
SEMANTIC_WEIGHT = 0.60
KEYWORD_WEIGHT = 0.25
CLUSTER_BOOST = 0.10          # flat bonus for results in the dominant cluster
CONFIDENCE_WEIGHT = 0.13      # scales [0,1] confidence → max 0.13 extra (+0.08 per V1.1)

# Refresh cluster label every N ingests that land in a given cluster.
LABEL_REFRESH_EVERY = 5
# Run merge check every N total ingests.
MERGE_CHECK_EVERY = 20

_ingest_counter = 0


def extract_domain(url: str) -> str:
  return urlparse(url).netloc or "unknown"


def parse_timestamp(value: str) -> datetime | None:
  if not value:
    return None
  try:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
  except ValueError:
    return None
  return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def build_snippet(text: str, query: str, max_length: int = 180) -> str:
  normalized = " ".join((text or "").split())
  if not normalized:
    return ""

  lower_text = normalized.lower()
  lower_query = query.lower().strip()
  idx = lower_text.find(lower_query) if lower_query else -1

  if idx == -1:
    return normalized[:max_length].rstrip() + ("..." if len(normalized) > max_length else "")

  start = max(0, idx - 60)
  end = min(len(normalized), idx + max_length - 60)
  snippet = normalized[start:end].strip()
  if start > 0:
    snippet = f"...{snippet}"
  if end < len(normalized):
    snippet = f"{snippet}..."
  return snippet


def calculate_recency_boost(last_visited_at: str) -> float:
  dt = parse_timestamp(last_visited_at)
  if not dt:
    return 0.0
  hours = max(0.0, (datetime.now(timezone.utc) - dt).total_seconds() / 3600)
  return min(0.12, 0.12 / (1 + hours / 24))


def calculate_time_boost(total_time_spent: float) -> float:
  if total_time_spent <= 0:
    return 0.0
  return min(0.1, math.log1p(total_time_spent) / 80)


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

@app.on_event("startup")
def startup() -> None:
  init_db()
  initialize_vector_store()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health_check() -> dict[str, str]:
  return {"status": "ok"}


@app.get("/clusters")
def list_clusters() -> dict[str, object]:
  """Observability endpoint — returns all clusters with representative items."""
  details = fetch_cluster_details()
  return {"count": len(details), "clusters": details}


@app.post("/ingest")
def ingest(payload: IngestRequest) -> dict[str, object]:
  global _ingest_counter

  domain = extract_domain(payload.url)
  record = upsert_page_visit(
    url=payload.url,
    title=payload.title,
    text=payload.text,
    domain=domain,
    timestamp=payload.timestamp,
    time_spent=payload.time_spent,
  )

  # Compute embedding once; reuse for both Chroma and cluster assignment.
  embedding = embed_document(payload.text or payload.title)

  upsert_document_embedding(
    record_id=record["id"],
    text=payload.text,
    url=payload.url,
    title=payload.title,
  )

  cluster_id = assign_cluster(record["id"], embedding)

  _ingest_counter += 1

  if _ingest_counter % LABEL_REFRESH_EVERY == 0:
    refresh_cluster_label(cluster_id)

  if _ingest_counter % MERGE_CHECK_EVERY == 0:
    maybe_merge_clusters()

  return {
    "id": record["id"],
    "status": record["status"],
    "url": payload.url,
    "domain": domain,
    "total_time_spent": record["total_time_spent"],
    "visit_count": record["visit_count"],
    "cluster_id": cluster_id,
  }


@app.post("/search")
def search(payload: SearchRequest) -> dict[str, object]:
  vector_matches = search_similar_documents(payload.query, limit=20)
  keyword_matches = search_keyword_matches(payload.query, limit=20)

  candidate_ids: set[int] = set()
  semantic_scores: dict[int, float] = {}
  keyword_scores: dict[int, float] = {}
  vector_metadata: dict[int, dict[str, object]] = {}

  for match in vector_matches:
    try:
      rid = int(match["id"])
    except (TypeError, ValueError):
      continue
    candidate_ids.add(rid)
    distance = match.get("distance")
    semantic_scores[rid] = 1 / (1 + float(distance or 0))
    vector_metadata[rid] = match.get("metadata", {})

  max_kw = max((float(m.get("keyword_score", 0)) for m in keyword_matches), default=0)
  for match in keyword_matches:
    rid = int(match["id"])
    candidate_ids.add(rid)
    raw = float(match.get("keyword_score", 0))
    keyword_scores[rid] = raw / max_kw if max_kw > 0 else 0

  records = fetch_page_visits_by_ids(sorted(candidate_ids))
  records_by_id = {r["id"]: r for r in records}

  # Dominant cluster = the cluster most represented in the top-5 semantic hits.
  top_semantic_ids = sorted(semantic_scores, key=lambda k: semantic_scores[k], reverse=True)[:5]
  cluster_votes: dict[int, int] = {}
  for rid in top_semantic_ids:
    cid = records_by_id.get(rid, {}).get("cluster_id")
    if cid is not None:
      cluster_votes[cid] = cluster_votes.get(cid, 0) + 1

  dominant_cluster_id: int | None = (
    max(cluster_votes, key=lambda k: cluster_votes[k]) if cluster_votes else None
  )

  results = []
  for record in records:
    sem = semantic_scores.get(record["id"], 0)
    kw = keyword_scores.get(record["id"], 0)
    recency = calculate_recency_boost(record["last_visited_at"])
    time_b = calculate_time_boost(float(record["total_time_spent"]))

    cluster_boost = (
      CLUSTER_BOOST
      if record.get("cluster_id") is not None
      and record["cluster_id"] == dominant_cluster_id
      else 0.0
    )

    # cluster_confidence is NULL for records ingested before V1.2 — treat as 0.
    confidence = float(record.get("cluster_confidence") or 0)
    confidence_bonus = confidence * CONFIDENCE_WEIGHT

    score = (
      sem * SEMANTIC_WEIGHT
      + kw * KEYWORD_WEIGHT
      + recency
      + time_b
      + cluster_boost
      + confidence_bonus
    )

    results.append({
      **record,
      "snippet": build_snippet(record["text"], payload.query),
      "semantic_score": round(sem, 4),
      "keyword_score": round(kw, 4),
      "recency_boost": round(recency, 4),
      "time_boost": round(time_b, 4),
      "cluster_boost": round(cluster_boost, 4),
      "confidence_bonus": round(confidence_bonus, 4),
      "score": round(score, 4),
      "vector_metadata": vector_metadata.get(record["id"], {}),
    })

  results.sort(key=lambda r: r["score"], reverse=True)
  top_results = results[:5]

  for i, result in enumerate(top_results, start=1):
    result["rank"] = i

  for result in top_results:
    cid = result.get("cluster_id")
    if cid is not None:
      related_rows = fetch_related_by_cluster(cid, exclude_id=result["id"], limit=2)
      result["related"] = [
        {
          "title": row["title"],
          "url": row["url"],
          "snippet": build_snippet(row["text"], payload.query),
        }
        for row in related_rows
      ]
    else:
      result["related"] = []

  # Context label from the dominant cluster.
  context_label: str | None = None
  if dominant_cluster_id is not None:
    all_clusters = fetch_all_clusters()
    dominant = next((c for c in all_clusters if c["id"] == dominant_cluster_id), None)
    if dominant and dominant.get("label"):
      context_label = dominant["label"]

  return {
    "query": payload.query,
    "count": len(top_results),
    "context_label": context_label,
    "results": top_results,
  }
