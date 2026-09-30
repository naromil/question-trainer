#!/usr/bin/env python3
# Copyright (c) 2026 naromil. All rights reserved.
# No College Board question content is distributed with this repository: the file this
# script writes, app/data/questions.js, is gitignored and local-only. See NOTICE.md.
"""Build `app/data/questions.js` for the SAT trainer.

Source of truth: `questions/all.json` (gitignored, produced by the
question-bank pipeline in `questions/tools/`).

This script only *selects, normalises and validates*; it never rewrites prose.

  * keeps `difficulty == "Hard"` items (the trainer is a hard-question drill);
  * recovers the 29 `answer: null` items (the whole `Inferences 3` set, whose key
    PDF is byte-identical to the question PDF) from the bank rationale, which
    always starts with `Choice <L> is the best answer.`; the recovered letter is
    cross-checked against the 224 keyed items and any disagreement aborts;
  * strips the stray leading `-` some set names carry in the source sheets;
  * folds the OCR `Text1` / `Text 2` cross-text labels to `Text 1` / `Text 2`;
  * for items whose bank record draws a figure, ships the bank's own markup
    (`stimulus_html`: inline SVG chart or real table) and its exact prose as the
    stimulus, instead of the OCR of that row, which is chart noise;
  * derives the `underline` / `figure` caveat flags the UI warns about, scoped to
    what the item actually renders: a figure item loses the flags that only ever
    described the replaced OCR stimulus, and keeps `underline` only when the bank
    markup does not show the underline itself.

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
SOURCE = ROOT / "questions" / "all.json"
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
# How the bank marks an underlined portion in its own stimulus HTML.
UNDERLINE = re.compile(r"<u[ >]|text-decoration:\s*underline", re.I)
# Flags that only ever described the OCR of the stimulus, plus the two that say "this
# screenshot looks like it held a figure": for the items whose text *and* figure come
# from the bank, none of them describes anything the app renders.
STIMULUS_OCR_FLAGS = {
    "ocr-disagreement", "line-repaired", "multiple-blanks", "blank-missing",
    "stem-not-parsed", "psm3-fallback", "possible-figure", "figure-mentioned",
}


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
        # The bank's own figure for this item: inline SVG chart or real table markup,
        # vector-exact, where the screenshot OCR of the same row is reading-order noise.
        figure = item.get("figure_kind")
        html = item.get("bank_stimulus_html")
        stimulus = item["stimulus"]
        if figure:
            if figure not in ("svg", "table") or not html or not item.get("bank_stimulus_text"):
                raise SystemExit(f"{qid}: figure_kind {figure!r} without bank stimulus")
            if re.search(r"<script|\son[a-z]+\s*=", html, re.I):
                raise SystemExit(f"{qid}: unsanitized figure markup")
            stimulus = item["bank_stimulus_text"]

        flags = sorted(set(item.get("flags") or []))
        if figure:
            # These flags only ever described the OCR of the stimulus, which the bank's
            # own text replaces here; `figure` says what remains true about the figure.
            flags = [f for f in flags if f not in STIMULUS_OCR_FLAGS]
        # `underline` drives both the caveat and the filter, so it is about what the item
        # renders: the bank marks the referenced portion (and italics) in its own markup,
        # which is the exception to OCR's blindness to both.
        if "underlin" in body.lower() and not (html and UNDERLINE.search(html)):
            flags.append("underline")
        if figure or {"possible-figure", "figure-mentioned"} & set(flags):
            flags.append("figure")

        entry = OrderedDict(
            id=qid,
            set=normalise_set(item["set"]),
            skill=item["skill"],
            domain=item["domain"],
            number=item["number"],
            stimulus=normalise_stimulus(stimulus),
            stem=re.sub(r"\s+", " ", item["question"]).strip(),
            choices=[c["text"].strip() for c in choices],
            answer=answer,
            analysis=re.sub(r"[ \t]+", " ", analysis).strip(),
            flags=sorted(set(flags)),
            source=OrderedDict(
                pdf=item["source"]["pdf"], page=item["source"]["page"]
            ),
        )
        if figure:
            entry["figure_kind"] = figure
            entry["stimulus_html"] = html
        questions.append(entry)

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
            source="questions/all.json",
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
        "// LOCAL ONLY: not distributed with the repository. This file contains College\n"
        "// Board question text and rationales; keep it out of every commit (.gitignore)\n"
        "// and see NOTICE.md for the content and trademark terms.\n"
        "// Hard Reading & Writing items from the SAT Question Bank JSON export.\n"
        "// Rationale text, difficulty and figure markup come from the College Board\n"
        "// Educator Question Bank; the rest is OCR of the source screenshots. Items\n"
        "// with `figure_kind` carry the bank's own figure in `stimulus_html`.\n"
        "(function (root, data) {\n"
        "  if (typeof module === 'object' && module.exports) module.exports = data;\n"
        "  else root.SATBANK = data;\n"
        "})(typeof globalThis !== 'undefined' ? globalThis : this, "
        f"{body});\n",
        encoding="utf-8",
    )

    print(f"{TARGET.relative_to(ROOT)}: {len(questions)} items, "
          f"{TARGET.stat().st_size / 1024:.0f} KiB, "
          f"{recoveries} answers recovered from rationales, "
          f"{sum(1 for q in questions if 'figure_kind' in q)} bank figures")
    print("\nper skill:")
    for entry in skills:
        print(f"  {entry['domain']:<28} {entry['skill']:<28} {entry['count']:>3}")
    print("\nflag prevalence:", dict(Counter(f for q in questions for f in q["flags"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
