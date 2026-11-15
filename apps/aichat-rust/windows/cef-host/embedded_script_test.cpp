#include "compatibility_script.h"
#include <fstream>

// Write the compiler-concatenated array as binary bytes for the independent
// JavaScript fixture's byte comparison, including all UTF-8 and newlines.
int main(int argc, char** argv) {
  if (argc != 2) return 2;
  std::ofstream output(argv[1], std::ios::binary | std::ios::trunc);
  output.write(keepwork_cef::kPopoverScript, sizeof(keepwork_cef::kPopoverScript) - 1);
  return output.good() ? 0 : 1;
}
