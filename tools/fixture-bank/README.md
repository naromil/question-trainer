# Fixture question bank

A small bank in the `questions/` layout (see `questions/README.md`) for
`tools/test_core.js` and `tools/test_server.py`. `questions/` is git-ignored,
so a fresh clone has no local data; the tests use this folder when
`questions/index.json` is absent. It holds two sets, one made of two units,
and keeps to the bank checks (valid, unique ids, no answer given away by its
length).

The app never reads this folder. `tools/acceptance.py` always checks the real
`questions/` bank.
