#!/bin/bash
set -e

# Configuration
S3_BUCKET="doazgpt-public"
ARCH=$(dpkg --print-architecture || uname -m)
KUBECTL_VERSION=""
HELM_VERSION=""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if object exists in S3
check_s3_object() {
    local s3_path="$1"
    aws s3 ls "s3://${S3_BUCKET}/${s3_path}" >/dev/null 2>&1
}

# Function to get version from S3
get_s3_version() {
    local version_file="$1"
    aws s3 cp "s3://${S3_BUCKET}/${version_file}" - 2>/dev/null | tr -d '\n' || echo ""
}

echo -e "${BLUE}📦 Checking and uploading kubectl and helm to S3 bucket: ${S3_BUCKET}${NC}"

# Create temporary directory
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# Check and upload kubectl
echo -e "${BLUE}🔍 Checking kubectl version...${NC}"
KUBECTL_RELEASE=$(curl -L -s https://dl.k8s.io/release/stable.txt)
KUBECTL_VERSION="${KUBECTL_RELEASE#v}"  # Remove 'v' prefix if present

# Check if version already exists on S3
KUBECTL_S3_VERSION_FILE="tools/kubectl/${ARCH}/version.txt"
S3_KUBECTL_VERSION=$(get_s3_version "${KUBECTL_S3_VERSION_FILE}")

if [ -n "${S3_KUBECTL_VERSION}" ] && [ "${S3_KUBECTL_VERSION}" = "${KUBECTL_VERSION}" ]; then
    # Check if the version-specific file exists
    KUBECTL_S3_KEY="tools/kubectl/${ARCH}/kubectl-${KUBECTL_VERSION}"
    if check_s3_object "${KUBECTL_S3_KEY}"; then
        echo -e "${YELLOW}⏭️  kubectl version ${KUBECTL_VERSION} already exists on S3, skipping upload${NC}"
    else
        echo -e "${BLUE}📥 Version file exists but binary missing, downloading...${NC}"
        # Fall through to download
    fi
else
    echo -e "${BLUE}📥 New kubectl version detected (${KUBECTL_VERSION}), downloading...${NC}"
fi

# Download if needed (if we didn't skip above)
if [ -z "${S3_KUBECTL_VERSION}" ] || [ "${S3_KUBECTL_VERSION}" != "${KUBECTL_VERSION}" ] || ! check_s3_object "tools/kubectl/${ARCH}/kubectl-${KUBECTL_VERSION}"; then
    KUBECTL_URL="https://dl.k8s.io/release/${KUBECTL_RELEASE}/bin/linux/${ARCH}/kubectl"
    KUBECTL_PATH="${TMPDIR}/kubectl"

    if ! curl -f -s -L -o "${KUBECTL_PATH}" "${KUBECTL_URL}"; then
        echo -e "${RED}❌ Failed to download kubectl${NC}"
        exit 1
    fi

    chmod +x "${KUBECTL_PATH}"

    # Verify kubectl works and get actual version
    if "${KUBECTL_PATH}" version --client >/dev/null 2>&1; then
        # Try to extract version from kubectl output
        KUBECTL_ACTUAL_VERSION=$("${KUBECTL_PATH}" version --client --short 2>/dev/null | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "${KUBECTL_VERSION}")
        if [ -n "${KUBECTL_ACTUAL_VERSION}" ] && [ "${KUBECTL_ACTUAL_VERSION}" != "latest" ]; then
            KUBECTL_VERSION="${KUBECTL_ACTUAL_VERSION}"
        fi
    fi

    echo -e "${GREEN}✅ kubectl downloaded (version: ${KUBECTL_VERSION})${NC}"

    # Set S3 key with final version
    KUBECTL_S3_KEY="tools/kubectl/${ARCH}/kubectl-${KUBECTL_VERSION}"
    
    # Upload kubectl to S3
    echo -e "${BLUE}📤 Uploading kubectl to s3://${S3_BUCKET}/${KUBECTL_S3_KEY}${NC}"
    aws s3 cp "${KUBECTL_PATH}" "s3://${S3_BUCKET}/${KUBECTL_S3_KEY}" --acl public-read --content-type application/octet-stream
    aws s3 cp "${KUBECTL_PATH}" "s3://${S3_BUCKET}/tools/kubectl/${ARCH}/kubectl-latest" --acl public-read --content-type application/octet-stream
    
    # Update version file
    echo "${KUBECTL_VERSION}" | aws s3 cp - "s3://${S3_BUCKET}/${KUBECTL_S3_VERSION_FILE}" --acl public-read --content-type text/plain
    
    echo -e "${GREEN}✅ kubectl uploaded${NC}"
fi

# Check and upload Helm
echo -e "${BLUE}🔍 Checking Helm version...${NC}"
# Map architecture
case "${ARCH}" in
    amd64|x86_64) HELM_ARCH="amd64" ;;
    arm64|aarch64) HELM_ARCH="arm64" ;;
    *) HELM_ARCH="amd64" ;;
