//! Present page-owned tool confirmations and return to the pet before a screen capture.
use super::{launch::trusted_main_document_origin, main_window, pet_host, state::AppCore};
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

pub(super) struct ReturnTicket {
    document: String,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

impl ReturnTicket {
    fn new(window: &WebviewWindow, document: &str) -> tauri::Result<Self> {
        Ok(Self {
            document: document.to_owned(),
            position: window.outer_position()?,
            size: window.inner_size()?,
        })
    }

    fn window_changed(&self, event: &tauri::WindowEvent) -> bool {
        match event {
            tauri::WindowEvent::Resized(size) => self.size != *size,
            tauri::WindowEvent::Moved(position) => self.position != *position,
            _ => false,
        }
    }
}

pub(super) fn observe_main(window: &WebviewWindow, core: Arc<AppCore>) {
    window.on_window_event(move |event| {
        let mut pending = core.pet_approval_return.lock().unwrap();
        if pending
            .as_ref()
            .is_some_and(|ticket| ticket.window_changed(event))
        {
            pending.take();
        }
    });
}

enum PresentationRequest {
    Reveal { return_to_pet: bool },
    ReturnToPet,
}

#[tauri::command]
pub(super) async fn desktop_reveal_pet_approval(
    app: AppHandle,
    window: WebviewWindow,
    document: String,
    token: String,
    return_to_pet: Option<bool>,
) -> Result<bool, String> {
    request(
        app,
        window,
        document,
        token,
        PresentationRequest::Reveal {
            return_to_pet: return_to_pet.unwrap_or(false),
        },
    )
    .await
}

#[tauri::command]
pub(super) async fn desktop_return_to_pet_after_approval(
    app: AppHandle,
    window: WebviewWindow,
    document: String,
    token: String,
) -> Result<bool, String> {
    request(
        app,
        window,
        document,
        token,
        PresentationRequest::ReturnToPet,
    )
    .await
}

async fn request(
    app: AppHandle,
    window: WebviewWindow,
    document: String,
    token: String,
    request: PresentationRequest,
) -> Result<bool, String> {
    let handle = app.clone();
    let (done, result) = tokio::sync::oneshot::channel();
    main_window::run_on_window_thread(&app, move || {
        let core = handle.state::<Arc<AppCore>>();
        let result = authenticate(&window, &core, &document, &token).and_then(|()| match request {
            PresentationRequest::Reveal { return_to_pet } => {
                reveal(&handle, &window, &core, &document, return_to_pet)
            }
            PresentationRequest::ReturnToPet => return_to_pet(&handle, &window, &core, &document),
        });
        let _ = done.send(result);
    })
    .map_err(|e| e.to_string())?;
    result.await.map_err(|e| e.to_string())?
}

pub(super) fn authenticate(
    window: &WebviewWindow,
    core: &AppCore,
    document: &str,
    token: &str,
) -> Result<(), String> {
    trusted_main_document_origin(window, core)?;
    uuid::Uuid::parse_str(document).map_err(|_| "Invalid approval document")?;
    core.launch_intents.lock().unwrap().authenticate(token)
}

pub(super) fn reveal(
    app: &AppHandle,
    main: &WebviewWindow,
    core: &AppCore,
    document: &str,
    return_to_pet: bool,
) -> Result<bool, String> {
    core.pet_approval_return.lock().unwrap().take();
    let Some(pet) = app.get_webview_window("pet") else {
        return Ok(false);
    };
    if core.quitting.load(Ordering::Relaxed)
        || !pet_host::pet_is_active(&pet).map_err(|e| e.to_string())?
    {
        return Ok(false);
    }
    // The pet keeps its pending decisions when hidden. Returning to it after
    // the page approval restores those controls along with the conversation.
    let owned = return_to_pet && !main.is_visible().map_err(|e| e.to_string())?;
    main_window::show_main_window(app, core);
    if owned {
        if !main.is_visible().map_err(|e| e.to_string())? {
            return Err("Cannot present the approval window".into());
        }
        let ticket = ReturnTicket::new(main, document).map_err(|e| e.to_string())?;
        *core.pet_approval_return.lock().unwrap() = Some(ticket);
    }
    Ok(!return_to_pet || owned)
}

pub(super) fn return_to_pet(
    app: &AppHandle,
    main: &WebviewWindow,
    core: &Arc<AppCore>,
    document: &str,
) -> Result<bool, String> {
    let mut pending = core.pet_approval_return.lock().unwrap();
    if !pending.as_ref().is_some_and(|t| t.document == document) {
        return Ok(false);
    }
    let ticket = pending.take().unwrap();
    drop(pending);
    if core.quitting.load(Ordering::Relaxed)
        || !core.settings().pet_visible
        || !main.is_visible().map_err(|e| e.to_string())?
        || main.is_minimized().map_err(|e| e.to_string())?
        || main.outer_position().map_err(|e| e.to_string())? != ticket.position
        || main.inner_size().map_err(|e| e.to_string())? != ticket.size
    {
        return Ok(false);
    }
    core.pet.set_expanded(false);
    main_window::hide_main_window(app, core);
    pet_host::ensure_pet_window(app, core, true);
    let pet = app.get_webview_window("pet").ok_or("Missing pet window")?;
    Ok(!main.is_visible().map_err(|e| e.to_string())?
        && pet.is_visible().map_err(|e| e.to_string())?)
}
