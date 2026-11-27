use super::{station, Band, Security, Seen, Unavailable};
use std::{
    ops::Deref,
    ptr, slice,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use windows_sys::core::GUID;
use windows_sys::Win32::{
    Foundation::{ERROR_ACCESS_DENIED, ERROR_SUCCESS, HANDLE},
    NetworkManagement::WiFi::{
        dot11_BSS_type_any, WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory,
        WlanGetAvailableNetworkList, WlanGetNetworkBssList, WlanOpenHandle, WlanScan,
        DOT11_AUTH_ALGO_80211_SHARED_KEY, DOT11_AUTH_ALGO_OWE, DOT11_AUTH_ALGO_RSNA,
        DOT11_AUTH_ALGO_RSNA_PSK, DOT11_AUTH_ALGO_WPA, DOT11_AUTH_ALGO_WPA3_ENT,
        DOT11_AUTH_ALGO_WPA3_ENT_192, DOT11_AUTH_ALGO_WPA3_SAE, DOT11_AUTH_ALGO_WPA_PSK,
        DOT11_CIPHER_ALGO_WEP, DOT11_CIPHER_ALGO_WEP104, DOT11_CIPHER_ALGO_WEP40, DOT11_SSID,
        WLAN_AVAILABLE_NETWORK, WLAN_AVAILABLE_NETWORK_INCLUDE_ALL_ADHOC_PROFILES,
        WLAN_AVAILABLE_NETWORK_INCLUDE_ALL_MANUAL_HIDDEN_PROFILES, WLAN_AVAILABLE_NETWORK_LIST,
        WLAN_BSS_LIST, WLAN_INTERFACE_INFO_LIST,
    },
};

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { WlanCloseHandle(self.0, ptr::null()) };
    }
}

// A scan list stays readable until WlanFreeMemory runs.
struct List<T>(*mut T);

impl<T> Drop for List<T> {
    fn drop(&mut self) {
        unsafe { WlanFreeMemory(self.0.cast()) };
    }
}

impl<T> Deref for List<T> {
    type Target = T;

    fn deref(&self) -> &T {
        unsafe { &*self.0 }
    }
}

