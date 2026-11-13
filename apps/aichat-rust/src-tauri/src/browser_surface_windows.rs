//! Bare WebView2 controllers: no Tauri registration, initialization scripts or IPC.
//! COM objects and the registry never leave the native UI thread.
use crate::browser_surface_policy::{bounded, event_url, physical_bounds, windows_contract};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};
use webview2_com::{
    take_pwstr, CreateCoreWebView2ControllerCompletedHandler, DocumentTitleChangedEventHandler,
    DownloadStartingEventHandler, HistoryChangedEventHandler,
    LaunchingExternalUriSchemeEventHandler, Microsoft::Web::WebView2::Win32::*,
    NavigationCompletedEventHandler, NavigationStartingEventHandler,
    NewWindowRequestedEventHandler, PermissionRequestedEventHandler, ProcessFailedEventHandler,
};
use windows::{
    core::{Interface, BOOL, HSTRING, PWSTR},
    Win32::Foundation::{HWND, RECT},
};

type Completion = Box<dyn FnOnce(Result<Value, String>)>;
type Key = (usize, String);
thread_local! {
    static SURFACES: RefCell<HashMap<Key, Rc<Surface>>> = RefCell::new(HashMap::new());
}

struct Surface {
    key: Key,
    owner: ICoreWebView2Controller,
    controller: RefCell<Option<ICoreWebView2Controller>>,
    active: Cell<bool>,
    visible: Cell<bool>,
    bounds: RefCell<Value>,
    zoom: Cell<f64>,
    navigation: Cell<u64>,
    owner_navigation: Cell<Option<i64>>,
}

fn owner_key(owner: &ICoreWebView2Controller) -> usize {
    owner.as_raw() as usize
}

fn read_text(read: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>) -> String {
    let mut raw = PWSTR::null();
    let result = read(&mut raw);
    let value = take_pwstr(raw);
    if result.is_ok() {
        value
    } else {
        String::new()
    }
}

impl Surface {
    fn controller(&self) -> Option<ICoreWebView2Controller> {
        self.controller.borrow().clone()
    }

    fn emit(&self, event: &str, error: &str) {
        if !self.active.get() {
            return;
        }
        let Some(controller) = self.controller() else {
            return;
        };
        unsafe {
            let Ok(view) = controller.CoreWebView2() else {
                return;
            };
            let mut back = BOOL::default();
            let mut forward = BOOL::default();
            let _ = view.CanGoBack(&mut back);
            let _ = view.CanGoForward(&mut forward);
            let payload = json!({"id":self.key.1,"event":event,
                "url":event_url(&read_text(|p| view.Source(p))),
                "title":bounded(&read_text(|p| view.DocumentTitle(p)),500),
                "error":bounded(error,1000),"canGoBack":back.as_bool(),"canGoForward":forward.as_bool()});
            let script = format!("window.dispatchEvent(new CustomEvent('__aichat_desktop_event__',{{detail:{{event:'browser-surface',payload:{payload}}}}}));");
            if let Ok(owner) = self.owner.CoreWebView2() {
                let _ = owner.ExecuteScript(&HSTRING::from(script), None);
            }
        }
    }

    fn layout(&self) -> windows::core::Result<()> {
        let Some(controller) = self.controller() else {
            return Ok(());
        };
        unsafe {
            let mut owner = RECT::default();
            self.owner.Bounds(&mut owner)?;
            let mut dpi = 1.0;
            self.owner
                .cast::<ICoreWebView2Controller3>()?
                .RasterizationScale(&mut dpi)?;
            let rect = physical_bounds(
                &self.bounds.borrow(),
                [owner.left, owner.top, owner.right, owner.bottom],
                self.zoom.get(),
                dpi,
            );
            if let Some([left, top, right, bottom]) = rect {
                controller.SetBounds(RECT {
                    left,
                    top,
                    right,
                    bottom,
                })?;
                controller.SetZoomFactor(self.zoom.get())?;
                controller.NotifyParentWindowPositionChanged()?;
            }
            controller.SetIsVisible(self.visible.get() && rect.is_some())
        }
    }

    fn close(&self) {
        self.active.set(false);
        unsafe {
            if let Some(token) = self.owner_navigation.take() {
                if let Ok(owner) = self.owner.CoreWebView2() {
                    let _ = owner.remove_NavigationStarting(token);
                }
            }
            let controller = self.controller.borrow_mut().take();
            if let Some(controller) = controller {
                let _ = controller.SetIsVisible(false);
                if let Ok(view) = controller.CoreWebView2() {
                    let _ = view.Stop();
                }
                let _ = controller.Close();
            }
        }
    }
}

