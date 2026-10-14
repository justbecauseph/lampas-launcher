#!/usr/bin/env bash
# Microsoft Store submission preflight. Shared by the automatic store job in release-pack.yml and the manual
# publish job in store-status.yml.
#
# Environment:
#   TAG                                     release tag, vMAJOR.MINOR.PATCH
#   ARTIFACT_DIR                            directory with SHA256SUMS-*.txt and the AppX (default release-artifacts)
#   AZURE_AD_TENANT_ID, AZURE_AD_APPLICATION_CLIENT_ID, AZURE_AD_APPLICATION_SECRET, SELLER_ID
#   GITHUB_OUTPUT                           set by Actions
#
# Writes decision=submit or decision=skip, with reason, store_version and submission_state, to GITHUB_OUTPUT.
# A skip is a result, not an error: the caller decides whether it skips the job (automatic) or refuses the
# publish (manual). Every check outcome exits 0. The script exits 1 only for a malformed TAG.
# Checks run in order and stop at the first failure, so the reason names one cause. The reason is also the
# Discord notice text, so it is plain and short. Nothing here prints secret values.

set -uo pipefail
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"

store_product_id="9P9WWSV7L7RS"

set_output() {
  # Outputs are single-line key=value pairs, so newlines in a value are replaced.
  printf '%s=%s\n' "$1" "${2//$'\n'/ }" >> "$GITHUB_OUTPUT"
}

skip() {
  echo "Microsoft Store submission skipped: $1"
  set_output decision skip
  set_output reason "$1"
  exit 0
}

if [[ ! "${TAG:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error title=Invalid release tag::TAG must look like vMAJOR.MINOR.PATCH."
  exit 1
fi
version="${TAG#v}"
expected="$version.0"
artifact_dir="${ARTIFACT_DIR:-release-artifacts}"

# 1. The AppX is the only one for this version, and its checksum is verified.
shopt -s nullglob
sums=("$artifact_dir"/SHA256SUMS-*.txt)
appx_files=("$artifact_dir"/*.appx)
shopt -u nullglob
if [ "${#sums[@]}" -ne 1 ]; then
  skip "expected one SHA256SUMS file in the artifacts, found ${#sums[@]}"
fi
if [ "${#appx_files[@]}" -ne 1 ]; then
  skip "expected exactly one .appx in the artifacts, found ${#appx_files[@]}"
fi
appx_name="$(basename "${appx_files[0]}")"
case "$appx_name" in
  *"-$version-"*) ;;
  *) skip "the AppX name $appx_name does not contain version $version" ;;
esac
if ! grep -Fq -- "$appx_name" "${sums[0]}"; then
  skip "$appx_name is not listed in the SHA256SUMS file"
fi
if ! (cd "$artifact_dir" && sha256sum --check "$(basename "${sums[0]}")"); then
  skip "the SHA256SUMS verification failed"
fi

# 2. Store credentials, then msstore sign-in.
if [ -z "${AZURE_AD_TENANT_ID:-}" ] || [ -z "${AZURE_AD_APPLICATION_CLIENT_ID:-}" ] \
  || [ -z "${AZURE_AD_APPLICATION_SECRET:-}" ] || [ -z "${SELLER_ID:-}" ]; then
  skip "Store credentials are not configured"
fi
if ! msstore reconfigure --tenantId "$AZURE_AD_TENANT_ID" --sellerId "$SELLER_ID" \
  --clientId "$AZURE_AD_APPLICATION_CLIENT_ID" --clientSecret "$AZURE_AD_APPLICATION_SECRET"; then
  skip "msstore reconfigure failed"
fi

# 3. Partner Center submission status. Only "no pending submission" or a final state allows a submit.
# The exit code is ignored; the output text decides. Unrecognized output is a skip.
status_output=$(msstore submission status "$store_product_id" 2>&1) || true
printf '%s\n' "$status_output"
state=$(printf '%s\n' "$status_output" \
  | sed -n 's/.*Submission Status[[:space:]]*=[[:space:]]*\([A-Za-z][A-Za-z]*\).*/\1/p' | head -n1)
if [ -n "$state" ]; then
  lowered=$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')
  case "$lowered" in
    published | *failed*)
      # Final states: nothing is in progress, and a new submission replaces this one.
      set_output submission_state "$state"
      ;;
    *)
      skip "a Store submission is still in $state"
      ;;
  esac
# msstore-cli prints "Could not find a Pending Submission, but found the Last Published Submission."
# (MSStore.CLI/Helpers/IStorePackagedAPIExtensions.cs) and normally follows it with "Submission Status = Published".
elif printf '%s\n' "$status_output" | grep -qiE 'could not find a pending submission|no pending submission'; then
  set_output submission_state none
else
  skip "msstore submission status output was not recognized"
fi

# 4. The Store's public version, from the Display Catalog (public, no credentials).
catalog=$(mktemp)
if ! curl -fsS --retry 3 --max-time 30 -o "$catalog" \
  "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=$store_product_id&market=US&languages=en-US"; then
  skip "the Display Catalog request failed, so the Store version could not be confirmed"
fi
product_count=$(jq '.Products | length' < "$catalog" 2>/dev/null) || product_count=-1
if [ "$product_count" != "1" ]; then
  skip "the Display Catalog returned $product_count products for $store_product_id, expected 1"
fi
# Package full names look like Name_1.5.3.0_x64__publisher, so field 2 is the version. Sort with -V so 1.5.10 sorts after 1.5.9.
versions=$(jq -r '[.Products[0].DisplaySkuAvailabilities[]?.Sku.Properties.Packages[]?.PackageFullName | split("_")[1]] | unique | .[]' < "$catalog")
store_version=$(printf '%s\n' "$versions" | sed '/^$/d' | sort -V | tail -n1)
set_output store_version "$store_version"
if [ -z "$store_version" ]; then
  skip "the Store lists no package version for $store_product_id"
fi
if [ "$store_version" = "$expected" ]; then
  skip "the Store already has version $store_version"
fi
if [ "$(printf '%s\n%s\n' "$store_version" "$expected" | sort -V | head -n1)" != "$store_version" ]; then
  skip "the Store already has a newer version, $store_version"
fi

echo "Microsoft Store checks passed for $TAG: AppX $appx_name, Store version $store_version, submission state ${state:-none}."
set_output decision submit
set_output reason "all checks passed"
exit 0
