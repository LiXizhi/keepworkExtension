//! Native Windows fixture; all waits run outside WebView2 callbacks.
#[cfg(windows)]
mod fixture {
    use aichat_rust_lib::browser_surface_windows::{dispatch, inspect, reset};
    use serde_json::{json, Value};
    use std::{
        error::Error,
        sync::mpsc,
        time::{Duration, Instant},
    };
    use webview2_com::{
        take_pwstr, wait_with_pump, BrowserProcessExitedEventHandler,
        CreateCoreWebView2ControllerCompletedHandler,
        CreateCoreWebView2EnvironmentCompletedHandler, DownloadStartingEventHandler,
        ExecuteScriptCompletedHandler, Microsoft::Web::WebView2::Win32::*,
        NavigationCompletedEventHandler,
    };
    use windows::{
        core::{Interface, BOOL, HSTRING, PCWSTR, PWSTR},
        Win32::{
            Foundation::{HWND, RECT},
            System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        },
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    type Result<T> = std::result::Result<T, Box<dyn Error>>;

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    fn evaluate(webview: &ICoreWebView2, javascript: &str) -> Result<Value> {
        let (send, receive) = mpsc::channel();
        let completed = ExecuteScriptCompletedHandler::create(Box::new(move |status, result| {
            let result = status
                .map_err(|e| e.to_string())
                .and_then(|_| serde_json::from_str::<Value>(&result).map_err(|e| e.to_string()));
            let _ = send.send(result);
            Ok(())
        }));
        unsafe {
            webview.ExecuteScript(&HSTRING::from(javascript), &completed)?;
        }
        Ok(wait_with_pump(receive)?.map_err(std::io::Error::other)?)
    }

    fn pump(duration: Duration) {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            unsafe {
                let mut message = MSG::default();
                while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_until(webview: &ICoreWebView2, javascript: &str) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if evaluate(webview, javascript)? == json!(true) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Timed out waiting for {javascript}; events: {}",
                    evaluate(webview, "window.events")?
                )
                .into());
            }
            pump(Duration::from_millis(20));
        }
    }

    fn command(
        environment: &ICoreWebView2Environment,
        owner: &ICoreWebView2Controller,
        command: Value,
        zoom: f64,
    ) -> Result<Value> {
        let (send, receive) = mpsc::channel();
        dispatch(
            environment,
            owner,
            command,
            zoom,
            Box::new(move |result| {
                let _ = send.send(result);
            }),
        );
        Ok(wait_with_pump(receive)?.map_err(std::io::Error::other)?)
    }

    fn load_count(webview: &ICoreWebView2, id: &str) -> Result<u64> {
        Ok(evaluate(
            webview,
            &format!(
                "window.events.filter(e=>e.id==={}&&e.event==='loaded').length",
                json!(id)
            ),
        )?
        .as_u64()
        .unwrap())
    }

    fn wait_loaded(webview: &ICoreWebView2, id: &str, path: &str, previous: u64) -> Result<()> {
        wait_until(webview, &format!(
            "window.events.filter(e=>e.id==={}&&e.event==='loaded').length>{previous}&&window.events.filter(e=>e.id==={}&&e.event==='loaded').at(-1)?.url.endsWith({})",
            json!(id), json!(id), json!(path)))
    }

    fn navigate_owner(webview: &ICoreWebView2, url: &str) -> Result<()> {
        let (send, receive) = mpsc::channel();
        let expected_url = url.to_owned();
        let completed = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
            // A newly created controller can finish its initial about:blank
            // after this handler is attached. Await the requested document.
            if let Some(sender) = sender {
                let mut source = PWSTR::null();
                unsafe {
                    sender.Source(&mut source)?;
                }
                if take_pwstr(source) != expected_url {
                    return Ok(());
                }
            }
            let result = match args {
                Some(args) => unsafe {
                    let mut success = BOOL::default();
                    args.IsSuccess(&mut success)
                        .map(|_| success.as_bool())
                        .map_err(|e| e.to_string())
                },
                None => Err("Missing navigation result".into()),
            };
            let _ = send.send(result);
            Ok(())
        }));
        let mut token = 0;
        unsafe {
            webview.add_NavigationCompleted(&completed, &mut token)?;
            webview.Navigate(&HSTRING::from(url))?;
        }
        let loaded = wait_with_pump(receive)?.map_err(std::io::Error::other)?;
        unsafe {
            webview.remove_NavigationCompleted(token)?;
        }
        assert!(loaded, "owner fixture must load");
        Ok(())
    }

    fn assert_visible(controller: &ICoreWebView2Controller, expected: bool) -> Result<()> {
        let mut visible = BOOL::default();
        unsafe {
            controller.IsVisible(&mut visible)?;
        }
        assert_eq!(visible.as_bool(), expected);
        Ok(())
    }

    pub fn run() -> Result<()> {
        let mut arguments = std::env::args().skip(1);
        let base = arguments.next().ok_or("Expected loopback fixture URL")?;
        let profile = arguments
            .next()
            .ok_or("Expected isolated profile directory")?;
        assert!(base.starts_with("http://127.0.0.1:"));
        // A stuck COM operation must not leave the CI fixture process alive.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(75));
            eprintln!("Windows browser fixture exceeded 75 seconds");
            std::process::exit(1);
        });
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
            SetProcessDPIAware();
        }
        // Declared before all COM references so they are released first.
        let _apartment = ComApartment;
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "Keepwork browser fixture\0".encode_utf16().collect();
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                0,
                0,
                1100,
                850,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!hwnd.is_null(), "fixture HWND must exist");
        let (send, receive) = mpsc::channel();
        let completed = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
            move |status, environment| {
                let result = status
                    .map_err(|e| e.to_string())
                    .and_then(|_| environment.ok_or("Missing environment".to_string()));
                let _ = send.send(result);
                Ok(())
            },
        ));
        unsafe {
            CreateCoreWebView2EnvironmentWithOptions(
                PCWSTR::null(),
                &HSTRING::from(profile.as_str()),
                None,
                &completed,
            )?;
        }
        let environment = wait_with_pump(receive)?.map_err(std::io::Error::other)?;
        let (send, receive) = mpsc::channel();
        let completed = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
            move |status, controller| {
                let result = status
                    .map_err(|e| e.to_string())
                    .and_then(|_| controller.ok_or("Missing owner controller".to_string()));
                let _ = send.send(result);
                Ok(())
            },
        ));
        unsafe {
            environment.CreateCoreWebView2Controller(HWND(hwnd), &completed)?;
        }
        let owner = wait_with_pump(receive)?.map_err(std::io::Error::other)?;
        unsafe {
            owner.SetBounds(RECT {
                left: 0,
                top: 0,
                right: 1080,
                bottom: 800,
            })?;
            owner.SetIsVisible(true)?;
        }
        let main = unsafe { owner.CoreWebView2()? };
        navigate_owner(&main, &format!("{base}/main"))?;
        assert_eq!(
            evaluate(&main, "localStorage.getItem('owner-secret')")?,
            json!("private")
        );

        for url in [
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "https://user:password@example.com",
            "https://example.com/?token=secret",
        ] {
            assert!(command(&environment, &owner, json!({"op":"open","id":"invalid-browser","url":url,"bounds":{"x":0,"y":0,"width":300,"height":200}}), 1.0).is_err());
            assert!(inspect(&owner, "invalid-browser").is_none());
        }

        let id = "windows-browser-fixture";
        let bounds = json!({"x":17,"y":83,"width":420,"height":260});
        command(
            &environment,
            &owner,
            json!({"op":"open","id":id,"url":format!("{base}/deny"),"bounds":bounds}),
            1.0,
        )?;
        wait_loaded(&main, id, "/deny", 0)?;
        let surface = inspect(&owner, id).ok_or("Missing created native surface")?;
        let page = unsafe { surface.CoreWebView2()? };
        assert_eq!(evaluate(&page, "({path:location.pathname,title:document.title,bridge:typeof window.aichatDesktop,ipc:typeof window.__TAURI_INTERNALS__,cookie:document.cookie,storage:localStorage.getItem('owner-secret')})")?,
            json!({"path":"/deny","title":"Native fixture /deny","bridge":"undefined","ipc":"undefined","cookie":"","storage":null}));
        let settings = unsafe { page.Settings()? };
        let mut enabled = BOOL::default();
        unsafe {
            settings.IsWebMessageEnabled(&mut enabled)?;
        }
        assert!(
            !enabled.as_bool(),
            "external pages must have no WebView2 host message route"
        );
        unsafe {
            settings.AreHostObjectsAllowed(&mut enabled)?;
        }
        assert!(
            !enabled.as_bool(),
            "external pages must have no host object route"
        );
        assert_visible(&surface, true)?;

        for (op, path) in [
            ("navigate", "/csp"),
            ("back", "/deny"),
            ("forward", "/csp"),
            ("reload", "/csp"),
        ] {
            let previous = load_count(&main, id)?;
            let mut args = json!({"op":op,"id":id});
            if op == "navigate" {
                args["url"] = json!(format!("{base}{path}"));
            }
            command(&environment, &owner, args, 1.0)?;
            wait_loaded(&main, id, path, previous)?;
        }
        let previous = load_count(&main, id)?;
        evaluate(&page, "document.getElementById('next').click(); true")?;
        wait_loaded(&main, id, "/second", previous)?;
        assert!(
            inspect(&owner, id).is_some(),
            "popup navigation must retain its original surface"
        );

        let previous = load_count(&main, id)?;
        let errors = evaluate(
            &main,
            &format!(
                "events.filter(e=>e.id==={}&&e.event==='error').length",
                json!(id)
            ),
        )?
        .as_u64()
        .unwrap();
        command(
            &environment,
            &owner,
            json!({"op":"navigate","id":id,"url":format!("{base}/failure")}),
            1.0,
        )?;
        wait_until(
            &main,
            &format!(
                "events.filter(e=>e.id==={}&&e.event==='error').length>{errors}",
                json!(id)
            ),
        )?;
        pump(Duration::from_millis(150));
        assert_eq!(
            load_count(&main, id)?,
            previous,
            "failed navigation must not report a successful load"
        );
        assert_eq!(
            evaluate(
                &main,
                &format!(
                    "events.filter(e=>e.id==={}&&e.event==='error').at(-1).error.length>0",
                    json!(id)
                )
            )?,
            json!(true)
        );
        command(
            &environment,
            &owner,
            json!({"op":"navigate","id":id,"url":format!("{base}/csp")}),
            1.0,
        )?;
        wait_loaded(&main, id, "/csp", previous)?;

        // Observe the production handler's decisions after its registration;
        // this fixture handler never changes Cancel, Handled or the destination.
        let (send, receive) = mpsc::channel();
        let download = DownloadStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                let _ = send.send(Err("Missing download event".to_owned()));
                return Ok(());
            };
            let result = (|| -> windows::core::Result<_> {
                let mut cancel = BOOL::default();
                let mut handled = BOOL::default();
                let mut path = PWSTR::null();
                unsafe {
                    args.Cancel(&mut cancel)?;
                    args.Handled(&mut handled)?;
                    args.ResultFilePath(&mut path)?;
                }
                Ok((cancel.as_bool(), handled.as_bool(), take_pwstr(path)))
            })()
            .map_err(|error| error.to_string());
            let _ = send.send(result);
            Ok(())
        }));
        let view4: ICoreWebView2_4 = page.cast()?;
        let mut download_token = 0;
        unsafe {
            view4.add_DownloadStarting(&download, &mut download_token)?;
        }
        command(
            &environment,
            &owner,
            json!({"op":"navigate","id":id,"url":format!("{base}/download")}),
            1.0,
        )?;
        let (cancel, handled, destination) =
            wait_with_pump(receive)?.map_err(std::io::Error::other)?;
        unsafe {
            view4.remove_DownloadStarting(download_token)?;
        }
        assert!(cancel, "production must cancel the download");
        assert!(
            handled,
            "production must suppress the default download dialog"
        );
        let filename = format!(
            "{}.bin",
            std::path::Path::new(&profile)
                .file_name()
                .unwrap()
                .to_string_lossy()
        );
        assert!(
            std::path::Path::new(&destination).ends_with(&filename),
            "fixture must observe its unique attachment destination"
        );
        pump(Duration::from_millis(200));
        assert!(
            !std::path::Path::new(&destination).exists(),
            "cancelled downloads must not write a file"
        );

        // Check physical bounds against the actual system raster scale, keeping
        // application zoom separate from OS DPI. This is not a multi-monitor test.
        let controller3: ICoreWebView2Controller3 = owner.cast()?;
        let mut raster = 1.0;
        unsafe {
            controller3.RasterizationScale(&mut raster)?;
        }
        for zoom in [1.0, 1.25] {
            command(
                &environment,
                &owner,
                json!({"op":"bounds","id":id,"bounds":bounds}),
                zoom,
            )?;
            let mut actual = RECT::default();
            unsafe {
                surface.Bounds(&mut actual)?;
            }
            let pixel = |value: f64| (value * zoom * raster).round() as i32;
            assert_eq!(
                (actual.left, actual.top, actual.right, actual.bottom),
                (
                    pixel(17.0),
                    pixel(83.0),
                    pixel(437.0).min(1080),
                    pixel(343.0).min(800)
                ),
                "bounds must follow app zoom and OS DPI"
            );
            let mut actual_zoom = 0.0;
            unsafe {
                surface.ZoomFactor(&mut actual_zoom)?;
            }
            assert!(
                (actual_zoom - zoom).abs() < 0.0001,
                "browser CSS pixels must follow app zoom"
            );
        }

        command(&environment, &owner, json!({"op":"hide","id":id}), 1.0)?;
        assert_visible(&surface, false)?;
        command(
            &environment,
            &owner,
            json!({"op":"bounds","id":id,"bounds":bounds,"visible":true}),
            1.0,
        )?;
        assert_visible(&surface, true)?;
        command(&environment, &owner, json!({"op":"close","id":id}), 1.0)?;
        assert!(
            inspect(&owner, id).is_none(),
            "close removes native surface"
        );
        command(
            &environment,
            &owner,
            json!({"op":"open","id":"initially-hidden","url":format!("{base}/deny"),"bounds":bounds,"visible":false}),
            1.0,
        )?;
        assert_visible(
            &inspect(&owner, "initially-hidden").ok_or("Missing hidden surface")?,
            false,
        )?;
        command(
            &environment,
            &owner,
            json!({"op":"close","id":"initially-hidden"}),
            1.0,
        )?;
        command(
            &environment,
            &owner,
            json!({"op":"open","id":"reset-browser","url":format!("{base}/deny"),"bounds":bounds}),
            1.0,
        )?;
        reset(&owner);
        assert!(
            inspect(&owner, "reset-browser").is_none(),
            "reset removes native surface"
        );

        let (send, receive) = mpsc::channel();
        dispatch(
            &environment,
            &owner,
            json!({"op":"open","id":"pending-browser","url":format!("{base}/deny"),"bounds":bounds}),
            1.0,
            Box::new(move |result| {
                let _ = send.send(result);
            }),
        );
        reset(&owner);
        let _ = wait_with_pump(receive)?;
        pump(Duration::from_millis(150));
        assert!(
            inspect(&owner, "pending-browser").is_none(),
            "late controller creation cannot resurrect a reset surface"
        );

        command(
            &environment,
            &owner,
            json!({"op":"open","id":"owner-navigation","url":format!("{base}/deny"),"bounds":bounds}),
            1.0,
        )?;
        navigate_owner(&main, &format!("{base}/main?reload=live"))?;
        assert!(
            inspect(&owner, "owner-navigation").is_none(),
            "a new owner document must close its old surfaces"
        );
        let (send, receive) = mpsc::channel();
        dispatch(
            &environment,
            &owner,
            json!({"op":"open","id":"owner-pending","url":format!("{base}/deny"),"bounds":bounds}),
            1.0,
            Box::new(move |result| {
                let _ = send.send(result);
            }),
        );
        navigate_owner(&main, &format!("{base}/main?reload=pending"))?;
        let _ = wait_with_pump(receive)?;
        pump(Duration::from_millis(150));
        assert!(
            inspect(&owner, "owner-pending").is_none(),
            "a late controller cannot survive owner navigation"
        );
        assert_eq!(
            evaluate(&main, "localStorage.getItem('owner-secret')")?,
            json!("private")
        );
        // Close is asynchronous: wait for the fixture's browser to release its
        // user data folder before Node removes it. Keep the environment alive
        // while pumping; releasing it early would also remove the exit event.
        let environment5: ICoreWebView2Environment5 = environment.cast()?;
        let mut browser_pid = 0;
        unsafe {
            main.BrowserProcessId(&mut browser_pid)?;
        }
        let (send, receive) = mpsc::channel();
        let exited = BrowserProcessExitedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                let _ = send.send(Err("Missing browser exit event".to_owned()));
                return Ok(());
            };
            let result = (|| -> windows::core::Result<_> {
                let mut pid = 0;
                let mut kind = COREWEBVIEW2_BROWSER_PROCESS_EXIT_KIND_NORMAL;
                unsafe {
                    args.BrowserProcessId(&mut pid)?;
                    args.BrowserProcessExitKind(&mut kind)?;
                }
                Ok((pid, kind))
            })()
            .map_err(|error| error.to_string());
            let _ = send.send(result);
            Ok(())
        }));
        let mut exit_token = 0;
        unsafe {
            environment5.add_BrowserProcessExited(&exited, &mut exit_token)?;
        }
        reset(&owner);
        unsafe {
            owner.Close()?;
            DestroyWindow(hwnd);
        }
        drop(controller3);
        drop(view4);
        drop(settings);
        drop(page);
        drop(surface);
        drop(main);
        drop(owner);
        let deadline = Instant::now() + Duration::from_secs(15);
        let exit_result = loop {
            match receive.try_recv() {
                Ok(result) => break result.map_err(std::io::Error::other),
                Err(mpsc::TryRecvError::Disconnected) => {
                    break Err(std::io::Error::other("Browser exit handler disconnected"));
                }
                Err(mpsc::TryRecvError::Empty) if Instant::now() >= deadline => {
                    break Err(std::io::Error::other(
                        "Timed out waiting for the fixture browser to release its profile",
                    ));
                }
                Err(mpsc::TryRecvError::Empty) => pump(Duration::from_millis(20)),
            }
        };
        unsafe {
            environment5.remove_BrowserProcessExited(exit_token)?;
        }
        let (exited_pid, exit_kind) = exit_result?;
        assert_eq!(exited_pid, browser_pid, "only the fixture browser may exit");
        assert_eq!(
            exit_kind, COREWEBVIEW2_BROWSER_PROCESS_EXIT_KIND_NORMAL,
            "the fixture browser must shut down normally"
        );
        drop(environment5);
        drop(environment);
        println!("native Windows browser surface tests passed (raster scale {raster}); browser process exited");
        Ok(())
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = fixture::run() {
        eprintln!("Windows browser surface fixture failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    println!("browser-surface-smoke: SKIP (native WebView2 fixture requires Windows)");
    std::process::exit(77);
}
