# Image-by-image elk census — 2026-09-09

The working approach is tiled elk detection followed by direct visual review of
the source pixels, with a separate search for missed animals. It produced the
four point sets below. The target is **less than 1% count error**. These are
reviewable AI audits, not independently established ground truth or evidence
that the target has been met across the corpus.

| Image | Definite elk | Unresolved additional elk | Training use |
|---|---:|---:|---|
| IMG_3938.JPG | 53 | 0 | Eligible; replaces incomplete labels |
| DSC02031.JPG | 80 | 0 | Eligible; previously unlabeled; user-identified omission added |
| IMG_3706.JPG | 117 | 0 | Eligible audit, but held out in the existing test split |
| IMG_3835.JPG | 395 | 5 | Excluded; also in the existing test split |

“Definite” describes the audit decision, not mathematical certainty. The range
395–400 covers the **recorded** ambiguities; it is not a statistical
confidence intervals and cannot account for unknown mistakes. No error percentage
is calculated against the old labels, which are themselves questionable.

## Inspect the results

The versioned [census_reviews](census_reviews) JSON files contain source image
SHA-256 hashes, every counted coordinate, unresolved coordinates, review method,
and training eligibility. They use the frontend's single-image annotation import
format, with extra audit metadata. Import the matching photo and JSON into the
labeling app to inspect or correct the points. Counted annotations remain
**unconfirmed**, and age/sex classification remains **unclassified**.

The full working evidence is under
`storage/output/independent_audit/<image stem>/` (gitignored):

- `annotated.jpg`: full-resolution numbered image, orange U markers for unresolved spots.
- `review_herd.jpg`: cropped herd view for convenient review.
- `result.json`, `annotations.json`, `review.json`: counts, importable points, and spatial review ledger.
- `manifest.json`: source hash, dimensions, and tile ownership.
- `proposals.json`, `candidates.json`: detector output and review groups, with raw member IDs retained.
- Additional source crops, contact sheets, and decisions used during inspection.

For IMG_3835, `uncertain_context.jpg` shows all five unresolved spots alongside
neighboring elk and vegetation. U1/U2 may be parts of already-counted standing
elk; U3/U4/U5 may be additional bedded elk. IMG_3706's
`uncertain_overlap.jpg` preserves the overlap subsequently resolved by user feedback.

## What was actually reviewed

**IMG_3938:** A direct visual point pass was frozen at 52 before reconciling
detector proposals. Enlarged source crops established that several very close
pairs were separate bedded elk. Reconciliation found one additional animal
partly hidden by vegetation, at (1756, 1286), bringing the count to 53. This
52-to-53 correction illustrates why self-agreement alone is insufficient at a
1% target. The existing partial label set was not used to decide the count.

**DSC02031:** A direct source-point pass produced 79. All 126 detector proposals
more than 100 source pixels from those points were inspected: shadows,
vegetation, or parts of already-counted animals. Torso locations were refined in
native-resolution crops. Strong shadows are a major failure mode here; some
received high elk detection scores. There was no previous label set to follow.
The user then identified an omission between numbered animals 49 and 52.
Native source inspection confirmed it at (6388, 3318); it was appended as ID 80,
preserving the earlier review numbering. This is a real miss in the initial audit.

**IMG_3706:** All detector candidates in the herd were inspected in eight large
source regions, with peripheral proposals checked separately. Vegetation and
head/body duplicates were removed. After freezing 116 points, comparison with
the previous 117-point set identified one unresolved overlapping animal at
(1481, 1360). The user independently identified the same omission between IDs 34
and 42. It was promoted to counted ID 117 following that feedback and contextual
source review. The image remains excluded from training because it is in the test split.

**IMG_3835:** This was a proposal-assisted audit, not a blind recount. Every one
of the 394 legacy points was inspected in source-crop sheets; all 75 unmatched
consolidated detector candidates were inspected; and all connected groups of
legacy markers less than 16 pixels apart were reviewed together. A full-frame
sweep checked unmarked areas. The empty upper portion was screened at half
resolution; occupied areas received native/enlarged inspection. Four bedded elk
were added. Legacy point 325 duplicated 324. Two other legacy points, 309 and
369, became unresolved possible second animals; three new candidate shapes also
remain unresolved. The resulting count is 395 plus five possibilities. This
image demonstrates why finding an animal underneath each individual marker is
insufficient: two valid-looking markers can still refer to one animal.

For ambiguous objects, comparisons use **this same photograph**: nearby elk at
similar depth, their relative sizes and poses, shadow direction, and surrounding
vegetation. Enlargement exposes existing pixels; it does not recover lost detail.
No image generation or invented image detail was used.

## Repeating the workflow

The existing elk-specific v4 YOLO checkpoint was used as a proposer, without
retraining. CPU inference worked locally. The detector outputs are not counts.

