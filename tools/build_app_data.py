#!/usr/bin/env python3
"""Build `app/data/questions.js` for the SAT trainer.

Source of truth: `SAT Question Bank JSON/all.json` (gitignored, produced by the
question-bank pipeline in `SAT Question Bank JSON/tools/`).

This script only *selects, normalises and validates*; it never rewrites prose.

  * keeps `difficulty == "Hard"` items (the trainer is a hard-question drill);
  * recovers the 29 `answer: null` items (the whole `Inferences 3` set, whose key
    PDF is byte-identical to the question PDF) from the bank rationale, which
    always starts with `Choice <L> is the best answer.`; the recovered letter is
    cross-checked against the 224 keyed items and any disagreement aborts;
  * strips the stray leading `-` some set names carry in the source sheets;
  * folds the OCR `Text1` / `Text 2` cross-text labels to `Text 1` / `Text 2`;
  * derives the `underline` / `figure` caveat flags the UI warns about.

Run from the repo root:  python3 tools/build_app_data.py
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "SAT Question Bank JSON" / "all.json"
TARGET = ROOT / "app" / "data" / "questions.js"
DIFFICULTY = "Hard"

# College Board's own domain order, used for the home screen.
DOMAINS = [
    "Craft and Structure",
    "Information and Ideas",
    "Expression of Ideas",
    "Standard English Conventions",
]

BEST_ANSWER = re.compile(r"^Choice ([A-D]) is the best answer\b\.?")
TEXT_LABEL = re.compile(r"^Text\s?(\d+)$")


def recover_answer(item: dict) -> tuple[str, str]:
    """Return (answer_letter, how). `how` is 'key' or 'rationale'."""
    analysis = (item.get("analysis") or "").strip()
    match = BEST_ANSWER.match(analysis)
    letter = item.get("answer")
    if match:
        derived = match.group(1)
        if letter and letter != derived:
            raise SystemExit(
                f"{item['id']}: answer key says {letter}, bank rationale says "
                f"{derived} - refusing to guess"
            )
        if not letter:
            return derived, "rationale"
        return letter, "key"
    if letter:
        return letter, "key"
    raise SystemExit(
        f"{item['id']}: no answer key and no 'Choice X is the best answer' "
        f"rationale - item cannot be graded"
    )


def normalise_stimulus(text: str) -> str:
    """Collapse OCR line-wrap noise; label cross-text blocks."""
    blocks = []
    for block in re.split(r"\n{2,}", text.strip()):
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        out = []
        for line in lines:
            label = TEXT_LABEL.match(line)
            if label:
                out.append(f"Text {label.group(1)}")
            else:
                out.append(line)
        blocks.append("\n".join(out))
    return "\n\n".join(blocks)


def normalise_set(name: str) -> str:
    return re.sub(r"^[^A-Za-z0-9]+", "", name).strip()


def main() -> int:
    if not SOURCE.exists():
        raise SystemExit(f"missing source: {SOURCE}")

    raw = json.loads(SOURCE.read_text())
    hard = [item for item in raw if item.get("difficulty") == DIFFICULTY]

    questions = []
    recoveries = 0
    seen_ids = set()
    for item in hard:
        qid = item["id"]
        if qid in seen_ids:
            raise SystemExit(f"duplicate id {qid}")
        seen_ids.add(qid)

        answer, how = recover_answer(item)
        if how == "rationale":
            recoveries += 1

        choices = item["choices"]
        if len(choices) != 4:
            raise SystemExit(f"{qid}: {len(choices)} choices")
        if [c["label"] for c in choices] != ["A", "B", "C", "D"]:
            raise SystemExit(f"{qid}: unexpected choice labels")
        if not item["stimulus"].strip() or not item["question"].strip():
            raise SystemExit(f"{qid}: empty stimulus/question")
        for choice in choices:
            if not choice["text"].strip():
                raise SystemExit(f"{qid}: empty choice text")

        analysis = (item.get("analysis") or "").strip()
        if not analysis:
            raise SystemExit(f"{qid}: hard item without a rationale")

        body = f"{item['question']}\n{item['stimulus']}"
        flags = sorted(set(item.get("flags") or []))
        if "underlin" in body.lower():
            flags.append("underline")
        if {"possible-figure", "figure-mentioned"} & set(flags):
            flags.append("figure")

        questions.append(
            OrderedDict(
                id=qid,
                set=normalise_set(item["set"]),
                skill=item["skill"],
                domain=item["domain"],
                number=item["number"],
                stimulus=normalise_stimulus(item["stimulus"]),
                stem=re.sub(r"\s+", " ", item["question"]).strip(),
                choices=[c["text"].strip() for c in choices],
                answer=answer,
                analysis=re.sub(r"[ \t]+", " ", analysis).strip(),
                flags=sorted(set(flags)),
                source=OrderedDict(
                    pdf=item["source"]["pdf"], page=item["source"]["page"]
                ),
            )
        )

    questions.sort(key=lambda q: (DOMAINS.index(q["domain"]), q["skill"], q["set"], q["id"]))

    by_skill: "OrderedDict[str, OrderedDict]" = OrderedDict()
    for q in questions:
        entry = by_skill.setdefault(
            q["skill"],
            OrderedDict(skill=q["skill"], domain=q["domain"], count=0, sets=[]),
        )
        entry["count"] += 1
        if q["set"] not in entry["sets"]:
            entry["sets"].append(q["set"])
    skills = list(by_skill.values())

    payload = OrderedDict(
        meta=OrderedDict(
            generated=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            source="SAT Question Bank JSON/all.json",
            section="Reading and Writing",
            difficulty=DIFFICULTY,
            count=len(questions),
            answers_recovered_from_rationale=recoveries,
            domains=[d for d in DOMAINS if any(s["domain"] == d for s in skills)],
            skills=skills,
        ),
        questions=questions,
    )

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(payload, ensure_ascii=False, indent=1)
    TARGET.write_text(
        "// Generated by tools/build_app_data.py - do not edit by hand.\n"
        "// Hard Reading & Writing items from the SAT Question Bank JSON export.\n"
        "// Rationale text and difficulty come from the College Board Educator\n"
        "// Question Bank; stimulus/choices are OCR of the source screenshots.\n"
        "(function (root, data) {\n"
        "  if (typeof module === 'object' && module.exports) module.exports = data;\n"
        "  else root.SATBANK = data;\n"
        "})(typeof globalThis !== 'undefined' ? globalThis : this, "
        f"{body});\n",
        encoding="utf-8",
    )

    print(f"{TARGET.relative_to(ROOT)}: {len(questions)} items, "
          f"{TARGET.stat().st_size / 1024:.0f} KiB, "
          f"{recoveries} answers recovered from rationales")
    print("\nper skill:")
    for entry in skills:
        print(f"  {entry['domain']:<28} {entry['skill']:<28} {entry['count']:>3}")
    print("\nflag prevalence:", dict(Counter(f for q in questions for f in q["flags"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
