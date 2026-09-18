# 2026-09-17

## Hunt

- **SEEK:** 130 keyword searches (`--since=2d`), 472 cards touched; 1423 SEEK rows now in the pipeline (136 new). No login/DOM errors.
- **LinkedIn jobs:** search discovered 274 roles (165 new); inline enrichment covered 60/165, then `linkedin:enrich --status discovered --limit 110` covered the remaining 105 (all succeeded, 0 failed). All 165 new rows carry full JD + `applyMethod`. No login/DOM errors.
- **Saved SEEK jobs:** 7 on the saved list, 0 new (2 expired). The 5 known saved rows were left as they are.
- The duplicate-group bug is fixed; tests pass.

## Channel health

- seek: healthy, no login issues.
- linkedin_jobs: healthy, no login issues.
- linkedin_posts: session expired mid-hunt, the posts adapter failed after 12 cards.
