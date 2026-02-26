#!/bin/bash
set -o noglob

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this test script."
  exit 1
fi

BASE="${MEMOS_BASE_URL:-http://localhost:5230}"
CLI=(node generated/memos-cli.js)
TEST_PASSWORD="${MEMOS_TEST_PASSWORD:-Test1234!}"
TEST_USER="e2e$(date +%s)"
TEST_EMAIL="${TEST_USER}@example.com"

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

echo "========================================================"
echo "  MEMOS CLI - E2E TEST SUITE"
echo "  Base URL: $BASE"
echo "========================================================"
echo ""

run_success "GET /api/v1/instance/profile" \
  "${CLI[@]}" instance-service get-instance-profile --base-url "$BASE" --output json

run_success "GET /api/v1/activities?pageSize=5" \
  "${CLI[@]}" activity-service list-activities --base-url "$BASE" --page-size 5 --output json

echo ""
echo "[User + Auth flow]"

CREATE_BODY=$(printf '{"username":"%s","displayName":"%s","email":"%s","password":"%s","role":"USER","state":"NORMAL"}' \
  "$TEST_USER" "$TEST_USER" "$TEST_EMAIL" "$TEST_PASSWORD")

TOTAL=$((TOTAL + 1))
CREATE_OUTPUT=$("${CLI[@]}" user-service create-user --base-url "$BASE" --output json --body "$CREATE_BODY" 2>&1)
CREATE_EXIT=$?

if [ $CREATE_EXIT -ne 0 ] || echo "$CREATE_OUTPUT" | grep -q '"error"'; then
  FAIL=$((FAIL + 1))
  printf "  FAIL  POST /api/v1/users\n"
  echo "$CREATE_OUTPUT" | head -3 | sed 's/^/        /'
else
  USER_RESOURCE=$(echo "$CREATE_OUTPUT" | jq -r '.name // empty')
  if [ -z "$USER_RESOURCE" ]; then
    FAIL=$((FAIL + 1))
    printf "  FAIL  POST /api/v1/users (missing user resource)\n"
    echo "$CREATE_OUTPUT" | head -3 | sed 's/^/        /'
  else
    PASS=$((PASS + 1))
    printf "  PASS  POST /api/v1/users\n"

    SIGNIN_BODY=$(printf '{"passwordCredentials":{"username":"%s","password":"%s"}}' "$TEST_USER" "$TEST_PASSWORD")
    TOTAL=$((TOTAL + 1))
    SIGNIN_OUTPUT=$("${CLI[@]}" auth-service sign-in --base-url "$BASE" --output json --body "$SIGNIN_BODY" 2>&1)
    SIGNIN_EXIT=$?

    if [ $SIGNIN_EXIT -ne 0 ] || echo "$SIGNIN_OUTPUT" | grep -q '"error"'; then
      FAIL=$((FAIL + 1))
      printf "  FAIL  POST /api/v1/auth/signin\n"
      echo "$SIGNIN_OUTPUT" | head -3 | sed 's/^/        /'
    else
      ACCESS_TOKEN=$(echo "$SIGNIN_OUTPUT" | jq -r '.accessToken // empty')
      if [ -z "$ACCESS_TOKEN" ]; then
        FAIL=$((FAIL + 1))
        printf "  FAIL  POST /api/v1/auth/signin (missing access token)\n"
        echo "$SIGNIN_OUTPUT" | head -3 | sed 's/^/        /'
      else
        PASS=$((PASS + 1))
        printf "  PASS  POST /api/v1/auth/signin\n"

        run_success "GET /api/v1/auth/currentuser" \
          "${CLI[@]}" auth-service get-current-user --base-url "$BASE" --token "$ACCESS_TOKEN" --output json

        run_success "GET /api/v1/users/:user" \
          "${CLI[@]}" user-service get-user --user "$TEST_USER" --base-url "$BASE" --token "$ACCESS_TOKEN" --output json

        run_success "POST /api/v1/auth/signout" \
          "${CLI[@]}" auth-service sign-out --base-url "$BASE" --token "$ACCESS_TOKEN" --output json
      fi
    fi
  fi
fi

echo ""
echo "========================================================"
printf "  RESULTS: %d passed, %d failed (out of %d)\n" "$PASS" "$FAIL" "$TOTAL"
echo "========================================================"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
