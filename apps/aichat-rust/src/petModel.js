// Compatibility projection for AIChat pages whose pet snapshot omits the model.
// These are the same selected-value controls used by the published pet producer.
export function createPetModelPublisher(publish, env = window) {
  let lastState;
  let lastModel;
  let sequence = 0;
  let live = true;
  const bounded = value => typeof value === "string" && value.length <= 128
    && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : "";
  const model = state => {
    if (Object.prototype.hasOwnProperty.call(state, "modelId")) return bounded(state.modelId);
    if (state.target === "persona") {
      const page = env.document.getElementById("personaPage");
      if (!page || page.hidden) return "";
      // The published persona composer writes the raw ID in parentheses when
      // its display label differs. Its independent selection must not borrow
      // the ordinary chat's last model. Do not use layout visibility: the main
      // window can be hidden while the companion remains active.
      const title = page.querySelector('.persona-composer [data-compose="model"]')?.title || "";
      const selected = /^选择模型：(.*)$/.exec(title)?.[1];
      if (!selected) return "";
      return bounded(/ \(([^()]*)\)$/.exec(selected)?.[1] ?? selected);
    }
    const harness = env.document.getElementById("chatHarnessSelect")?.value;
    if (harness && harness !== "keepwork") {
      return bounded(env.document.getElementById("chatHarnessModel")?.value);
    }
    return bounded(env.document.getElementById("chatModelSelect")?.value
      || env.document.getElementById("modelSelect")?.value || "");
  };
  const send = state => {
    lastModel = model(state);
    const request = ++sequence;
    return Promise.resolve(publish({ ...state, modelId: lastModel })).catch(error => {
      if (sequence === request) lastModel = undefined;
      throw error;
    });
  };
  const refresh = () => {
    if (live && lastState && model(lastState) !== lastModel) {
      // A model-only selection can be deduplicated by the old page producer.
      // Never fabricate a new chat state or replay a chat command here.
      Promise.resolve(send(lastState)).catch(() => {});
    }
  };
  // Programmatic .value assignments (including restoring a conversation) do
  // not emit DOM change events or attribute mutations. Poll only two values.
  const timer = env.setInterval(refresh, 250);
  env.addEventListener("change", refresh, true);
  env.addEventListener("pageshow", refresh);
  const dispose = () => {
    live = false;
    lastState = undefined;
    env.clearInterval(timer);
    env.removeEventListener("change", refresh, true);
    env.removeEventListener("pageshow", refresh);
    env.removeEventListener("pagehide", dispose);
  };
  env.addEventListener("pagehide", dispose);
  return {
    publish(state) {
      if (!live) return Promise.resolve(false);
      lastState = state && typeof state === "object" && !Array.isArray(state) ? { ...state } : {};
      return send(lastState);
    },
    dispose,
  };
}
