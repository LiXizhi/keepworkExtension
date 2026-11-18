export function createPetModelPublisher(
  publish: (state: Record<string, unknown>) => Promise<boolean>,
  env?: Window,
): { publish(state: Record<string, unknown>): Promise<boolean>; dispose(): void };
