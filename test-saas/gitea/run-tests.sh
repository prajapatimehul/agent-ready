#!/bin/bash
set -o noglob

TOKEN=$(cat /tmp/gitea-token.txt)
BASE="http://localhost:3001/api/v1"
CLI="node generated/gitea-cli.js"
PASS=0
FAIL=0
TOTAL=0

test_cli() {
  local label="$1"
  shift
  TOTAL=$((TOTAL + 1))
  OUTPUT=$("$@" 2>&1)
  EXIT=$?

  if [ $EXIT -ne 0 ]; then
    FAIL=$((FAIL + 1))
    printf "  FAIL  %s (exit code %d)\n" "$label" "$EXIT"
    echo "$OUTPUT" | head -3 | sed 's/^/        /'
    return
  fi

  if echo "$OUTPUT" | head -1 | grep -q '"error"'; then
    FAIL=$((FAIL + 1))
    printf "  FAIL  %s\n" "$label"
    echo "$OUTPUT" | head -3 | sed 's/^/        /'
    return
  fi

  PASS=$((PASS + 1))
  printf "  PASS  %s\n" "$label"
}

echo "========================================================"
echo "  GITEA CLI - FULL E2E TEST SUITE"
echo "  Gitea 1.25.4 | Docker | 467 generated operations"
echo "========================================================"
echo ""

echo "[Unauthenticated GET]"
test_cli "GET /version" \
  $CLI miscellaneous get-version --base-url "$BASE" --output json

test_cli "GET /nodeinfo" \
  $CLI miscellaneous get-node-info --base-url "$BASE" --output json

echo ""
echo "[Authenticated GET - no params]"
test_cli "GET /user (current user)" \
  $CLI user get-current --base-url "$BASE" --token "$TOKEN" --output json

test_cli "GET /settings/api" \
  $CLI settings get-general-apisettings --base-url "$BASE" --token "$TOKEN" --output json

test_cli "GET /user/repos" \
  $CLI user current-list-repos --base-url "$BASE" --token "$TOKEN" --output json

test_cli "GET /user/settings" \
  $CLI user get-user-settings --base-url "$BASE" --token "$TOKEN" --output json

echo ""
echo "[Path Parameters]"
test_cli "GET /repos/:owner/:repo" \
  $CLI repository repo-get --owner testadmin --repo cli-test-repo --base-url "$BASE" --token "$TOKEN" --output json

test_cli "GET /repos/:owner/:repo/branches" \
  $CLI repository repo-list-branches --owner testadmin --repo cli-test-repo --base-url "$BASE" --token "$TOKEN" --output json

test_cli "GET /repos/:owner/:repo/topics" \
  $CLI repository repo-list-topics --owner testadmin --repo cli-test-repo --base-url "$BASE" --token "$TOKEN" --output json

test_cli "GET /repos/:owner/:repo/languages" \
  $CLI repository repo-get-languages --owner testadmin --repo cli-test-repo --base-url "$BASE" --token "$TOKEN" --output json

echo ""
echo "[POST with JSON Body]"
test_cli "POST /user/repos (create repo)" \
  $CLI repository create-current-user-repo --base-url "$BASE" --token "$TOKEN" --output json \
  --body '{"name":"e2e-repo","auto_init":true}'

test_cli "POST /repos/:owner/:repo/issues (create issue)" \
  $CLI issue create-issue --owner testadmin --repo cli-test-repo --base-url "$BASE" --token "$TOKEN" --output json \
  --body '{"title":"E2E test issue"}'

test_cli "POST /orgs (create org)" \
  $CLI organization org-create --base-url "$BASE" --token "$TOKEN" --output json \
  --body '{"username":"e2e-org","visibility":"public"}'

echo ""
echo "[Query Parameters]"
test_cli "GET /repos/search?q=test" \
  $CLI repository repo-search --q test --limit 5 --base-url "$BASE" --token "$TOKEN" --output json

test_cli "GET /repos/:owner/:repo/issues?state=open" \
  $CLI issue list-issues --owner testadmin --repo cli-test-repo --state open --limit 5 --base-url "$BASE" --token "$TOKEN" --output json

echo ""
echo "[PATCH - update resources]"
test_cli "PATCH /repos/:owner/:repo (edit repo)" \
  $CLI repository repo-edit --owner testadmin --repo cli-test-repo --base-url "$BASE" --token "$TOKEN" --output json \
  --body '{"description":"Updated via CLI","website":"https://example.com"}'

echo ""
echo "[DELETE]"
test_cli "DELETE /repos/:owner/:repo" \
  $CLI repository repo-delete --owner testadmin --repo e2e-repo --base-url "$BASE" --token "$TOKEN" --output json

echo ""
echo "========================================================"
printf "  RESULTS: %d passed, %d failed (out of %d)\n" "$PASS" "$FAIL" "$TOTAL"
echo "========================================================"
