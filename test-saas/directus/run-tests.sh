#!/bin/bash
set -o noglob

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this test script."
  exit 1
fi

BASE="${DIRECTUS_BASE_URL:-http://localhost:8055}"
EMAIL="${DIRECTUS_ADMIN_EMAIL:-admin@example.com}"
PASSWORD="${DIRECTUS_ADMIN_PASSWORD:-admin123}"
CLI=(node generated/directus-cli.js)

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
echo "  DIRECTUS CLI - E2E TEST SUITE"
echo "  Base URL: $BASE"
echo "========================================================"
echo ""

run_success "GET /server/ping" \
  "${CLI[@]}" server ping --base-url "$BASE" --output json

echo ""
echo "[Auth flow]"

TOTAL=$((TOTAL + 1))
LOGIN_OUTPUT=$("${CLI[@]}" authentication login --base-url "$BASE" --output json \
  --body "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" 2>&1)
LOGIN_EXIT=$?

if [ $LOGIN_EXIT -ne 0 ] || echo "$LOGIN_OUTPUT" | grep -q '"error"'; then
  FAIL=$((FAIL + 1))
  printf "  FAIL  POST /auth/login\n"
  echo "$LOGIN_OUTPUT" | head -3 | sed 's/^/        /'
else
  ACCESS_TOKEN=$(echo "$LOGIN_OUTPUT" | jq -r '.data.access_token // empty')
  REFRESH_TOKEN=$(echo "$LOGIN_OUTPUT" | jq -r '.data.refresh_token // empty')

  if [ -z "$ACCESS_TOKEN" ] || [ -z "$REFRESH_TOKEN" ]; then
    FAIL=$((FAIL + 1))
    printf "  FAIL  POST /auth/login (missing tokens)\n"
    echo "$LOGIN_OUTPUT" | head -3 | sed 's/^/        /'
  else
    PASS=$((PASS + 1))
    printf "  PASS  POST /auth/login\n"

    TOTAL=$((TOTAL + 1))
    REFRESH_OUTPUT=$("${CLI[@]}" authentication refresh --base-url "$BASE" --output json \
      --body "{\"refresh_token\":\"$REFRESH_TOKEN\"}" 2>&1)
    REFRESH_EXIT=$?

    if [ $REFRESH_EXIT -ne 0 ] || echo "$REFRESH_OUTPUT" | grep -q '"error"'; then
      FAIL=$((FAIL + 1))
      printf "  FAIL  POST /auth/refresh\n"
      echo "$REFRESH_OUTPUT" | head -3 | sed 's/^/        /'
    else
      NEW_REFRESH_TOKEN=$(echo "$REFRESH_OUTPUT" | jq -r '.data.refresh_token // empty')
      if [ -z "$NEW_REFRESH_TOKEN" ]; then
        FAIL=$((FAIL + 1))
        printf "  FAIL  POST /auth/refresh (missing refresh token)\n"
        echo "$REFRESH_OUTPUT" | head -3 | sed 's/^/        /'
      else
        PASS=$((PASS + 1))
        printf "  PASS  POST /auth/refresh\n"

        run_success "POST /auth/logout" \
          "${CLI[@]}" authentication logout --base-url "$BASE" --output json \
          --body "{\"refresh_token\":\"$NEW_REFRESH_TOKEN\"}"
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
