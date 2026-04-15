#!/usr/bin/env python3
"""AKIS RAG Knowledge Base — Bulk Document Ingestion (Python version)"""

import json, os, ssl, sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError

API_URL = "https://akisflow.com"
TOKEN = sys.argv[1] if len(sys.argv) > 1 else ""

if not TOKEN:
    print("Usage: python3 ingest-docs-python.py JWT_TOKEN")
    sys.exit(1)

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DOC_FILES = [
    "CLAUDE.md",
    "docs/AGENTS.md",
    "docs/AGENT_VERIFICATION.md",
    "docs/API_SPEC.md",
    "docs/ARCHITECTURE.md",
    "docs/CONTINUATION_USE_CASES.md",
    "docs/DEPLOYMENT.md",
    "docs/ENV_SETUP.md",
    "docs/KNOWLEDGE_INTEGRITY.md",
    "docs/PIPELINE.md",
    "docs/ROADMAP.md",
    "docs/TESTING.md",
    "docs/UI_DESIGN_SYSTEM.md",
    "docs/USE_CASES.md",
    "docs/architecture/ADR-001-adversarial-review.md",
    "docs/architecture/ADR-002-fix-loop-pattern.md",
    "docs/architecture/ADR-003-holdout-testing.md",
    "docs/architecture/ADR-004-level3-pipeline-architecture.md",
    "docs/architecture/ADR-005-domain-agnostic-verification.md",
    "docs/learnings/CONVENTIONS.md",
    "docs/learnings/CRITIC_LEARNINGS.md",
    "docs/learnings/PIPELINE_LEARNINGS.md",
    "docs/learnings/PROTO_LEARNINGS.md",
    "docs/learnings/SCRIBE_LEARNINGS.md",
    "docs/learnings/TRACE_LEARNINGS.md",
    "docs/plans/AKIS_VISION.md",
    "docs/plans/AKIS_LEVEL3_MASTER_PLAN.md",
    "docs/dogfooding/DOGFOODING_GUIDE.md",
    "docs/deploy/OCI_DEPLOY.md",
    "docs/deploy/OCI_RUNBOOK.md",
]

# Allow self-signed certs if needed
ctx = ssl.create_default_context()

print(f"AKIS RAG Ingestion — {len(DOC_FILES)} files")
print(f"API: {API_URL}")
print()

ok, skip, fail = 0, 0, 0

for doc_path in DOC_FILES:
    full = os.path.join(PROJECT_DIR, doc_path)
    if not os.path.isfile(full):
        print(f"  SKIP {doc_path} (not found)")
        skip += 1
        continue

    with open(full, "r", encoding="utf-8") as f:
        content = f.read()

    title = os.path.basename(doc_path).replace(".md", "")
    payload = json.dumps({
        "title": title,
        "content": content,
        "sourcePath": doc_path,
        "status": "approved",
        "metadata": {"category": "project-docs"}
    }).encode("utf-8")

    req = Request(
        f"{API_URL}/api/knowledge/documents/upload",
        data=payload,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        resp = urlopen(req, context=ctx, timeout=30)
        code = resp.getcode()
        print(f"  OK   {doc_path} (HTTP {code})")
        ok += 1
    except HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:200]
        print(f"  FAIL {doc_path} (HTTP {e.code}): {body}")
        fail += 1
    except Exception as e:
        print(f"  FAIL {doc_path}: {e}")
        fail += 1

print()
print(f"Results: {ok} uploaded, {skip} skipped, {fail} failed")
sys.exit(1 if fail > 0 else 0)
