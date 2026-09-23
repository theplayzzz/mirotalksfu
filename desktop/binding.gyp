{
  "targets": [
    {
      "target_name": "process_loopback",
      "sources": ["native/process_loopback.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "_WIN32_WINNT=0x0A00",
        "WINVER=0x0A00",
        "UNICODE",
        "_UNICODE"
      ],
      "libraries": ["ole32.lib", "uuid.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++20"],
          "ExceptionHandling": 0
        }
      },
      "conditions": [
        ["OS!='win'", {
          "type": "none"
        }]
      ]
    }
  ]
}
