//! Bind a gesture to one trusted desktop surface. Only that surface and the
//! current session ID can release its remote controls.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::oneshot;

// CG keyboard events are accepted only after their sender is identified as the
// selected RC003. Keep both edges of a consumed OK out of the foreground app.
static CONTROLS: AtomicBool = AtomicBool::new(false);
static OK_HELD: AtomicBool = AtomicBool::new(false);
static OK_PRESSED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
#[no_mangle]
pub extern "C" fn keepwork_remote_dialogue_ok_edge(down: bool) -> bool {
    if !down {
        return OK_HELD.swap(false, Ordering::AcqRel);
    }
    if OK_HELD.load(Ordering::Acquire) {
        return true;
    }
    if !CONTROLS.load(Ordering::Acquire) {
        return false;
    }
    OK_HELD.store(true, Ordering::Release);
    OK_PRESSED.store(true, Ordering::Release);
    true
}
pub(super) fn release_device() {
    OK_HELD.store(false, Ordering::Release);
    OK_PRESSED.store(false, Ordering::Release);
}
pub(super) fn take_ok() -> bool {
    OK_PRESSED.swap(false, Ordering::AcqRel)
}

pub(crate) type Reply = oneshot::Receiver<bool>;
pub(crate) struct Surface {
    pub label: &'static str,
    pub send: Box<dyn Fn(&str, &str, &str) -> Result<Reply, String> + Send + Sync>,
}
struct Owner {
    id: String,
    surface: Surface,
}
type Select = Box<dyn Fn(bool) -> Option<Surface> + Send + Sync>;
#[derive(Default)]
pub(crate) struct Dialogue {
    select: OnceLock<Select>,
    owner: Mutex<Option<Arc<Owner>>>,
}
impl Dialogue {
    pub fn install(&self, select: impl Fn(bool) -> Option<Surface> + Send + Sync + 'static) {
        let _ = self.select.set(Box::new(select));
    }
    pub fn active(&self) -> bool {
        self.owner.lock().unwrap().is_some()
    }
    #[cfg(target_os = "macos")]
    pub fn owns(&self, label: &str, id: &str) -> bool {
        self.owner
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|o| o.surface.label == label && o.id == id)
    }
    pub fn closed(&self, label: &str, id: &str) -> bool {
        let mut slot = self.owner.lock().unwrap();
        if !slot
            .as_ref()
            .is_some_and(|o| o.surface.label == label && o.id == id)
        {
            return false;
        }
        slot.take();
        CONTROLS.store(false, Ordering::Release);
        OK_PRESSED.store(false, Ordering::Release);
        true
    }
    pub fn exit(&self, reason: &str) -> bool {
        let owner = {
            let mut slot = self.owner.lock().unwrap();
            let Some(owner) = slot.take() else {
                return false;
            };
            CONTROLS.store(false, Ordering::Release);
            OK_PRESSED.store(false, Ordering::Release);
            owner
        };
        let _ = (owner.surface.send)("exit", &owner.id, reason);
        true
    }
    pub fn enter(self: &Arc<Self>) {
        let Some(surface) = self.select.get().and_then(|select| select(false)) else {
            return;
        };
        let owner = Arc::new(Owner {
            id: uuid::Uuid::new_v4().to_string(),
            surface,
        });
        {
            let mut slot = self.owner.lock().unwrap();
            if slot.is_some() {
                return;
            }
            *slot = Some(owner.clone());
            OK_PRESSED.store(false, Ordering::Release);
            CONTROLS.store(true, Ordering::Release);
        }
        self.send_owned(&owner, "enter");
    }
    pub fn record(self: &Arc<Self>) {
        let owner = self.owner.lock().unwrap().clone();
        if let Some(owner) = owner {
            self.send_owned(&owner, "record");
        }
    }
    pub fn interrupt(&self) {
        if let Some(surface) = self.select.get().and_then(|select| select(true)) {
            let _ = (surface.send)("interrupt", "", "");
        }
    }
    fn send_owned(self: &Arc<Self>, owner: &Arc<Owner>, action: &str) {
        let reply = (owner.surface.send)(action, &owner.id, "");
        let service = self.clone();
        let owner = owner.clone();
        tauri::async_runtime::spawn(async move {
            let accepted = if let Ok(reply) = reply {
                matches!(
                    tokio::time::timeout(Duration::from_secs(2), reply).await,
                    Ok(Ok(true))
                )
            } else {
                false
            };
            if !accepted && service.closed(owner.surface.label, &owner.id) {
                let _ = (owner.surface.send)("exit", &owner.id, "closed");
            }
        });
    }
}

#[cfg(test)]
pub(super) static TEST_OWNER_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(test)]
#[path = "dialogue_tests.rs"]
mod tests;