```bash
# The base app environment does not include the detector dependencies.
uv pip install --python .venv/bin/python ultralytics scipy

.venv/bin/python scripts/census.py prepare \
  data/elk_images_from_fwp/IMG_3938.JPG storage/output/new_census
.venv/bin/python scripts/census.py render storage/output/new_census --source blind --scale 2
.venv/bin/python scripts/census.py propose storage/output/new_census \
  --weights runs/detect/storage/models/runs/elk_yolo11s_v4/weights/best.pt \
  --conf 0.05 --device cpu
.venv/bin/python scripts/census.py consolidate storage/output/new_census
.venv/bin/python scripts/census.py render storage/output/new_census --source candidates --scale 2
```

Review the pixels, then fill `review.json`: reviewer, method, and each tile's
`status`, `points`, `uncertain`, and notes. Coordinates are in the original
image, not crop coordinates. Each torso center belongs to exactly one disjoint
core; surrounding context is for recognition only. Mark empty tiles reviewed
only after inspecting them. Inspect close pairs jointly and check raw members of
consolidated candidates. Sweep unmarked source regions for recall.

```bash
.venv/bin/python scripts/census.py finalize storage/output/new_census
```

Finalization rejects pending tiles, changed source images, invalid or misplaced
coordinates, and identical points. It does not certify the reviewer's visual
judgment. The consolidation distance is only a review convenience; distinct
nearby animals survive finalization without distance-based suppression.

## Dataset and implementation changes

`scripts/build_dataset.py` now gives validated source-hashed audits precedence
over old exports, preserves provenance and unresolved points, and distinguishes
`image-audited` from human confirmation. `scripts/make_training_data.py` excludes
unresolved audits and preserves the existing test split. IMG_3938 and DSC02031
have been promoted into the generated training data. IMG_3706 and IMG_3835
do not contribute training tiles.

Training generation now stages a fresh output before replacing the previous
one, preventing stale tiles from surviving when an image is excluded or its
labels change. Tile origins cover image edges; pseudo boxes are clipped to the
tile, including visible animals whose centers fall just outside it. These remain
point-derived boxes, not manually traced animal bounds.

