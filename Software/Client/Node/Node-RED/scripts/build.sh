#!/bin/bash

##
#   build.sh
#   Build the @freya-vivariums/freya-hardware-cartridge-node-red-contrib package
#

# Stop on the first error, so a failed compile can never leave a
# half-built folder behind for npm to publish.
set -e

BUILD_DIR=build

# Remove the old build folder
echo -e "Removing folder '$BUILD_DIR'";
rm -rf $BUILD_DIR/;

# Convert the TypeScript to JavaScript
tsc;

# Copy all the nodes their html files to their right sub-folder in the build/ folder
rsync -av --include='*/' --include='*.html' --exclude='*' nodes/ ${BUILD_DIR}/nodes/

# Copy all required files to the build folder
cp -r icons/ package.json LICENSE.txt README.md ${BUILD_DIR}/;

# The SDK library is a sibling folder in this repository, so the source
# package.json depends on it by path for local development. A 'file:' path means
# nothing once published, so resolve it to the library's actual version range.
LIBRARY_NAME=@freya-vivariums/freya-hardware-cartridge
LIBRARY_VERSION=$(jq -r '.version' ../Library/package.json)

# Rewrite build/package.json for publishing from the build/ directory:
# - strip prepublishOnly (the guard that blocks publishing from the source tree)
# - rewrite files and node-red.nodes paths from build/nodes -> nodes,
#   so the published tarball has the nodes at its root
# - replace the 'file:' dependency with the published version range
jq --arg lib "$LIBRARY_NAME" --arg ver "^${LIBRARY_VERSION}" '
  del(.scripts.prepublishOnly) |
  .files = ["icons","nodes"] |
  ."node-red".nodes |= with_entries(.value |= ltrimstr("build/")) |
  .dependencies[$lib] = $ver
' ${BUILD_DIR}/package.json > ${BUILD_DIR}/package.json.tmp
mv ${BUILD_DIR}/package.json.tmp ${BUILD_DIR}/package.json

# No 'file:' dependency may survive into the published package.
if jq -e '(.dependencies // {}) | to_entries[] | select(.value | startswith("file:"))' ${BUILD_DIR}/package.json >/dev/null; then
    echo "Build failed: ${BUILD_DIR}/package.json still contains a 'file:' dependency";
    exit 1;
fi

# Every file referenced by node-red.nodes must exist in the build folder.
# This is what went wrong before: the package shipped .ts sources while
# node-red.nodes pointed at .js files, so Node-RED refused to load the node.
for node_file in $(jq -r '."node-red".nodes[]' ${BUILD_DIR}/package.json); do
    if [ ! -f "${BUILD_DIR}/${node_file}" ]; then
        echo "Build failed: '${node_file}' is referenced by node-red.nodes but missing from ${BUILD_DIR}/";
        exit 1;
    fi
done

exit 0;
