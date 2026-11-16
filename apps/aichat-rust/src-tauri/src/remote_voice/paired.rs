//! Read-only pairing evidence. This probe never scans, connects or starts input.
use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct PairedRemote {
    pub name: String,
    pub identifier: Option<String>,
    pub hardware_key: Option<String>,
    pub paired: bool,
    pub connected: bool,
    pub hardware_supported: bool,
}

pub(super) fn known_remote_name(name: &str) -> bool {
    let name = name.trim().to_lowercase();
    if [
        "headphone",
        "earphone",
        "earbud",
        "keyboard",
        "mouse",
        "耳机",
        "键盘",
        "鼠标",
    ]
    .iter()
    .any(|part| name.contains(part))
    {
        return false;
    }
    ((name.contains("xiaomi") || name.contains("小米"))
        && (name.contains("remote") || name.contains("遥控器")))
        || ["mi rc", "rc001", "rc003"].iter().any(|prefix| {
            name == *prefix
                || name.strip_prefix(prefix).is_some_and(|suffix| {
                    suffix.starts_with(' ') || suffix.starts_with('-') || suffix.starts_with('_')
                })
        })
}

pub(super) fn canonical_mac(value: &str) -> Option<String> {
    let value = value.trim();
    let compact: String = value
        .chars()
        .filter(|ch| *ch != ':' && *ch != '-')
        .collect();
    if compact.len() != 12 || !compact.bytes().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    let compact = compact.to_uppercase();
    if compact == "000000000000" || compact == "FFFFFFFFFFFF" {
        return None;
    }
    Some(
        (0..6)
            .map(|i| &compact[i * 2..i * 2 + 2])
            .collect::<Vec<_>>()
            .join(":"),
    )
}

fn canonical_identifier(value: &str) -> Option<String> {
    canonical_mac(value).or_else(|| {
        uuid::Uuid::parse_str(value.trim())
            .ok()
            .map(|id| id.to_string())
    })
}

pub(super) fn select_paired(
    candidates: Vec<PairedRemote>,
    config_device: &str,
) -> Result<Option<String>, String> {
    if candidates.len() > 256 {
        return Err("已配对设备列表过长，请在设置中指定遥控器设备 ID。".into());
    }
    let explicit = if config_device.trim().is_empty() {
        None
    } else {
        Some(
            canonical_identifier(config_device)
                .ok_or("遥控器设备 ID 格式无效，请检查蓝牙地址或 CoreBluetooth UUID。")?,
        )
    };
    let mut unique: Vec<PairedRemote> = Vec::new();
    for mut candidate in candidates {
        if !(candidate.paired || candidate.connected)
            || !(candidate.hardware_supported || known_remote_name(&candidate.name))
        {
            continue;
        }
        candidate.identifier = candidate
            .identifier
            .as_deref()
            .and_then(canonical_identifier);
        candidate.hardware_key = candidate
            .hardware_key
            .filter(|key| !key.trim().is_empty() && key.len() <= 512);
        let matching = unique.iter().position(|previous| {
            (candidate.identifier.is_some() && previous.identifier == candidate.identifier)
                || (candidate.hardware_key.is_some()
                    && previous.hardware_key == candidate.hardware_key)
        });
        if let Some(index) = matching {
            let previous = &mut unique[index];
            if previous.identifier.is_some()
                && candidate.identifier.is_some()
                && previous.identifier != candidate.identifier
            {
                return Err("系统配对记录的设备身份不一致，请检查遥控器配对后手动开启。".into());
            }
            if previous.identifier.is_none() {
                previous.identifier = candidate.identifier;
            }
            previous.paired |= candidate.paired;
            previous.connected |= candidate.connected;
            previous.hardware_supported |= candidate.hardware_supported;
        } else {
            unique.push(candidate);
        }
    }
    if let Some(explicit) = explicit {
        if let Some(candidate) = unique
            .iter()
            .find(|candidate| candidate.identifier.as_ref() == Some(&explicit))
        {
            return Ok(candidate.identifier.clone());
        }
        if unique
            .iter()
            .any(|candidate| candidate.identifier.is_none())
        {
            return Err("系统已发现配对遥控器，但无法验证它与保存的设备 ID 对应；请手动开启，或清空设备 ID 后使用自动查找。".into());
        }
        return Ok(None); // Never substitute a different paired remote.
    }
    if unique.len() > 1 {
        // Several remotes may stay paired while only one is awake. Only a
        // connected peripheral can be retrieved, so it is the unambiguous target.
        let mut connected: Vec<_> = unique.iter().filter(|candidate| candidate.connected).cloned().collect();
        match connected.len() {
            0 => return Err(MULTIPLE_IDLE.into()),
            1 => unique = vec![connected.pop().unwrap()],
            _ => return Err("发现多只已连接的遥控器，请在设置中指定要使用的设备 ID 后手动开启。".into()),
        }
    }
    Ok(unique
        .pop()
        .map(|candidate| candidate.identifier.unwrap_or_default()))
}

