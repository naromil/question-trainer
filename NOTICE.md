# Copyright and content notice

Copyright © 2026 naromil. All rights reserved.

The source code, styles, tooling and documentation in this repository are the original
work of the repository author. No licence is granted except by explicit written
permission; a fork is fine, redistribution of the code as your own is not.

## No SAT question content is distributed here

This repository ships **no** question material. The trainer reads a generated data file,
`app/data/questions.js`, which is:

* **not committed** — it is listed in `.gitignore`;
* **not in the repository history** — it never appears in any commit reachable from
  `main`; the ignore rule is enforced for every future commit too;
* **not regenerable from this repository alone** — it is built locally by
  `tools/build_app_data.py` from `questions/all.json`, produced by the extraction
  pipeline in `questions/tools/` from material the reader supplies, plus the figure
  markup (`tools/bank.py figures`) read from the public Educator Question Bank API.

Stimulus text and answer choices in that local file derive from SAT question material, the
rationale text derives from the College Board Educator Question Bank API, and for the items
that carry a figure the stimulus text and the figure itself (charts as inline SVG, tables
as markup) come from that same API. All of that material remains the property of its owner,
**College Board**, and is kept by the reader for their own personal study. Nothing in this
repository grants any right to reproduce or redistribute it.

If you fork this project, keep `app/data/questions.js` and `questions/` ignored and out
of your commits. A clone without them runs, and tells you to generate the data.

## Trademarks and affiliation

SAT, Bluebook and College Board are trademarks of College Board. Khan Academy is a
trademark of Khan Academy, Inc. Those names appear here only to describe the material the
trainer reads, the interfaces it imitates (the Bluebook cross-out control, the
Khan-style mastery score), and the origin of the local data.

This project is **not affiliated with, endorsed by, sponsored by, or approved by**
College Board, Khan Academy, or any other test publisher or educational provider.