The backend agent had a material vision plumbing defect: image reads returned
base64 text rather than multimodal image content. They now return Pydantic AI
`BinaryContent` ([tool return documentation](https://pydantic.dev/docs/ai/tools-toolsets/tools-advanced/)).
Its subprocess now uses the server's Python interpreter and resolved working
directory. The prompt uses the actual relative workspace, requires full-image
review, adds within-image context comparisons, and removes undercounting bias.
Submitted coordinates and confidences are validated. The local tool behavior
was tested; these four audits were performed in this Codex session, **not by a
validated end-to-end run of the app's hosted agent**. The new counting workflow
described below separately enforces a spatial review ledger in host code.

```bash
.venv/bin/python scripts/build_dataset.py
.venv/bin/python scripts/make_training_data.py
.venv/bin/python -m unittest discover -s tests -v
```

The rebuilt training set has 1,793 training tiles and 470 validation tiles.
No new model weights have been trained. The remaining work for a defensible 1%
claim is to resolve the indicated cases with independent image review and test
the procedure on more photographs; the current artifacts make that review
specific and reproducible at the coordinate level.

## Local full-application experiment

The new `/api/counting` workflow runs the same bounded image tools through either
a Codex CLI MCP connection (default, ChatGPT subscription) or Pydantic AI (optional
API path). For the local experiment, Codex CLI 0.153.4 is signed in through ChatGPT,
forced to use that login method, and receives no API keys. No paid model API calls
were made. The agent gets the original image, coordinate-aware crop tools, optional
detector proposals, and a spatial ledger; it is not given previous counts or labels.

The host requires source inspection and a recorded decision for every region,
including empty regions. Populated regions also require inspection of the resulting
marker overlay. Crowded regions can be subdivided, preserving disjoint ownership.
Unresolved possible animals remain separate from the count. These checks enforce
coverage and review steps; they cannot certify the model's visual judgment.

IMG_3938 run `26c7f7af6c494657b0fa2258eb8aea4e` completed in about 3.5 minutes with
**52 definite + 2 possible**. All 52 definite points match the frozen 53-point audit
within 30 source pixels, with no unmatched definite prediction. The unmatched audit
animal at (1459, 1380) was explicitly flagged as possible U2 at (1462, 1380).
The other possibility, U1 at (1596, 1301), concerns a close overlapping pair and
needs further independent review. Thus the autonomous definite count differs by
1/53 (1.89%); the experiment does **not** demonstrate the 1% target. The discrepancy
is localized for review instead of being hidden in a scalar count.

DSC02031 run `8fbdabbfa0c048b696a7edef2cdd2a9f` produced **82 definite** with no
declared uncertainty. Spatial matching within 100 source pixels found all 80
audited animals, including the user's correction, plus two unmatched markers at
(7370, 3985) and (7340, 4050). Native source inspection shows these extra markers
on connected portions of an already-counted overlapping animal. The actual count
error relative to the corrected audit is +2 (2.5%). Its usage was 1,807,619 input
(1,659,904 cached; 147,715 fresh) and 5,576 output tokens, approximately $3.415854
standard API equivalent. Original run and disagreement source crops are retained.

This failure motivated version `spatial-census-v2-neighborhood-review`: a mandatory
final pass on a different spatial grid with wider context, including markers from
adjacent counting regions. The prompt requires tracing connected rump, torso,
neck, head, and legs through overlapping groups. Any point edit invalidates this
pass. No distance-based suppression or reference counts are used to remove points.
This is a development-set improvement, not an independent validation result.

Fresh v2 run `1b11bcc1837447f287f8d5a2a3fd596e` completed on DSC02031 with
**80 definite + 1 possible**, in 8 minutes 56 seconds. All 80 definite markers match
the corrected audit within 100 source pixels, with no unmatched marker on either
side. Native inspection confirmed the previously omitted elk was included and
the two earlier duplicate body-part markers were absent. The remaining possibility
at (7340, 4045) is a dark overlapping body segment; it is retained for review rather
than silently counted. This run had no reference labels and no manual point edits.
It used 3,940,361 input tokens (3,709,184 cached; 231,177 fresh) and 6,800 output
tokens: approximately **$6.360954** standard API equivalent, via the subscription.
The stronger review increased time and cost; it has not yet been price-optimized.

All three completed local runs used direct visual tools without invoking the
optional detector. Browser testing verified original-image upload (including Sony
MPO JPEGs), job completion, persistent history across a server restart, reversible
uncertainty decisions, explicit marker application, undo/redo, annotations surviving
a browser refresh, and JSON export. The original uncertainty decisions were restored
after the review-control test. 24 Python tests and 161 frontend tests pass; Python
type/lint checks and the frontend production build also pass. No changes were pushed
or deployed, and no model weights were retrained.

Usage for that isolated image: 746,695 input tokens, of which 647,680 were cached
(99,015 fresh), and 4,577 output tokens. Standard short-context API equivalent:
**$1.86668** using [published pricing](https://developers.openai.com/api/docs/pricing).
This is not an API charge; CLI aggregate usage does not expose all details needed
to price long-context premiums or service-tier differences. A preceding failed
tool-approval configuration test consumed an additional 49,192 input tokens
(43,520 cached) and 242 output tokens, about $0.11234 equivalent. It is retained as
a failed run, not an image count.

For comparison, the earlier four-image research-and-implementation session used
9,375,155 input tokens (9,055,360 cached) and 62,010 output tokens through the first
results handoff. That is approximately $15.35 standard / $30.71 fast API equivalent
for the entire mixed session, not a measured inference cost per image. Reasoning
tokens are already included in output and must not be added again.

Local original outputs, comparisons, and screenshots are under
`storage/output/app-census/`. To compare future exported runs without feeding
reference labels back to the counter:

```bash
.venv/bin/python scripts/eval_census_run.py \
  storage/output/app-census/IMG_3938-run.json \
  research/census_reviews/IMG_3938.json --radius 30
```

The evaluator verifies source hashes and reports one-to-one spatial mismatches,
unresolved points, review decisions, and token/cost data. Count agreement alone
can hide offsetting misses and duplicates. Use a radius appropriate to animal
size, inspect unmatched points in the source, and retain raw runs separately from
subsequent review decisions. The reference audits themselves remain fallible.

Price optimization should compare fresh runs on the same frozen images, including
crowded and difficult cases, with point-level disagreement review. Lower-cost
models, less repeated context, and selective expensive review are candidates;
none has yet been shown to preserve this quality. Monty is unnecessary for the
current fixed tool set; if agent-authored composition later helps, native CV can
remain in host functions.

## Simplified application workflow

Following UI feedback, counting now uses a single **Count elk** toolbar action,
background status, and automatic delivery to the normal annotation canvas. The
separate review modal, image overlays, cost display, and normal-case apply step
were removed. Possible animals also become ordinary unconfirmed markers, with
their reason retained in the annotation label. Consequently the UI's unconfirmed
total includes those possibilities (for example, the latest DSC02031 run supplies
81 review markers from 80 definite plus one possible). Raw run/evaluation counts
above retain their original meaning.

Review happens with the existing confirm, classify, and delete controls. Provided
class predictions are preserved independently of confirmation status; automatic
classification has not been enabled or evaluated. Starting a count saves an
unlabeled upload to Recent Work, and reopening its image retrieves background
results. Existing reviewed labels or edits made during counting are preserved,
with an inline option to use AI labels. Results remain undoable, and delivery
receipts written after annotation persistence prevent undone results from
reappearing on refresh. The counting model and its measured runs were unchanged
for this UI revision.