esac

HELM_VERSION=$(curl -s https://api.github.com/repos/helm/helm/releases/latest | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/' | head -1)
if [ -z "$HELM_VERSION" ]; then
    HELM_VERSION="v3.20.0"
fi

# Check if version already exists on S3
HELM_S3_VERSION_FILE="tools/helm/${HELM_ARCH}/version.txt"
HELM_S3_KEY="tools/helm/${HELM_ARCH}/helm-${HELM_VERSION}"
S3_HELM_VERSION=$(get_s3_version "${HELM_S3_VERSION_FILE}")

if [ -n "${S3_HELM_VERSION}" ] && [ "${S3_HELM_VERSION}" = "${HELM_VERSION}" ] && check_s3_object "${HELM_S3_KEY}"; then
    echo -e "${YELLOW}⏭️  Helm version ${HELM_VERSION} already exists on S3, skipping upload${NC}"
else
    echo -e "${BLUE}📥 Downloading Helm (version: ${HELM_VERSION})...${NC}"
    HELM_URL="https://get.helm.sh/helm-${HELM_VERSION}-linux-${HELM_ARCH}.tar.gz"
    HELM_TAR="${TMPDIR}/helm.tar.gz"
    HELM_PATH="${TMPDIR}/helm"

    if ! curl -f -s -L -o "${HELM_TAR}" "${HELM_URL}"; then
        echo -e "${RED}❌ Failed to download Helm${NC}"
        exit 1
    fi

    if ! tar -xzf "${HELM_TAR}" -C "${TMPDIR}" "linux-${HELM_ARCH}/helm" 2>/dev/null; then
        echo -e "${RED}❌ Failed to extract Helm${NC}"
        exit 1
    fi

    mv "${TMPDIR}/linux-${HELM_ARCH}/helm" "${HELM_PATH}"
    chmod +x "${HELM_PATH}"
    echo -e "${GREEN}✅ Helm downloaded (version: ${HELM_VERSION})${NC}"

    # Upload Helm to S3
    echo -e "${BLUE}📤 Uploading Helm to s3://${S3_BUCKET}/${HELM_S3_KEY}${NC}"
    aws s3 cp "${HELM_PATH}" "s3://${S3_BUCKET}/${HELM_S3_KEY}" --acl public-read --content-type application/octet-stream
    aws s3 cp "${HELM_PATH}" "s3://${S3_BUCKET}/tools/helm/${HELM_ARCH}/helm-latest" --acl public-read --content-type application/octet-stream
    
    # Update version file
    echo "${HELM_VERSION}" | aws s3 cp - "s3://${S3_BUCKET}/${HELM_S3_VERSION_FILE}" --acl public-read --content-type text/plain
    
    echo -e "${GREEN}✅ Helm uploaded${NC}"
fi

echo -e "${GREEN}✅ All binaries uploaded successfully!${NC}"
echo ""
echo "S3 URLs:"
echo "  kubectl: https://${S3_BUCKET}.s3.amazonaws.com/tools/kubectl/${ARCH}/kubectl-latest"
echo "  helm: https://${S3_BUCKET}.s3.amazonaws.com/tools/helm/${HELM_ARCH}/helm-latest"
