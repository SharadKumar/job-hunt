# tests/fixtures/profile-min

A deliberately tiny, entirely invented profile (Jane Citizen) used by tests that
need a real profile on disk without reading the person's `state/profile/`.

A test copies this directory into a temp repo root:

    <tmp>/state/profile/   <- profile.md, resumes.yaml, cv-source.md, ...
    <tmp>/state/org/       <- org/keyword-clouds.yaml
    <tmp>/templates        <- symlink to the real templates/

then sets `HARNESS_REPO_ROOT` to that temp root *before* importing any tool, so
the tools' module-level `repoPath(...)` constants resolve to the fixture.

Never put real personal detail in here.
