//! Observe system sleep independently of the foreground window or WebView.
use super::RemoteVoice;
use std::sync::{Arc, OnceLock, Weak};

static SERVICE: OnceLock<Weak<RemoteVoice>> = OnceLock::new();

extern "C" fn notify(sleeping: bool) {
    if let Some(service) = SERVICE.get().and_then(Weak::upgrade) {
        service.power_changed(sleeping);
    }
}

pub(super) fn observe(service: &Arc<RemoteVoice>) {
    if SERVICE.set(Arc::downgrade(service)).is_err() {
        return;
    }
    #[cfg(target_os = "macos")]
    unsafe {
        extern "C" {
            fn keepwork_voice_observe_power(callback: extern "C" fn(bool));
        }
        keepwork_voice_observe_power(notify);
    }
    #[cfg(windows)]
    windows_observe();
}

#[cfg(windows)]
fn windows_observe() {
    use std::ffi::c_void;
    use windows_sys::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMSUSPEND,
    };
    unsafe extern "system" fn callback(_: *const c_void, event: u32, _: *const c_void) -> u32 {
        match event {
            PBT_APMSUSPEND => notify(true),
            PBT_APMRESUMEAUTOMATIC => notify(false),
            _ => {}
        }
        0
    }
    let mut registration = std::ptr::null_mut();
    let parameters = DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
        Callback: Some(callback),
        Context: std::ptr::null_mut(),
    };
    // One observer for the desktop process; the callback retains no application handle.
    unsafe {
        PowerRegisterSuspendResumeNotification(
            DEVICE_NOTIFY_CALLBACK,
            (&raw const parameters).cast_mut().cast(),
            &mut registration,
        );
    }
}