fn retire(surface: &Rc<Surface>) {
    SURFACES.with(|surfaces| {
        let mut surfaces = surfaces.borrow_mut();
        if surfaces
            .get(&surface.key)
            .is_some_and(|current| Rc::ptr_eq(current, surface))
        {
            surfaces.remove(&surface.key);
        }
    });
    surface.close();
}

/// Invalidates pending creations as well as live views. Late callbacks close
/// their new controller without navigating, emitting, or restoring the view.
pub fn reset(owner: &ICoreWebView2Controller) {
    let key = owner_key(owner);
    let removed = SURFACES.with(|surfaces| {
        let mut surfaces = surfaces.borrow_mut();
        let keys: Vec<_> = surfaces.keys().filter(|k| k.0 == key).cloned().collect();
        keys.into_iter()
            .filter_map(|key| surfaces.remove(&key))
            .collect::<Vec<_>>()
    });
    for surface in removed {
        surface.close();
    }
}

/// Main window destruction is already on the UI thread; its webview handle
/// can no longer be requested through Tauri's with_webview at that point.
pub fn reset_all() {
    let removed = SURFACES.with(|surfaces| {
        surfaces
            .borrow_mut()
            .drain()
            .map(|(_, surface)| surface)
            .collect::<Vec<_>>()
    });
    for surface in removed {
        surface.close();
    }
}

unsafe fn watch_owner(surface: &Rc<Surface>) -> windows::core::Result<()> {
    let weak = Rc::downgrade(surface);
    let mut token = 0;
    surface.owner.CoreWebView2()?.add_NavigationStarting(
        &NavigationStartingEventHandler::create(Box::new(move |_, _| {
            if let Some(surface) = weak.upgrade() {
                retire(&surface);
            }
            Ok(())
        })),
        &mut token,
    )?;
    surface.owner_navigation.set(Some(token));
    Ok(())
}

unsafe fn install(
    surface: &Rc<Surface>,
    controller: &ICoreWebView2Controller,
) -> windows::core::Result<()> {
    controller.SetIsVisible(false)?;
    controller
        .cast::<ICoreWebView2Controller4>()?
        .SetAllowExternalDrop(false)?;
    let view = controller.CoreWebView2()?;
    let settings = view.Settings()?;
    settings.SetIsWebMessageEnabled(false)?;
    settings.SetAreHostObjectsAllowed(false)?;
    settings.SetAreDevToolsEnabled(false)?;
    settings.SetAreDefaultContextMenusEnabled(false)?;
    settings.SetAreDefaultScriptDialogsEnabled(false)?;
    settings.SetIsStatusBarEnabled(false)?;
    settings.SetIsZoomControlEnabled(false)?;
    settings
        .cast::<ICoreWebView2Settings3>()?
        .SetAreBrowserAcceleratorKeysEnabled(false)?;
    let mut token = 0;
    let weak = Rc::downgrade(surface);
    view.add_NavigationStarting(
        &NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let Some(surface) = weak.upgrade().filter(|s| s.active.get()) else {
                return args.SetCancel(true);
            };
            let url = read_text(|p| args.Uri(p));
            if !crate::security::allowed_subframe_navigation(&url) {
                args.SetCancel(true)?;
                surface.emit(
                    "error",
                    "Only credential-free HTTP(S) browser navigation is supported",
                );
            } else {
                let mut navigation = 0;
                args.NavigationId(&mut navigation)?;
                surface.navigation.set(navigation);
                surface.emit("loading", "");
            }
            Ok(())
        })),
        &mut token,
    )?;
    view.add_FrameNavigationStarting(
        &NavigationStartingEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                args.SetCancel(!crate::security::allowed_subframe_navigation(&read_text(
                    |p| args.Uri(p),
                )))?;
            }
            Ok(())
        })),
        &mut token,
    )?;
    let weak = Rc::downgrade(surface);
    view.add_NavigationCompleted(
        &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
            let Some(surface) = weak.upgrade().filter(|s| s.active.get()) else {
                return Ok(());
            };
            if let Some(args) = args {
                let mut navigation = 0;
                args.NavigationId(&mut navigation)?;
                if navigation != surface.navigation.get() {
                    return Ok(());
                }
                let mut success = BOOL::default();
                args.IsSuccess(&mut success)?;
                if success.as_bool() {
                    surface.emit("loaded", "");
                } else {
                    let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                    args.WebErrorStatus(&mut status)?;
                    if status != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
                        surface.emit(
                            "error",
                            &format!("The browser could not load this page (error {})", status.0),
                        );
                    }
                }
            }
            Ok(())
        })),
        &mut token,
    )?;
    let weak = Rc::downgrade(surface);
    view.add_DocumentTitleChanged(
        &DocumentTitleChangedEventHandler::create(Box::new(move |_, _| {
            if let Some(surface) = weak.upgrade() {
                surface.emit("title", "");
            }
            Ok(())
        })),
        &mut token,
    )?;
    let weak = Rc::downgrade(surface);
    view.add_HistoryChanged(
        &HistoryChangedEventHandler::create(Box::new(move |_, _| {
            if let Some(surface) = weak.upgrade() {
                surface.emit("history", "");
            }
            Ok(())
        })),
        &mut token,
    )?;
    let weak = Rc::downgrade(surface);
    view.add_NewWindowRequested(
        &NewWindowRequestedEventHandler::create(Box::new(move |view, args| {
            if let Some(args) = args {
                args.SetHandled(true)?;
                if !weak.upgrade().is_some_and(|surface| surface.active.get()) {
                    return Ok(());
                }
                let url = read_text(|p| args.Uri(p));
                if crate::security::allowed_subframe_navigation(&url) {
                    if let Some(view) = view {
                        view.Navigate(&HSTRING::from(url))?;
                    }
                }
            }
            Ok(())
        })),
        &mut token,
    )?;
    view.add_PermissionRequested(
        &PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
            }
            Ok(())
        })),
        &mut token,
    )?;
    if let Ok(view) = view.cast::<ICoreWebView2_18>() {
        view.add_LaunchingExternalUriScheme(
            &LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetCancel(true)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    view.cast::<ICoreWebView2_4>()?.add_DownloadStarting(
        &DownloadStartingEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                args.SetCancel(true)?;
                args.SetHandled(true)?;
            }
            Ok(())
        })),
        &mut token,
    )?;
    let weak = Rc::downgrade(surface);
    view.add_ProcessFailed(
        &ProcessFailedEventHandler::create(Box::new(move |_, _| {
            if let Some(surface) = weak.upgrade() {
                surface.emit(
                    "error",
                    "The web page process stopped. Reload to try again.",
                );
            }
            Ok(())
        })),
        &mut token,
    )?;
    Ok(())
}