/// Several paired remotes are asleep. This is not a configuration error: the
/// first remote woken by a key press becomes the only connected candidate.
pub(super) const MULTIPLE_IDLE: &str = "发现多只已配对遥控器，按一下要使用的遥控器即可自动连接。";

/// Waiting for one of several idle remotes keeps polling instead of pausing automation.
fn select_or_wait(candidates: Vec<PairedRemote>, config_device: &str) -> Result<Result<Option<String>, Probe>, String> {
    match select_paired(candidates, config_device) {
        Err(message) if message == MULTIPLE_IDLE => Ok(Err(Probe::Retry(message))),
        selected => selected.map(Ok),
    }
}

#[derive(Debug, PartialEq)]
pub(super) enum Probe {
    Waiting,
    Retry(String),
    NeedsPermission(&'static str),
    NeedsBluetoothPermission,
    Available(String),
}

#[derive(Debug)]
enum InventoryError {
    Temporary(String),
    Blocked(String),
}
impl InventoryError {
    fn probe(self) -> Result<Probe, String> {
        match self {
            Self::Temporary(reason) => Ok(Probe::Retry(reason)),
            Self::Blocked(reason) => Err(reason),
        }
    }
}
impl From<&str> for InventoryError {
    fn from(reason: &str) -> Self {
        Self::Blocked(reason.into())
    }
}

pub(super) async fn paired_remote(config_device: &str) -> Result<Probe, String> {
    #[cfg(target_os = "macos")]
    {
        let inventory = match platform::inventory().await {
            Ok(inventory) => inventory,
            Err(error) => return error.probe(),
        };
        probe_macos(inventory.candidates, config_device, inventory.bluetooth_allowed,
            inventory.bluetooth_not_determined, super::ble::saved_remote(config_device.trim()),
            super::native_input::missing_permission).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let candidates = match platform::candidates(config_device).await {
            Ok(candidates) => candidates,
            Err(error) => return error.probe(),
        };
        Ok(match select_or_wait(candidates, config_device)? {
            Ok(device) => device.map_or(Probe::Waiting, Probe::Available),
            Err(probe) => probe,
        })
    }
}

#[cfg(target_os = "macos")]
async fn probe_macos(
    candidates: Vec<PairedRemote>, config_device: &str, bluetooth_allowed: bool, bluetooth_not_determined: bool,
    saved_remote: impl std::future::Future<Output = Result<Probe, String>>,
    input_permission: impl FnOnce() -> Option<&'static str>,
) -> Result<Probe, String> {
    if !config_device.trim().is_empty() {
        uuid::Uuid::parse_str(config_device.trim())
            .map_err(|_| "macOS 蓝牙设备 ID 必须是系统 CoreBluetooth UUID。")?;
        if bluetooth_allowed {
            // Pairing addresses cannot prove a CoreBluetooth UUID. Retrieve
            // exactly the saved, system-known target without guessing a MAC.
            return match saved_remote.await? {
                Probe::Available(device) => Ok(input_admission(device, input_permission)),
                probe => Ok(probe),
            };
        }
    }
    admit_macos(candidates, config_device, bluetooth_allowed, bluetooth_not_determined, input_permission)
}

#[cfg(target_os = "macos")]
fn admit_macos(
    candidates: Vec<PairedRemote>,
    config_device: &str,
    bluetooth_allowed: bool,
    bluetooth_not_determined: bool,
    input_permission: impl FnOnce() -> Option<&'static str>,
) -> Result<Probe, String> {
    let device = match select_or_wait(candidates, if bluetooth_allowed { config_device } else { "" })? {
        Ok(device) => device,
        Err(probe) => return Ok(probe),
    };
    let Some(device) = device else {
        return Ok(Probe::Waiting);
    };
    if !bluetooth_allowed {
        if bluetooth_not_determined { return Ok(Probe::NeedsBluetoothPermission); }
        return Ok(Probe::NeedsPermission("已检测到小米遥控器。请点「启动语音输入」，按系统提示依次授权。若曾拒绝蓝牙访问，请到系统设置 → 隐私与安全性 → 蓝牙中授权。通过编辑器或终端启动时，系统可能显示该应用的名称。"));
    }
    Ok(input_admission(device, input_permission))
}

#[cfg(target_os = "macos")]
fn input_admission(device: String, input_permission: impl FnOnce() -> Option<&'static str>) -> Probe {
    match input_permission() {
        Some(reason) => Probe::NeedsPermission(reason),
        None => Probe::Available(device),
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{InventoryError, PairedRemote};
    use serde::Deserialize;
    use std::ffi::{c_char, CStr};
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct Inventory {
        #[serde(default)]
        pub candidates: Vec<PairedRemote>,
        #[serde(default)]
        pub bluetooth_allowed: bool,
        #[serde(default)]
        pub bluetooth_not_determined: bool,
        error: Option<String>,
        #[serde(default)]
        retry: bool,
    }
    #[link(name = "IOKit", kind = "framework")]
    #[link(name = "IOBluetooth", kind = "framework")]
    #[link(name = "CoreBluetooth", kind = "framework")]
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {
        fn keepwork_paired_remotes_json() -> *mut c_char;
        fn keepwork_paired_remotes_free(value: *mut c_char);
    }
    pub(super) async fn inventory() -> Result<Inventory, InventoryError> {
        static WORKER: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
        run_inventory_worker(&WORKER, || {
            let raw = unsafe { keepwork_paired_remotes_json() };
            if raw.is_null() {
                return Err(InventoryError::Temporary("暂时无法读取系统配对记录，将自动重试。".into()));
            }
            let bytes = unsafe { CStr::from_ptr(raw) }.to_bytes();
            let result = if bytes.len() <= 131_072 {
                serde_json::from_slice::<Inventory>(bytes)
                    .map_err(|_| InventoryError::Blocked("系统配对记录格式不可用，请手动开启语音输入。".into()))
            } else {
                Err("系统配对记录过长，请手动开启语音输入。".into())
            };
            unsafe {
                keepwork_paired_remotes_free(raw);
            }
            let inventory = result?;
            if let Some(error) = inventory.error {
                return Err(if inventory.retry {
                    InventoryError::Temporary(error)
                } else {
                    InventoryError::Blocked(error)
                });
            }
            Ok(inventory)
        })
        .await
    }

    async fn run_inventory_worker<T: Send + 'static>(
        worker: &'static tokio::sync::Semaphore,
        read: impl FnOnce() -> Result<T, InventoryError> + Send + 'static,
    ) -> Result<T, InventoryError> {
        // Cancelling a waiter cannot interrupt an IOBluetooth call. Keep the permit
        // inside the native worker and let later probes retry until the OS returns.
        let permit = worker.try_acquire().map_err(|_| {
            InventoryError::Temporary("系统配对查询尚未完成，将自动重试。".into())
        })?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            read()
        })
        .await
        .map_err(|_| InventoryError::Temporary("系统配对记录查询暂时中断，将自动重试。".into()))?
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[tokio::test]
        async fn interrupted_probe_bounds_workers_until_the_os_call_returns() {
            static WORKER: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
            let (started, ready) = tokio::sync::oneshot::channel();
            let (finish, release) = std::sync::mpsc::channel();
            let task = tokio::spawn(run_inventory_worker(&WORKER, move || {
                started.send(()).unwrap();
                release.recv().unwrap();
                Ok(())
            }));
            ready.await.unwrap();
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            let retry = run_inventory_worker::<()>(&WORKER, || panic!("spawned a second worker")).await;
            assert!(matches!(retry, Err(InventoryError::Temporary(_))));
            finish.send(()).unwrap();
            let permit = tokio::time::timeout(std::time::Duration::from_secs(2), WORKER.acquire()).await.unwrap().unwrap();
            drop(permit);
            assert_eq!(run_inventory_worker(&WORKER, || Ok(23)).await.unwrap(), 23);
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{canonical_mac, known_remote_name, InventoryError, PairedRemote};
    use windows::core::{Interface, HSTRING};
    use windows::Devices::{Bluetooth::BluetoothLEDevice, Enumeration::DeviceInformation};
    use windows::Foundation::IPropertyValue;
    fn error(error: windows::core::Error) -> InventoryError {
        if error.code().0 as u32 == 0x80070005 || error.code().0 as u32 == 0x80070522 {
            "系统拒绝读取已配对蓝牙设备，请检查蓝牙隐私权限后手动开启语音输入。".into()
        } else {
            InventoryError::Temporary("系统蓝牙设备列表暂不可用，将自动重试。".into())
        }
    }
    pub(super) async fn candidates(config: &str) -> Result<Vec<PairedRemote>, InventoryError> {
        let requested = if config.trim().is_empty() {
            None
        } else {
            Some(canonical_mac(config).ok_or("Windows 遥控器设备 ID 必须是有效的蓝牙 MAC 地址。")?)
        };
        let mut selector = BluetoothLEDevice::GetDeviceSelectorFromPairingState(true)
            .map_err(error)?
            .to_string();
        if let Some(address) = &requested {
            let value = u64::from_str_radix(&address.replace(':', ""), 16)
                .map_err(|_| "蓝牙地址格式无效。")?;
            let address_selector =
                BluetoothLEDevice::GetDeviceSelectorFromBluetoothAddress(value).map_err(error)?;
            selector = format!("({selector}) AND ({address_selector})");
        }
        let query = {
            // IIterable is not Send. Release it before suspending so the
            // paired-device monitor can run on Tauri's multithreaded runtime.
            let properties: windows_collections::IIterable<HSTRING> = vec![
                HSTRING::from("System.Devices.Aep.DeviceAddress"),
                HSTRING::from("System.Devices.Aep.IsConnected"),
            ]
            .into();
            DeviceInformation::FindAllAsyncAqsFilterAndAdditionalProperties(
                &HSTRING::from(selector),
                &properties,
            )
            .map_err(error)?
        };
        let devices = query.await.map_err(error)?;
        let count = devices.Size().map_err(error)?;
        if count > 256 {
            return Err("已配对设备列表过长，请指定遥控器设备 ID。".into());
        }
        let mut candidates = Vec::new();
        for index in 0..count {
            let device = devices.GetAt(index).map_err(error)?;
            let name = device.Name().map_err(error)?.to_string();
            if !known_remote_name(&name) {
                continue;
            }
            if !device.Pairing().map_err(error)?.IsPaired().map_err(error)? {
                continue;
            }
            let properties = device.Properties().map_err(error)?;
            let address = properties
                .Lookup(&HSTRING::from("System.Devices.Aep.DeviceAddress"))
                .ok()
                .and_then(|value| value.cast::<IPropertyValue>().ok())
                .and_then(|value| value.GetString().ok())
                .and_then(|value| canonical_mac(&value.to_string()));
            if address.is_some() && requested.is_some() && address != requested {
                return Err("系统配对记录与指定蓝牙地址不一致，请手动检查设备设置。".into());
            }
            let identifier = address.or_else(|| requested.clone());
            let connected = properties
                .Lookup(&HSTRING::from("System.Devices.Aep.IsConnected"))
                .ok()
                .and_then(|value| value.cast::<IPropertyValue>().ok())
                .and_then(|value| value.GetBoolean().ok())
                .unwrap_or(false);
            let hardware_key = if let Some(address) = &identifier {
                Some(format!("mac:{address}"))
            } else {
                Some(format!("windows:{}", device.Id().map_err(error)?))
            };
            candidates.push(PairedRemote {
                name,
                identifier,
                hardware_key,
                paired: true,
                connected,
                hardware_supported: false,
            });
        }
        Ok(candidates)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::{InventoryError, PairedRemote};
    pub(super) async fn candidates(_config: &str) -> Result<Vec<PairedRemote>, InventoryError> {
        Err("当前平台不支持只读查询已配对遥控器，请手动开启语音输入。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inventory_io_retries_but_policy_or_data_errors_require_user_action() {
        let reason = String::from("native inventory unavailable");
        assert_eq!(InventoryError::Temporary(reason.clone()).probe(), Ok(Probe::Retry(reason.clone())));
        assert_eq!(InventoryError::Blocked(reason.clone()).probe(), Err(reason));
    }

    #[test]
    fn paired_probe_future_can_move_between_runtime_threads() {
        fn assert_send<T: Send>(_: T) {}
        // Constructing the future does not query Bluetooth or start input.
        assert_send(paired_remote(""));
    }
    fn remote(id: Option<&str>, hardware: Option<&str>) -> PairedRemote {
        PairedRemote {
            name: "Xiaomi Bluetooth Remote 2 Pro".into(),
            identifier: id.map(str::to_string),
            hardware_key: hardware.map(str::to_string),
            paired: true,
            ..Default::default()
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn only_a_unique_eligible_remote_needs_setup_and_external_grants_resume_admission() {
        let device = remote(None, Some("hid:one"));
        let skip = || panic!("input preflight precedes device selection or Bluetooth consent");
        assert_eq!(
            admit_macos(vec![], "", false, true, skip).unwrap(),
            Probe::Waiting
        );
        assert_eq!(
            admit_macos(vec![device.clone(), remote(None, Some("hid:two"))], "", false, true, skip).unwrap(),
            Probe::Retry(MULTIPLE_IDLE.into())
        );
        assert!(matches!(
            admit_macos(vec![device.clone()], "", false, false, skip),
            Ok(Probe::NeedsPermission(_))
        ));
        assert_eq!(
            admit_macos(vec![device.clone()], "", false, true, skip).unwrap(),
            Probe::NeedsBluetoothPermission
        );
        assert_eq!(
            admit_macos(vec![device.clone()], "12345678-1234-5678-1234-567812345678", false, true, skip).unwrap(),
            Probe::NeedsBluetoothPermission
        );
        assert_eq!(
            admit_macos(vec![device.clone()], "", true, false, || Some("Input Monitoring")).unwrap(),
            Probe::NeedsPermission("Input Monitoring")
        );
        assert_eq!(
            admit_macos(vec![device], "", true, false, || None).unwrap(),
            Probe::Available(String::new())
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn bluetooth_consent_is_followed_by_automatic_admission_without_another_start() {
        let inventory = vec![remote(None, Some("hid:one"))];
        let no_lookup = || async { panic!("an unspecified target cannot retrieve a UUID") };
        let no_input = || panic!("undecided Bluetooth must precede input preflight");
        assert_eq!(probe_macos(inventory.clone(), "", false, true, no_lookup(), no_input).await.unwrap(), Probe::NeedsBluetoothPermission);
        assert!(matches!(probe_macos(inventory.clone(), "", false, false, no_lookup(), no_input).await.unwrap(), Probe::NeedsPermission(_)));
        assert_eq!(probe_macos(inventory.clone(), "", true, false, no_lookup(), || Some("Input Monitoring")).await.unwrap(), Probe::NeedsPermission("Input Monitoring"));
        assert_eq!(probe_macos(inventory, "", true, false, no_lookup(), || None).await.unwrap(), Probe::Available(String::new()));
        assert_eq!(probe_macos(vec![], "", false, true, no_lookup(), no_input).await.unwrap(), Probe::Waiting);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn explicit_uuid_uses_authorized_system_retrieval_instead_of_mac_pairing_guesses() {
        let uuid = "12345678-1234-5678-1234-567812345678";
        let mac_only = vec![remote(None, Some("mac:AA:BB:CC:DD:EE:FF"))];
        assert_eq!(probe_macos(mac_only.clone(), uuid, true, false, async { Ok(Probe::Available(uuid.into())) }, || None).await.unwrap(), Probe::Available(uuid.into()));
        assert_eq!(probe_macos(mac_only.clone(), uuid, true, false, async { Ok(Probe::Waiting) }, || panic!("no target, no input preflight")).await.unwrap(), Probe::Waiting);
        assert_eq!(probe_macos(mac_only.clone(), uuid, true, false, async { Ok(Probe::Retry("not known yet".into())) }, || None).await.unwrap(), Probe::Retry("not known yet".into()));
        assert_eq!(probe_macos(mac_only.clone(), uuid, false, true, async { panic!("unauthorized retrieval") }, || None).await.unwrap(), Probe::NeedsBluetoothPermission);
        assert!(probe_macos(mac_only, "AA:BB:CC:DD:EE:FF", true, false, async { panic!("MAC cannot retrieve a UUID") }, || None).await.is_err());
    }

    #[test]
    fn names_exclude_ordinary_bluetooth_keyboards_and_headphones() {
        for name in [
            "MI RC",
            "MI RC-003",
            "RC001",
            "Xiaomi Bluetooth Remote 2 Pro",
            "小米蓝牙语音遥控器",
        ] {
            assert!(known_remote_name(name), "{name}");
        }
        for name in [
            "Xiaomi",
            "Xiaomi Keyboard",
            "MI RC Headphones",
            "Bluetooth Remote",
            "小米耳机",
            "RC003 Keyboard",
            "my MI RC device",
        ] {
            assert!(!known_remote_name(name), "{name}");
        }
    }
    #[test]
    fn only_paired_or_known_connected_remotes_are_eligible() {
        assert_eq!(select_paired(vec![], "").unwrap(), None);
        let mut unpaired = remote(Some("AA:BB:CC:DD:EE:01"), None);
        unpaired.paired = false;
        assert_eq!(select_paired(vec![unpaired.clone()], "").unwrap(), None);
        unpaired.connected = true;
        unpaired.name = "renamed device".into();
        assert_eq!(select_paired(vec![unpaired.clone()], "").unwrap(), None);
        unpaired.hardware_supported = true;
        assert_eq!(
            select_paired(vec![unpaired], "").unwrap(),
            Some("AA:BB:CC:DD:EE:01".into())
        );
    }
    #[test]
    fn unique_evidence_works_but_same_name_is_not_a_device_identity() {
        assert_eq!(
            select_paired(vec![remote(None, Some("hid:one"))], "").unwrap(),
            Some(String::new())
        );
        assert!(select_paired(
            vec![remote(None, Some("hid:one")), remote(None, Some("hid:two"))],
            ""
        )
        .is_err());
        assert!(select_paired(vec![remote(None, None), remote(None, None)], "").is_err());
        assert_eq!(
            select_paired(
                vec![
                    remote(None, Some("mac:AA:BB:CC:DD:EE:01")),
                    remote(Some("aa-bb-cc-dd-ee-01"), Some("mac:AA:BB:CC:DD:EE:01"))
                ],
                ""
            )
            .unwrap(),
            Some("AA:BB:CC:DD:EE:01".into())
        );
    }
    #[test]
    fn the_single_connected_remote_wins_over_other_idle_paired_remotes() {
        // macOS: classic inventory and the HID registry describe the same awake remote.
        let mut awake_hid = remote(None, Some("mac:E8:55:40:EE:4D:D9"));
        awake_hid.paired = false;
        awake_hid.connected = true;
        awake_hid.hardware_supported = true;
        let mut awake_paired = remote(None, Some("mac:E8:55:40:EE:4D:D9"));
        awake_paired.connected = true;
        let idle = remote(None, Some("mac:E8:55:40:E1:39:03"));
        assert_eq!(
            select_paired(vec![awake_paired.clone(), idle.clone(), awake_hid.clone()], "").unwrap(),
            Some(String::new())
        );
        let mut awake_mac = remote(Some("AA:BB:CC:DD:EE:01"), None);
        awake_mac.connected = true;
        assert_eq!(
            select_paired(vec![remote(Some("AA:BB:CC:DD:EE:02"), None), awake_mac.clone()], "").unwrap(),
            Some("AA:BB:CC:DD:EE:01".into())
        );
        let mut second = remote(Some("AA:BB:CC:DD:EE:02"), None);
        second.connected = true;
        assert!(select_paired(vec![awake_mac, second], "").unwrap_err().contains("已连接"));
        // Idle remotes keep the monitor polling until one key press wakes a target.
        assert_eq!(select_paired(vec![idle.clone(), remote(None, Some("mac:AA:BB:CC:DD:EE:02"))], "").unwrap_err(), MULTIPLE_IDLE);
        assert_eq!(
            select_or_wait(vec![idle, remote(None, Some("mac:AA:BB:CC:DD:EE:02"))], "").unwrap(),
            Err(Probe::Retry(MULTIPLE_IDLE.into()))
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn startup_admits_the_connected_remote_when_another_is_paired() {
        let mut awake = remote(None, Some("mac:E8:55:40:EE:4D:D9"));
        awake.connected = true;
        let idle = remote(None, Some("mac:E8:55:40:E1:39:03"));
        assert_eq!(admit_macos(vec![awake, idle], "", true, false, || None).unwrap(), Probe::Available(String::new()));
    }
    #[test]
    fn explicit_id_selects_only_a_verified_pair_and_never_another_remote() {
        let candidates = vec![
            remote(Some("AA:BB:CC:DD:EE:01"), None),
            remote(Some("AA:BB:CC:DD:EE:02"), None),
        ];
        assert!(select_paired(candidates.clone(), "").is_err());
        assert_eq!(
            select_paired(candidates.clone(), "aa-bb-cc-dd-ee-02").unwrap(),
            Some("AA:BB:CC:DD:EE:02".into())
        );
        assert_eq!(
            select_paired(candidates, "AA:BB:CC:DD:EE:03").unwrap(),
            None
        );
    }
    #[test]
    fn mac_address_evidence_does_not_verify_an_unrelated_corebluetooth_uuid() {
        let candidates = vec![remote(None, Some("mac:AA:BB:CC:DD:EE:01"))];
        assert!(
            select_paired(candidates, "cfa50000-0000-4000-8000-000000000001")
                .unwrap_err()
                .contains("无法验证")
        );
    }
    #[test]
    fn conflicting_ids_and_invalid_addresses_do_not_start_automatically() {
        assert!(select_paired(
            vec![
                remote(Some("AA:BB:CC:DD:EE:01"), Some("shared")),
                remote(Some("AA:BB:CC:DD:EE:02"), Some("shared"))
            ],
            ""
        )
        .is_err());
        assert!(select_paired(vec![], "not-a-bluetooth-id").is_err());
        assert_eq!(canonical_mac("000000000000"), None);
        assert_eq!(canonical_mac("FFFFFFFFFFFF"), None);
    }
}
