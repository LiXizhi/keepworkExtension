#include "pet_input_policy.h"
#include <cstdlib>
#include <iostream>

static void Check(bool value, const char* label) {
  if (!value) { std::cerr << "Pet input policy failure: " << label << '\n'; std::exit(1); }
}

int main() {
  using namespace keepwork_cef;
  Check(PetEnterDecision({}) == PetEnterAction::Send, "idle Enter sends");
  PetEnterInput input;
  input.busy = true;
  Check(PetEnterDecision(input) == PetEnterAction::Stop, "busy Enter stops the current reply");
  for (const bool busy : {false, true}) {
    input = {}; input.busy = busy; input.repeat = true;
    Check(PetEnterDecision(input) == PetEnterAction::Consume, "held Enter cannot repeat send or stop");
    for (const auto field : {&PetEnterInput::composing, &PetEnterInput::shift, &PetEnterInput::control,
                            &PetEnterInput::alt, &PetEnterInput::windows}) {
      input = {}; input.busy = busy; input.*field = true;
      Check(PetEnterDecision(input) == PetEnterAction::PassThrough, "IME and modifiers retain native behavior");
      input.repeat = true;
      Check(PetEnterDecision(input) == PetEnterAction::PassThrough, "modified held keys retain native behavior");
    }
  }
  std::cout << "CEF pet input policy passed\n";
}
