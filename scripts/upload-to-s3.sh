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
NC='\033[0m' # No Color

echo -e "${BLUE}📦 Uploading kubectl and helm to S3 bucket: ${S3_BUCKET}${NC}"

# Create temporary directory
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# Download kubectl
echo -e "${BLUE}📥 Downloading kubectl...${NC}"
KUBECTL_URL="https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/${ARCH}/kubectl"
KUBECTL_PATH="${TMPDIR}/kubectl"

if ! curl -f -s -L -o "${KUBECTL_PATH}" "${KUBECTL_URL}"; then
    echo -e "${RED}❌ Failed to download kubectl${NC}"
    exit 1
fi

chmod +x "${KUBECTL_PATH}"
KUBECTL_VERSION=$("${KUBECTL_PATH}" version --client --short 2>/dev/null | cut -d' ' -f3 || echo "latest")
echo -e "${GREEN}✅ kubectl downloaded (version: ${KUBECTL_VERSION})${NC}"

# Upload kubectl to S3
KUBECTL_S3_KEY="tools/kubectl/${ARCH}/kubectl-${KUBECTL_VERSION}"
echo -e "${BLUE}📤 Uploading kubectl to s3://${S3_BUCKET}/${KUBECTL_S3_KEY}${NC}"
aws s3 cp "${KUBECTL_PATH}" "s3://${S3_BUCKET}/${KUBECTL_S3_KEY}" --acl public-read
aws s3 cp "${KUBECTL_PATH}" "s3://${S3_BUCKET}/tools/kubectl/${ARCH}/kubectl-latest" --acl public-read
echo -e "${GREEN}✅ kubectl uploaded${NC}"

# Download Helm
echo -e "${BLUE}📥 Downloading Helm...${NC}"
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
HELM_S3_KEY="tools/helm/${HELM_ARCH}/helm-${HELM_VERSION}"
echo -e "${BLUE}📤 Uploading Helm to s3://${S3_BUCKET}/${HELM_S3_KEY}${NC}"
aws s3 cp "${HELM_PATH}" "s3://${S3_BUCKET}/${HELM_S3_KEY}" --acl public-read
aws s3 cp "${HELM_PATH}" "s3://${S3_BUCKET}/tools/helm/${HELM_ARCH}/helm-latest" --acl public-read
echo -e "${GREEN}✅ Helm uploaded${NC}"

# Create version manifest files
echo -e "${BLUE}📝 Creating version manifests...${NC}"
echo "${KUBECTL_VERSION}" | aws s3 cp - "s3://${S3_BUCKET}/tools/kubectl/${ARCH}/version.txt" --acl public-read --content-type text/plain
echo "${HELM_VERSION}" | aws s3 cp - "s3://${S3_BUCKET}/tools/helm/${HELM_ARCH}/version.txt" --acl public-read --content-type text/plain

echo -e "${GREEN}✅ All binaries uploaded successfully!${NC}"
echo ""
echo "S3 URLs:"
echo "  kubectl: https://${S3_BUCKET}.s3.amazonaws.com/tools/kubectl/${ARCH}/kubectl-latest"
echo "  helm: https://${S3_BUCKET}.s3.amazonaws.com/tools/helm/${HELM_ARCH}/helm-latest"