fn apply(surface: &Rc<Surface>, command: &Value, zoom: f64) -> Result<Value, String> {
    if let Some(bounds) = command.get("bounds") {
        *surface.bounds.borrow_mut() = bounds.clone();
    }
    surface.zoom.set(zoom);
    let op = command["op"].as_str().unwrap_or_default();
    if op == "hide" {
        surface.visible.set(false);
    } else if let Some(visible) = command["visible"].as_bool() {
        surface.visible.set(visible);
    } else if op == "open" {
        surface.visible.set(true);
    }
    surface
        .layout()
        .map_err(|_| "Unable to position the browser surface")?;
    let Some(controller) = surface.controller() else {
        return if matches!(op, "bounds" | "hide") {
            Ok(json!({}))
        } else {
            Err("The browser surface is still opening".into())
        };
    };
    unsafe {
        let view = controller
            .CoreWebView2()
            .map_err(|_| "Browser surface unavailable")?;
        let mut back = BOOL::default();
        let mut forward = BOOL::default();
        let _ = view.CanGoBack(&mut back);
        let _ = view.CanGoForward(&mut forward);
        let action = match op {
            "open" | "navigate" => {
                view.Navigate(&HSTRING::from(command["url"].as_str().unwrap_or_default()))
            }
            "back" if back.as_bool() => view.GoBack(),
            "forward" if forward.as_bool() => view.GoForward(),
            "reload" => view.Reload(),
            _ => Ok(()),
        };
        action.map_err(|_| "The browser could not perform this action")?;
        Ok(json!({"canGoBack":back.as_bool(),"canGoForward":forward.as_bool()}))
    }
}

