#!/bin/bash

##
#   build.sh
#   Build the @freya-vivariums/freya-hardware-cartridge package
#

BUILD_DIR=build

# Remove the old build folder
echo -e "Removing folder '$BUILD_DIR'";
rm -rf $BUILD_DIR/;

# Convert the TypeScript to JavaScript
tsc;

exit 0;
