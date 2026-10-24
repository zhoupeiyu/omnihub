# Knowledge Refinery Design QA

## Source of truth

- Repository library reference: `/Users/zhoupeiyu/.codex/generated_images/01a0cde1-a1e2-71b1-a0a8-1b6edba163f3/exec-76b462bc-2a65-4f00-ba30-845ef5c7d728.png`
- Repository dossier reference: `/Users/zhoupeiyu/.codex/generated_images/01a0cde1-a1e2-71b1-a0a8-1b6edba163f3/exec-8a344e04-b700-459d-b26d-8bf086b66ad0.png`
- Final repository library capture: `output/playwright/repository-library-1487x1058-final.png`
- Final repository dossier capture: `output/playwright/repository-dossier-1487x1058-final.png`
- Full-view comparisons: `output/playwright/design-comparison-final.png`, `output/playwright/detail-design-comparison-final.png`
- Focused comparisons: `output/playwright/focus-list-inspector-comparison.png`, `output/playwright/focus-detail-workspace-comparison.png`

## Comparison setup

- URL: `http://127.0.0.1:4320/`
- Browser: Playwright CLI, fresh guest session, dark mode
- Reference bitmap: `1487 × 1058`
- Implementation viewport and bitmap: `1487 × 1058`, device pixel ratio `1`
- Full-view comparison: no density normalization or reference rescaling
- Repository library state: `kepano/obsidian-skills` selected, curated-recommendation sorting, table density
- Repository dossier state: full dossier with the Sources evidence tab selected
- Focused list inspector comparison: reference crop `497 × 1003` at `(990, 55)`; implementation crop `489 × 1003` at `(998, 50)`, resized to `497 × 1003` for component-level comparison
- Focused dossier workspace comparison: reference crop `1306 × 1003` at `(181, 55)`; implementation crop `1263 × 1003` at `(224, 50)`, resized to `1306 × 1003` for component-level comparison

## Visual findings

No actionable P0, P1, or P2 mismatch remains in the repository-library and repository-dossier targets.

- Repository library now matches the reference hierarchy: dedicated search, four filters, status counts, sort and density controls, six-column table, selected-row state, and a structured right inspector.
- Repository inspector now matches the reference reading order: title/actions, tags, status and links, four statistics, why saved, suitable scenarios, saved entries, related knowledge, and compact X evidence.
- Repository dossier now matches the reference shell: recent-repository rail, long-form article, and right evidence rail. The article includes metadata, four numbered knowledge sections, problem cards, cautions, a next-step checklist, and a usage record.
- Typography, row height, borders, column proportions, and right-rail density were retuned at the exact reference viewport.
- Responsive verification at `390 × 844` confirms the filter grid and simplified repository rows remain readable without document-level horizontal overflow.

Expected P3/data differences remain and must not be disguised with mock values:

- The live public dataset contains 593 repositories, while the visual reference contains 597 mock records.
- The public archive exposes broader topics but does not reliably expose GitHub stars, language, license, or activity metadata. The dossier therefore labels GitHub metadata as pending verification instead of inventing it.
- Real X author avatars, excerpts, repository names, source counts, and relation counts replace the reference's sample content.
- The existing global sidebar footer and quote remain because they belong to the current product shell rather than the repository module.

## Interaction and data verification

- Repository search: querying `kepano` returns one repository.
- Technology filter: selecting `Obsidian` returns 11 repositories.
- Purpose/topic, usage-status, and source-activity filters render and update the table.
- Curated, source-count, recent, and alphabetical sorting paths are available.
- Table/compact density controls switch successfully.
- Repository selection refreshes the inspector; GitHub and full-dossier actions remain usable.
- Dossier evidence tabs switch between sources, knowledge, and records.
- Recent-repository search filters `obra/superpowers` with the query `obra`.
- Knowledge links retain their relation targets and the original X evidence remains accessible.
- Mobile navigation and repository layouts remain operable at `390 × 844`.
- Browser console: zero application errors. One expected development-only Babel transformer warning remains.

## Automated verification

- `npm run test:x-refinement`: 21/21 passed
- `npm run test:x-pipeline`: 37/37 passed
- `npm run test:media`: 3/3 passed
- `git diff --check -- public/refinery.jsx public/index.html design-qa.md`: passed

## Iteration log

1. The initial `1440 × 1024` QA pass was invalidated because it did not use the reference's exact viewport and overlooked major information-architecture drift.
2. The comparison was reopened as blocked after identifying missing toolbar controls, missing table columns, an over-simplified inspector, a missing dossier rail, and undersized typography.
3. The first repair pass restored the overall library and dossier structure, but the right rail, type hierarchy, and knowledge-first content still showed P2 drift.
4. The final pass enlarged and rebalanced the typography and rails, prioritized `kepano/obsidian-skills`, synthesized the why-saved and suitable-scenario knowledge blocks from real relations, and revised dossier evidence to four compact X sources followed by related knowledge and saved links.
5. Exact-viewport full comparisons and normalized focused comparisons were reviewed. No actionable P0-P2 visual mismatch remains; only truthful data differences remain.

## Final result

passed
