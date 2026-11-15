use super::{choose_backend, spawn_guarded, Backend};
use std::cell::Cell;
use std::rc::Rc;

#[test]
fn every_export_combination_selects_one_complete_backend() {
    for legacy_edition in [false, true] {
        for mask in 0..8 {
            let exports = [mask & 1 != 0, mask & 2 != 0, mask & 4 != 0];
            match choose_backend(legacy_edition, exports) {
                Some(Backend::Conpty) => assert_eq!(mask, 7),
                Some(Backend::Winpty) => assert!(legacy_edition && mask != 7),
                None => assert!(!legacy_edition && mask != 7),
            }
        }
    }
}

#[test]
fn integrity_failure_never_invokes_either_backend() {
    for backend in [Backend::Conpty, Backend::Winpty] {
        let result: Result<(), &str> = spawn_guarded(
            Err::<(), _>("pinned backend integrity failed"),
            backend,
            |_| panic!("ConPTY must not bypass a failed integrity guard"),
            |_| panic!("WinPTY must not bypass a failed integrity guard"),
        );
        assert_eq!(result, Err("pinned backend integrity failed"));
    }
}

struct Guard {
    drops: Rc<Cell<usize>>,
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.drops.set(self.drops.get() + 1);
    }
}

#[test]
fn selected_backend_keeps_the_integrity_guard_alive_until_spawn_returns() {
    for backend in [Backend::Conpty, Backend::Winpty] {
        let expected = if matches!(&backend, Backend::Conpty) {
            "conpty"
        } else {
            "winpty"
        };
        let drops = Rc::new(Cell::new(0));
        let conpty_calls = Cell::new(0);
        let winpty_calls = Cell::new(0);
        let result: Result<&str, &str> = spawn_guarded(
            Ok(Guard {
                drops: Rc::clone(&drops),
            }),
            backend,
            |guard| {
                assert_eq!(guard.drops.get(), 0);
                conpty_calls.set(conpty_calls.get() + 1);
                Ok("conpty")
            },
            |guard| {
                assert_eq!(guard.drops.get(), 0);
                winpty_calls.set(winpty_calls.get() + 1);
                Ok("winpty")
            },
        );
        assert_eq!(result, Ok(expected));
        assert_eq!(drops.get(), 1);
        assert_eq!(conpty_calls.get(), usize::from(expected == "conpty"));
        assert_eq!(winpty_calls.get(), usize::from(expected == "winpty"));
    }
}

#[test]
fn selected_spawn_failure_is_returned_without_trying_the_other_backend() {
    for backend in [Backend::Conpty, Backend::Winpty] {
        let expected = if matches!(&backend, Backend::Conpty) {
            "conpty failed"
        } else {
            "winpty failed"
        };
        let drops = Rc::new(Cell::new(0));
        let conpty_calls = Cell::new(0);
        let winpty_calls = Cell::new(0);
        let result: Result<(), &str> = spawn_guarded(
            Ok(Guard {
                drops: Rc::clone(&drops),
            }),
            backend,
            |guard| {
                assert_eq!(guard.drops.get(), 0);
                conpty_calls.set(conpty_calls.get() + 1);
                Err("conpty failed")
            },
            |guard| {
                assert_eq!(guard.drops.get(), 0);
                winpty_calls.set(winpty_calls.get() + 1);
                Err("winpty failed")
            },
        );
        assert_eq!(result, Err(expected));
        assert_eq!(drops.get(), 1);
        assert_eq!(conpty_calls.get(), usize::from(expected == "conpty failed"));
        assert_eq!(winpty_calls.get(), usize::from(expected == "winpty failed"));
    }
}