pub(super) fn scan(_consent: bool, cancelled: &AtomicBool) -> Result<Vec<Seen>, Unavailable> {
    let (mut handle, mut negotiated) = (ptr::null_mut::<core::ffi::c_void>(), 0);
    if unsafe { WlanOpenHandle(2, ptr::null(), &mut negotiated, &mut handle) } != ERROR_SUCCESS {
        return Err(Unavailable::NoAdapter);
    }
    let handle = Handle(handle);
    let interfaces = interfaces(handle.0)?;
    let (mut scanning, mut denied) = (false, false);
    for guid in &interfaces {
        let status = unsafe { WlanScan(handle.0, guid, ptr::null(), ptr::null(), ptr::null()) };
        scanning |= status == ERROR_SUCCESS;
        denied |= status == ERROR_ACCESS_DENIED;
    }
    if interfaces.is_empty() {
        return Err(Unavailable::NoAdapter);
    }
    if !scanning {
        return Err(if denied {
            Unavailable::LocationDenied
        } else {
            Unavailable::PoweredOff
        });
    }
    // A requested scan flushes the previous results and logo-certified drivers
    // finish it within 4 seconds.
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(4) {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(Vec::new());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(Vec::new());
        }
        let mut seen = Vec::new();
        denied = false;
        for guid in &interfaces {
            match unsafe { networks(handle.0, guid) } {
                Ok(found) => seen.extend(found),
                Err(status) => denied |= status == ERROR_ACCESS_DENIED,
            }
        }
        if denied && seen.is_empty() {
            return Err(Unavailable::LocationDenied);
        }
        if !seen.is_empty() || started.elapsed() >= Duration::from_secs(8) {
            return Ok(seen);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn interfaces(handle: HANDLE) -> Result<Vec<GUID>, Unavailable> {
    let mut list: *mut WLAN_INTERFACE_INFO_LIST = ptr::null_mut();
    let status = unsafe { WlanEnumInterfaces(handle, ptr::null(), &mut list) };
    if status != ERROR_SUCCESS || list.is_null() {
        return Err(match status {
            ERROR_ACCESS_DENIED => Unavailable::LocationDenied,
            _ => Unavailable::NoAdapter,
        });
    }
    let list = List(list);
    Ok(
        unsafe {
            slice::from_raw_parts(list.InterfaceInfo.as_ptr(), list.dwNumberOfItems as usize)
        }
        .iter()
        .map(|interface| interface.InterfaceGuid)
        .collect(),
    )
}

// Signal readings come from the BSS list; Windows only publishes security per network name.
unsafe fn networks(handle: HANDLE, guid: *const GUID) -> Result<Vec<Seen>, u32> {
    let flags = WLAN_AVAILABLE_NETWORK_INCLUDE_ALL_ADHOC_PROFILES
        | WLAN_AVAILABLE_NETWORK_INCLUDE_ALL_MANUAL_HIDDEN_PROFILES;
    let mut list: *mut WLAN_AVAILABLE_NETWORK_LIST = ptr::null_mut();
    let status = WlanGetAvailableNetworkList(handle, guid, flags, ptr::null(), &mut list);
    if status != ERROR_SUCCESS || list.is_null() {
        return Err(status);
    }
    let list = List(list);
    let available: Vec<(String, Security, i32)> =
        slice::from_raw_parts(list.Network.as_ptr(), list.dwNumberOfItems as usize)
            .iter()
            .filter_map(|network| {
                name(&network.dot11Ssid).map(|ssid| {
                    (
                        ssid,
                        security(network),
                        network.wlanSignalQuality as i32 / 2 - 100,
                    )
                })
            })
            .collect();
    drop(list);

    let mut list: *mut WLAN_BSS_LIST = ptr::null_mut();
    let status = WlanGetNetworkBssList(
        handle,
        guid,
        ptr::null(),
        dot11_BSS_type_any,
        0,
        ptr::null(),
        &mut list,
    );
    let stations: Vec<Seen> = if status == ERROR_SUCCESS && !list.is_null() {
        let list = List(list);
        slice::from_raw_parts(list.wlanBssEntries.as_ptr(), list.dwNumberOfItems as usize)
            .iter()
            .filter_map(|entry| {
                let ssid = name(&entry.dot11Ssid)?;
                let (channel, band) = station(entry.ulChCenterFrequency);
                let security = available
                    .iter()
                    .find(|(known, _, _)| known == &ssid)
                    .map_or(Security::Unknown, |(_, security, _)| *security);
                Some(Seen {
                    ssid,
                    rssi: entry.lRssi,
                    channel,
                    band,
                    security,
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    if stations.is_empty() {
        Ok(available
            .into_iter()
            .map(|(ssid, security, rssi)| Seen {
                ssid,
                rssi,
                channel: 0,
                band: Band::Unknown,
                security,
            })
            .collect())
    } else {
        Ok(stations)
    }
}

fn name(ssid: &DOT11_SSID) -> Option<String> {
    let length = (ssid.uSSIDLength as usize).min(ssid.ucSSID.len());
    let name = String::from_utf8_lossy(&ssid.ucSSID[..length]).into_owned();
    (!name.trim().is_empty()).then_some(name)
}

fn security(network: &WLAN_AVAILABLE_NETWORK) -> Security {
    if network.bSecurityEnabled == 0 {
        return Security::Open;
    }
    match network.dot11DefaultCipherAlgorithm {
        DOT11_CIPHER_ALGO_WEP40 | DOT11_CIPHER_ALGO_WEP104 | DOT11_CIPHER_ALGO_WEP => Security::Wep,
        _ => match network.dot11DefaultAuthAlgorithm {
            DOT11_AUTH_ALGO_80211_SHARED_KEY => Security::Wep,
            DOT11_AUTH_ALGO_WPA3_SAE => Security::Wpa3,
            DOT11_AUTH_ALGO_OWE => Security::Owe,
            DOT11_AUTH_ALGO_WPA_PSK | DOT11_AUTH_ALGO_WPA => Security::Wpa,
            DOT11_AUTH_ALGO_RSNA_PSK => Security::Wpa2,
            DOT11_AUTH_ALGO_RSNA | DOT11_AUTH_ALGO_WPA3_ENT | DOT11_AUTH_ALGO_WPA3_ENT_192 => {
                Security::Enterprise
            }
            _ => Security::Unknown,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{security, Security, WLAN_AVAILABLE_NETWORK};
    use windows_sys::Win32::NetworkManagement::WiFi::*;

    #[test]
    fn windows_network_auth_and_cipher_modes_map_to_security() {
        for (enabled, auth, cipher, expected) in [
            (
                0,
                DOT11_AUTH_ALGO_80211_OPEN,
                DOT11_CIPHER_ALGO_NONE,
                Security::Open,
            ),
            (
                1,
                DOT11_AUTH_ALGO_80211_SHARED_KEY,
                DOT11_CIPHER_ALGO_WEP104,
                Security::Wep,
            ),
            (
                1,
                DOT11_AUTH_ALGO_80211_OPEN,
                DOT11_CIPHER_ALGO_WEP40,
                Security::Wep,
            ),
            (
                1,
                DOT11_AUTH_ALGO_WPA_PSK,
                DOT11_CIPHER_ALGO_TKIP,
                Security::Wpa,
            ),
            (
                1,
                DOT11_AUTH_ALGO_RSNA_PSK,
                DOT11_CIPHER_ALGO_CCMP,
                Security::Wpa2,
            ),
            (
                1,
                DOT11_AUTH_ALGO_WPA3_SAE,
                DOT11_CIPHER_ALGO_CCMP,
                Security::Wpa3,
            ),
            (
                1,
                DOT11_AUTH_ALGO_OWE,
                DOT11_CIPHER_ALGO_CCMP,
                Security::Owe,
            ),
            (
                1,
                DOT11_AUTH_ALGO_RSNA,
                DOT11_CIPHER_ALGO_CCMP,
                Security::Enterprise,
            ),
            (
                1,
                DOT11_AUTH_ALGO_WPA3_ENT_192,
                DOT11_CIPHER_ALGO_GCMP_256,
                Security::Enterprise,
            ),
        ] {
            let network = WLAN_AVAILABLE_NETWORK {
                bSecurityEnabled: enabled,
                dot11DefaultAuthAlgorithm: auth,
                dot11DefaultCipherAlgorithm: cipher,
                ..Default::default()
            };
            assert_eq!(security(&network), expected);
        }
    }
}
