#!/bin/bash
set -o noglob

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this test script."
  exit 1
fi

BASE="${PLANE_BASE_URL:-http://localhost:38004}"
CLI=(node generated/plane-cli.js)
PLANE_API_CONTAINER="${PLANE_API_CONTAINER:-ar-plane-api}"
PLANE_ADMIN_EMAIL="${PLANE_ADMIN_EMAIL:-admin@example.com}"
PLANE_WORKSPACE_SLUG="${PLANE_WORKSPACE_SLUG:-agent-ready}"

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
echo "  PLANE CLI - E2E TEST SUITE"
echo "  Base URL: $BASE"
echo "========================================================"
echo ""

TOTAL=$((TOTAL + 1))
TOKEN=$(docker exec "$PLANE_API_CONTAINER" sh -lc \
  "python manage.py shell -c \"from plane.db.models import User, Workspace, WorkspaceMember, APIToken; u=User.objects.get(email='${PLANE_ADMIN_EMAIL}'); ws,_=Workspace.objects.get_or_create(slug='${PLANE_WORKSPACE_SLUG}', defaults={'name':'Agent Ready','owner':u}); wm,_=WorkspaceMember.objects.get_or_create(workspace=ws, member=u, defaults={'role':20}); wm.role=20; wm.is_active=True; wm.save(update_fields=['role','is_active']); t=APIToken.objects.create(user=u,label='agent-ready-e2e'); print(t.token)\"" \
  2>&1 | tail -n1 | tr -d '\r')

if [ -z "$TOKEN" ] || echo "$TOKEN" | grep -q "Traceback"; then
  FAIL=$((FAIL + 1))
  printf "  FAIL  Seed workspace + create API token\n"
  echo "$TOKEN" | head -3 | sed 's/^/        /'
else
  PASS=$((PASS + 1))
  printf "  PASS  Seed workspace + create API token\n"
fi

run_success "GET /api/v1/users/me" \
  "${CLI[@]}" users get-current-user --base-url "$BASE" --api-key "$TOKEN" --output json

run_success "GET /api/v1/workspaces/:slug/members" \
  "${CLI[@]}" members get-workspace-members --slug "$PLANE_WORKSPACE_SLUG" --base-url "$BASE" --api-key "$TOKEN" --output json

run_success "GET /api/v1/workspaces/:slug/projects?per_page=5" \
  "${CLI[@]}" projects list-projects --slug "$PLANE_WORKSPACE_SLUG" --per-page 5 --base-url "$BASE" --api-key "$TOKEN" --output json

PROJECT_IDENTIFIER="E2E$((RANDOM % 900 + 100))"
CREATE_BODY=$(printf '{"name":"E2E Project %s","description":"created by agent-ready","identifier":"%s"}' \
  "$PROJECT_IDENTIFIER" "$PROJECT_IDENTIFIER")

TOTAL=$((TOTAL + 1))
CREATE_OUTPUT=$("${CLI[@]}" projects create-project --slug "$PLANE_WORKSPACE_SLUG" --base-url "$BASE" \
  --api-key "$TOKEN" --output json --body "$CREATE_BODY" 2>&1)
CREATE_EXIT=$?

if [ $CREATE_EXIT -ne 0 ] || echo "$CREATE_OUTPUT" | grep -q '"error"'; then
  FAIL=$((FAIL + 1))
  printf "  FAIL  POST /api/v1/workspaces/:slug/projects\n"
  echo "$CREATE_OUTPUT" | head -3 | sed 's/^/        /'
else
  PROJECT_ID=$(echo "$CREATE_OUTPUT" | jq -r '.id // empty')
  if [ -z "$PROJECT_ID" ]; then
    FAIL=$((FAIL + 1))
    printf "  FAIL  POST /api/v1/workspaces/:slug/projects (missing project id)\n"
    echo "$CREATE_OUTPUT" | head -3 | sed 's/^/        /'
  else
    PASS=$((PASS + 1))
    printf "  PASS  POST /api/v1/workspaces/:slug/projects\n"

    run_success "GET /api/v1/workspaces/:slug/projects/:pk" \
      "${CLI[@]}" projects retrieve-project --slug "$PLANE_WORKSPACE_SLUG" --pk "$PROJECT_ID" --base-url "$BASE" --api-key "$TOKEN" --output json

    run_success "PATCH /api/v1/workspaces/:slug/projects/:pk" \
      "${CLI[@]}" projects update-project --slug "$PLANE_WORKSPACE_SLUG" --pk "$PROJECT_ID" --base-url "$BASE" --api-key "$TOKEN" --output json \
      --body '{"description":"Updated via CLI"}'

    run_success "DELETE /api/v1/workspaces/:slug/projects/:pk" \
      "${CLI[@]}" projects delete-project --slug "$PLANE_WORKSPACE_SLUG" --pk "$PROJECT_ID" --base-url "$BASE" --api-key "$TOKEN" --output json

    run_expected_failure "GET deleted project returns 404" '"status": 404' \
      "${CLI[@]}" projects retrieve-project --slug "$PLANE_WORKSPACE_SLUG" --pk "$PROJECT_ID" --base-url "$BASE" --api-key "$TOKEN" --output json
  fi
fi

echo ""
echo "========================================================"
printf "  RESULTS: %d passed, %d failed (out of %d)\n" "$PASS" "$FAIL" "$TOTAL"
echo "========================================================"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
