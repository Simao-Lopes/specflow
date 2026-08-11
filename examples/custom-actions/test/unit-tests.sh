#!/usr/bin/env bash
# Example custom SpecFlow action (test phase).
# Place custom actions in:  <repoRoot>/.specflow/actions/<phase>/<name>.sh
# Phases: plan | code | test. Runs in the checked-out repo.
echo "== Custom action: unit-tests =="
if [ -f package.json ]; then
  npm test --silent
else
  echo "No package.json — placeholder action succeeded."
  exit 0
fi