pub fn dispatch(
    environment: &ICoreWebView2Environment,
    owner: &ICoreWebView2Controller,
    command: Value,
    zoom: f64,
    complete: Completion,
) {
    if let Err(error) = windows_contract(&command) {
        complete(Err(error));
        return;
    }
    let op = command["op"].as_str().unwrap_or_default();
    if matches!(op, "open" | "navigate")
        && crate::security::external_url(command["url"].as_str().unwrap_or_default()).is_none()
    {
        complete(Err(
            "Only credential-free HTTP(S) browser URLs are supported".into(),
        ));
        return;
    }
    let key = (
        owner_key(owner),
        command["id"].as_str().unwrap_or_default().to_owned(),
    );
    let existing = SURFACES.with(|surfaces| surfaces.borrow().get(&key).cloned());
    if op == "close" {
        if let Some(surface) = existing {
            retire(&surface);
        }
        complete(Ok(json!({})));
        return;
    }
    if let Some(surface) = existing {
        complete(apply(&surface, &command, zoom));
        return;
    }
    if op != "open" {
        complete(if matches!(op, "bounds" | "hide") {
            Ok(json!({}))
        } else {
            Err("Unknown browser surface".into())
        });
        return;
    }
    if SURFACES.with(|surfaces| surfaces.borrow().keys().filter(|k| k.0 == key.0).count()) >= 8 {
        complete(Err("Too many open browser surfaces".into()));
        return;
    }
    // Never fall back to the owner's default profile when private profiles are
    // unavailable. Older runtimes fail only this optional browser operation.
    let options = (|| -> windows::core::Result<_> {
        unsafe {
            let environment = environment.cast::<ICoreWebView2Environment10>()?;
            let options = environment.CreateCoreWebView2ControllerOptions()?;
            options.SetIsInPrivateModeEnabled(true)?;
            options.SetProfileName(&HSTRING::from(format!(
                "KeepworkBrowser-{}",
                uuid::Uuid::new_v4()
            )))?;
            let mut parent = HWND::default();
            owner.ParentWindow(&mut parent)?;
            Ok((environment, options, parent))
        }
    })();
    let Ok((environment, options, parent)) = options else {
        complete(Err("This WebView2 runtime cannot create an isolated browser. Update Microsoft Edge WebView2 Runtime and retry.".into()));
        return;
    };
    let surface = Rc::new(Surface {
        key: key.clone(),
        owner: owner.clone(),
        controller: RefCell::new(None),
        active: Cell::new(true),
        visible: Cell::new(command["visible"].as_bool().unwrap_or(true)),
        bounds: RefCell::new(command["bounds"].clone()),
        zoom: Cell::new(zoom),
        navigation: Cell::new(0),
        owner_navigation: Cell::new(None),
    });
    SURFACES.with(|surfaces| surfaces.borrow_mut().insert(key, surface.clone()));
    if unsafe { watch_owner(&surface) }.is_err() {
        retire(&surface);
        complete(Err(
            "Unable to bind the browser to its owner document".into()
        ));
        return;
    }
    let complete = Rc::new(RefCell::new(Some(complete)));
    let callback_complete = complete.clone();
    let created = surface.clone();
    let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
        move |status, controller| {
            let result = (|| -> Result<Value, String> {
                if !created.active.get() {
                    if let Some(controller) = controller {
                        unsafe {
                            let _ = controller.Close();
                        }
                    }
                    return Err("The browser surface was closed while opening".into());
                }
                status.map_err(|_| "Unable to create the isolated browser")?;
                let controller = controller.ok_or("WebView2 returned no browser controller")?;
                *created.controller.borrow_mut() = Some(controller.clone());
                unsafe { install(&created, &controller) }
                    .map_err(|_| "Unable to secure the isolated browser")?;
                // Apply the latest geometry/visibility after creation, so a hide or
                // resize delivered while opening cannot be undone by the callback.
                let result = apply(&created, &json!({"op":"bounds"}), created.zoom.get())?;
                unsafe {
                    controller.CoreWebView2().and_then(|view| {
                        view.Navigate(&HSTRING::from(command["url"].as_str().unwrap_or_default()))
                    })
                }
                .map_err(|_| "Unable to navigate the isolated browser")?;
                Ok(result)
            })();
            if result.is_err() {
                retire(&created);
            }
            if let Some(complete) = callback_complete.borrow_mut().take() {
                complete(result);
            }
            Ok(())
        },
    ));
    if unsafe { environment.CreateCoreWebView2ControllerWithOptions(parent, &options, &handler) }
        .is_err()
    {
        retire(&surface);
        if let Some(complete) = complete.borrow_mut().take() {
            complete(Err("Unable to start the isolated browser".into()));
        }
    }
}

#[cfg(feature = "dev-bins")]
pub fn inspect(owner: &ICoreWebView2Controller, id: &str) -> Option<ICoreWebView2Controller> {
    SURFACES.with(|surfaces| {
        surfaces
            .borrow()
            .get(&(owner_key(owner), id.into()))
            .and_then(|surface| surface.controller())
    })
}
