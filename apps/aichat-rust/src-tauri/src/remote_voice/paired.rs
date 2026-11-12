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
        return Err("发现多只已配对遥控器，请在设置中指定要使用的设备 ID 后手动开启。".into());
    }
    Ok(unique
        .pop()
        .map(|candidate| candidate.identifier.unwrap_or_default()))
}

pub(super) async fn paired_remote(config_device: &str) -> Result<Option<String>, String> {
    let candidates = platform::candidates(config_device).await?;
    select_paired(candidates, config_device)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::PairedRemote;
    use serde::Deserialize;
    use std::ffi::{c_char, CStr};
    #[derive(Deserialize)]
    struct Inventory {
        #[serde(default)]
        candidates: Vec<PairedRemote>,
        error: Option<String>,
    }
    #[link(name = "IOKit", kind = "framework")]
    #[link(name = "IOBluetooth", kind = "framework")]
    #[link(name = "CoreBluetooth", kind = "framework")]
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {
        fn keepwork_paired_remotes_json() -> *mut c_char;
        fn keepwork_paired_remotes_free(value: *mut c_char);
    }
    pub async fn candidates(_config: &str) -> Result<Vec<PairedRemote>, String> {
        tokio::task::spawn_blocking(|| {
            let raw = unsafe { keepwork_paired_remotes_json() };
            if raw.is_null() {
                return Err("无法读取已配对遥控器，请手动开启语音输入。".into());
            }
            let bytes = unsafe { CStr::from_ptr(raw) }.to_bytes();
            let result = if bytes.len() <= 131_072 {
                serde_json::from_slice::<Inventory>(bytes)
                    .map_err(|_| "系统配对记录格式不可用，请手动开启语音输入。".to_string())
            } else {
                Err("系统配对记录过长，请手动开启语音输入。".into())
            };
            unsafe {
                keepwork_paired_remotes_free(raw);
            }
            let inventory = result?;
            if let Some(error) = inventory.error {
                return Err(error);
            }
            Ok(inventory.candidates)
        })
        .await
        .map_err(|_| "读取已配对遥控器的任务未完成，请手动开启。".to_string())?
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{canonical_mac, known_remote_name, PairedRemote};
    use windows::core::{Interface, HSTRING};
    use windows::Devices::{Bluetooth::BluetoothLEDevice, Enumeration::DeviceInformation};
    use windows::Foundation::IPropertyValue;
    fn error(error: windows::core::Error) -> String {
        if error.code().0 as u32 == 0x80070005 || error.code().0 as u32 == 0x80070522 {
            "系统拒绝读取已配对蓝牙设备，请检查蓝牙隐私权限后手动开启语音输入。".into()
        } else {
            "无法读取系统已配对蓝牙设备，请检查蓝牙设置后手动开启语音输入。".into()
        }
    }
    pub async fn candidates(config: &str) -> Result<Vec<PairedRemote>, String> {
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
    use super::PairedRemote;
    pub async fn candidates(_config: &str) -> Result<Vec<PairedRemote>, String> {
        Err("当前平台不支持只读查询已配对遥控器，请手动开启语音输入。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
