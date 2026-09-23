from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path
from typing import Callable, Iterable


def chunk_text(text: str, chunk_size: int, overlap: int) -> list[str]:
    cleaned = " ".join(text.split())
    if not cleaned:
        return []

    step = max(chunk_size - overlap, 1)
    chunks: list[str] = []
    for start in range(0, len(cleaned), step):
        chunk = cleaned[start : start + chunk_size].strip()
        if chunk:
            chunks.append(chunk)
        if start + chunk_size >= len(cleaned):
            break
    return chunks


def cosine_similarity(left: list[float], right: list[float]) -> float:
    numerator = sum(a * b for a, b in zip(left, right, strict=False))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return numerator / (left_norm * right_norm)


class SQLiteVectorStore:
    def __init__(self, database_path: Path):
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_name TEXT NOT NULL UNIQUE,
                    chunk_count INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    document_id INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    embedding TEXT NOT NULL,
                    FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
                )
                """
            )

    def list_documents(self) -> list[dict[str, str | int]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT source_name, chunk_count, created_at FROM documents ORDER BY created_at DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_document(self, source_name: str) -> None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id FROM documents WHERE source_name = ?", (source_name,)
            ).fetchone()
            if row is None:
                return
            connection.execute("DELETE FROM chunks WHERE document_id = ?", (row["id"],))
            connection.execute("DELETE FROM documents WHERE id = ?", (row["id"],))

    def upsert_document(
        self,
        source_name: str,
        text: str,
        chunk_size: int,
        overlap: int,
        embed_many: Callable[[list[str]], list[list[float]]],
    ) -> int:
        chunks = chunk_text(text, chunk_size=chunk_size, overlap=overlap)
        if not chunks:
            raise ValueError("The document did not contain any indexable text.")

        embeddings = embed_many(chunks)
        if len(embeddings) != len(chunks):
            raise ValueError("Embedding response size did not match the chunk count.")

        with self._connect() as connection:
            existing = connection.execute(
                "SELECT id FROM documents WHERE source_name = ?", (source_name,)
            ).fetchone()
            if existing is not None:
                connection.execute("DELETE FROM chunks WHERE document_id = ?", (existing["id"],))
                connection.execute("DELETE FROM documents WHERE id = ?", (existing["id"],))

            cursor = connection.execute(
                "INSERT INTO documents (source_name, chunk_count) VALUES (?, ?)",
                (source_name, len(chunks)),
            )
            document_id = cursor.lastrowid
            connection.executemany(
                "INSERT INTO chunks (document_id, content, embedding) VALUES (?, ?, ?)",
                [
                    (document_id, chunk, json.dumps(embedding))
                    for chunk, embedding in zip(chunks, embeddings, strict=True)
                ],
            )

        return len(chunks)

    def search(
        self,
        query: str,
        top_k: int,
        embed_one: Callable[[str], list[float]],
    ) -> list[dict[str, str | float]]:
        query_embedding = embed_one(query)
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT documents.source_name, chunks.content, chunks.embedding
                FROM chunks
                JOIN documents ON documents.id = chunks.document_id
                """
            ).fetchall()

        scored: list[dict[str, str | float]] = []
        for row in rows:
            similarity = cosine_similarity(query_embedding, json.loads(row["embedding"]))
            scored.append(
                {
                    "source_name": row["source_name"],
                    "content": row["content"],
                    "score": similarity,
                }
            )

        scored.sort(key=lambda item: float(item["score"]), reverse=True)
        return scored[:top_k]
