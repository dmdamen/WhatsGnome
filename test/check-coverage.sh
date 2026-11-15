#!/usr/bin/env bash
# Fail when total line coverage in an lcov file is below a threshold.
set -euo pipefail
file=$1; min=$2
read -r hit found < <(awk -F: '/^LH:/{h+=$2} /^LF:/{f+=$2} END{print h, f}' "$file")
pct=$(awk -v h="$hit" -v f="$found" 'BEGIN{printf "%.2f", f ? 100*h/f : 0}')
echo "Line coverage: $pct% ($hit/$found), minimum $min%"
awk -v p="$pct" -v m="$min" 'BEGIN{exit !(p+0 >= m+0)}' || { echo "FAIL: coverage below $min%"; exit 1; }
