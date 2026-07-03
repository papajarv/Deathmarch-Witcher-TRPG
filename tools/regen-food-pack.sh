#!/usr/bin/env bash
# Single-command rebuild of the food pack source.
#
# Runs each region's generator script under /tmp/, then the tier/AE backfill.
# Generators output items WITHOUT tier/blandFood/AE (they only know name +
# satiety + cost + freshness); the backfill enriches them based on cost band
# (tier) and slug+name keywords (category → axis → AE blob).
#
# Re-run order:
#   1. each /tmp/gen_<region>_meals.py (self-cleans its own region's JSONs)
#   2. /tmp/backfill_food_tier_ae.py (idempotent — re-tags all 800 items)
#
# After this, run `node tools/build-packs.mjs food` to compile to LevelDB.
set -euo pipefail

REGIONS=(
  aedirn
  skellige
  toussaint
  mahakam
  kaedwen
  velen
  redania
  nilfgaard
  cintra
  lyria
)

for region in "${REGIONS[@]}"; do
  script="/tmp/gen_${region}_meals.py"
  if [[ ! -f "$script" ]]; then
    echo "  ✗ missing $script — skipping ${region}" >&2
    continue
  fi
  python3 "$script" | tail -1
done

echo ""
echo "→ Running backfill (tier + blandFood + axis AE)…"
python3 /tmp/backfill_food_tier_ae.py | tail -3

echo ""
echo "→ Done. Next: node tools/build-packs.mjs food"
