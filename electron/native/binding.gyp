{
  "targets": [{
    "target_name": "paperquay_fs",
    "sources": ["pinned_fs.cc"],
    "defines": ["NAPI_VERSION=8"],
    "defines!": ["_HAS_EXCEPTIONS=0"],
    "cflags_cc!": ["-fno-exceptions"],
    "cflags_cc": ["-std=c++17"],
    "xcode_settings": {"CLANG_CXX_LANGUAGE_STANDARD": "c++17", "GCC_ENABLE_CPP_EXCEPTIONS": "YES", "MACOSX_DEPLOYMENT_TARGET": "11.0"},
    "msvs_settings": {"VCCLCompilerTool": {"ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"]}}
  }]
}
