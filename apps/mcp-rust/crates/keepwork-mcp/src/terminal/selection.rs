//! Backend selection never retries a failed native spawn on another backend.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Backend {
    Conpty,
    Winpty,
}

pub(super) fn choose_backend(legacy_edition: bool, exports: [bool; 3]) -> Option<Backend> {
    if exports.into_iter().all(|present| present) {
        Some(Backend::Conpty)
    } else if legacy_edition {
        Some(Backend::Winpty)
    } else {
        None
    }
}

pub(super) fn spawn_guarded<T, E, G>(
    guard: Result<G, E>,
    backend: Backend,
    conpty: impl FnOnce(&G) -> Result<T, E>,
    winpty: impl FnOnce(&G) -> Result<T, E>,
) -> Result<T, E> {
    let guard = guard?;
    match backend {
        Backend::Conpty => conpty(&guard),
        Backend::Winpty => winpty(&guard),
    }
}

#[cfg(test)]
#[path = "selection_tests.rs"]
mod tests;
