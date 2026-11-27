use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::atomic::AtomicBool};

const BOX_SSID: &str = "xiaozhi-box-";
const MAX_NETWORKS: usize = 64;
const BUFFER: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) enum Band {
    Unknown,
    Ghz2,
    Ghz5,
    Ghz6,
}

impl From<u8> for Band {
    fn from(band: u8) -> Self {
        match band {
            1 => Self::Ghz2,
            2 => Self::Ghz5,
            3 => Self::Ghz6,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) enum Security {
    Open,
    Wep,
    Wpa,
    Wpa2,
    Wpa3,
    Wpa3Transition,
    Owe,
    Enterprise,
    Unknown,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct Network {
    ssid: String,
    rssi: i32,
    channel: u32,
    band: Band,
    security: Security,
    is_box: bool,
}

// One access point as reported by the platform scanner.
#[derive(Debug, PartialEq)]
struct Seen {
    ssid: String,
    rssi: i32,
    channel: u32,
    band: Band,
    security: Security,
}

#[derive(Debug, PartialEq)]
enum Unavailable {
    NoAdapter,
    PoweredOff,
    LocationUnanswered,
    LocationDenied,
    Failed,
}

impl Unavailable {
    fn message(self) -> &'static str {
        match self {
            Self::NoAdapter => "未检测到 Wi-Fi 网卡，无法扫描热点。",
            Self::PoweredOff => "Wi-Fi 已关闭，请先打开 Wi-Fi 再扫描热点。",
            Self::LocationUnanswered => "未获得定位权限，无法读取热点名称。请在系统弹窗中选择「允许」后重试。",
            Self::LocationDenied if cfg!(target_os = "macos") => {
                "读取热点名称需要定位权限。请在「系统设置 → 隐私与安全性 → 定位服务」中开启定位服务并允许 Keepwork，然后重试。"
            }
            Self::LocationDenied => {
                "读取热点名称需要位置权限。请在 Windows「设置 → 隐私和安全性 → 位置」中开启位置服务并允许桌面应用访问位置，然后重试。"
            }
            Self::Failed => "Wi-Fi 热点扫描失败，请稍后重试。",
        }
    }
}

pub(super) fn scan(cancelled: &AtomicBool) -> Result<Vec<Network>, String> {
    scan_with(true, cancelled)
}

fn scan_with(consent: bool, cancelled: &AtomicBool) -> Result<Vec<Network>, String> {
    platform_scan(consent, cancelled)
        .map(collect)
        .map_err(|unavailable| unavailable.message().to_owned())
}

// Access points sharing a name collapse into their strongest reading.
fn collect(seen: Vec<Seen>) -> Vec<Network> {
    let mut strongest: BTreeMap<String, Seen> = BTreeMap::new();
    for network in seen {
        if network.ssid.trim().is_empty() {
            continue;
        }
        if strongest
            .get(&network.ssid)
            .is_none_or(|found| found.rssi < network.rssi)
        {
            strongest.insert(network.ssid.clone(), network);
        }
    }
    let mut networks: Vec<Network> = strongest
        .into_values()
        .map(|seen| Network {
            is_box: seen.ssid.to_ascii_lowercase().starts_with(BOX_SSID),
            ssid: seen.ssid,
            rssi: seen.rssi,
            channel: seen.channel,
            band: seen.band,
            security: seen.security,
        })
        .collect();
    networks.sort_by(|a, b| {
        b.is_box
            .cmp(&a.is_box)
            .then(b.rssi.cmp(&a.rssi))
            .then(a.ssid.cmp(&b.ssid))
    });
    networks.truncate(MAX_NETWORKS);
    networks
}

// Bitmask of the CWSecurity modes a CoreWLAN network advertises.
fn macos_security(modes: u32) -> Security {
    const WEP: u32 = 1 << 1;
    const WPA: u32 = (1 << 2) | (1 << 3);
    const WPA2: u32 = (1 << 4) | (1 << 5);
    const ENTERPRISE: u32 = (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 10) | (1 << 12);
    const WPA3: u32 = (1 << 11) | (1 << 13);
    const OWE: u32 = (1 << 14) | (1 << 15);
    if modes & WPA3 != 0 {
        if modes & WPA2 != 0 {
            Security::Wpa3Transition
        } else {
            Security::Wpa3
        }
    } else if modes & WPA2 != 0 {
        Security::Wpa2
    } else if modes & WPA != 0 {
        Security::Wpa
    } else if modes & ENTERPRISE != 0 {
        Security::Enterprise
    } else if modes & OWE != 0 {
        Security::Owe
    } else if modes & WEP != 0 {
        Security::Wep
    } else if modes & 1 != 0 {
        Security::Open
    } else {
        Security::Unknown
    }
}

// Windows reports the center frequency in kHz instead of a channel number.
fn station(frequency_khz: u32) -> (u32, Band) {
    let mhz = frequency_khz / 1000;
    match mhz {
        2412..=2472 => ((mhz - 2412) / 5 + 1, Band::Ghz2),
        2484 => (14, Band::Ghz2),
        5160..=5885 => ((mhz - 5000) / 5, Band::Ghz5),
        5955..=7115 => ((mhz - 5950) / 5, Band::Ghz6),
        _ => (0, Band::Unknown),
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{macos_security, Seen, Unavailable, BUFFER};
    use serde::Deserialize;
    use std::{
        ffi::c_void,
        sync::atomic::{AtomicBool, Ordering},
    };

    type CancelledFn = unsafe extern "C" fn(*const c_void) -> bool;

    extern "C" {
        fn keepwork_box_wifi_scan(
            out: *mut u8,
            capacity: usize,
            request_location: bool,
            cancelled: CancelledFn,
            context: *const c_void,
        ) -> i32;
    }

    unsafe extern "C" fn is_cancelled(context: *const c_void) -> bool {
        !context.is_null() && (*(context as *const AtomicBool)).load(Ordering::Relaxed)
    }

    #[derive(Deserialize)]
    struct Entry {
        ssid: String,
        rssi: i32,
        channel: u32,
        band: u8,
        security: u32,
    }

    impl Entry {
        fn into_seen(self) -> Seen {
            Seen {
                ssid: self.ssid,
                rssi: self.rssi,
                channel: self.channel,
                band: self.band.into(),
                security: macos_security(self.security),
            }
        }
    }

    pub(super) fn scan(consent: bool, cancelled: &AtomicBool) -> Result<Vec<Seen>, Unavailable> {
        let mut json = vec![0u8; BUFFER];
        // Status codes mirror box_wifi_macos.m.
        match unsafe {
            keepwork_box_wifi_scan(
                json.as_mut_ptr(),
                json.len(),
                consent,
                is_cancelled,
                (cancelled as *const AtomicBool).cast(),
            )
        } {
            0 => {}
            1 => return Err(Unavailable::NoAdapter),
            2 => return Err(Unavailable::PoweredOff),
            3 => return Err(Unavailable::LocationUnanswered),
            4 => return Err(Unavailable::LocationDenied),
            _ => return Err(Unavailable::Failed),
        }
        let end = json
            .iter()
            .position(|&byte| byte == 0)
            .unwrap_or(json.len());
        serde_json::from_slice::<Vec<Entry>>(&json[..end])
            .map(|entries| entries.into_iter().map(Entry::into_seen).collect())
            .map_err(|_| Unavailable::Failed)
    }
}

#[cfg(windows)]
#[path = "wifi_windows.rs"]
mod platform;

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::{Seen, Unavailable};
    use std::sync::atomic::AtomicBool;

    pub(super) fn scan(_consent: bool, _cancelled: &AtomicBool) -> Result<Vec<Seen>, Unavailable> {
        Err(Unavailable::NoAdapter)
    }
}

use platform::scan as platform_scan;

#[cfg(test)]
mod tests {
    use super::{collect, macos_security, station, Band, Security, Seen};

    fn seen(ssid: &str, rssi: i32, channel: u32, band: Band, security: Security) -> Seen {
        Seen {
            ssid: ssid.into(),
            rssi,
            channel,
            band,
            security,
        }
    }

    #[test]
    fn hotspots_merge_by_name_and_put_the_box_first() {
        let open = (Band::Ghz2, Security::Open);
        let networks = collect(vec![
            seen("Router", -70, 36, Band::Ghz5, Security::Wpa2),
            seen("xiaozhi-box-8D91", -60, 6, open.0, open.1),
            seen("Router", -48, 6, open.0, Security::Wpa2),
            seen("XIAOZHI-BOX-2A00", -80, 11, open.0, open.1),
            seen("  ", -10, 1, open.0, open.1),
            seen("", -10, 1, open.0, open.1),
        ]);
        assert_eq!(
            networks
                .iter()
                .map(|network| network.ssid.as_str())
                .collect::<Vec<_>>(),
            ["xiaozhi-box-8D91", "XIAOZHI-BOX-2A00", "Router"]
        );
        assert_eq!((networks[2].rssi, networks[2].channel), (-48, 6));
        assert_eq!(
            serde_json::to_value(&networks[0]).unwrap(),
            serde_json::json!({
                "ssid": "xiaozhi-box-8D91", "rssi": -60, "channel": 6,
                "band": "ghz2", "security": "open", "isBox": true,
            })
        );
    }

    #[test]
    fn hotspot_security_summarizes_every_advertised_mode() {
        let modes = |list: &[u32]| list.iter().fold(0, |bits, mode| bits | 1 << mode);
        for (list, security) in [
            (vec![0], Security::Open),
            (vec![1], Security::Wep),
            (vec![2, 3], Security::Wpa),
            (vec![4, 5], Security::Wpa2),
            (vec![11, 13], Security::Wpa3),
            (vec![3, 4, 5, 11, 13], Security::Wpa3Transition),
            (vec![2, 3, 4, 5, 13], Security::Wpa3Transition),
            (vec![14], Security::Owe),
            (vec![0, 14, 15], Security::Owe),
            (vec![10, 12], Security::Enterprise),
            (vec![9], Security::Enterprise),
            (vec![], Security::Unknown),
        ] {
            assert_eq!(macos_security(modes(&list)), security, "{list:?}");
        }
    }

    #[test]
    fn windows_center_frequencies_map_to_channels_and_bands() {
        for (khz, channel, band) in [
            (2_437_000, 6, Band::Ghz2),
            (2_484_000, 14, Band::Ghz2),
            (5_180_000, 36, Band::Ghz5),
            (5_825_000, 165, Band::Ghz5),
            (5_955_000, 1, Band::Ghz6),
            (6_135_000, 37, Band::Ghz6),
        ] {
            assert_eq!(station(khz), (channel, band), "{khz} kHz");
        }
        assert_eq!(station(0), (0, Band::Unknown));
        assert_eq!(station(3_500_000), (0, Band::Unknown));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "scans with this computer's Wi-Fi adapter"]
    fn live_hotspot_scan_reads_the_real_adapter() {
        // Skips the Location Services prompt, so names appear only after a past consent.
        let cancelled = super::AtomicBool::new(false);
        match super::scan_with(false, &cancelled) {
            Ok(networks) => {
                assert!(networks
                    .iter()
                    .all(|network| !network.ssid.trim().is_empty()));
                assert!(networks
                    .windows(2)
                    .all(|pair| !pair[0].is_box || pair[1].is_box));
                eprintln!(
                    "{} named hotspots, strongest {} dBm",
                    networks.len(),
                    networks.first().map_or(0, |network| network.rssi)
                );
            }
            Err(message) => {
                eprintln!("hotspot scan unavailable: {message}");
                assert!(message.contains("定位") || message.contains("Wi-Fi"));
            }
        }
    }
}
