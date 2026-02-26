#!/bin/bash
set -o noglob

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this test script."
  exit 1
fi

BASE="${LAGO_BASE_URL:-http://localhost:38015/api/v1}"
TOKEN="${LAGO_API_KEY:-lago_e2e_api_key_123}"
CLI=(node generated/lago-cli.js)

PASS=0
FAIL=0
TOTAL=0

run_success() {
  local label="$1"
  shift

  TOTAL=$((TOTAL + 1))
  local output
  output=$("$@" 2>&1)
  local exit_code=$?

  if [ $exit_code -ne 0 ]; then
    FAIL=$((FAIL + 1))
    printf "  FAIL  %s (exit code %d)\n" "$label" "$exit_code"
    echo "$output" | head -3 | sed 's/^/        /'
    return
  fi

  if echo "$output" | grep -q '"error"'; then
    FAIL=$((FAIL + 1))
    printf "  FAIL  %s\n" "$label"
    echo "$output" | head -3 | sed 's/^/        /'
    return
  fi

  PASS=$((PASS + 1))
  printf "  PASS  %s\n" "$label"
}

run_expected_failure() {
  local label="$1"
  local expected="$2"
  shift 2

  TOTAL=$((TOTAL + 1))
  local output
  output=$("$@" 2>&1)
  local exit_code=$?

  if [ $exit_code -eq 0 ]; then
    FAIL=$((FAIL + 1))
    printf "  FAIL  %s (expected failure)\n" "$label"
    echo "$output" | head -3 | sed 's/^/        /'
    return
  fi

  if [ -n "$expected" ] && ! echo "$output" | grep -q "$expected"; then
    FAIL=$((FAIL + 1))
    printf "  FAIL  %s (missing expected pattern)\n" "$label"
    echo "$output" | head -3 | sed 's/^/        /'
    return
  fi

  PASS=$((PASS + 1))
  printf "  PASS  %s\n" "$label"
}

echo "========================================================"
echo "  LAGO CLI - E2E TEST SUITE"
echo "  Base URL: $BASE"
echo "========================================================"
echo ""

TOTAL=$((TOTAL + 1))
BILLING_ENTITIES_OUTPUT=$("${CLI[@]}" billing-entities list-billing-entities --base-url "$BASE" --token "$TOKEN" --output json 2>&1)
BILLING_ENTITIES_EXIT=$?

if [ $BILLING_ENTITIES_EXIT -ne 0 ] || echo "$BILLING_ENTITIES_OUTPUT" | grep -q '"error"'; then
  FAIL=$((FAIL + 1))
  printf "  FAIL  GET /billing_entities\n"
  echo "$BILLING_ENTITIES_OUTPUT" | head -3 | sed 's/^/        /'
else
  BILLING_ENTITY_CODE=$(echo "$BILLING_ENTITIES_OUTPUT" | jq -r '.billing_entities[0].code // empty')
  if [ -z "$BILLING_ENTITY_CODE" ]; then
    FAIL=$((FAIL + 1))
    printf "  FAIL  GET /billing_entities (missing code)\n"
    echo "$BILLING_ENTITIES_OUTPUT" | head -3 | sed 's/^/        /'
  else
    PASS=$((PASS + 1))
    printf "  PASS  GET /billing_entities\n"

    run_success "GET /billing_entities/:code" \
      "${CLI[@]}" billing-entities get-billing-entity --code "$BILLING_ENTITY_CODE" --base-url "$BASE" --token "$TOKEN" --output json

    run_success "PUT /billing_entities/:code" \
      "${CLI[@]}" billing-entities update-billing-entity --code "$BILLING_ENTITY_CODE" --base-url "$BASE" --token "$TOKEN" --output json \
      --body '{"billing_entity":{"name":"Agent Ready Org"}}'
  fi
fi

run_success "GET /customers?search_term=Agent&per_page=5" \
  "${CLI[@]}" customers find-all-customers --search-term Agent --per-page 5 --base-url "$BASE" --token "$TOKEN" --output json

CUSTOMER_EXTERNAL_ID="ar-e2e-$(date +%s)"
CREATE_CUSTOMER_BODY=$(printf '{"customer":{"external_id":"%s","name":"Agent Ready E2E"}}' "$CUSTOMER_EXTERNAL_ID")

run_success "POST /customers" \
  "${CLI[@]}" customers create-customer --base-url "$BASE" --token "$TOKEN" --output json --body "$CREATE_CUSTOMER_BODY"

run_success "GET /customers/:external_customer_id" \
  "${CLI[@]}" customers find-customer --external-customer-id "$CUSTOMER_EXTERNAL_ID" --base-url "$BASE" --token "$TOKEN" --output json

run_success "DELETE /customers/:external_customer_id" \
  "${CLI[@]}" customers destroy-customer --external-customer-id "$CUSTOMER_EXTERNAL_ID" --base-url "$BASE" --token "$TOKEN" --output json

run_expected_failure "GET deleted customer returns 404" '"status": 404' \
  "${CLI[@]}" customers find-customer --external-customer-id "$CUSTOMER_EXTERNAL_ID" --base-url "$BASE" --token "$TOKEN" --output json

echo ""
echo "========================================================"
printf "  RESULTS: %d passed, %d failed (out of %d)\n" "$PASS" "$FAIL" "$TOTAL"
echo "========================================================"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
