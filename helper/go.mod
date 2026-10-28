module github.com/meanaverage/tabby-rdp/helper

go 1.25.0

// Release builds use exactly this toolchain, so that every platform's helper can be rebuilt byte for byte
// (scripts/build-helper.mjs refuses another for a release build).
toolchain go1.27.1
