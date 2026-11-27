#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/../.."
mkdir -p vendor/native
"${EMXX:-em++}" native/css/core.cpp -std=c++20 -O3 -flto --no-entry \
  -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=2097152 -sSTACK_SIZE=262144 -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=@native/css/exports.json -o vendor/native/css.wasm
NATIVE_CSS_COMPILER_VERSION="$("${EMXX:-em++}" --version | head -n 1)" \
  "${NATIVE_CSS_NODE:-node}" build/native-css.cjs --write
