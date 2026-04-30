from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path
from typing import Any

import chromadb
from sentence_transformers import SentenceTransformer


BASE_DIR = Path(__file__).resolve().parent
CHROMA_PATH = BASE_DIR / "chroma_db"
COLLECTION_NAME = "ambi_pages"
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


@lru_cache(maxsize=1)
def get_embedding_model() -> SentenceTransformer:
  return SentenceTransformer(MODEL_NAME)


@lru_cache(maxsize=1)
def get_chroma_client() -> chromadb.PersistentClient:
  CHROMA_PATH.mkdir(parents=True, exist_ok=True)
  return chromadb.PersistentClient(path=str(CHROMA_PATH))


@lru_cache(maxsize=1)
def get_collection():
  return get_chroma_client().get_or_create_collection(name=COLLECTION_NAME)


def initialize_vector_store() -> None:
  get_collection()


def embed_document(text: str) -> list[float]:
  model = get_embedding_model()
  embedding = model.encode_document(
    [text],
    normalize_embeddings=True
  )
  return embedding[0].tolist()


def embed_query(query: str) -> list[float]:
  model = get_embedding_model()
  embedding = model.encode_query(
    [query],
    normalize_embeddings=True
  )
  return embedding[0].tolist()


def upsert_document_embedding(
  *,
  record_id: int,
  text: str,
  url: str,
  title: str
) -> None:
  collection = get_collection()
  embedding = embed_document(text)

  collection.upsert(
    ids=[str(record_id)],
    embeddings=[embedding],
    documents=[text],
    metadatas=[{
      "url": url,
      "title": title
    }]
  )


def normalize_vector(v: list[float]) -> list[float]:
  magnitude = math.sqrt(sum(x * x for x in v))
  if magnitude == 0:
    return v
  return [x / magnitude for x in v]


def cosine_similarity(a: list[float], b: list[float]) -> float:
  return sum(x * y for x, y in zip(a, b))


def update_centroid(
  old_centroid: list[float],
  old_count: int,
  new_embedding: list[float]
) -> list[float]:
  """Incremental centroid update: weighted average, then re-normalize."""
  updated = [
    (old_centroid[i] * old_count + new_embedding[i]) / (old_count + 1)
    for i in range(len(old_centroid))
  ]
  return normalize_vector(updated)


def fetch_embeddings_by_ids(record_ids: list[int]) -> list[list[float]]:
  """Retrieve stored document embeddings from Chroma by SQLite record IDs."""
  if not record_ids:
    return []
  collection = get_collection()
  results = collection.get(
    ids=[str(rid) for rid in record_ids],
    include=["embeddings"]
  )
  return results.get("embeddings") or []


def search_similar_documents(query: str, limit: int = 20) -> list[dict[str, Any]]:
  collection = get_collection()
  query_embedding = embed_query(query)

  results = collection.query(
    query_embeddings=[query_embedding],
    n_results=limit,
    include=["metadatas", "distances"]
  )

  ids = results.get("ids", [[]])[0]
  metadatas = results.get("metadatas", [[]])[0]
  distances = results.get("distances", [[]])[0]

  matches: list[dict[str, Any]] = []

  for index, record_id in enumerate(ids):
    metadata = metadatas[index] if index < len(metadatas) else {}
    distance = distances[index] if index < len(distances) else None

    matches.append({
      "id": record_id,
      "metadata": metadata or {},
      "distance": distance
    })

  return matches
