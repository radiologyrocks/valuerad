#!/usr/bin/env bash
# Run this FROM TITAN (your server) to validate all 3 connectivity layers.
# Usage: bash test-connectivity.sh [your-app-domain]
#   e.g. bash test-connectivity.sh valuerad.example.com

set -euo pipefail

APP_DOMAIN="${1:-valuerad.example.com}"
FHIR_BASE="https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4"

GREEN="\033[0;32m"; RED="\033[0;31m"; YELLOW="\033[1;33m"; NC="\033[0m"
pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }
info() { echo -e "${YELLOW}[INFO]${NC} $*"; }

echo "========================================"
echo "  ValueRad FHIR/SMART Connectivity Test"
echo "========================================"
echo

# -----------------------------------------------------------------------
# Layer 1 — Basic reachability
# -----------------------------------------------------------------------
echo "--- Layer 1: Basic network reachability ---"

STATUS=$(curl -o /dev/null -s -w "%{http_code}" -I --max-time 10 "https://fhir.epic.com" 2>&1 || true)
if [[ "$STATUS" =~ ^[2345] ]]; then
  pass "fhir.epic.com reachable (HTTP $STATUS)"
else
  fail "fhir.epic.com unreachable (got: $STATUS)"
fi

echo
echo "--- Layer 1b: FHIR R4 metadata ---"
METADATA=$(curl -s --max-time 15 \
  -H "Accept: application/fhir+json" \
  "${FHIR_BASE}/metadata" | head -c 200 || true)

if echo "$METADATA" | grep -qi '"resourceType"'; then
  pass "FHIR metadata returned FHIR JSON"
  echo "$METADATA"
elif echo "$METADATA" | grep -qi '<CapabilityStatement'; then
  pass "FHIR metadata returned XML CapabilityStatement"
else
  fail "FHIR metadata unexpected response:"
  echo "$METADATA"
fi

echo
# -----------------------------------------------------------------------
# Layer 2 — SMART well-known configuration
# -----------------------------------------------------------------------
echo "--- Layer 2: SMART well-known configuration ---"
SMART=$(curl -s --max-time 15 \
  -H "Accept: application/json" \
  "${FHIR_BASE}/.well-known/smart-configuration" || true)

if echo "$SMART" | grep -q '"authorization_endpoint"'; then
  pass "SMART well-known returned authorization_endpoint"
  AUTH_EP=$(echo "$SMART" | grep -o '"authorization_endpoint":"[^"]*"' | head -1)
  TOKEN_EP=$(echo "$SMART" | grep -o '"token_endpoint":"[^"]*"' | head -1)
  info "$AUTH_EP"
  info "$TOKEN_EP"
else
  fail "SMART well-known missing authorization_endpoint"
  echo "$SMART" | head -c 300
fi

echo
# -----------------------------------------------------------------------
# Layer 3 — App path
# -----------------------------------------------------------------------
echo "--- Layer 3: App endpoints on $APP_DOMAIN ---"

LAUNCH_STATUS=$(curl -o /dev/null -s -w "%{http_code}" --max-time 10 \
  "https://${APP_DOMAIN}/epic/launch" 2>&1 || true)
if [[ "$LAUNCH_STATUS" == "400" ]]; then
  pass "/epic/launch reachable (400 expected — no iss/launch params)"
elif [[ "$LAUNCH_STATUS" =~ ^[23] ]]; then
  pass "/epic/launch reachable (HTTP $LAUNCH_STATUS)"
else
  fail "/epic/launch returned HTTP $LAUNCH_STATUS"
fi

CALLBACK_STATUS=$(curl -o /dev/null -s -w "%{http_code}" --max-time 10 \
  "https://${APP_DOMAIN}/epic/callback" 2>&1 || true)
if [[ "$CALLBACK_STATUS" == "400" ]]; then
  pass "/epic/callback reachable (400 expected — no code/state params)"
elif [[ "$CALLBACK_STATUS" =~ ^[23] ]]; then
  pass "/epic/callback reachable (HTTP $CALLBACK_STATUS)"
else
  fail "/epic/callback returned HTTP $CALLBACK_STATUS"
fi

echo
echo "========================================"
echo "  All connectivity checks complete."
echo "  If Layer 1 + 2 pass but OAuth fails,"
echo "  check: client ID, redirect URI, scopes,"
echo "  app sandbox readiness, R4 vs DSTU2."
echo "========================================"
