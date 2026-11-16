#pragma once

namespace keepwork_cef {
enum class PetEnterAction { PassThrough, Consume, Send, Stop };
struct PetEnterInput {
  bool composing = false, shift = false, control = false, alt = false;
  bool windows = false, repeat = false, busy = false;
};

// Keep IME confirmation and modified Enter with the native EDIT control. A
// held unmodified key is consumed, so it cannot submit or stop a second time.
inline PetEnterAction PetEnterDecision(const PetEnterInput& input) {
  if (input.composing || input.shift || input.control || input.alt || input.windows)
    return PetEnterAction::PassThrough;
  if (input.repeat) return PetEnterAction::Consume;
  return input.busy ? PetEnterAction::Stop : PetEnterAction::Send;
}
}
